/*
static-api.js ~ 展示模式（沒有 API Server 時使用）

GitHub Pages 只能放靜態檔案，跑不了 Flask。連不到 API Server 時，
地圖頁改讀 repo 裡的 Open Data 資料檔 data/youbike_stations.csv，
在瀏覽器端模擬地圖用到的唯讀端點：
  GET /stations?limit&offset   GET /stations/nearby   GET /stats   GET /sync/status
計算方式與 repository.py 相同。新增 / 修改 / 刪除仍需啟動 rest_server.py。
*/

const StaticApi = (() => {
  const CSV_URL = '../data/youbike_stations.csv';
  let cache = null;

  // 官方欄位 → API 欄位（同 youbike_source.normalize）
  function normalize(r) {
    let name = (r.sna || '').trim();
    if (name.startsWith('YouBike2.0_')) name = name.slice('YouBike2.0_'.length);
    const int = (v) => { const n = parseInt(parseFloat(v), 10); return Number.isFinite(n) ? n : 0; };
    return {
      sno: (r.sno || '').trim(), name, area: (r.sarea || '').trim(), address: (r.ar || '').trim(),
      lat: parseFloat(r.latitude) || 0, lng: parseFloat(r.longitude) || 0,
      total: int(r.Quantity), available_rent: int(r.available_rent_bikes), available_return: int(r.available_return_bikes),
      active: String(r.act || '1').trim() === '1', updated_at: (r.mday || '').trim(), source: 'official',
    };
  }

  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    const head = lines.shift().split(',');
    return lines.map((line) => {
      const cols = line.split(',');
      return Object.fromEntries(head.map((h, i) => [h, cols[i]]));
    }).filter((r) => r.sno).map(normalize);
  }

  async function load() {
    if (!cache) {
      cache = fetch(CSV_URL).then((res) => {
        if (!res.ok) throw new Error(`讀不到 ${CSV_URL}（HTTP ${res.status}）`);
        return res.text();
      }).then(parseCsv);
      cache.catch(() => { cache = null; });
    }
    return cache;
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000, r = (d) => (d * Math.PI) / 180;
    const h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function stats(items, low = 2) {
    const active = items.filter((s) => s.active);
    const byArea = {};
    for (const s of active) {
      const a = byArea[s.area] ||= { area: s.area, stations: 0, total: 0, available_rent: 0, available_return: 0 };
      a.stations++; a.total += s.total; a.available_rent += s.available_rent; a.available_return += s.available_return;
    }
    for (const a of Object.values(byArea)) a.rent_ratio = a.total ? Math.round((a.available_rent / a.total) * 1000) / 1000 : 0;
    const sum = (k) => active.reduce((n, s) => n + s[k], 0);
    const lowList = active.filter((s) => s.available_rent <= low);
    const full = active.filter((s) => s.available_return === 0);
    return {
      summary: {
        stations: items.length, active_stations: active.length, total_docks: sum('total'),
        available_rent: sum('available_rent'), available_return: sum('available_return'),
        low_bike_stations: lowList.length, full_stations: full.length,
      },
      by_area: Object.values(byArea).sort((a, b) => b.available_rent - a.available_rent),
      low_bike_threshold: low,
    };
  }

  async function handle(path) {
    const url = new URL(path, 'http://static/');
    const q = url.searchParams;
    const items = await load();
    switch (url.pathname) {
      case '/stations': {
        const limit = Number(q.get('limit') || 20), offset = Number(q.get('offset') || 0);
        const page = items.slice(offset, offset + limit);
        return { total: items.length, count: page.length, limit, offset, items: page };
      }
      case '/stations/nearby': {
        const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
        const radius = Number(q.get('r') || 500), limit = Number(q.get('limit') || 10), need = q.get('need');
        const out = [];
        for (const s of items) {
          if (!s.active) continue;
          if (need === 'rent' && s.available_rent <= 0) continue;
          if (need === 'return' && s.available_return <= 0) continue;
          const d = haversine(lat, lng, s.lat, s.lng);
          if (d <= radius) out.push({ ...s, distance_m: Math.round(d) });
        }
        out.sort((a, b) => a.distance_m - b.distance_m);
        return { center: { lat, lng }, radius_m: radius, need, count: Math.min(out.length, limit), items: out.slice(0, limit) };
      }
      case '/stats':
        return stats(items, Number(q.get('low') || 2));
      case '/sync/status': {
        const latest = items.reduce((m, s) => (s.updated_at > m ? s.updated_at : m), '');
        return { enabled: false, static: true, snapshot_time: latest };
      }
      default:
        throw new Error('展示模式不支援此操作，請啟動 rest_server.py');
    }
  }

  // 放在 GitHub Pages 且沒有指定 ?api= 時，直接用展示模式（https 頁面也連不到本機的 http API）
  const preferStatic = location.hostname.endsWith('github.io') && !new URLSearchParams(location.search).get('api');

  return { handle, preferStatic };
})();
