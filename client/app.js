/*
app.js ~ YouBike 2.0 RESTful API Client
  - callApi(): 共用的 fetch 包裝，統一處理錯誤、Console 輸出、網頁紀錄
  - 所有參數皆由網頁輸入欄位讀取
*/

const $ = (id) => document.getElementById(id);
const state = { offset: 0, total: 0, origSno: null, timer: null };

// ==============================================================
// 共用: API 呼叫
// ==============================================================
function apiUrl(path) {
  let host = $('host').value.trim() || 'http://localhost:5000/';
  if (!host.endsWith('/')) host += '/';
  return host + path;
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v !== null && v !== undefined) p.set(k, v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

/**
 * @param {string} method
 * @param {string} path       不含 host 的路徑
 * @param {object} [body]
 * @param {object} [opt]      { log: 是否寫入網頁紀錄 (預設 true) }
 */
async function callApi(method, path, body, { log = true } = {}) {
  const url = apiUrl(path);
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  let status = 0, data;
  try {
    const res = await fetch(url, options);
    status = res.status;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
  } catch (err) {
    data = { error: `無法連線到 Server：${err.message}（Server 有啟動嗎？Host 正確嗎？）` };
  }
  const ok = status >= 200 && status < 300;
  if (log) {
    console.log(`${method} ${url} [${status}]`, data);
    addLog({ method, url, body, status, data, ok });
  }
  return { ok, status, data };
}

// ==============================================================
// 共用: DOM 工具 (一律用 textContent，避免 XSS)
// ==============================================================
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function addLog({ method, url, body, status, data, ok, label }) {
  const box = $('log');
  box.querySelector('.empty')?.remove();
  const entry = el('div', `entry ${ok ? 'ok' : 'err'}`);
  const head = el('div', 'entry-head');
  head.append(
    el('span', `m ${method}`, method),
    el('span', 'url', url),
    el('span', 'status', label || (status ? `HTTP ${status}` : '連線失敗')),
    el('span', 'time', new Date().toLocaleTimeString()),
  );
  entry.append(head);
  if (body !== undefined) entry.append(el('pre', '', 'Request Body:\n' + JSON.stringify(body, null, 2)));
  entry.append(el('pre', '', 'Response:\n' + (typeof data === 'string' ? data : JSON.stringify(data, null, 2))));
  box.prepend(entry);
  while (box.children.length > 30) box.lastChild.remove();   // 最多保留 30 筆
}

function localError(message) {
  addLog({ method: '', url: '（未送出請求）', data: message, ok: false, label: '輸入錯誤' });
}

class InputError extends Error {}

// ==============================================================
// 即時概況: 統計 + 同步狀態
// ==============================================================
async function loadStats() {
  const { ok, data } = await callApi('GET', 'stats', undefined, { log: false });
  if (!ok) return;
  const s = data.summary;
  $('st-stations').textContent = s.active_stations.toLocaleString();
  $('st-rent').textContent = s.available_rent.toLocaleString();
  $('st-return').textContent = s.available_return.toLocaleString();
  $('st-low').textContent = s.low_bike_stations.toLocaleString();
  $('st-full').textContent = s.full_stations.toLocaleString();

  const max = Math.max(1, ...data.by_area.map(a => a.available_rent));
  $('area-bars').replaceChildren(...data.by_area.map(a => {
    const row = el('div', 'bar');
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = (a.available_rent / max * 100) + '%';
    track.append(fill);
    row.append(el('span', '', a.area), track,
      el('span', 'n', `${a.available_rent} 台 / ${a.stations} 站`));
    return row;
  }));
}

async function loadSyncStatus() {
  const badge = $('sync-badge');
  const { ok, data } = await callApi('GET', 'sync/status', undefined, { log: false });
  if (!ok) { badge.className = 'badge err'; badge.textContent = '無法連線到 Server'; return; }
  if (data.last_error) {
    badge.className = 'badge err';
    badge.textContent = `同步失敗：${data.last_error}`;
  } else if (data.last_success) {
    badge.className = 'badge ok';
    badge.textContent = `最後同步 ${data.last_success.slice(11)}（${data.enabled ? '每 ' + data.interval_sec + ' 秒' : '自動同步關閉'}）`;
  } else {
    badge.className = 'badge off';
    badge.textContent = data.enabled ? '等待第一次同步…' : '使用 CSV 資料（未啟動同步）';
  }
}

async function loadAreas() {
  const { ok, data } = await callApi('GET', 'areas', undefined, { log: false });
  if (!ok) return;
  const sel = $('q-area');
  const current = sel.value;
  sel.replaceChildren(el('option', '', '全部'));
  sel.firstChild.value = '';
  $('area-options').replaceChildren();
  for (const a of data) {
    const o = el('option', '', `${a.area}（${a.stations}）`);
    o.value = a.area;
    sel.append(o);
    const d = el('option'); d.value = a.area;
    $('area-options').append(d);
  }
  sel.value = current;
}

async function refreshAll() {
  await Promise.all([loadStats(), loadSyncStatus(), loadAreas(), loadStations({ log: false })]);
}

$('sync-button').addEventListener('click', async () => {
  const btn = $('sync-button');
  btn.disabled = true; btn.textContent = '同步中…';
  await callApi('POST', 'sync');
  btn.disabled = false; btn.textContent = '立即同步';
  refreshAll();
});

function setAutoRefresh(on) {
  clearInterval(state.timer);
  if (on) state.timer = setInterval(refreshAll, 60_000);
}
$('auto-refresh').addEventListener('change', e => setAutoRefresh(e.target.checked));

// ==============================================================
// 附近站點
// ==============================================================
$('preset').addEventListener('change', e => {
  if (!e.target.value) return;
  const [lat, lng] = e.target.value.split(',');
  $('lat').value = lat; $('lng').value = lng;
});
['lat', 'lng'].forEach(id => $(id).addEventListener('input', () => { $('preset').value = ''; }));

$('geo-button').addEventListener('click', () => {
  if (!navigator.geolocation) return localError('此瀏覽器不支援定位');
  navigator.geolocation.getCurrentPosition(
    pos => {
      $('lat').value = pos.coords.latitude.toFixed(5);
      $('lng').value = pos.coords.longitude.toFixed(5);
      $('preset').value = '';
      searchNearby();
    },
    err => localError(`定位失敗：${err.message}`),
    { timeout: 10000 },
  );
});

async function searchNearby() {
  const path = 'stations/nearby' + qs({
    lat: $('lat').value, lng: $('lng').value, r: $('radius').value, need: $('need').value, limit: 20,
  });
  const { ok, data } = await callApi('GET', path);
  const list = $('nearby-list');
  if (!ok) { list.replaceChildren(el('li', 'empty', data.message || '查詢失敗，請看下方紀錄')); return; }
  if (data.count === 0) { list.replaceChildren(el('li', 'empty', `半徑 ${data.radius_m} 公尺內沒有符合的站點`)); return; }
  list.replaceChildren(...data.items.map(s => {
    const li = el('li');
    const info = el('div');
    info.append(el('div', 'nm', s.name), el('div', 'addr', `${s.area}・${s.address}`));
    const pills = el('div', 'pills');
    pills.append(
      el('span', `pill ${s.available_rent ? 'rent' : 'zero'}`, `借 ${s.available_rent}`),
      el('span', `pill ${s.available_return ? 'ret' : 'zero'}`, `還 ${s.available_return}`),
    );
    li.append(el('span', 'dist', `${s.distance_m} m`), info, pills);
    li.addEventListener('click', () => fillForm(s));
    return li;
  }));
}
$('nearby-button').addEventListener('click', searchNearby);

// ==============================================================
// 站點列表 (篩選 / 排序 / 分頁)
// ==============================================================
async function loadStations({ log = true } = {}) {
  const limit = Number($('q-limit').value);
  const path = 'stations' + qs({
    area: $('q-area').value, q: $('q-kw').value.trim(), min_rent: $('q-min').value || 0,
    sort: $('q-sort').value, limit, offset: state.offset,
  });
  const { ok, data } = await callApi('GET', path, undefined, { log });
  const body = $('station-body');
  if (!ok) { body.replaceChildren(msgRow(data.message || '無法取得資料')); return; }

  state.total = data.total;
  $('list-info').textContent = `共 ${data.total} 站`;
  const page = Math.floor(state.offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(data.total / limit));
  $('page-info').textContent = `第 ${page} / ${pages} 頁`;
  $('prev-page').disabled = state.offset === 0;
  $('next-page').disabled = state.offset + limit >= data.total;

  if (data.count === 0) { body.replaceChildren(msgRow('沒有符合條件的站點')); return; }
  body.replaceChildren(...data.items.map(s => {
    const tr = el('tr', s.source === 'custom' ? 'custom' : '');
    tr.append(
      el('td', '', s.sno), el('td', '', s.name), el('td', '', s.area),
      el('td', `num ${s.available_rent ? '' : 'zero'}`, s.available_rent),
      el('td', `num ${s.available_return ? '' : 'zero'}`, s.available_return),
      el('td', 'num', s.total), el('td', 'muted', s.updated_at),
    );
    tr.addEventListener('click', () => fillForm(s));
    return tr;
  }));
}

function msgRow(text) {
  const tr = el('tr'); const td = el('td', 'empty', text); td.colSpan = 7; tr.append(td); return tr;
}

$('search-button').addEventListener('click', () => { state.offset = 0; loadStations(); });
$('q-kw').addEventListener('keydown', e => { if (e.key === 'Enter') { state.offset = 0; loadStations(); } });
['q-area', 'q-sort', 'q-limit'].forEach(id =>
  $(id).addEventListener('change', () => { state.offset = 0; loadStations(); }));
$('prev-page').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - Number($('q-limit').value)); loadStations();
});
$('next-page').addEventListener('click', () => {
  state.offset += Number($('q-limit').value); loadStations();
});

