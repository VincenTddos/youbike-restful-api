/*
map2d.js ~ YouBike 2.0 即時地圖
  - 啟動時分頁抓取全部站點 (/stations，每頁 200)，之後每 60 秒自動刷新
  - 模式: rent (借車，看可借車輛) / return (還車，看可還空位)
  - 附近站點使用 /stations/nearby；導航交給 Google Maps
  - 所有文字一律用 textContent 寫入，避免 XSS
*/

const $ = (id) => document.getElementById(id);
const REFRESH_SEC = 60;
const TAIPEI = [25.0478, 121.5319];

const state = {
  stations: [],          // 全部站點
  bySno: new Map(),
  markers: new Map(),    // sno -> L.marker
  mode: 'rent',
  area: '',
  keyword: '',
  onlyAvailable: false,
  selected: null,        // sno
  origin: null,          // { lat, lng, label } 附近搜尋中心
  me: null,              // 使用者位置
  stats: null,
  countdown: REFRESH_SEC,
  picking: false,
};

// ==============================================================
// API
// ==============================================================
function defaultHost() {
  const fromUrl = new URLSearchParams(location.search).get('api');
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem('yb-host') || 'http://localhost:5000/'; } catch { return 'http://localhost:5000/'; }
}
let HOST = defaultHost();

// 展示模式：連不到 API Server（或放在 GitHub Pages 上）時，改讀 repo 裡的 Open Data 資料檔，見 static-api.js
const HAS_STATIC = typeof StaticApi !== 'undefined';
let STATIC = HAS_STATIC && StaticApi.preferStatic;

