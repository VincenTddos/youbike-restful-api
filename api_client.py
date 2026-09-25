'''
api_client.py ~ 臺北市 YouBike 2.0 RESTful API 的 Python Client

以 requests 透過 HTTP 呼叫 API Server，可對 Station Resource 做完整 CRUD，
並能跑完整的實測流程，輸出每一次的 Request (Method / URL / Body) 與 Response (Status / Output)。

使用方式 (先在另一個視窗執行 python rest_server.py):
  python api_client.py demo                              # 跑完整實測流程 (查詢 → CRUD → 錯誤處理)
  python api_client.py demo --markdown docs/api_examples.md   # 同時輸出 Markdown 實測紀錄

  python api_client.py list --area 大安區 --min-rent 5 --sort -available_rent --limit 3
  python api_client.py get 500101001
  python api_client.py nearby 25.0478 121.5170 --r 300 --need rent
  python api_client.py create '{"sno":"900000001","name":"測試站","area":"中正區","lat":25.04,"lng":121.52,"total":20,"available_rent":5,"available_return":15}'
  python api_client.py replace 900000001 '{...完整欄位...}'
  python api_client.py update 900000001 '{"available_rent":3}'
  python api_client.py delete 900000001
  python api_client.py areas | stats | sync-status | sync

  共用參數: --base-url http://127.0.0.1:5000
'''

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import unquote

import requests

DEFAULT_BASE_URL = 'http://127.0.0.1:5000'


@dataclass
class ApiCall:
    '''一次 API 呼叫的完整紀錄。'''
    method: str
    url: str
    status: int
    output: object
    body: object = None
    title: str = ''
    elapsed_ms: int = 0

    @property
    def ok(self):
        return 200 <= self.status < 300


@dataclass
class YouBikeClient:
    base_url: str = DEFAULT_BASE_URL
    timeout: float = 15
    history: list = field(default_factory=list)

    def __post_init__(self):
        self.base_url = self.base_url.rstrip('/')
        self.session = requests.Session()

    # ---------- 共用 ----------
    def request(self, method, path, body=None, params=None, title=''):
        url = self.base_url + path
        resp = self.session.request(method, url, json=body, params=params, timeout=self.timeout)
        try:
            output = resp.json()
        except ValueError:
            output = resp.text
        call = ApiCall(method=method, url=resp.url, status=resp.status_code, output=output,
                       body=body, title=title, elapsed_ms=round(resp.elapsed.total_seconds() * 1000))
        self.history.append(call)
        return call

    # ---------- Meta ----------
    def info(self, title=''):
        return self.request('GET', '/', title=title)

    # ---------- Station CRUD ----------
    def list_stations(self, title='', **filters):
        params = {k: v for k, v in filters.items() if v is not None}
        return self.request('GET', '/stations', params=params, title=title)

    def get_station(self, sno, title=''):
        return self.request('GET', f'/stations/{sno}', title=title)

    def create_station(self, station, title=''):
        return self.request('POST', '/stations', body=station, title=title)

    def replace_station(self, sno, station, title=''):
        return self.request('PUT', f'/stations/{sno}', body=station, title=title)

    def update_station(self, sno, fields, title=''):
        return self.request('PATCH', f'/stations/{sno}', body=fields, title=title)

    def delete_station(self, sno, title=''):
        return self.request('DELETE', f'/stations/{sno}', title=title)

    # ---------- 查詢 / 統計 / 同步 ----------
    def nearby(self, lat, lng, r=None, limit=None, need=None, title=''):
        params = {'lat': lat, 'lng': lng, 'r': r, 'limit': limit, 'need': need}
        return self.request('GET', '/stations/nearby', params={k: v for k, v in params.items() if v is not None}, title=title)

    def areas(self, title=''):
        return self.request('GET', '/areas', title=title)

    def stats(self, low=None, title=''):
        return self.request('GET', '/stats', params={'low': low} if low is not None else None, title=title)

    def sync_status(self, title=''):
        return self.request('GET', '/sync/status', title=title)

    def sync_now(self, title=''):
        return self.request('POST', '/sync', title=title)