// ==============================================================
// 站點編輯 (CRUD)
// ==============================================================
const FORM = {
  sno: 'f-sno', name: 'f-name', area: 'f-area', address: 'f-address', lat: 'f-lat', lng: 'f-lng',
  total: 'f-total', available_rent: 'f-rent', available_return: 'f-return', active: 'f-active',
};
const NUM_INT = ['total', 'available_rent', 'available_return'];
const NUM_FLOAT = ['lat', 'lng'];

function fillForm(s) {
  for (const [field, id] of Object.entries(FORM)) $(id).value = String(s[field] ?? '');
  state.origSno = s.sno;
  $('orig-sno').textContent = s.sno;
}

$('clear-form').addEventListener('click', () => {
  for (const id of Object.values(FORM)) $(id).value = '';
  $('f-active').value = 'true';
  state.origSno = null;
  $('orig-sno').textContent = '（未選取）';
});

function readField(field) {
  const raw = $(FORM[field]).value.trim();
  if (raw === '') return undefined;
  if (field === 'active') return raw === 'true';
  if (NUM_INT.includes(field)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new InputError(`${field} 必須是 0 以上的整數`);
    return n;
  }
  if (NUM_FLOAT.includes(field)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new InputError(`${field} 必須是數字`);
    return n;
  }
  return raw;
}

