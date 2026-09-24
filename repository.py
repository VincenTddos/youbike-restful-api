'''
repository.py ~ 資料存取層 (物件導向設計)

StationRepository      抽象介面: 定義所有資料操作 (CRUD、查詢、附近站點、統計、同步匯入)
DictStationRepository  以 Python dict 為 Data Storage 的實作 (執行緒安全)

之後改接 MariaDB 時，只要新增 MariaDBStationRepository 實作同一組方法，
rest_server.py 的路由完全不用改。
'''

import math
import threading
from abc import ABC, abstractmethod
from datetime import datetime


# ==============================================================
# 例外類別 (由 Flask errorhandler 轉成 HTTP 回應)
# ==============================================================
class ApiError(Exception):
    status_code = 400

    def __init__(self, message):
        super().__init__(message)
        self.message = message


class ValidationError(ApiError):
    status_code = 400


class NotFoundError(ApiError):
    status_code = 404


class ConflictError(ApiError):
    status_code = 409


# ==============================================================
# 共用工具
# ==============================================================
EARTH_RADIUS_M = 6_371_000


def haversine(lat1, lng1, lat2, lng2):
    '''Haversine 公式: 計算地球表面兩點的大圓距離 (公尺)。'''
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


SORTABLE = {'sno', 'name', 'area', 'total', 'available_rent', 'available_return'}


# ==============================================================
# 抽象介面
# ==============================================================
class StationRepository(ABC):

    # ---------- CRUD ----------
    @abstractmethod
    def get(self, sno: str) -> dict: ...

    @abstractmethod
    def create(self, station: dict) -> dict: ...

    @abstractmethod
    def replace(self, sno: str, station: dict) -> dict: ...

    @abstractmethod
    def update(self, sno: str, fields: dict) -> dict: ...

    @abstractmethod
    def delete(self, sno: str) -> None: ...

    # ---------- 查詢 ----------
    @abstractmethod
    def search(self, area=None, keyword=None, min_rent=0, min_return=0,
               active=None, sort='sno', limit=20, offset=0) -> dict: ...

    @abstractmethod
    def nearby(self, lat, lng, radius=500, limit=10, need=None) -> list: ...

    @abstractmethod
    def areas(self) -> list: ...

    @abstractmethod
    def stats(self, low_threshold=2) -> dict: ...

    # ---------- 匯入 / 匯出 ----------
    @abstractmethod
    def upsert_official(self, stations: list) -> dict: ...

    @abstractmethod
    def all(self) -> list: ...

    @abstractmethod
    def count(self) -> int: ...