async function api(path) {
  if (STATIC) return StaticApi.handle('/' + path);
  let host = HOST.trim();
  if (!host.endsWith('/')) host += '/';
  let res;
  try {
    res = await fetch(host + path);
  } catch (err) {
    if (!HAS_STATIC) throw err;
    STATIC = true;
    return StaticApi.handle('/' + path);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

async function fetchAllStations() {
  const PAGE = 200;
  const first = await api(`stations?limit=${PAGE}&offset=0`);
  const pages = [];
  for (let off = PAGE; off < first.total; off += PAGE) pages.push(api(`stations?limit=${PAGE}&offset=${off}`));
  const rest = await Promise.all(pages);
  return first.items.concat(...rest.map((r) => r.items));
}

// ==============================================================
// 工具
// ==============================================================
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const fmt = (n) => Number(n || 0).toLocaleString('zh-TW');
const valueOf = (s, mode = state.mode) => (mode === 'rent' ? s.available_rent : s.available_return);

function level(s) {
  if (!s.active) return 'off';
  const n = valueOf(s);
  if (n <= 0) return 'empty';
  if (n < 5) return 'low';
  return 'ok';
}
const LEVEL_COLOR = { ok: '#22c55e', low: '#f5a524', empty: '#ef4444', off: '#6b7280' };

function distance(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const walkMin = (m) => Math.max(1, Math.round(m / 75)); // 步行約 75 m/min

function toast(msg, isErr = false, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function gmapsNav(s) {
  const p = new URLSearchParams({ api: '1', destination: `${s.lat},${s.lng}`, travelmode: 'walking' });
  if (state.me) p.set('origin', `${state.me.lat},${state.me.lng}`);
  return `https://www.google.com/maps/dir/?${p}`;
}
const gmapsView = (s) => `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;

// ==============================================================
// 地圖
// ==============================================================
const map = L.map('map', { zoomControl: false, maxZoom: 19, minZoom: 11 }).setView(TAIPEI, 13);
// Esri 免費底圖（免 API Key；CARTO 已改為需要 Key）
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors';
const TILES = {
  dark: [
    L.tileLayer(ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 16, attribution: ESRI_ATTR }),
    L.tileLayer(ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 16 }),
  ],
  light: [
    L.tileLayer(ESRI + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: ESRI_ATTR }),
  ],
};

const cluster = L.markerClusterGroup({
  chunkedLoading: true,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  disableClusteringAtZoom: 16,
  maxClusterRadius: 55,
  iconCreateFunction(c) {
    const children = c.getAllChildMarkers();
    let sum = 0, cap = 0;
    for (const m of children) {
      const s = state.bySno.get(m.options.sno);
      if (!s || !s.active) continue;
      sum += valueOf(s);
      cap += s.total;
    }
    const ratio = cap ? sum / cap : 0;
    const c1 = ratio >= 0.3 ? LEVEL_COLOR.ok : ratio >= 0.12 ? LEVEL_COLOR.low : LEVEL_COLOR.empty;
    const size = Math.min(70, 38 + Math.sqrt(children.length) * 3);
    const html = `<div class="cluster" style="--c:${c1}">${sum}<small>${children.length} 站</small></div>`;
    return L.divIcon({ html, className: 'cluster-wrap', iconSize: [size, size] });
  },
});
map.addLayer(cluster);

const overlay = L.layerGroup().addTo(map); // 附近搜尋圈 + 中心點
let meMarker = null;

function pinIcon(s) {
  const n = s.active ? valueOf(s) : '–';
  const pct = s.total ? Math.round((valueOf(s) / s.total) * 100) : 0;
  const sel = state.selected === s.sno ? ' sel' : '';
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin lv-${level(s)}${sel}" style="--p:${pct}"><b>${n}</b></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function matchesFilter(s) {
  if (state.area && s.area !== state.area) return false;
  if (state.onlyAvailable && (!s.active || valueOf(s) <= 0)) return false;
  if (state.keyword) {
    const k = state.keyword.toLowerCase();
    if (!s.name.toLowerCase().includes(k) && !(s.address || '').toLowerCase().includes(k)) return false;
  }
  return true;
}

function renderMarkers() {
  cluster.clearLayers();
  const list = [];
  for (const s of state.stations) {
    if (!matchesFilter(s)) continue;
    let m = state.markers.get(s.sno);
    if (!m) {
      m = L.marker([s.lat, s.lng], { sno: s.sno, icon: pinIcon(s), title: s.name, riseOnHover: true });
      m.on('click', () => selectStation(s.sno, { fly: false }));
      state.markers.set(s.sno, m);
    } else {
      m.setLatLng([s.lat, s.lng]);
      m.setIcon(pinIcon(s));
    }
    list.push(m);
  }
  cluster.addLayers(list);
}

// ==============================================================
// 載入 / 刷新
// ==============================================================
async function loadAll({ silent = false } = {}) {
  const btn = $('ctl-refresh');
  btn.classList.add('spin');
  try {
    const [stations, stats, sync] = await Promise.all([
      fetchAllStations(),
      api('stats'),
      api('sync/status').catch(() => null),
    ]);
    const firstLoad = state.stations.length === 0;
    state.stations = stations;
    state.bySno = new Map(stations.map((s) => [s.sno, s]));
    // 移除已刪除站點的 marker
    for (const sno of [...state.markers.keys()]) if (!state.bySno.has(sno)) state.markers.delete(sno);
    state.stats = stats;

    renderMarkers();
    renderKpis();
    renderAreas();
    if (firstLoad) fillAreaSelect();
    if (state.selected) {
      if (state.bySno.has(state.selected)) showDetail(state.bySno.get(state.selected));
      else closeDetail();
    }
    if (state.origin) searchNearby(state.origin, { quiet: true, fit: false });
    setLive(true, sync);
    if (!silent) toast(`已載入 ${fmt(stations.length)} 個站點`);
    // 深層連結: map.html?sno=500101001 直接開啟該站
    const deep = new URLSearchParams(location.search).get('sno');
    if (firstLoad && deep && state.bySno.has(deep)) selectStation(deep);
  } catch (err) {
    setLive(false);
    toast(`無法連線到 API（${HOST}）：${err.message}。請確認 Server 已啟動，或在「設定」修改 API Host。`, true, 6000);
  } finally {
    btn.classList.remove('spin');
    state.countdown = REFRESH_SEC;
  }
}

function setLive(ok, sync) {
  const dot = $('live-dot');
  dot.className = 'dot ' + (ok ? 'on' : 'err');
  if (!ok) { $('live-text').textContent = '離線：無法連線到 API'; return; }
  if (sync && sync.static) {
    dot.className = 'dot demo';
    $('live-text').textContent = `展示模式・Open Data 快照 ${(sync.snapshot_time || '').slice(0, 16)}`;
    if (!setLive.noted) { setLive.noted = true; toast('目前為展示模式：顯示 repo 內的 Open Data 快照（唯讀）。即時資料與 CRUD 請啟動 rest_server.py', false, 6500); }
    return;
  }
  const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  let text = `即時資料・更新於 ${t}`;
  if (sync && !sync.enabled) text += '（未啟用同步）';
  $('live-text').textContent = text;
}

// ==============================================================
// KPI / 行政區
// ==============================================================
function animateNumber(node, to) {
  const from = Number(node.dataset.v || 0);
  node.dataset.v = to;
  const start = performance.now(), dur = 700;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur), e = 1 - (1 - p) ** 3;
    node.textContent = fmt(Math.round(from + (to - from) * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderKpis() {
  const s = state.stats?.summary;
  if (!s) return;
  const rent = state.mode === 'rent';
  const main = rent ? s.available_rent : s.available_return;
  $('kpi-main-label').textContent = rent ? '全市可借車輛' : '全市可還空位';
  animateNumber($('kpi-main'), main);
  const pct = s.total_docks ? (main / s.total_docks) * 100 : 0;
  $('kpi-bar').style.width = pct.toFixed(1) + '%';
  $('kpi-main-sub').textContent = `佔 ${fmt(s.total_docks)} 個車格的 ${pct.toFixed(1)}%`;
  animateNumber($('kpi-stations'), s.active_stations);
  animateNumber($('kpi-low'), s.low_bike_stations);
  animateNumber($('kpi-full'), s.full_stations);
}

function renderAreas() {
  const rows = (state.stats?.by_area || []).map((a) => {
    const v = state.mode === 'rent' ? a.available_rent : a.available_return;
    return { ...a, v, ratio: a.total ? v / a.total : 0 };
  }).sort((a, b) => b.ratio - a.ratio);
  $('area-hint').textContent = `長條 = ${state.mode === 'rent' ? '可借車輛' : '可還空位'}佔總車格比例，點一下可聚焦該區。`;
  const list = $('area-list');
  list.replaceChildren();
  for (const a of rows) {
    const li = el('li', state.area === a.area ? 'sel' : '');
    const bar = el('div', 'ab'); const i = el('i'); i.style.width = (a.ratio * 100).toFixed(1) + '%'; bar.append(i);
    const av = el('div', 'av', fmt(a.v)); av.append(el('small', '', `${Math.round(a.ratio * 100)}%`));
    li.append(el('span', 'an', a.area), bar, av);
    li.title = `${a.area}：${a.stations} 站、${fmt(a.total)} 車格`;
    li.addEventListener('click', () => setArea(state.area === a.area ? '' : a.area, true));
    list.append(li);
  }
}

function fillAreaSelect() {
  const sel = $('area');
  const areas = [...new Set(state.stations.map((s) => s.area))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  for (const a of areas) sel.append(new Option(a, a));
}

function setArea(area, fit = false) {
  state.area = area;
  $('area').value = area;
  renderMarkers();
  renderAreas();
  if (fit) {
    const pts = state.stations.filter((s) => !area || s.area === area).map((s) => [s.lat, s.lng]);
    if (pts.length) map.flyToBounds(pts, { padding: [40, 40], paddingTopLeft: panelPad(), duration: 0.8 });
  }
}

// 桌機版左側面板會蓋住地圖，定位時要把它讓開
function panelPad() {
  return window.innerWidth > 760 ? [420, 40] : [20, 20];
}

// ==============================================================
// 站點詳情
// ==============================================================
function selectStation(sno, { fly = true } = {}) {
  const prev = state.selected;
  state.selected = sno;
  for (const id of [prev, sno]) {
    const s = state.bySno.get(id), m = state.markers.get(id);
    if (s && m) m.setIcon(pinIcon(s));
  }
  const s = state.bySno.get(sno);
  if (!s) return;
  showDetail(s);
  if (fly) {
    const m = state.markers.get(sno);
    if (m && cluster.hasLayer(m)) {
      cluster.zoomToShowLayer(m, () => centerOn(s));
    } else {
      centerOn(s, 17);
    }
  }
}

function centerOn(s, zoom) {
  const z = Math.max(zoom || map.getZoom(), 16);
  // 讓站點落在面板右側可視區的中上方
  const pt = map.project([s.lat, s.lng], z);
  const offX = window.innerWidth > 760 ? -198 : 0;
  const offY = window.innerWidth > 760 ? 90 : 120;
  map.flyTo(map.unproject(pt.add([offX, offY]), z), z, { duration: 0.7 });
}

function showDetail(s) {
  $('detail').hidden = false;
  $('d-area').textContent = s.area;
  const st = $('d-state');
  st.textContent = s.active ? '營運中' : '暫停營運';
  st.className = 'd-state ' + (s.active ? 'ok' : 'off');
  $('d-name').textContent = s.name.replace(/^YouBike2\.0_/, '');
  $('d-addr').textContent = s.address || '';
  $('d-rent').textContent = s.available_rent;
  $('d-return').textContent = s.available_return;
  const total = s.total || s.available_rent + s.available_return || 1;
  const main = valueOf(s);
  const pct = Math.round((main / total) * 100);
  $('d-pct').textContent = pct + '%';
  const g = $('d-gauge');
  g.style.stroke = state.mode === 'rent' ? 'var(--brand)' : 'var(--ret)';
  g.style.strokeDashoffset = (100.5 * (1 - main / total)).toFixed(1);
  $('d-bar-rent').style.width = (s.available_rent / total) * 100 + '%';
  $('d-bar-ret').style.width = (s.available_return / total) * 100 + '%';
  const parts = [`總車格 ${s.total}`, `更新 ${s.updated_at || '–'}`];
  const ref = state.me || state.origin;
  if (ref) {
    const d = distance(ref, s);
    parts.unshift(`${state.me ? '距離你' : '距離選點'} ${fmtDist(d)}・步行約 ${walkMin(d)} 分`);
  }
  if (s.source && s.source !== 'official') parts.push('自建站點');
  $('d-meta').textContent = parts.join('　·　');
  $('d-nav').href = gmapsNav(s);
  $('d-gmap').href = gmapsView(s);
}

function closeDetail() {
  const prev = state.selected;
  state.selected = null;
  $('detail').hidden = true;
  const s = state.bySno.get(prev), m = state.markers.get(prev);
  if (s && m) m.setIcon(pinIcon(s));
}

// ==============================================================
// 附近站點
// ==============================================================
async function searchNearby(origin, { quiet = false, fit = true } = {}) {
  state.origin = origin;
  const r = Number($('radius').value);
  overlay.clearLayers();
  L.circle([origin.lat, origin.lng], {
    radius: r, color: state.mode === 'rent' ? '#ffb400' : '#38bdf8', weight: 1.5, fillOpacity: 0.07, dashArray: '6 6',
  }).addTo(overlay);
  if (origin.label !== 'me') {
    L.marker([origin.lat, origin.lng], { icon: L.divIcon({ className: 'pin-wrap', html: '<div class="pick-dot"></div>', iconSize: [16, 16] }) }).addTo(overlay);
  }
  if (fit) {
    map.flyToBounds(L.latLng(origin.lat, origin.lng).toBounds(r * 2.2), { paddingTopLeft: panelPad(), duration: 0.8 });
  }
  const list = $('nearby-list');
  if (!quiet) list.replaceChildren(el('li', 'empty', '搜尋中…'));
  try {
    const qs = new URLSearchParams({ lat: origin.lat.toFixed(6), lng: origin.lng.toFixed(6), r, limit: 20, need: state.mode });
    const data = await api(`stations/nearby?${qs}`);
    renderNearby(data.items);
  } catch (err) {
    list.replaceChildren(el('li', 'empty', `查詢失敗：${err.message}`));
  }
}

function renderNearby(items) {
  const list = $('nearby-list');
  list.replaceChildren();
  if (!items.length) {
    list.append(el('li', 'empty', `半徑內沒有${state.mode === 'rent' ? '可借車' : '可還車'}的站點，\n試著把半徑拉大。`));
    return;
  }
  const rent = state.mode === 'rent';
  for (const it of items) {
    const s = state.bySno.get(it.sno) || it;
    const li = el('li', 'st');
    const badge = el('span', 'badge', valueOf(s));
    badge.style.background = LEVEL_COLOR[level(s)];
    const mid = el('div');
    mid.style.minWidth = '0';
    mid.append(
      el('div', 'nm', s.name.replace(/^YouBike2\.0_/, '')),
      el('div', 'sub', `${rent ? '可借' : '可還'} ${valueOf(s)}・${rent ? '可還' : '可借'} ${rent ? s.available_return : s.available_rent}・${s.area}`),
    );
    const dist = el('div', 'dist');
    dist.append(el('b', '', fmtDist(it.distance_m)), document.createTextNode(`步行 ${walkMin(it.distance_m)} 分`));
    li.append(badge, mid, dist);
    li.addEventListener('click', () => { selectStation(s.sno); collapseSheet(); });
    list.append(li);
  }
}

function locateMe() {
  if (!navigator.geolocation) { toast('此瀏覽器不支援定位', true); return; }
  toast('定位中…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const me = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'me' };
      state.me = me;
      if (meMarker) meMarker.remove();
      meMarker = L.marker([me.lat, me.lng], {
        icon: L.divIcon({ className: 'pin-wrap', html: '<div class="me-dot"></div>', iconSize: [18, 18] }),
        zIndexOffset: 2000,
      }).addTo(map).bindTooltip('你在這裡');
      const inTaipei = me.lat > 24.9 && me.lat < 25.25 && me.lng > 121.4 && me.lng < 121.7;
      if (!inTaipei) toast('你目前不在臺北市範圍，附近可能沒有站點', true, 4000);
      switchTab('nearby');
      searchNearby(me);
    },
    (err) => toast(`無法取得位置：${err.message}（可改用「在地圖上選點」）`, true, 4500),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}

function setPicking(on) {
  state.picking = on;
  document.body.classList.toggle('picking', on);
  $('pick-banner').hidden = !on;
  $('btn-pick').classList.toggle('on', on);
  if (on) collapseSheet();
}

// ==============================================================
// 搜尋框
// ==============================================================
let hl = -1;
function renderSearchResults() {
  const box = $('search-results');
  const k = state.keyword.toLowerCase();
  box.replaceChildren();
  hl = -1;
  if (!k) { box.hidden = true; return; }
  const hits = state.stations.filter((s) => s.name.toLowerCase().includes(k) || (s.address || '').toLowerCase().includes(k)).slice(0, 8);
  if (!hits.length) box.append(el('li', 'empty', '找不到符合的站點'));
  for (const s of hits) {
    const li = el('li');
    const left = el('div');
    left.append(el('span', '', s.name.replace(/^YouBike2\.0_/, '')), el('small', '', `${s.area}・${s.address || ''}`));
    const b = el('b', '', valueOf(s));
    b.style.color = LEVEL_COLOR[level(s)];
    li.append(left, b);
    li.dataset.sno = s.sno;
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pickResult(s.sno); });
    box.append(li);
  }
  box.hidden = false;
}

function pickResult(sno) {
  $('search-results').hidden = true;
  $('search').blur();
  selectStation(sno);
  collapseSheet();
}

// ==============================================================
// 模式 / 主題 / 分頁 / 行動版面板
// ==============================================================
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-rent', mode === 'rent');
  document.body.classList.toggle('mode-return', mode === 'return');
  document.querySelectorAll('.seg').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  $('legend-title').textContent = mode === 'rent' ? '可借車輛' : '可還空位';
  $('only-label').textContent = mode === 'rent' ? '只看有車' : '只看有位';
  renderMarkers();
  cluster.refreshClusters();
  renderKpis();
  renderAreas();
  if (state.selected) showDetail(state.bySno.get(state.selected));
  if (state.origin) searchNearby(state.origin, { fit: false });
  if (state.keyword) renderSearchResults();
}

function setTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  for (const [name, layers] of Object.entries(TILES)) {
    for (const l of layers) {
      if (name === theme) l.addTo(map); else l.remove();
    }
  }
  try { localStorage.setItem('yb-theme', theme); } catch { /* 無痕模式 */ }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-nearby').hidden = name !== 'nearby';
  $('tab-areas').hidden = name !== 'areas';
}

const isMobile = () => window.innerWidth <= 760;
function collapseSheet() { if (isMobile()) $('panel').classList.add('collapsed'); }

// ==============================================================
// 事件綁定
// ==============================================================
document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

$('area').addEventListener('change', (e) => setArea(e.target.value, true));
$('only-available').addEventListener('change', (e) => { state.onlyAvailable = e.target.checked; renderMarkers(); });

let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.keyword = e.target.value.trim();
    renderSearchResults();
    renderMarkers();
  }, 150);
});
$('search').addEventListener('keydown', (e) => {
  const items = [...$('search-results').querySelectorAll('li[data-sno]')];
  if (!items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle('hl', i === hl));
  } else if (e.key === 'Enter') {
    pickResult(items[Math.max(0, hl)].dataset.sno);
  } else if (e.key === 'Escape') {
    $('search-results').hidden = true;
  }
});
$('search').addEventListener('focus', () => { if (state.keyword) renderSearchResults(); if (isMobile()) $('panel').classList.remove('collapsed'); });
$('search').addEventListener('blur', () => { $('search-results').hidden = true; });

$('radius').addEventListener('input', (e) => { $('radius-val').textContent = `${e.target.value} m`; });
$('radius').addEventListener('change', () => { if (state.origin) searchNearby(state.origin); });

$('btn-locate').addEventListener('click', locateMe);
$('ctl-locate').addEventListener('click', locateMe);
$('btn-pick').addEventListener('click', () => setPicking(!state.picking));
$('pick-cancel').addEventListener('click', () => setPicking(false));
map.on('click', (e) => {
  if (!state.picking) return;
  setPicking(false);
  switchTab('nearby');
  if (isMobile()) $('panel').classList.remove('collapsed');
  searchNearby({ lat: e.latlng.lat, lng: e.latlng.lng, label: 'pick' });
});

$('ctl-refresh').addEventListener('click', () => loadAll());
$('ctl-theme').addEventListener('click', () => setTheme(document.body.classList.contains('light') ? 'dark' : 'light'));

$('detail-close').addEventListener('click', closeDetail);
$('d-near').addEventListener('click', () => {
  const s = state.bySno.get(state.selected);
  if (!s) return;
  switchTab('nearby');
  if (isMobile()) $('panel').classList.remove('collapsed');
  searchNearby({ lat: s.lat, lng: s.lng, label: 'station' });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (state.picking) setPicking(false); else closeDetail(); }
});

$('sheet-handle').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

$('host').value = HOST;
$('host-save').addEventListener('click', () => {
  STATIC = false;
  HOST = $('host').value.trim() || 'http://localhost:5000/';
  try { localStorage.setItem('yb-host', HOST); } catch { /* 無痕模式 */ }
  state.stations = [];
  state.markers.clear();
  $('area').length = 1;
  loadAll();
});

// 倒數計時環 + 自動刷新
setInterval(() => {
  if (document.hidden) return;
  state.countdown -= 1;
  $('countdown').style.strokeDashoffset = (100.5 * (1 - state.countdown / REFRESH_SEC)).toFixed(1);
  if (state.countdown <= 0) loadAll({ silent: true });
}, 1000);

// ==============================================================
// 啟動
// ==============================================================
(function init() {
  let theme = null;
  try { theme = localStorage.getItem('yb-theme'); } catch { /* 無痕模式 */ }
  if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  setTheme(theme);
  document.body.classList.add('mode-rent');
  if (isMobile()) $('panel').classList.add('collapsed');
  loadAll();
})();

// 切換到 3D 視圖時帶上目前的 API Host
$('to-3d').addEventListener('click', (e) => { e.preventDefault(); location.href = 'map.html?api=' + encodeURIComponent(HOST); });