# ==============================================================
# 輸出
# ==============================================================
def shorten(output, max_items=3):
    '''清單太長時只保留前幾筆，讓實測紀錄好讀。'''
    if isinstance(output, list) and len(output) > max_items:
        return output[:max_items] + [f'... 共 {len(output)} 筆，略']
    if isinstance(output, dict):
        return {k: shorten(v, max_items) for k, v in output.items()}
    return output


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)


def print_call(call, short=True):
    mark = 'OK ' if call.ok else 'ERR'
    if call.title:
        print(f'\n=== {call.title} ===')
    print(f'[{mark}] {call.method} {call.url}')
    if call.body is not None:
        print('Request Body:')
        print(dumps(call.body))
    print(f'Status: {call.status}  ({call.elapsed_ms} ms)')
    print('Response:')
    print(dumps(shorten(call.output) if short else call.output))


def to_markdown(calls, base_url):
    lines = [
        '# API 實測範例',
        '',
        f'由 `python api_client.py demo --markdown docs/api_examples.md` 自動產生，'
        f'測試時間 {datetime.now():%Y-%m-%d %H:%M:%S}，Server：`{base_url}`。',
        '',
        '回應中的清單只列前 3 筆（標示「略」）。',
        '',
        '| # | 情境 | Method | URL Path | Status |',
        '|---|---|---|---|---|',
    ]
    for i, c in enumerate(calls, 1):
        path = unquote(c.url[len(base_url):]) or '/'
        lines.append(f'| {i} | {c.title} | `{c.method}` | `{path}` | {c.status} |')
    for i, c in enumerate(calls, 1):
        path = unquote(c.url[len(base_url):]) or '/'
        lines += ['', f'## {i}. {c.title}', '', '**Request**', '', '```http', f'{c.method} {path}']
        if c.body is not None:
            lines += ['Content-Type: application/json', '', dumps(c.body)]
        lines += ['```', '', f'**Response** — Status `{c.status}`', '', '```json', dumps(shorten(c.output)), '```']
    return '\n'.join(lines) + '\n'


# ==============================================================
# 完整實測流程
# ==============================================================
TEST_STATION = {
    'sno': '900000001', 'name': '北商大測試站', 'area': '中正區', 'address': '濟南路一段321號',
    'lat': 25.0421, 'lng': 121.5256, 'total': 20, 'available_rent': 5, 'available_return': 15,
}


def run_demo(client: YouBikeClient):
    sno = TEST_STATION['sno']
    # 前一次中斷可能留下測試站，先清掉 (不列入紀錄)
    client.delete_station(sno)
    client.history.clear()

    client.info(title='API 資訊')
    client.list_stations(title='查詢站點：大安區、可借 ≥ 5、依可借數遞減、取 3 筆',
                         area='大安區', min_rent=5, sort='-available_rent', limit=3)
    client.list_stations(title='關鍵字搜尋：「捷運」、第 2 頁（每頁 2 筆）', q='捷運', limit=2, offset=2)
    first = client.history[-1].output['items'][0]['sno'] if client.history[-1].ok and client.history[-1].output['items'] else '500101001'
    client.get_station(first, title='查詢單一站點')
    client.nearby(25.0478, 121.5170, r=300, limit=3, need='rent', title='附近站點：臺北車站 300 m 內有車可借的站')
    client.areas(title='行政區列表')
    client.stats(low=1, title='統計（快沒車門檻 = 1）')

    client.create_station(TEST_STATION, title='Create：新增站點')
    client.get_station(sno, title='Read：確認新增結果')
    client.replace_station(sno, {**TEST_STATION, 'name': '北商大測試站（改）', 'total': 30,
                                 'available_rent': 10, 'available_return': 20}, title='Update：PUT 整筆改換')
    client.update_station(sno, {'available_rent': 3, 'available_return': 27}, title='Update：PATCH 部份更新')
    client.delete_station(sno, title='Delete：刪除站點')
    client.get_station(sno, title='Read：刪除後再查詢 → 404')

    client.create_station({'sno': '900000002', 'name': '缺欄位'}, title='錯誤處理：缺少必填欄位 → 400')
    client.create_station({**TEST_STATION, 'sno': first}, title='錯誤處理：站點編號重複 → 409')
    client.update_station(first, {'available_rent': 999}, title='錯誤處理：可借數超過總車格 → 400')
    client.nearby(0, 0, title='錯誤處理：座標超出範圍 → 400')
    client.sync_status(title='背景同步狀態')
    return client.history


