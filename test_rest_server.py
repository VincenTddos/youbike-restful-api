'''
test_rest_server.py ~ 自動化測試 (執行: pytest -v)
使用 Flask test client 與假的資料來源，不需要網路，也不需要先啟動 Server。
'''
import pytest

from repository import DictStationRepository, haversine
from rest_server import create_app
from sync_service import SyncService
from youbike_source import SAMPLE_CSV, load_csv, save_csv

TAIPEI_MAIN = (25.0478, 121.5170)   # 臺北車站

NEW_STATION = {
    'sno': '900000001', 'name': '北商大測試站', 'area': '中正區', 'address': '濟南路一段321號',
    'lat': 25.0421, 'lng': 121.5256, 'total': 20, 'available_rent': 5, 'available_return': 15,
}


def fake_official(rows):
    '''產生官方格式的假資料。'''
    return lambda: [dict(r) for r in rows]


OFFICIAL_ROW = {
    'sno': '500101001', 'sna': 'YouBike2.0_捷運科技大樓站', 'sarea': '大安區', 'ar': '復興南路二段235號前',
    'latitude': 25.02605, 'longitude': 121.5436, 'Quantity': 28,
    'available_rent_bikes': 20, 'available_return_bikes': 8, 'act': '1', 'mday': '2026-09-24 12:00:00',
}


@pytest.fixture
def repo():
    return DictStationRepository(load_csv(SAMPLE_CSV))


@pytest.fixture
def client(repo):
    sync = SyncService(repo, fetcher=fake_official([OFFICIAL_ROW]))
    return create_app(repo, sync).test_client()


# ---------- CSV 匯入 ----------
def test_csv_loaded_and_normalized(repo):
    s = repo.get('500101001')
    assert s['name'] == '捷運科技大樓站'          # 已去掉 "YouBike2.0_" 前綴
    assert s['area'] == '大安區'
    assert isinstance(s['lat'], float) and isinstance(s['total'], int)
    assert s['active'] is True and s['source'] == 'official'


def test_csv_roundtrip(tmp_path, repo):
    path = tmp_path / 'out.csv'
    save_csv(repo.all(), str(path))
    assert load_csv(str(path)) == load_csv(SAMPLE_CSV)


# ---------- 距離計算 ----------
def test_haversine_known_distance():
    # 臺北車站 → 台北 101 約 5.3 km
    d = haversine(*TAIPEI_MAIN, 25.0339, 121.5645)
    assert 5000 < d < 5600


# ---------- 查詢 ----------
def test_list_default_pagination(client):
    r = client.get('/stations')
    body = r.get_json()
    assert r.status_code == 200
    assert body['count'] == 20 and body['total'] > 20


def test_filter_area_and_sort(client):
    body = client.get('/stations?area=中正區&sort=-available_rent&limit=200').get_json()
    rents = [s['available_rent'] for s in body['items']]
    assert all(s['area'] == '中正區' for s in body['items'])
    assert rents == sorted(rents, reverse=True)


def test_filter_keyword_and_min_rent(client):
    body = client.get('/stations?q=捷運&min_rent=5&limit=200').get_json()
    assert body['total'] > 0
    assert all('捷運' in s['name'] or '捷運' in s['address'] for s in body['items'])
    assert all(s['available_rent'] >= 5 for s in body['items'])


def test_pagination_offset(client):
    a = client.get('/stations?limit=5&offset=0').get_json()['items']
    b = client.get('/stations?limit=5&offset=5').get_json()['items']
    assert not {s['sno'] for s in a} & {s['sno'] for s in b}


@pytest.mark.parametrize('qs', ['sort=bad', 'limit=0', 'limit=999', 'min_rent=abc', 'active=maybe'])
def test_list_invalid_query(client, qs):
    assert client.get(f'/stations?{qs}').status_code == 400


def test_get_one_and_not_found(client):
    assert client.get('/stations/500101001').get_json()['sno'] == '500101001'
    assert client.get('/stations/000').status_code == 404


