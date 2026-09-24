'''
rest_server.py ~ 臺北市 YouBike 2.0 RESTful API Server
(物聯網應用 W03 課後作業：Flask RESTful API 範例之功能擴增及優化)

架構:
  youbike_source.py   公開資料的下載、欄位轉換、CSV 讀寫
  repository.py       資料存取層 (StationRepository 抽象介面 + dict 實作)
  sync_service.py     背景即時同步 (每 60 秒抓一次官方資料)
  rest_server.py      Flask 路由: 只負責「解析請求 → 呼叫 repository → 回傳 JSON」

執行:
  python rest_server.py                  # 匯入 CSV + 啟動背景同步
  python rest_server.py --no-sync        # 只用 CSV 資料 (離線 demo)
  python rest_server.py --csv 檔案.csv --interval 30 --port 5000
'''

import argparse
import logging
import os

from flask import Flask, jsonify, request
from flask_cors import CORS

from repository import (ApiError, DictStationRepository, StationRepository,
                        ValidationError)
from sync_service import SyncService
from youbike_source import FULL_CSV, default_csv_path, load_csv

# 臺灣本島 + 離島的經緯度範圍，用來擋掉明顯錯誤的座標
LAT_RANGE = (21.0, 26.5)
LNG_RANGE = (118.0, 123.0)


# ==============================================================
# 輸入驗證
# ==============================================================
def get_json_body():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ValidationError('request body must be a JSON object')
    return body


def _str(value, field, required=True):
    if value is None and not required:
        return ''
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValidationError(f"'{field}' is required and must be a non-empty string")
    return value.strip()


def _int(value, field):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValidationError(f"'{field}' must be a non-negative integer")
    return value


