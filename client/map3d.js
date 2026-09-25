/*
map3d.js ~ YouBike 2.0 3D 城市視圖
  - three.js 以 dynamic import + importmap 載入（一般 script，直接雙擊 html 用 file:// 開也能跑）
  - 座標：Web Mercator zoom 14 的像素座標（1 單位 ≈ 8.6 m），地面圖磚可以精準對齊
  - 每站一根 InstancedMesh 六角柱：高度 = 可借車輛 / 可還空位，顏色 = 充足/偏少/沒有/暫停
  - 沒車（或沒位）的站在地面打紅色脈衝；UnrealBloom 讓柱頂發光
  - 所有文字一律用 textContent 寫入，避免 XSS
*/

const $ = (id) => document.getElementById(id);
const REFRESH_SEC = 60;
const Z = 14, TILE = 256, WORLD = TILE * 2 ** Z;
const CENTER = { lat: 25.055, lng: 121.555 };
const BBOX = { s: 24.955, n: 25.215, w: 121.455, e: 121.675 }; // 臺北市範圍（地面圖磚）
const H_PER = 1.9, H_MIN = 1.4, RADIUS = 2.5;
const HOME = { radius: 1650, phi: 0.98, theta: -0.32 };
const PALETTE = {
  rent: { ok: '#2ee07a', low: '#ffb020', empty: '#ff3b5c', off: '#3a4458' },
  return: { ok: '#33c7ff', low: '#ffb020', empty: '#ff3b5c', off: '#3a4458' },
};

const state = {
  stations: [], bySno: new Map(), idx: new Map(),
  mode: 'rent', area: '', keyword: '', onlyAvailable: false,
  selected: null, hovered: -1, origin: null, me: null, stats: null,
  countdown: REFRESH_SEC, picking: false,
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
function icon(id, cls = 'ic') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}
const fmt = (n) => Number(n || 0).toLocaleString('zh-TW');
const cleanName = (n) => n.replace(/^YouBike2\.0_/, '');
const valueOf = (s, mode = state.mode) => (mode === 'rent' ? s.available_rent : s.available_return);
function level(s) {
  if (!s.active) return 'off';
  const n = valueOf(s);
  return n <= 0 ? 'empty' : n < 5 ? 'low' : 'ok';
}
const levelColor = (s) => PALETTE[state.mode][level(s)];

function distance(a, b) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const walkMin = (m) => Math.max(1, Math.round(m / 75));

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

// Web Mercator
function merc(lat, lng) {
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * WORLD, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD };
}
const ORIGIN = merc(CENTER.lat, CENTER.lng);
function toWorld(lat, lng) { const p = merc(lat, lng); return { x: p.x - ORIGIN.x, z: p.y - ORIGIN.y }; }
function fromWorld(x, z) {
  const lng = ((x + ORIGIN.x) / WORLD) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * (z + ORIGIN.y)) / WORLD;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng };
}
const metersToWorld = (m, lat = CENTER.lat) => m / ((40075016.686 * Math.cos((lat * Math.PI) / 180)) / WORLD);

function setBoot(pct, msg) {
  $('boot-bar').style.width = pct + '%';
  if (msg) $('boot-msg').textContent = msg;
}
const isMobile = () => window.innerWidth <= 760;