def test_areas(client):
    areas = client.get('/areas').get_json()
    assert {'area': '中正區', 'stations': 16} in areas


# ---------- 附近站點 ----------
def test_nearby_sorted_and_within_radius(client):
    body = client.get('/stations/nearby?lat=25.0478&lng=121.5170&r=500').get_json()
    dists = [s['distance_m'] for s in body['items']]
    assert body['count'] > 0
    assert dists == sorted(dists) and all(d <= 500 for d in dists)


def test_nearby_need_rent(client):
    items = client.get('/stations/nearby?lat=25.0478&lng=121.5170&r=1000&need=rent&limit=50') \
        .get_json()['items']
    assert all(s['available_rent'] > 0 for s in items)


@pytest.mark.parametrize('qs', ['lng=121.5', 'lat=25&lng=121.5&r=10', 'lat=99&lng=121.5',
                                'lat=25&lng=121.5&need=fly'])
def test_nearby_invalid(client, qs):
    assert client.get(f'/stations/nearby?{qs}').status_code == 400


# ---------- 統計 ----------
def test_stats(client):
    body = client.get('/stats').get_json()
    summary = body['summary']
    assert summary['active_stations'] == summary['stations']
    assert summary['available_rent'] == sum(a['available_rent'] for a in body['by_area'])
    assert all(s['available_rent'] <= 2 for s in body['low_bike'])
    assert all(s['available_return'] == 0 for s in body['full'])


# ---------- CRUD ----------
def test_create_and_conflict(client):
    r = client.post('/stations', json=NEW_STATION)
    assert r.status_code == 201 and r.get_json()['data']['source'] == 'custom'
    assert client.post('/stations', json=NEW_STATION).status_code == 409


@pytest.mark.parametrize('patch', [
    {'lat': 40.0},                  # 超出臺灣範圍
    {'total': -1},
    {'available_rent': 99},         # 超過 total
    {'name': ''},
    {'active': 'yes'},
])
def test_create_invalid(client, patch):
    assert client.post('/stations', json={**NEW_STATION, **patch}).status_code == 400


def test_create_missing_fields(client):
    r = client.post('/stations', json={'sno': '1'})
    assert r.status_code == 400 and 'missing' in r.get_json()['message']


def test_replace_and_rename(client):
    body = {**NEW_STATION, 'sno': '900000002', 'name': '改名站'}
    r = client.put('/stations/500101001', json=body)
    assert r.status_code == 200
    assert client.get('/stations/500101001').status_code == 404
    assert client.get('/stations/900000002').get_json()['name'] == '改名站'


def test_replace_rename_conflict(client):
    body = {**NEW_STATION, 'sno': '500101002'}
    assert client.put('/stations/500101001', json=body).status_code == 409


def test_patch(client):
    r = client.patch('/stations/500101001', json={'available_rent': 10, 'available_return': 18})
    assert r.status_code == 200
    assert client.get('/stations/500101001').get_json()['available_rent'] == 10


@pytest.mark.parametrize('body', [{'sno': 'x'}, {'foo': 1}, {}, {'available_rent': 999}])
def test_patch_invalid(client, body):
    assert client.patch('/stations/500101001', json=body).status_code == 400


def test_delete(client):
    assert client.delete('/stations/500101001').status_code == 200
    assert client.delete('/stations/500101001').status_code == 404


# ---------- 同步 ----------
def test_sync_updates_official(client):
    r = client.post('/sync')
    assert r.status_code == 200 and r.get_json()['data']['updated'] == 1
    assert client.get('/stations/500101001').get_json()['available_rent'] == 20
    status = client.get('/sync/status').get_json()
    assert status['success_count'] == 1 and status['last_error'] is None