# ==============================================================
# CLI
# ==============================================================
def parse_json(text):
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        sys.exit(f'JSON 格式錯誤：{exc}')
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description='YouBike 2.0 RESTful API Client')
    parser.add_argument('--base-url', default=DEFAULT_BASE_URL, help=f'API Server 位址 (預設 {DEFAULT_BASE_URL})')
    parser.add_argument('--full', action='store_true', help='完整輸出回應 (預設清單只列前 3 筆)')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('demo', help='跑完整實測流程')
    p.add_argument('--markdown', help='另存 Markdown 實測紀錄的路徑')

    sub.add_parser('info', help='GET /')
    p = sub.add_parser('list', help='GET /stations')
    p.add_argument('--area'); p.add_argument('--q'); p.add_argument('--min-rent', type=int); p.add_argument('--min-return', type=int)
    p.add_argument('--active', choices=['true', 'false']); p.add_argument('--sort'); p.add_argument('--limit', type=int); p.add_argument('--offset', type=int)
    p = sub.add_parser('get', help='GET /stations/<sno>'); p.add_argument('sno')
    p = sub.add_parser('create', help='POST /stations'); p.add_argument('json', help='站點 JSON')
    p = sub.add_parser('replace', help='PUT /stations/<sno>'); p.add_argument('sno'); p.add_argument('json')
    p = sub.add_parser('update', help='PATCH /stations/<sno>'); p.add_argument('sno'); p.add_argument('json')
    p = sub.add_parser('delete', help='DELETE /stations/<sno>'); p.add_argument('sno')
    p = sub.add_parser('nearby', help='GET /stations/nearby')
    p.add_argument('lat', type=float); p.add_argument('lng', type=float)
    p.add_argument('--r', type=int); p.add_argument('--limit', type=int); p.add_argument('--need', choices=['rent', 'return'])
    sub.add_parser('areas', help='GET /areas')
    p = sub.add_parser('stats', help='GET /stats'); p.add_argument('--low', type=int)
    sub.add_parser('sync-status', help='GET /sync/status')
    sub.add_parser('sync', help='POST /sync')
    args = parser.parse_args(argv)

    client = YouBikeClient(args.base_url)
    try:
        if args.cmd == 'demo':
            calls = run_demo(client)
            for c in calls:
                print_call(c, short=not args.full)
            passed = sum(1 for c in calls if c.ok)
            print(f'\n共 {len(calls)} 個請求：{passed} 個 2xx、{len(calls) - passed} 個預期中的錯誤回應')
            if args.markdown:
                with open(args.markdown, 'w', encoding='utf-8') as f:
                    f.write(to_markdown(calls, client.base_url))
                print(f'實測紀錄已寫入 {args.markdown}')
            return 0

        cmd = args.cmd
        if cmd == 'info':
            call = client.info()
        elif cmd == 'list':
            call = client.list_stations(area=args.area, q=args.q, min_rent=args.min_rent, min_return=args.min_return,
                                        active=args.active, sort=args.sort, limit=args.limit, offset=args.offset)
        elif cmd == 'get':
            call = client.get_station(args.sno)
        elif cmd == 'create':
            call = client.create_station(parse_json(args.json))
        elif cmd == 'replace':
            call = client.replace_station(args.sno, parse_json(args.json))
        elif cmd == 'update':
            call = client.update_station(args.sno, parse_json(args.json))
        elif cmd == 'delete':
            call = client.delete_station(args.sno)
        elif cmd == 'nearby':
            call = client.nearby(args.lat, args.lng, r=args.r, limit=args.limit, need=args.need)
        elif cmd == 'areas':
            call = client.areas()
        elif cmd == 'stats':
            call = client.stats(low=args.low)
        elif cmd == 'sync-status':
            call = client.sync_status()
        else:
            call = client.sync_now()
        print_call(call, short=not args.full)
        return 0 if call.ok else 1
    except requests.ConnectionError:
        print(f'無法連線到 {args.base_url}，請先執行 python rest_server.py', file=sys.stderr)
        return 2


if __name__ == '__main__':
    # Windows 終端機預設 cp950，強制 UTF-8 輸出避免中文亂碼
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