function readAll({ partial = false } = {}) {
  const out = {};
  for (const field of Object.keys(FORM)) {
    if (partial && field === 'sno') continue;
    const v = readField(field);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

function requireSno() {
  const sno = $('f-sno').value.trim();
  if (!sno) throw new InputError('請輸入 sno 站點編號');
  return encodeURIComponent(sno);
}

const OPS = {
  get: () => callApi('GET', `stations/${requireSno()}`).then(r => { if (r.ok) fillForm(r.data); }),
  post: () => callApi('POST', 'stations', readAll()),
  put: () => {
    const target = state.origSno || $('f-sno').value.trim();
    if (!target) throw new InputError('請先從列表選取站點，或輸入 sno');
    return callApi('PUT', `stations/${encodeURIComponent(target)}`, readAll());
  },
  patch: () => {
    const target = state.origSno || $('f-sno').value.trim();
    if (!target) throw new InputError('請先從列表選取站點，或輸入 sno');
    return callApi('PATCH', `stations/${encodeURIComponent(target)}`, readAll({ partial: true }));
  },
  delete: () => callApi('DELETE', `stations/${requireSno()}`),
};

document.querySelectorAll('[data-op]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const op = btn.dataset.op;
    try {
      const result = await OPS[op]();
      if (op !== 'get' && result?.ok) {
        if (result.data?.data) fillForm(result.data.data);        // 用 Server 回傳的最新資料更新表單
        if (op === 'delete') $('clear-form').click();
        refreshAll();
      }
    } catch (err) {
      if (err instanceof InputError) localError(err.message); else throw err;
    }
  });
});

// ==============================================================
// 其他
// ==============================================================
$('clear-log').addEventListener('click', () => $('log').replaceChildren(el('p', 'empty', '尚無紀錄。')));
$('host').addEventListener('change', refreshAll);

refreshAll();
setAutoRefresh(true);