def test_sync_does_not_overwrite_custom(repo):
    repo.create({**NEW_STATION, 'active': True})
    row = {**OFFICIAL_ROW, 'sno': NEW_STATION['sno'], 'available_rent_bikes': 0}
    result = SyncService(repo, fetcher=fake_official([row])).run_once()
    assert result['skipped_custom'] == 1
    assert repo.get(NEW_STATION['sno'])['available_rent'] == 5


def test_sync_inserts_new_station(repo):
    row = {**OFFICIAL_ROW, 'sno': '599999999'}
    SyncService(repo, fetcher=fake_official([row])).run_once()
    assert repo.get('599999999')['name'] == '捷運科技大樓站'


def test_sync_failure_reported(repo):
    def broken():
        raise ConnectionError('network down')
    app = create_app(repo, SyncService(repo, fetcher=broken)).test_client()
    assert app.post('/sync').status_code == 502
    assert 'network down' in app.get('/sync/status').get_json()['last_error']


def test_sync_writes_snapshot(tmp_path, repo):
    path = tmp_path / 'snap.csv'
    SyncService(repo, fetcher=fake_official([OFFICIAL_ROW]), snapshot_path=str(path)).run_once()
    assert len(load_csv(str(path))) == repo.count()


# ---------- 其他 ----------
def test_json_errors(client):
    assert client.get('/nope').is_json
    assert client.put('/stations').status_code == 405
    r = client.post('/stations', data='x', content_type='text/plain')
    assert r.status_code == 400 and r.is_json


# ---------- API 文件 (Swagger UI / OpenAPI) ----------
def test_swagger_ui_served(client):
    r = client.get('/docs')
    assert r.status_code == 200 and b'swagger-ui' in r.data
    r = client.get('/openapi.yaml')
    assert r.status_code == 200 and b'openapi: 3.0' in r.data


def test_openapi_covers_all_routes(client):
    '''OpenAPI 規格必須涵蓋 Server 上每一條 API 路由 (含 Method)。'''
    import yaml
    spec = yaml.safe_load(client.get('/openapi.yaml').data)
    documented = {(path, m.upper()) for path, ops in spec['paths'].items()
                  for m in ops if m in ('get', 'post', 'put', 'patch', 'delete')}
    app = client.application
    actual = set()
    for rule in app.url_map.iter_rules():
        if rule.endpoint in ('static', 'swagger_ui', 'openapi_spec'):
            continue
        path = rule.rule.replace('<', '{').replace('>', '}')
        actual |= {(path, m) for m in rule.methods - {'HEAD', 'OPTIONS'}}
    assert actual == documented


# ---------- Python API Client (透過真正的 HTTP) ----------
@pytest.fixture
def live_server(repo):
    import threading
    from werkzeug.serving import make_server
    app = create_app(repo, SyncService(repo, fetcher=fake_official([OFFICIAL_ROW])))
    server = make_server('127.0.0.1', 0, app)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}'
    server.shutdown()


def test_api_client_crud(live_server):
    from api_client import TEST_STATION, YouBikeClient
    c = YouBikeClient(live_server)
    sno = TEST_STATION['sno']
    assert c.create_station(TEST_STATION).status == 201
    assert c.get_station(sno).output['name'] == TEST_STATION['name']
    assert c.update_station(sno, {'available_rent': 1}).output['data']['available_rent'] == 1
    assert c.replace_station(sno, {**TEST_STATION, 'name': 'X'}).output['data']['name'] == 'X'
    assert c.delete_station(sno).status == 200
    assert c.get_station(sno).status == 404


def test_api_client_demo_and_markdown(live_server):
    from api_client import YouBikeClient, run_demo, to_markdown
    calls = run_demo(YouBikeClient(live_server))
    expected = [200, 200, 200, 200, 200, 200, 200, 201, 200, 200, 200, 200, 404, 400, 409, 400, 400, 200]
    assert [c.status for c in calls] == expected
    md = to_markdown(calls, live_server)
    assert md.count('## ') == len(calls) and '`POST`' in md
