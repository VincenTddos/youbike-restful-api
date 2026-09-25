'''
youbike_source.py ~ 臺北市 YouBike 2.0 公開資料的「取得」與「轉換」

資料來源: 政府資料開放平臺「YouBike2.0臺北市公共自行車即時資訊」
          https://data.gov.tw/dataset/137993  (JSON，每 1 分鐘更新)

功能:
  - fetch_official()  從官方網址下載即時 JSON
  - normalize()       把官方欄位 (sno/sna/sarea/Quantity...) 轉成本 API 使用的欄位
  - load_csv() / save_csv()  CSV 快照的讀寫

單獨執行本檔可下載完整快照 (約 1,800 站):
  python youbike_source.py            → data/youbike_stations.csv

資料檔:
  data/youbike_stations.csv  Open Data 下載後轉存的單一資料檔 (納入版本控制)
  data/youbike_live.csv      Server 背景同步後寫出的最新快照 (不納入版本控制)
  data/youbike_sample.csv    86 站範例 (測試用)
'''

import csv
import json
import os
import urllib.request

OFFICIAL_URL = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json'

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
FULL_CSV = os.path.join(DATA_DIR, 'youbike_stations.csv')
SAMPLE_CSV = os.path.join(DATA_DIR, 'youbike_sample.csv')
LIVE_CSV = os.path.join(DATA_DIR, 'youbike_live.csv')

# CSV 沿用官方欄位名稱，方便和原始資料對照
CSV_FIELDS = ['sno', 'sna', 'sarea', 'ar', 'latitude', 'longitude', 'Quantity',
              'available_rent_bikes', 'available_return_bikes', 'act', 'mday']

NAME_PREFIX = 'YouBike2.0_'


def fetch_official(url=OFFICIAL_URL, timeout=15):
    '''下載官方即時資料，回傳 list[dict] (官方原始欄位)。'''
    req = urllib.request.Request(url, headers={'User-Agent': 'ntub-iot-homework/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize(raw: dict, source='official') -> dict:
    '''官方欄位 → API 欄位。'''
    name = str(raw.get('sna', '')).strip()
    if name.startswith(NAME_PREFIX):
        name = name[len(NAME_PREFIX):]
    return {
        'sno': str(raw.get('sno', '')).strip(),
        'name': name,
        'area': str(raw.get('sarea', '')).strip(),
        'address': str(raw.get('ar', '')).strip(),
        'lat': _float(raw.get('latitude')),
        'lng': _float(raw.get('longitude')),
        'total': _int(raw.get('Quantity', raw.get('total'))),
        'available_rent': _int(raw.get('available_rent_bikes')),
        'available_return': _int(raw.get('available_return_bikes')),
        'active': str(raw.get('act', '1')).strip() == '1',
        'updated_at': str(raw.get('mday', '')).strip(),
        'source': source,
    }


def denormalize(station: dict) -> dict:
    '''API 欄位 → 官方欄位 (寫 CSV 用)。'''
    name = station['name']
    if station.get('source', 'official') == 'official' and not name.startswith(NAME_PREFIX):
        name = NAME_PREFIX + name
    return {
        'sno': station['sno'], 'sna': name, 'sarea': station['area'], 'ar': station['address'],
        'latitude': station['lat'], 'longitude': station['lng'], 'Quantity': station['total'],
        'available_rent_bikes': station['available_rent'],
        'available_return_bikes': station['available_return'],
        'act': '1' if station['active'] else '0', 'mday': station['updated_at'],
    }


def load_csv(path) -> list:
    '''讀取 CSV 快照 (官方欄位)，回傳正規化後的 list[dict]。utf-8-sig 可相容 Excel 存檔的 BOM。'''
    with open(path, newline='', encoding='utf-8-sig') as f:
        return [normalize(row) for row in csv.DictReader(f) if row.get('sno')]


def save_csv(stations, path):
    '''把站點資料寫成 CSV 快照 (官方欄位)。先寫暫存檔再改名，避免寫到一半被讀取。'''
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for s in stations:
            writer.writerow(denormalize(s))
    os.replace(tmp, path)


def default_csv_path():
    '''優先順序: 同步後的最新快照 → Open Data 資料檔 → 範例檔。'''
    for path in (LIVE_CSV, FULL_CSV, SAMPLE_CSV):
        if os.path.exists(path):
            return path
    return SAMPLE_CSV


if __name__ == '__main__':
    print(f'下載中: {OFFICIAL_URL}')
    stations = [normalize(r) for r in fetch_official()]
    save_csv(stations, FULL_CSV)
    print(f'完成: {len(stations)} 站 → {FULL_CSV}')