def _coord(value, field, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
        raise ValidationError(f"'{field}' must be a number between {lo} and {hi}")
    return float(value)


def _bool(value, field):
    if not isinstance(value, bool):
        raise ValidationError(f"'{field}' must be true or false")
    return value


FIELD_VALIDATORS = {
    'name': lambda v: _str(v, 'name'),
    'area': lambda v: _str(v, 'area'),
    'address': lambda v: _str(v, 'address', required=False),
    'lat': lambda v: _coord(v, 'lat', *LAT_RANGE),
    'lng': lambda v: _coord(v, 'lng', *LNG_RANGE),
    'total': lambda v: _int(v, 'total'),
    'available_rent': lambda v: _int(v, 'available_rent'),
    'available_return': lambda v: _int(v, 'available_return'),
    'active': lambda v: _bool(v, 'active'),
}
REQUIRED = ('sno', 'name', 'area', 'lat', 'lng', 'total', 'available_rent', 'available_return')


def parse_full_station(body, sno=None):
    '''POST / PUT 用: 需要完整欄位。sno 可由 URL 帶入。'''
    if sno is not None and 'sno' not in body:
        body = {**body, 'sno': sno}
    missing = [f for f in REQUIRED if f not in body]
    if missing:
        raise ValidationError(f"missing fields: {', '.join(missing)}")
    station = {'sno': _str(body['sno'], 'sno'),
               'address': '', 'active': True}
    for field, validate in FIELD_VALIDATORS.items():
        if field in body:
            station[field] = validate(body[field])
    _check_capacity(station)
    return station


def parse_partial_fields(body):
    '''PATCH 用: 只接受部份欄位，不可修改 sno。'''
    if 'sno' in body:
        raise ValidationError("'sno' cannot be changed with PATCH (use PUT)")
    unknown = [k for k in body if k not in FIELD_VALIDATORS]
    if unknown:
        raise ValidationError(f"unknown fields: {', '.join(unknown)}")
    if not body:
        raise ValidationError('no fields to update')
    return {k: FIELD_VALIDATORS[k](v) for k, v in body.items()}


def _check_capacity(s):
    if s['available_rent'] > s['total'] or s['available_return'] > s['total']:
        raise ValidationError('available_rent / available_return cannot exceed total')


def arg_int(name, default, lo=0, hi=None):
    raw = request.args.get(name)
    if raw in (None, ''):
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValidationError(f"query '{name}' must be an integer")
    if value < lo or (hi is not None and value > hi):
        raise ValidationError(f"query '{name}' must be between {lo} and {hi}")
    return value


def arg_float(name, lo, hi, required=True):
    raw = request.args.get(name)
    if raw in (None, ''):
        if required:
            raise ValidationError(f"query '{name}' is required")
        return None
    try:
        value = float(raw)
    except ValueError:
        raise ValidationError(f"query '{name}' must be a number")
    if not lo <= value <= hi:
        raise ValidationError(f"query '{name}' must be between {lo} and {hi}")
    return value


def arg_bool(name):
    raw = request.args.get(name)
    if raw in (None, ''):
        return None
    if raw.lower() in ('1', 'true', 'yes'):
        return True
    if raw.lower() in ('0', 'false', 'no'):
        return False
    raise ValidationError(f"query '{name}' must be true or false")


# ==============================================================
# Flask 應用程式
# ==============================================================
def create_app(repo: StationRepository, sync: SyncService = None, csv_path=None) -> Flask:
    app = Flask(__name__)
    app.json.ensure_ascii = False
    app.json.sort_keys = False
    CORS(app)

    # ---------- 錯誤處理: 一律回傳 JSON ----------
    @app.errorhandler(ApiError)
    def handle_api_error(err):
        return jsonify({'result': 'error', 'message': err.message}), err.status_code

    @app.errorhandler(404)
    def handle_404(_):
        return jsonify({'result': 'error', 'message': 'endpoint not found'}), 404

    @app.errorhandler(405)
    def handle_405(_):
        return jsonify({'result': 'error', 'message': 'method not allowed'}), 405

    # ---------- API 說明 ----------
    @app.get('/')
    def index():
        return jsonify({
            'name': 'Taipei YouBike 2.0 RESTful API',
            'data_source': 'https://data.gov.tw/dataset/137993',
            'csv_loaded': os.path.basename(csv_path) if csv_path else None,
            'stations': repo.count(),
            'endpoints': {
                'GET /stations': '查詢站點 (area, q, min_rent, min_return, active, sort, limit, offset)',
                'GET /stations/<sno>': '查詢單一站點',
                'POST /stations': '新增站點',
                'PUT /stations/<sno>': '整筆改換站點',
                'PATCH /stations/<sno>': '部份更新站點',
                'DELETE /stations/<sno>': '刪除站點',
                'GET /stations/nearby': '附近站點 (lat, lng, r, limit, need=rent|return)',
                'GET /areas': '行政區列表',
                'GET /stats': '統計 (總覽、各區、快沒車、已滿位)',
                'GET /sync/status': '背景同步狀態',
                'POST /sync': '立即同步一次官方資料',
            },
        })

    # ---------- 查詢 ----------
    @app.get('/stations')
    def list_stations():
        result = repo.search(
            area=request.args.get('area') or None,
            keyword=request.args.get('q') or None,
            min_rent=arg_int('min_rent', 0),
            min_return=arg_int('min_return', 0),
            active=arg_bool('active'),
            sort=request.args.get('sort') or 'sno',
            limit=arg_int('limit', 20, lo=1, hi=200),
            offset=arg_int('offset', 0),
        )
        return jsonify(result)

    # 注意: /stations/nearby 必須定義在 /stations/<sno> 之前，
    # Flask 會優先比對靜態路徑，但寫在前面比較清楚
    @app.get('/stations/nearby')
    def nearby_stations():
        need = request.args.get('need') or None
        if need not in (None, 'rent', 'return'):
            raise ValidationError("query 'need' must be 'rent' or 'return'")
        lat = arg_float('lat', *LAT_RANGE)
        lng = arg_float('lng', *LNG_RANGE)
        radius = arg_int('r', 500, lo=50, hi=5000)
        limit = arg_int('limit', 10, lo=1, hi=50)
        items = repo.nearby(lat, lng, radius=radius, limit=limit, need=need)
        return jsonify({'center': {'lat': lat, 'lng': lng}, 'radius_m': radius,
                        'need': need, 'count': len(items), 'items': items})

    @app.get('/stations/<sno>')
    def get_station(sno):
        return jsonify(repo.get(sno))

    @app.get('/areas')
    def list_areas():
        return jsonify(repo.areas())

    @app.get('/stats')
    def get_stats():
        return jsonify(repo.stats(low_threshold=arg_int('low', 2, hi=50)))

    # ---------- 新增 / 改換 / 部份更新 / 刪除 ----------
    @app.post('/stations')
    def create_station():
        station = parse_full_station(get_json_body())
        data = repo.create(station)
        return jsonify({'result': 'inserted successfully', 'data': data}), 201

    @app.put('/stations/<sno>')
    def replace_station(sno):
        station = parse_full_station(get_json_body(), sno=sno)
        data = repo.replace(sno, station)
        return jsonify({'result': 'replaced successfully', 'data': data})

    @app.patch('/stations/<sno>')
    def update_station(sno):
        fields = parse_partial_fields(get_json_body())
        data = repo.update(sno, fields)
        return jsonify({'result': 'updated successfully', 'data': data})

    @app.delete('/stations/<sno>')
    def delete_station(sno):
        repo.delete(sno)
        return jsonify({'result': 'deleted successfully'})

    # ---------- 同步 ----------
    @app.get('/sync/status')
    def sync_status():
        if not sync:
            return jsonify({'enabled': False, 'message': 'sync service not configured'})
        return jsonify(sync.status)

    @app.post('/sync')
    def sync_now():
        if not sync:
            raise ValidationError('sync service not configured')
        try:
            result = sync.run_once()
        except Exception as exc:
            return jsonify({'result': 'error', 'message': f'sync failed: {exc}'}), 502
        return jsonify({'result': 'synced successfully', 'data': result})

    return app


# ==============================================================
# 主程式
# ==============================================================
def main():
    parser = argparse.ArgumentParser(description='Taipei YouBike 2.0 RESTful API Server')
    parser.add_argument('--csv', default=None, help='啟動時匯入的 CSV (預設: 完整快照，沒有就用範例檔)')
    parser.add_argument('--no-sync', action='store_true', help='不啟動背景即時同步')
    parser.add_argument('--interval', type=int, default=60, help='同步間隔秒數 (預設 60)')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=5000)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    log = logging.getLogger('youbike')

    csv_path = args.csv or default_csv_path()
    stations = load_csv(csv_path)
    log.info('匯入 CSV: %s (%d 站)', csv_path, len(stations))
    repo = DictStationRepository(stations)

    sync = SyncService(repo, interval=max(args.interval, 10), snapshot_path=FULL_CSV, logger=log)
    if not args.no_sync:
        sync.start()
        log.info('背景同步已啟動，每 %d 秒更新一次', sync.interval)

    app = create_app(repo, sync, csv_path)
    # 關閉 reloader，避免 debug 模式下啟動兩個同步執行緒
    app.run(host=args.host, port=args.port, debug=True, use_reloader=False)


if __name__ == '__main__':
    main()