// ==============================================================
// 主程式
// ==============================================================
(async function main() {
  let THREE, MapControls, EffectComposer, RenderPass, UnrealBloomPass, OutputPass;
  try {
    setBoot(6, '載入 three.js 引擎…');
    [THREE, { MapControls }, { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
      import('three'),
      import('three/addons/controls/MapControls.js'),
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);
  } catch (err) {
    setBoot(100, `無法載入 three.js（${err.message}），請確認網路連線，或改用平面地圖。`);
    return;
  }

  // ---------- Renderer / Scene ----------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    setBoot(100, '此瀏覽器不支援 WebGL，請改用平面地圖（map2d.html）。');
    return;
  }
  const stage = $('stage');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  stage.append(renderer.domElement);

  const BG = new THREE.Color('#04070d');
  const scene = new THREE.Scene();
  scene.background = BG;
  scene.fog = new THREE.FogExp2(BG, 0.00021);

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 2, 30000);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.3;
  controls.minDistance = 70;
  controls.maxDistance = 5200;
  controls.zoomToCursor = true;
  controls.autoRotateSpeed = 0.55;

  scene.add(new THREE.HemisphereLight('#9fc4ff', '#0a0f1a', 0.55));
  const sun = new THREE.DirectionalLight('#ffffff', 0.8);
  sun.position.set(900, 1600, 500);
  scene.add(sun);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.35, 0.75);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // 桌機版左側面板會蓋住畫面：用 view offset 把投影中心往右推
  function applyViewOffset() {
    const w = window.innerWidth, h = window.innerHeight;
    if (isMobile()) camera.setViewOffset(w, h, 0, h * 0.16, w, h);
    else camera.setViewOffset(w, h, -200, 0, w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  applyViewOffset();
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    applyViewOffset();
  });

  // ---------- 地面：Esri 圖磚拼成一張貼圖 ----------
  const tx0 = Math.floor(merc(BBOX.n, BBOX.w).x / TILE), tx1 = Math.floor(merc(BBOX.s, BBOX.e).x / TILE);
  const ty0 = Math.floor(merc(BBOX.n, BBOX.w).y / TILE), ty1 = Math.floor(merc(BBOX.s, BBOX.e).y / TILE);
  const GW = (tx1 - tx0 + 1) * TILE, GH = (ty1 - ty0 + 1) * TILE;
  const mkCanvas = () => { const c = document.createElement('canvas'); c.width = GW; c.height = GH; return c; };
  const groundCanvas = mkCanvas(), baseCanvas = mkCanvas(), refCanvas = mkCanvas();
  const gctx = groundCanvas.getContext('2d'), bctx = baseCanvas.getContext('2d'), rctx = refCanvas.getContext('2d');
  bctx.fillStyle = '#070b14';
  bctx.fillRect(0, 0, GW, GH);
  const groundTex = new THREE.CanvasTexture(groundCanvas);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), new THREE.MeshBasicMaterial({ map: groundTex, color: new THREE.Color(1.35, 1.35, 1.35), toneMapped: false }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(tx0 * TILE + GW / 2 - ORIGIN.x, 0, ty0 * TILE + GH / 2 - ORIGIN.y);
  scene.add(ground);

  const grid = new THREE.GridHelper(24000, 160, '#12325a', '#0b1a2e');
  grid.position.y = -1;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  function composeGround() {
    gctx.globalCompositeOperation = 'source-over';
    gctx.drawImage(baseCanvas, 0, 0);
    gctx.globalAlpha = 0.8;
    gctx.drawImage(refCanvas, 0, 0);
    gctx.globalAlpha = 1;
    // 四周淡出到背景色，讓地圖邊界融進霧裡
    const fade = 420;
    const edges = [
      [0, 0, GW, fade, 0, 0, 0, fade], [0, GH - fade, GW, fade, 0, GH, 0, GH - fade],
      [0, 0, fade, GH, 0, 0, fade, 0], [GW - fade, 0, fade, GH, GW, 0, GW - fade, 0],
    ];
    for (const [x, y, w, h, gx0, gy0, gx1, gy1] of edges) {
      const g = gctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, 'rgba(4,7,13,1)');
      g.addColorStop(1, 'rgba(4,7,13,0)');
      gctx.fillStyle = g;
      gctx.fillRect(x, y, w, h);
    }
    groundTex.needsUpdate = true;
  }

  function loadGround(onProgress) {
    const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        jobs.push({ layer: 'World_Dark_Gray_Base', ctx: bctx, tx, ty, tint: true });
        jobs.push({ layer: 'World_Dark_Gray_Reference', ctx: rctx, tx, ty, tint: false });
      }
    }
    let done = 0, dirty = false;
    const timer = setInterval(() => { if (dirty) { dirty = false; composeGround(); } }, 180);
    return new Promise((resolve) => {
      for (const j of jobs) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const x = (j.tx - tx0) * TILE, y = (j.ty - ty0) * TILE;
          j.ctx.drawImage(img, x, y);
          if (j.tint) {
            // 冷色調：把灰階底圖染成深藍
            j.ctx.globalCompositeOperation = 'multiply';
            j.ctx.fillStyle = '#8fb0ff';
            j.ctx.fillRect(x, y, TILE, TILE);
            j.ctx.globalCompositeOperation = 'source-over';
          }
          finish();
        };
        img.onerror = finish;
        img.src = `${ESRI}${j.layer}/MapServer/tile/${Z}/${j.ty}/${j.tx}`;
      }
      function finish() {
        done++;
        dirty = true;
        onProgress(done / jobs.length);
        if (done === jobs.length) { clearInterval(timer); composeGround(); resolve(); }
      }
    });
  }

  // ---------- 漂浮粒子 ----------
  const DUST = 1800;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * GW;
    dustPos[i * 3 + 1] = Math.random() * 420;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * GH;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: '#7fb2ff', size: 2.4, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(dust);

  // ---------- 站點柱體 ----------
  const glow = { value: 1 };
  const colGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
  colGeo.translate(0, 0.5, 0);
  const colMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, metalness: 0.35 });
  colMat.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * (0.08 * vH + 0.9 * pow(vH, 12.0)) * uGlow;');
  };

  // 地面脈衝（沒車/沒位的站）
  const pulseGeo = new THREE.PlaneGeometry(1, 1);
  pulseGeo.rotateX(-Math.PI / 2);
  const time = { value: 0 };
  const pulseVert = `
    attribute float aPhase;
    varying vec2 vUv; varying float vP;
    void main() {
      vUv = uv; vP = aPhase;
      #ifdef USE_INSTANCING
        vec4 p = instanceMatrix * vec4(position, 1.0);
      #else
        vec4 p = vec4(position, 1.0);
      #endif
      gl_Position = projectionMatrix * modelViewMatrix * p;
    }`;
  const pulseFrag = `
    uniform float uTime; uniform vec3 uColor; uniform float uSpeed;
    varying vec2 vUv; varying float vP;
    void main() {
      float d = length(vUv - 0.5) * 2.0;
      if (d > 1.0) discard;
      float t = fract(uTime * uSpeed + vP);
      float ring = smoothstep(0.09, 0.0, abs(d - t)) * (1.0 - t);
      float core = smoothstep(0.25, 0.0, d) * 0.5;
      gl_FragColor = vec4(uColor * 1.1, ring + core);
    }`;
  function pulseMaterial(color, speed = 0.6) {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: time, uColor: { value: new THREE.Color(color) }, uSpeed: { value: speed } },
      vertexShader: pulseVert, fragmentShader: pulseFrag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
  }

  let columns = null, pulses = null;
  let cur = [], tgt = [], curW = [], tgtW = [], delay = [], wpos = [];
  let widthFactor = 1, lastWF = 0, matricesDirty = true;
  const mtx = new THREE.Matrix4(), tmpColor = new THREE.Color(), WHITE = new THREE.Color('#ffffff');

  function buildColumns(n) {
    if (columns) { scene.remove(columns); columns.dispose(); }
    if (pulses) { scene.remove(pulses); pulses.dispose(); }
    columns = new THREE.InstancedMesh(colGeo, colMat, Math.max(1, n));
    columns.frustumCulled = false;
    columns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(columns);
    const phase = new Float32Array(Math.max(1, n)).map(() => Math.random());
    const pg = pulseGeo.clone();
    pg.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    pulses = new THREE.InstancedMesh(pg, pulseMaterial('#ff2d55'), Math.max(1, n));
    pulses.frustumCulled = false;
    pulses.count = 0;
    pulses.renderOrder = 2;
    scene.add(pulses);
    cur = new Array(n).fill(0); curW = new Array(n).fill(0);
    tgt = new Array(n).fill(0); tgtW = new Array(n).fill(0);
    delay = new Array(n).fill(0); wpos = new Array(n);
  }

  function isVisible(s) {
    if (state.area && s.area !== state.area) return false;
    if (state.onlyAvailable && (!s.active || valueOf(s) <= 0)) return false;
    if (state.keyword) {
      const k = state.keyword.toLowerCase();
      if (!s.name.toLowerCase().includes(k) && !(s.address || '').toLowerCase().includes(k)) return false;
    }
    return true;
  }

  // 依目前模式/篩選重新計算每根柱子的目標高度、寬度、顏色與脈衝
  function retarget() {
    if (!columns) return;
    let k = 0;
    state.stations.forEach((s, i) => {
      const vis = isVisible(s);
      tgt[i] = !vis ? 0 : !s.active ? 0.8 : H_MIN + valueOf(s) * H_PER;
      tgtW[i] = vis ? 1 : 0;
      paint(i);
      if (vis && s.active && valueOf(s) <= 0) {
        mtx.makeScale(46 * widthFactor, 1, 46 * widthFactor).setPosition(wpos[i].x, 0.6, wpos[i].z);
        pulses.setMatrixAt(k++, mtx);
      }
    });
    pulses.count = k;
    pulses.instanceMatrix.needsUpdate = true;
    if (columns.instanceColor) columns.instanceColor.needsUpdate = true;
  }

  function paint(i) {
    const s = state.stations[i];
    tmpColor.set(levelColor(s));
    if (i === state.hovered || s.sno === state.selected) tmpColor.lerp(WHITE, 0.35);
    columns.setColorAt(i, tmpColor);
  }

  function repaint(i) {
    if (i < 0 || !columns || i >= state.stations.length) return;
    paint(i);
    if (columns.instanceColor) columns.instanceColor.needsUpdate = true;
  }

  function stepColumns(dt, elapsed) {
    if (!columns) return;
    let moved = false;
    const k = 1 - Math.exp(-dt * 5.5);
    for (let i = 0; i < state.stations.length; i++) {
      if (elapsed < delay[i]) continue;
      if (cur[i] !== tgt[i] || curW[i] !== tgtW[i]) {
        cur[i] += (tgt[i] - cur[i]) * k;
        curW[i] += (tgtW[i] - curW[i]) * k;
        if (Math.abs(cur[i] - tgt[i]) < 0.02) cur[i] = tgt[i];
        if (Math.abs(curW[i] - tgtW[i]) < 0.002) curW[i] = tgtW[i];
        moved = true;
      }
    }
    if (moved || matricesDirty) {
      for (let i = 0; i < state.stations.length; i++) {
        const sel = state.stations[i].sno === state.selected ? 1.35 : 1;
        const w = RADIUS * widthFactor * curW[i] * sel;
        mtx.makeScale(w, Math.max(cur[i], 0.001), w).setPosition(wpos[i].x, 0, wpos[i].z);
        columns.setMatrixAt(i, mtx);
      }
      columns.instanceMatrix.needsUpdate = true;
      matricesDirty = false;
    }
  }

  // ---------- 選取光束 / 附近搜尋圈 ----------
  const beamMat = (color, alpha) => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uA: { value: alpha } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uA; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 2.2) * uA; gl_FragColor = vec4(uColor * 1.2, a); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  function beacon(color, height, pulseSize) {
    const g = new THREE.Group();
    const bg = new THREE.CylinderGeometry(2.4, 2.4, height, 20, 1, true);
    bg.translate(0, height / 2, 0);
    const beam = new THREE.Mesh(bg, beamMat(color, 0.9));
    const pg = pulseGeo.clone();
    pg.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array([0, 0.5]), 1));
    const p = new THREE.InstancedMesh(pg, pulseMaterial(color, 0.45), 2);
    for (let i = 0; i < 2; i++) p.setMatrixAt(i, mtx.makeScale(pulseSize, 1, pulseSize).setPosition(0, 0.8 + i * 0.1, 0));
    p.frustumCulled = false;
    g.add(beam, p);
    g.visible = false;
    g.renderOrder = 3;
    scene.add(g);
    return g;
  }
  const selBeacon = beacon('#ffd36b', 900, 70);
  const originBeacon = beacon('#5b8cff', 420, 90);
  const radiusRing = new THREE.Mesh(
    new THREE.RingGeometry(0.985, 1, 160).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffb400', transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  const radiusDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffb400', transparent: true, opacity: 0.07, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  radiusRing.position.y = 1; radiusDisc.position.y = 0.9;
  radiusRing.visible = radiusDisc.visible = false;
  scene.add(radiusRing, radiusDisc);

  function accentHex() { return state.mode === 'rent' ? '#ffb400' : '#33c7ff'; }

  // ---------- 相機飛行 ----------
  let fly = null;
  const sph = new THREE.Spherical();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  function flyTo(target, { radius, phi, theta, dur = 1.6 } = {}) {
    sph.setFromVector3(camera.position.clone().sub(controls.target));
    const from = { t: controls.target.clone(), r: sph.radius, phi: sph.phi, theta: sph.theta };
    let toTheta = theta ?? from.theta;
    while (toTheta - from.theta > Math.PI) toTheta -= Math.PI * 2;
    while (toTheta - from.theta < -Math.PI) toTheta += Math.PI * 2;
    fly = { el: 0, dur, from, to: { t: target.clone(), r: radius ?? from.r, phi: phi ?? from.phi, theta: toTheta } };
  }
  function stepFly(dt) {
    if (!fly) return;
    fly.el += dt;
    const k = ease(Math.min(1, fly.el / fly.dur));
    const { from: a, to: b } = fly;
    controls.target.lerpVectors(a.t, b.t, k);
    // 半徑走 log 內插：遠近切換時速度比較自然
    const r = Math.exp(Math.log(a.r) + (Math.log(b.r) - Math.log(a.r)) * k);
    sph.set(r, a.phi + (b.phi - a.phi) * k, a.theta + (b.theta - a.theta) * k);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
    if (k >= 1) fly = null;
  }
  controls.addEventListener('start', () => { fly = null; });
  const worldVec = (lat, lng) => { const p = toWorld(lat, lng); return new THREE.Vector3(p.x, 0, p.z); };
  const goHome = (dur = 1.8) => flyTo(new THREE.Vector3(0, 0, 0), { ...HOME, dur });

  // ---------- 3D 上的 HTML 標籤 ----------
  const labelsBox = $('labels');
  let areaTags = [];
  const stTags = Array.from({ length: 16 }, () => {
    const d = el('div', 'st-tag');
    d.hidden = true;
    labelsBox.append(d);
    return { el: d, i: -1 };
  });
  const proj = new THREE.Vector3();

  function buildAreaTags() {
    for (const t of areaTags) t.el.remove();
    const groups = new Map();
    state.stations.forEach((s, i) => {
      const g = groups.get(s.area) || { x: 0, z: 0, n: 0, v: 0 };
      g.x += wpos[i].x; g.z += wpos[i].z; g.n++; g.v += s.active ? valueOf(s) : 0;
      groups.set(s.area, g);
    });
    areaTags = [...groups].map(([name, g]) => {
      const d = el('div', 'area-tag', name);
      const sm = el('small', '', `${g.n} 站 · ${state.mode === 'rent' ? '可借' : '可還'} ${fmt(g.v)}`);
      d.append(sm);
      labelsBox.append(d);
      return { el: d, pos: new THREE.Vector3(g.x / g.n, 30, g.z / g.n), name };
    });
  }

  function placeLabels(frame) {
    const w = window.innerWidth, h = window.innerHeight;
    const dist = camera.position.distanceTo(controls.target);
    const areaAlpha = Math.min(1, Math.max(0, (dist - 700) / 500));
    for (const t of areaTags) {
      proj.copy(t.pos).project(camera);
      const on = areaAlpha > 0.01 && proj.z < 1 && (!state.area || state.area === t.name);
      t.el.hidden = !on;
      if (on) {
        t.el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w}px, ${(-proj.y * 0.5 + 0.5) * h}px) translate(-50%, -50%)`;
        t.el.style.opacity = areaAlpha;
      }
    }
    // 近距離時，挑離視角中心最近的站顯示名稱與數量
    const close = dist < 640;
    if (close && frame % 10 === 0) {
      const tx = controls.target.x, tz = controls.target.z, lim = (dist * 0.9) ** 2;
      const cand = [];
      for (let i = 0; i < state.stations.length; i++) {
        if (tgtW[i] === 0) continue;
        const dx = wpos[i].x - tx, dz = wpos[i].z - tz, d2 = dx * dx + dz * dz;
        if (d2 < lim) cand.push([d2, i]);
      }
      cand.sort((a, b) => a[0] - b[0]);
      stTags.forEach((t, k) => {
        const i = cand[k] ? cand[k][1] : -1;
        if (i === t.i) return;
        t.i = i;
        if (i < 0) return;
        const s = state.stations[i];
        const b = el('b', '', s.active ? valueOf(s) : '–');
        b.style.background = levelColor(s);
        t.el.replaceChildren(b, document.createTextNode(cleanName(s.name)));
      });
    }
    for (const t of stTags) {
      if (!close || t.i < 0) { t.el.hidden = true; continue; }
      proj.set(wpos[t.i].x, cur[t.i] + 6, wpos[t.i].z).project(camera);
      if (proj.z > 1) { t.el.hidden = true; continue; }
      t.el.hidden = false;
      t.el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w}px, ${(-proj.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
      t.el.style.opacity = Math.min(1, (640 - dist) / 160);
    }
  }
  function refreshStationTags() { for (const t of stTags) t.i = -2; }

  // ---------- 滑鼠：hover / 點擊 ----------
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let pointerMoved = false, lastClient = { x: 0, y: 0 }, downAt = null;

  renderer.domElement.addEventListener('pointermove', (e) => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    lastClient = { x: e.clientX, y: e.clientY };
    pointerMoved = true;
  });
  renderer.domElement.addEventListener('pointerleave', () => setHover(-1));
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    if (state.picking) {
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(groundPlane, hit)) {
        setPicking(false);
        switchTab('nearby');
        if (isMobile()) $('panel').classList.remove('collapsed');
        const ll = fromWorld(hit.x, hit.z);
        searchNearby({ ...ll, label: 'pick' });
      }
      return;
    }
    const i = pickColumn();
    if (i >= 0) selectStation(state.stations[i].sno);
  });

  function pickColumn() {
    if (!columns) return -1;
    const hits = ray.intersectObject(columns, false);
    return hits.length ? hits[0].instanceId : -1;
  }

  function setHover(i, showTip = true) {
    if (i === state.hovered) { if (i >= 0 && showTip) placeTip(); return; }
    const prev = state.hovered;
    state.hovered = i;
    repaint(prev); repaint(i);
    document.body.classList.toggle('hovering', i >= 0);
    const tip = $('tip');
    if (i < 0 || !showTip) { tip.hidden = true; return; }
    const s = state.stations[i];
    const row = el('div', 't-row');
    const r = el('span'); r.append(el('b', 'r', s.available_rent), document.createTextNode('可借'));
    const g = el('span'); g.append(el('b', 'g', s.available_return), document.createTextNode('可還'));
    row.append(r, g, el('span', '', s.active ? s.area : '暫停營運'));
    tip.replaceChildren(el('div', 't-name', cleanName(s.name)), row);
    tip.hidden = false;
    placeTip();
  }
  function placeTip() {
    const tip = $('tip');
    const x = Math.min(lastClient.x + 16, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(lastClient.y + 16, window.innerHeight - tip.offsetHeight - 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  // ==============================================================
  // 資料
  // ==============================================================
  let introAt = null;
  function applyStations(stations) {
    const sameSet = stations.length === state.stations.length && stations.every((s) => state.idx.has(s.sno));
    // 維持原本的 index 順序，柱子才能從舊高度平滑長到新高度
    if (sameSet) stations = stations.slice().sort((a, b) => state.idx.get(a.sno) - state.idx.get(b.sno));
    state.stations = stations;
    state.bySno = new Map(stations.map((s) => [s.sno, s]));
    state.idx = new Map(stations.map((s, i) => [s.sno, i]));
    if (!sameSet) {
      buildColumns(stations.length);
      stations.forEach((s, i) => { wpos[i] = toWorld(s.lat, s.lng); });
      // 開場由市中心往外一圈圈長出來
      const maxD = Math.max(...wpos.map((p) => Math.hypot(p.x, p.z)), 1);
      stations.forEach((s, i) => { delay[i] = (introAt === null ? 0 : elapsed) + 0.3 + (Math.hypot(wpos[i].x, wpos[i].z) / maxD) * 1.8; });
      state.hovered = -1;
    } else {
      stations.forEach((s, i) => { wpos[i] = toWorld(s.lat, s.lng); });
    }
    retarget();
    buildAreaTags();
    refreshStationTags();
    matricesDirty = true;
  }

  async function loadAll({ silent = false, boot = false } = {}) {
    const btn = $('ctl-refresh');
    btn.classList.add('spin');
    try {
      if (boot) setBoot(18, '讀取即時站點資料…');
      const [stations, stats, sync] = await Promise.all([fetchAllStations(), api('stats'), api('sync/status').catch(() => null)]);
      const first = state.stations.length === 0;
      state.stats = stats;
      applyStations(stations);
      renderKpis();
      renderAreas();
      if (first) fillAreaSelect();
      if (state.selected) {
        if (state.bySno.has(state.selected)) showDetail(state.bySno.get(state.selected));
        else closeDetail();
      }
      if (state.origin) searchNearby(state.origin, { quiet: true, fly: false });
      setLive(true, sync);
      if (!silent && !boot) toast(`已更新 ${fmt(stations.length)} 個站點`);
      return true;
    } catch (err) {
      setLive(false);
      toast(`無法連線到 API（${HOST}）：${err.message}。請確認 Server 已啟動，或在「設定」修改 API Host。`, true, 7000);
      return false;
    } finally {
      btn.classList.remove('spin');
      state.countdown = REFRESH_SEC;
    }
  }

  function setLive(ok, sync) {
    $('live-dot').className = 'dot ' + (ok ? 'on' : 'err');
    if (!ok) { $('live-text').textContent = 'OFFLINE · 無法連線到 API'; return; }
    if (sync && sync.static) {
      $('live-dot').className = 'dot demo';
      $('live-text').textContent = `DEMO · Open Data 快照 ${(sync.snapshot_time || '').slice(0, 16)}`;
      if (!setLive.noted) { setLive.noted = true; toast('目前為展示模式：顯示 repo 內的 Open Data 快照（唯讀）。即時資料與 CRUD 請啟動 rest_server.py', false, 6500); }
      return;
    }
    const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    $('live-text').textContent = `LIVE · 更新於 ${t}${sync && !sync.enabled ? '（未啟用同步）' : ''}`;
  }

  // ---------- KPI / 行政區 ----------
  function animateNumber(node, to) {
    const from = Number(node.dataset.v || 0);
    node.dataset.v = to;
    const start = performance.now(), dur = 900;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur), e = 1 - (1 - p) ** 4;
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
    const pct = s.total_docks ? (main / s.total_docks) * 100 : 0;
    $('kpi-main-label').textContent = rent ? '全市可借車輛' : '全市可還空位';
    animateNumber($('kpi-main'), main);
    $('kpi-pct').textContent = pct.toFixed(1) + '%';
    $('kpi-bar').style.width = pct.toFixed(1) + '%';
    $('kpi-main-sub').textContent = `全市 ${fmt(s.total_docks)} 個車格・${fmt(s.stations)} 站`;
    animateNumber($('kpi-stations'), s.active_stations);
    animateNumber($('kpi-low'), s.low_bike_stations);
    animateNumber($('kpi-full'), s.full_stations);
  }
  function renderAreas() {
    const rows = (state.stats?.by_area || []).map((a) => {
      const v = state.mode === 'rent' ? a.available_rent : a.available_return;
      return { ...a, v, ratio: a.total ? v / a.total : 0 };
    }).sort((a, b) => b.ratio - a.ratio);
    $('area-hint').textContent = `長條 = ${state.mode === 'rent' ? '可借車輛' : '可還空位'}佔總車格比例，點一下飛到該區。`;
    const list = $('area-list');
    list.replaceChildren();
    for (const a of rows) {
      const li = el('li', state.area === a.area ? 'sel' : '');
      const bar = el('div', 'ab'); const i = el('i'); i.style.width = (a.ratio * 100).toFixed(1) + '%'; bar.append(i);
      const av = el('div', 'av', fmt(a.v)); av.append(el('small', '', `${Math.round(a.ratio * 100)}%`));
      li.append(el('span', 'an', a.area), bar, av);
      li.title = `${a.area}：${a.stations} 站、${fmt(a.total)} 車格`;
      li.addEventListener('click', () => { setArea(state.area === a.area ? '' : a.area, true); collapseSheet(); });
      list.append(li);
    }
  }
  function fillAreaSelect() {
    const sel = $('area');
    const areas = [...new Set(state.stations.map((s) => s.area))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    for (const a of areas) sel.append(new Option(a, a));
  }
  function setArea(area, doFly = false) {
    state.area = area;
    $('area').value = area;
    retarget();
    refreshStationTags();
    renderAreas();
    if (!doFly) return;
    if (!area) { goHome(); return; }
    let x = 0, z = 0, n = 0, maxR = 0;
    state.stations.forEach((s, i) => { if (s.area === area) { x += wpos[i].x; z += wpos[i].z; n++; } });
    if (!n) return;
    x /= n; z /= n;
    state.stations.forEach((s, i) => { if (s.area === area) maxR = Math.max(maxR, Math.hypot(wpos[i].x - x, wpos[i].z - z)); });
    flyTo(new THREE.Vector3(x, 0, z), { radius: Math.max(600, maxR * 2.6), phi: 0.85 });
  }

  // ---------- 站點詳情 ----------
  function selectStation(sno, { doFly = true } = {}) {
    const prev = state.selected;
    state.selected = sno;
    repaint(state.idx.get(prev) ?? -1);
    const i = state.idx.get(sno);
    const s = state.bySno.get(sno);
    if (!s || i === undefined) return;
    repaint(i);
    matricesDirty = true;
    selBeacon.position.set(wpos[i].x, 0, wpos[i].z);
    selBeacon.visible = true;
    showDetail(s);
    if (doFly) flyTo(new THREE.Vector3(wpos[i].x, 0, wpos[i].z), { radius: 420, phi: 0.95, dur: 1.5 });
  }
  function showDetail(s) {
    $('detail').hidden = false;
    $('d-area').textContent = s.area;
    const st = $('d-state');
    st.textContent = s.active ? '營運中' : '暫停營運';
    st.className = 'd-chip ' + (s.active ? 'ok' : 'off');
    $('d-sno').textContent = '#' + s.sno;
    $('d-name').textContent = cleanName(s.name);
    $('d-addr').textContent = s.address || '';
    $('d-rent').textContent = s.available_rent;
    $('d-return').textContent = s.available_return;
    const total = s.total || s.available_rent + s.available_return || 1;
    const main = valueOf(s);
    $('d-pct').textContent = Math.round((main / total) * 100) + '%';
    $('d-gauge').style.strokeDashoffset = (100.5 * (1 - main / total)).toFixed(1);
    $('d-bar-rent').style.width = (s.available_rent / total) * 100 + '%';
    $('d-bar-ret').style.width = (s.available_return / total) * 100 + '%';
    $('d-total').textContent = `總車格 ${s.total}`;
    $('d-time').textContent = (s.updated_at || '–').slice(5, 16);
    const ref = state.me || state.origin;
    const dist = $('d-dist');
    dist.hidden = !ref;
    if (ref) {
      const d = distance(ref, s);
      dist.querySelector('b').textContent = `${state.me ? '距離你' : '距離選點'} ${fmtDist(d)}・步行 ${walkMin(d)} 分`;
    }
    $('d-nav').href = gmapsNav(s);
    $('d-gmap').href = gmapsView(s);
  }
  function closeDetail() {
    const prev = state.idx.get(state.selected);
    state.selected = null;
    $('detail').hidden = true;
    selBeacon.visible = false;
    repaint(prev ?? -1);
    matricesDirty = true;
  }

  // ---------- 附近站點 ----------
  async function searchNearby(origin, { quiet = false, fly: doFly = true } = {}) {
    state.origin = origin;
    const r = Number($('radius').value);
    const p = toWorld(origin.lat, origin.lng);
    const rw = metersToWorld(r, origin.lat);
    radiusRing.position.x = radiusDisc.position.x = p.x;
    radiusRing.position.z = radiusDisc.position.z = p.z;
    radiusRing.scale.setScalar(rw); radiusDisc.scale.setScalar(rw);
    radiusRing.material.color.set(accentHex()); radiusDisc.material.color.set(accentHex());
    radiusRing.visible = radiusDisc.visible = true;
    originBeacon.position.set(p.x, 0, p.z);
    originBeacon.visible = true;
    if (doFly) flyTo(new THREE.Vector3(p.x, 0, p.z), { radius: Math.max(380, rw * 3.4), phi: 0.9 });
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
      list.append(el('li', 'empty', `半徑內沒有${state.mode === 'rent' ? '可借車' : '可還車'}的站點，試著把半徑拉大。`));
      return;
    }
    const rent = state.mode === 'rent';
    items.forEach((it, k) => {
      const s = state.bySno.get(it.sno) || it;
      const li = el('li', 'st');
      li.style.animationDelay = k * 30 + 'ms';
      const badge = el('span', 'badge', valueOf(s));
      badge.style.setProperty('--c', levelColor(s));
      const mid = el('div');
      mid.style.minWidth = '0';
      mid.append(
        el('div', 'nm', cleanName(s.name)),
        el('div', 'sub', `${rent ? '可借' : '可還'} ${valueOf(s)}・${rent ? '可還' : '可借'} ${rent ? s.available_return : s.available_rent}・${s.area}`),
      );
      const dist = el('div', 'dist');
      dist.append(el('b', '', fmtDist(it.distance_m)), document.createTextNode(`步行 ${walkMin(it.distance_m)} 分`));
      li.append(badge, mid, dist);
      li.addEventListener('click', () => { selectStation(s.sno); collapseSheet(); });
      li.addEventListener('mouseenter', () => setHover(state.idx.get(s.sno) ?? -1, false));
      li.addEventListener('mouseleave', () => setHover(-1));
      list.append(li);
    });
  }
  function locateMe() {
    if (!navigator.geolocation) { toast('此瀏覽器不支援定位', true); return; }
    toast('定位中…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const me = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'me' };
        state.me = me;
        const inTaipei = me.lat > BBOX.s && me.lat < BBOX.n && me.lng > BBOX.w && me.lng < BBOX.e;
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

  // ---------- 搜尋框 ----------
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
      left.append(el('span', '', cleanName(s.name)), el('small', '', `${s.area}・${s.address || ''}`));
      const b = el('b', '', valueOf(s));
      b.style.color = levelColor(s);
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

  // ---------- 模式 / 分頁 / 行動版 ----------
  function setMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('mode-rent', mode === 'rent');
    document.body.classList.toggle('mode-return', mode === 'return');
    document.querySelectorAll('.seg').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    $('legend-title').textContent = mode === 'rent' ? '柱高 = 可借車輛' : '柱高 = 可還空位';
    $('only-label').textContent = mode === 'rent' ? '只看有車' : '只看有位';
    selBeacon.children[0].material.uniforms.uColor.value.set(mode === 'rent' ? '#ffd36b' : '#7fe0ff');
    retarget();
    buildAreaTags();
    refreshStationTags();
    renderKpis();
    renderAreas();
    if (state.selected) showDetail(state.bySno.get(state.selected));
    if (state.origin) searchNearby(state.origin, { fly: false });
    if (state.keyword) renderSearchResults();
  }
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('tab-nearby').hidden = name !== 'nearby';
    $('tab-areas').hidden = name !== 'areas';
  }
  function collapseSheet() { if (isMobile()) $('panel').classList.add('collapsed'); }

  // ---------- 事件綁定 ----------
  document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('area').addEventListener('change', (e) => setArea(e.target.value, true));
  $('only-available').addEventListener('change', (e) => { state.onlyAvailable = e.target.checked; retarget(); refreshStationTags(); });

  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.keyword = e.target.value.trim();
      renderSearchResults();
      retarget();
      refreshStationTags();
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
  $('ctl-refresh').addEventListener('click', () => loadAll());
  $('ctl-home').addEventListener('click', () => goHome());
  $('ctl-orbit').addEventListener('click', () => {
    controls.autoRotate = !controls.autoRotate;
    $('ctl-orbit').classList.toggle('on', controls.autoRotate);
  });
  $('ctl-2d').addEventListener('click', (e) => { e.preventDefault(); location.href = 'map2d.html?api=' + encodeURIComponent(HOST); });
  $('detail-close').addEventListener('click', closeDetail);
  $('d-near').addEventListener('click', () => {
    const s = state.bySno.get(state.selected);
    if (!s) return;
    switchTab('nearby');
    if (isMobile()) $('panel').classList.remove('collapsed');
    searchNearby({ lat: s.lat, lng: s.lng, label: 'station' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.tagName === 'INPUT') return;
    if (state.picking) setPicking(false); else closeDetail();
  });
  $('sheet-handle').addEventListener('click', () => $('panel').classList.toggle('collapsed'));
  $('host').value = HOST;
  $('host-save').addEventListener('click', () => {
    STATIC = false;
    HOST = $('host').value.trim() || 'http://localhost:5000/';
    try { localStorage.setItem('yb-host', HOST); } catch { /* 無痕模式 */ }
    state.stations = [];
    state.idx = new Map();
    $('area').length = 1;
    loadAll();
  });

  setInterval(() => {
    if (document.hidden) return;
    state.countdown -= 1;
    $('countdown').style.strokeDashoffset = (100.5 * (1 - state.countdown / REFRESH_SEC)).toFixed(1);
    if (state.countdown <= 0) loadAll({ silent: true });
  }, 1000);

  // ==============================================================
  // 迴圈
  // ==============================================================
  const clock = new THREE.Clock();
  let frame = 0, elapsed = 0;
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;
    time.value = elapsed;
    frame++;
    stepFly(dt);
    controls.update();

    // 拉遠時柱子變粗，全市視角也看得清楚
    const dist = camera.position.distanceTo(controls.target);
    widthFactor = Math.min(3.2, Math.max(1, dist / 650));
    if (Math.abs(widthFactor - lastWF) / widthFactor > 0.02) {
      lastWF = widthFactor;
      matricesDirty = true;
      if (frame % 6 === 0) retarget();
    }
    stepColumns(dt, elapsed);

    if (pointerMoved && !fly) {
      pointerMoved = false;
      ray.setFromCamera(pointer, camera);
      setHover(pickColumn());
    }
    const pos = dustGeo.attributes.position.array;
    for (let i = 1; i < pos.length; i += 3) { pos[i] += dt * 6; if (pos[i] > 420) pos[i] = 0; }
    dustGeo.attributes.position.needsUpdate = true;
    selBeacon.rotation.y += dt;

    placeLabels(frame);
    composer.render();
    requestAnimationFrame(tick);
  }

  // ==============================================================
  // 開場
  // ==============================================================
  // 從高空斜角俯衝到全市視角
  controls.target.set(0, 0, 0);
  camera.position.setFromSpherical(new THREE.Spherical(6200, 0.18, -1.2));
  tick();
  if (isMobile()) $('panel').classList.add('collapsed');

  const groundP = loadGround((p) => setBoot(35 + p * 55, `載入臺北市街道圖磚 ${Math.round(p * 100)}%`));
  const ok = await loadAll({ boot: true });
  // 圖磚最多等 4 秒，其餘在背景補齊
  await Promise.race([groundP, new Promise((r) => setTimeout(r, 4000))]);
  setBoot(100, ok ? `${fmt(state.stations.length)} 個站點就緒` : 'API 離線：只顯示地圖');
  introAt = elapsed;
  state.stations.forEach((s, i) => { delay[i] += elapsed; });
  $('boot').classList.add('done');
  flyTo(new THREE.Vector3(0, 0, 0), { ...HOME, dur: 3.4 });

  const deep = new URLSearchParams(location.search).get('sno');
  if (deep && state.bySno.has(deep)) setTimeout(() => selectStation(deep), 3000);
})();