# ==============================================================
# dict 實作
# ==============================================================
class DictStationRepository(StationRepository):
    '''
    以 dict {sno: station} 儲存。
    背景同步執行緒與 Flask 請求會同時存取資料，所以用 Lock 保護。
    '''

    def __init__(self, stations=None):
        self._data = {}
        self._lock = threading.RLock()
        for s in stations or []:
            self._data[s['sno']] = dict(s)

    # ---------- 內部工具 ----------
    def _require(self, sno):
        if sno not in self._data:
            raise NotFoundError(f"station not found: '{sno}'")
        return self._data[sno]

    # ---------- CRUD ----------
    def get(self, sno):
        with self._lock:
            return dict(self._require(sno))

    def create(self, station):
        with self._lock:
            if station['sno'] in self._data:
                raise ConflictError(f"station already exists: '{station['sno']}'")
            record = {**station, 'source': 'custom', 'updated_at': now_str()}
            self._data[record['sno']] = record
            return dict(record)

    def replace(self, sno, station):
        with self._lock:
            old = self._require(sno)
            new_sno = station['sno']
            if new_sno != sno and new_sno in self._data:
                raise ConflictError(f"station already exists: '{new_sno}'")
            record = {**station, 'source': old['source'], 'updated_at': now_str()}
            if new_sno != sno:
                del self._data[sno]
            self._data[new_sno] = record
            return dict(record)

    def update(self, sno, fields):
        with self._lock:
            record = self._require(sno)
            merged = {**record, **fields}
            if merged['available_rent'] > merged['total'] or merged['available_return'] > merged['total']:
                raise ValidationError('available_rent / available_return cannot exceed total')
            merged['updated_at'] = now_str()
            self._data[sno] = merged
            return dict(merged)

    def delete(self, sno):
        with self._lock:
            self._require(sno)
            del self._data[sno]

    # ---------- 查詢 ----------
    def search(self, area=None, keyword=None, min_rent=0, min_return=0,
               active=None, sort='sno', limit=20, offset=0):
        with self._lock:
            items = list(self._data.values())

        if area:
            items = [s for s in items if s['area'] == area]
        if keyword:
            kw = keyword.lower()
            items = [s for s in items if kw in s['name'].lower() or kw in s['address'].lower()]
        if min_rent:
            items = [s for s in items if s['available_rent'] >= min_rent]
        if min_return:
            items = [s for s in items if s['available_return'] >= min_return]
        if active is not None:
            items = [s for s in items if s['active'] == active]

        desc = sort.startswith('-')
        field = sort.lstrip('-')
        if field not in SORTABLE:
            raise ValidationError(f"invalid sort field: '{field}' (allowed: {', '.join(sorted(SORTABLE))})")
        items.sort(key=lambda s: (s[field], s['sno']), reverse=desc)

        total = len(items)
        page = items[offset:offset + limit]
        return {'total': total, 'count': len(page), 'limit': limit, 'offset': offset,
                'items': [dict(s) for s in page]}

    def nearby(self, lat, lng, radius=500, limit=10, need=None):
        with self._lock:
            items = list(self._data.values())
        result = []
        for s in items:
            if not s['active']:
                continue
            if need == 'rent' and s['available_rent'] <= 0:
                continue
            if need == 'return' and s['available_return'] <= 0:
                continue
            # 先用經緯度差做粗略篩選 (1 度緯度約 111 km)，減少三角函數計算量
            if abs(s['lat'] - lat) * 111_000 > radius:
                continue
            d = haversine(lat, lng, s['lat'], s['lng'])
            if d <= radius:
                result.append({**s, 'distance_m': round(d)})
        result.sort(key=lambda s: s['distance_m'])
        return result[:limit]

    def areas(self):
        with self._lock:
            items = list(self._data.values())
        counts = {}
        for s in items:
            counts[s['area']] = counts.get(s['area'], 0) + 1
        return [{'area': a, 'stations': n} for a, n in sorted(counts.items())]

    def stats(self, low_threshold=2):
        with self._lock:
            items = [dict(s) for s in self._data.values()]
        active = [s for s in items if s['active']]

        by_area = {}
        for s in active:
            a = by_area.setdefault(s['area'], {'area': s['area'], 'stations': 0, 'total': 0,
                                               'available_rent': 0, 'available_return': 0})
            a['stations'] += 1
            a['total'] += s['total']
            a['available_rent'] += s['available_rent']
            a['available_return'] += s['available_return']
        for a in by_area.values():
            a['rent_ratio'] = round(a['available_rent'] / a['total'], 3) if a['total'] else 0

        pick = lambda s: {k: s[k] for k in ('sno', 'name', 'area', 'total',
                                            'available_rent', 'available_return')}
        low = sorted((s for s in active if s['available_rent'] <= low_threshold),
                     key=lambda s: (s['available_rent'], s['sno']))
        full = sorted((s for s in active if s['available_return'] == 0), key=lambda s: s['sno'])

        return {
            'summary': {
                'stations': len(items),
                'active_stations': len(active),
                'total_docks': sum(s['total'] for s in active),
                'available_rent': sum(s['available_rent'] for s in active),
                'available_return': sum(s['available_return'] for s in active),
                'low_bike_stations': len(low),
                'full_stations': len(full),
            },
            'by_area': sorted(by_area.values(), key=lambda a: -a['available_rent']),
            'low_bike_threshold': low_threshold,
            'low_bike': [pick(s) for s in low],
            'full': [pick(s) for s in full],
        }

    # ---------- 匯入 / 匯出 ----------
    def upsert_official(self, stations):
        '''同步官方資料: 新站新增、舊站更新；使用者自建 (custom) 的站點不會被覆蓋。'''
        inserted = updated = skipped = 0
        with self._lock:
            for s in stations:
                old = self._data.get(s['sno'])
                if old and old.get('source') == 'custom':
                    skipped += 1
                    continue
                if old:
                    updated += 1
                else:
                    inserted += 1
                self._data[s['sno']] = {**s, 'source': 'official'}
        return {'inserted': inserted, 'updated': updated, 'skipped_custom': skipped}

    def all(self):
        with self._lock:
            return [dict(s) for s in sorted(self._data.values(), key=lambda s: s['sno'])]

    def count(self):
        with self._lock:
            return len(self._data)
