import { Disto } from './disto.js';
import { DxfWriter } from './dxf.js';
import { buildWalls, asBuilt } from './walls.js';
import { canvasesToPdf } from './pdf.js';
import { zipOne, zipMany } from './zip.js';

const VERSION = '2.5.1';
const EMPTY_PLAN = () => ({ name: 'Проект', unit: 'cm', blocks: [] });
const $ = (id) => document.getElementById(id);
const BASE = new URL('../', import.meta.url).href;

/* ---------- форматирование: метры, 2 знака, запятая ---------- */
const fmt = (m) => (m == null || !isFinite(m) ? '—' : m.toFixed(2).replace('.', ','));
const fmtSigned = (m) => (m > 0 ? '+' : m < 0 ? '−' : '±') + Math.abs(m).toFixed(2).replace('.', ',');
function parseNum(s) {
  if (s == null) return null;
  // на русской раскладке точка/запятая клавиатуры приходят как «ю» / «б»
  const m = String(s).replace(/\s/g, '').replace(/[юЮбБ,]/g, '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
const UNIT_M = { mm: 0.001, cm: 0.01, m: 1 };
const UNIT_MM = { mm: 1, cm: 10, m: 1000 };

/* ---------- хранилище (IndexedDB) ---------- */
const DB = {
  db: null,
  mem: new Map(), // запасной вариант, если хранилище браузера недоступно
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open('disto-plan', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
        r.onblocked = () => res();
        setTimeout(res, 3000);
      } catch (e) { res(); }
    });
  },
  get(k) {
    if (!this.db) return Promise.resolve(this.mem.get(k));
    return new Promise((res) => {
      const t = this.db.transaction('kv').objectStore('kv').get(k);
      t.onsuccess = () => res(t.result);
      t.onerror = () => res(undefined);
    });
  },
  set(k, v) {
    if (!this.db) { this.mem.set(k, v); return Promise.resolve(); }
    return new Promise((res) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  },
};

/* ---------- состояние ---------- */
const S = {
  plan: null,
  block: null, // имя блока
  floor: 16,
  dir: 'down',
  toFloor: 15,
  tool: 'walls',
  selSeg: null, // ключ выбранной стены
  session: false,
  sketchDir: null,
  sketchRel: 's',
  sheetFull: false,
  openType: 'door',
  items: [],
  selId: null,
  armedId: null,
  draft: null, // {kind:'line'|'sketch', pts:[]}
  settings: { floorH: 0, theme: 'light', otherFloors: false, snap: true, beep: true, autoNext: true, wallMin: 0.15, wallColumns: false, wallLabels: true, ortho: false, snapModes: { end: true, mid: true, perp: true, near: false },
    polar: false, rotate: false, laserRef: 'back', laserOffset: 0.13, wallTh: 0, btnPos: {},
    layers: { drawing: true, shadow: true, dims: true, areas: true, openings: true, thick: true, hatch: false, text: false, redoBtn: true, roomOps: false, mini: true, shadowDims: false } },
  views: {},
  undo: [],
  lastMeasure: null,
};

let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    DB.set('items', S.items);
    DB.set('settings', S.settings);
    DB.set('session', { block: S.block, floor: S.floor, dir: S.dir, toFloor: S.toFloor });
  }, 250);
}
function flushSave() {
  clearTimeout(saveT);
  DB.set('items', S.items); DB.set('settings', S.settings);
  DB.set('session', { block: S.block, floor: S.floor, dir: S.dir, toFloor: S.toFloor });
}
addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
function pushUndo() {
  S.undo.push(JSON.stringify(S.items));
  if (S.undo.length > 60) S.undo.shift();
  S.redo = [];
}
function doRedo() {
  const s2 = S.redo?.pop();
  if (!s2) return toast('Нечего повторять');
  S.undo.push(JSON.stringify(S.items));
  S.items = JSON.parse(s2);
  // черчение продолжается: линия, которую вернули, снова текущая
  if (S.draft) {
    let it = S.items.find((i) => i.id === S.draft.itemId);
    if (!it && S.draft.pts.length >= 2) it = S.items.find((i) => i.kind === 'sketch' && !i.closed && i.block === S.block && i.floor === S.floor && Math.hypot(i.start[0] - S.draft.pts[0], i.start[1] - S.draft.pts[1]) < 1e-6);
    if (it && !it.closed) { S.draft.itemId = it.id; S.draft.pts = it.pts.slice(); S.draft.auto = false; } else S.draft = null;
  }
  if (S.skm && !S.items.find((i) => i.id === S.skm.id)) S.skm = null;
  save(); draw(); refreshSheet(); toast('Повторено');
}
function doUndo() {
  const s = S.undo.pop();
  if (!s) return toast('Нечего отменять');
  (S.redo = S.redo || []).push(JSON.stringify(S.items));
  const dIt = S.draft?.itemId ? S.items.find((i) => i.id === S.draft.itemId) : null;
  S.items = JSON.parse(s);
  // убрали первый отрезок — начало линии остаётся на месте, можно чертить дальше
  if (S.draft?.itemId && !S.items.find((i) => i.id === S.draft.itemId)) S.draft = dIt ? { kind: 'sketch', pts: dIt.start.slice() } : null;
  else if (S.draft?.itemId) { const it = S.items.find((i) => i.id === S.draft.itemId); S.draft.pts = it.pts.slice(); }
  if (S.skm && !S.items.find((i) => i.id === S.skm.id)) S.skm = null;
  if (!S.items.find((i) => i.id === S.selId)) select(null);
  save(); draw(); refreshSheet();
  toast('Отменено');
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const blk = () => S.plan.blocks.find((b) => b.name === S.block) || S.plan.blocks[0];
const hasDrawing = (b = blk()) => !!b && !b.blank;
function sheetHeader(b = blk()) {
  if (!b) return '';
  return (b.title || b.name) + (b.blockLabel ? ` · блок ${b.blockLabel}` : '');
}
const unitM = () => UNIT_M[S.plan.unit] || 0.001;

/* ---------- элементы ---------- */
function nextNo(block, floor) {
  let n = 0;
  for (const i of S.items) if (i.block === block && i.floor === floor && i.kind !== 'sketch') n = Math.max(n, i.no || 0);
  return n + 1;
}
function autoDesign(it) {
  if (it.designManual) return;
  if (it.kind === 'point') {
    it.design = S.settings.floorH > 0 && it.toFloor != null ? Math.abs(it.floor - it.toFloor) * S.settings.floorH : null;
  } else if (it.kind === 'line') {
    it.design = Math.hypot(it.x2 - it.x, it.y2 - it.y) * unitM();
  } else if (it.kind === 'seg') {
    const sg = wallsOf(it.block).byKey.get(it.key); if (sg) it.design = sg.len;
  }
}
function addItem(it) {
  pushUndo();
  Object.assign(it, { id: uid(), block: S.block, floor: S.floor, t: Date.now() });
  if (it.kind !== 'sketch') {
    it.no = nextNo(S.block, S.floor);
    it.dir = S.dir;
    it.toFloor = S.toFloor;
    it.value = it.value ?? null;
    autoDesign(it);
  }
  S.items.push(it);
  save();
  return it;
}
function removeItem(id) {
  pushUndo();
  S.items = S.items.filter((i) => i.id !== id);
  if (S.selId === id) select(null);
  if (S.selSeg) refreshSheet();
  save(); draw();
}
const visibleItems = () => S.items.filter((i) => i.block === S.block && (i.floor === S.floor || S.settings.otherFloors));
const curItems = () => S.items.filter((i) => i.block === S.block && i.floor === S.floor);

/* ---------- приём замера (авто-запись) ---------- */
function onMeasure(meters, src) {
  S.viewFollow = true; // после замера вид подстраивается под текущую линию
  if (!blk()) { toast('Сначала создайте лист: «+» вверху'); return; }
  // лазер «спереди»: вычитаем длину прибора
  if (S.settings.laserRef === 'front') meters = Math.max(0, Math.round((meters - (S.settings.laserOffset ?? 0.13)) * 10000) / 10000);
  S.lastMeasure = { v: meters, src };
  const lb = $('lastBox');
  lb.hidden = false;
  $('lastVal').textContent = fmt(meters);
  $('lastSrc').textContent = src === 'manual' ? 'вручную' : 'лазер';
  lb.classList.remove('flash'); void lb.offsetWidth; lb.classList.add('flash');

  let target = null;
  const sel = S.items.find((i) => i.id === S.selId);
  if (S.armedId) target = S.items.find((i) => i.id === S.armedId);
  if (S.tool === 'sketch') {
    if (S.skm && skmRecord(meters)) return;
    if (!S.draft || !S.draft.pts.length) { toast(`${fmt(meters)} м — сначала нажмите на план (начало линии)`); return; }
    sketchAppend(meters);
    return;
  }
  if (!target && S.selSeg && !sel) { recordSeg(S.selSeg, meters, src); return; }
  if (!target && !sel && S.tool === 'walls') { const k = firstOpenSeg(); if (k) { S.selSeg = k; recordSeg(k, meters, src); return; } }
  if (!target && sel && sel.kind !== 'sketch' && sel.value == null) target = sel;
  if (!target) target = curItems().filter((i) => i.kind !== 'sketch' && i.value == null).sort((a, b) => a.t - b.t)[0];

  if (target) {
    pushUndo();
    target.value = meters;
    target.src = src;
    target.mt = Date.now();
    S.armedId = null;
    toast(`${target.kind === 'line' ? 'Размер' : 'Точка'} №${target.no}: ${fmt(meters)} м`);
  } else {
    // новая точка в центре экрана — её можно перетащить на место
    const c = screenToWorld(cv.clientWidth / 2, cv.clientHeight / 2);
    const k = curItems().filter((i) => i.free).length;
    target = addItem({ kind: 'point', x: c.x + k * 60 / V().s, y: c.y - k * 60 / V().s, value: meters, src, mt: Date.now(), free: true });
    toast(`Записано ${fmt(meters)} м — перетащите точку №${target.no} на место`);
  }
  feedback();
  select(target.id);
  save(); draw();
}
let actx = null;
function feedback() {
  if (!S.settings.beep) return;
  try { navigator.vibrate?.(60); } catch (e) { /* */ }
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 1320; g.gain.value = 0.08;
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.09);
  } catch (e) { /* */ }
}

/* ---------- холст и вид ---------- */
const cv = $('cv');
const ctx = cv.getContext('2d');
let DPR = 1;
let lastSize = null;
function V() {
  if (!S.views[S.block]) S.views[S.block] = fitView(blk());
  return S.views[S.block];
}
/** Рамка для показа: на пустом листе — по начерченным комнатам */
function viewBox(b) {
  if (!b.blank) return b.bbox;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of S.items) {
    if (it.block !== b.name || it.floor !== S.floor || it.kind !== 'sketch') continue;
    for (let i = 0; i < it.pts.length; i += 2) { x0 = Math.min(x0, it.pts[i]); x1 = Math.max(x1, it.pts[i]); y0 = Math.min(y0, it.pts[i + 1]); y1 = Math.max(y1, it.pts[i + 1]); }
  }
  if (!isFinite(x0)) return b.bbox;
  const mg = 1.5 / unitM();
  const minW = 8 / unitM();
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = Math.max((x1 - x0) / 2 + mg, minW / 2), hh = Math.max((y1 - y0) / 2 + mg, minW / 3);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}
function fitView(b, w = cv.clientWidth, h = cv.clientHeight, pad = 36) {
  const [x0, y0, x1, y1] = viewBox(b);
  const s = Math.min((w - pad * 2) / (x1 - x0 || 1), (h - pad * 2) / (y1 - y0 || 1));
  return { s, ox: w / 2 - ((x0 + x1) / 2) * s, oy: h / 2 + ((y0 + y1) / 2) * s };
}
// вид: масштаб s, сдвиг ox/oy и поворот rot (радианы) — поворачивается только план, кнопки на месте
const w2s = (x, y, v = V()) => {
  const X = x * v.s, Y = -y * v.s, r = v.rot || 0;
  if (!r) return { x: X + v.ox, y: Y + v.oy };
  const c = Math.cos(r), sn = Math.sin(r);
  return { x: X * c - Y * sn + v.ox, y: X * sn + Y * c + v.oy };
};
const screenToWorld = (sx, sy, v = V()) => {
  const dx = sx - v.ox, dy = sy - v.oy, r = v.rot || 0;
  if (!r) return { x: dx / v.s, y: -dy / v.s };
  const c = Math.cos(r), sn = Math.sin(r);
  return { x: (dx * c + dy * sn) / v.s, y: -(-dx * sn + dy * c) / v.s };
};
/** Поставить мировую точку (x,y) в экранную (sx,sy), не меняя масштаб и поворот */
function placeWorldAt(v, x, y, sx, sy) {
  const p = w2s(x, y, v); v.ox += sx - p.x; v.oy += sy - p.y;
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * DPR);
  cv.height = Math.round(r.height * DPR);
  if (lastSize && r.width && r.height) {
    // план не прыгает, когда снизу появляется/скрывается панель
    for (const v of Object.values(S.views)) { v.ox += (r.width - lastSize.w) / 2; }
  } else S.views = {};
  if (r.width && r.height) lastSize = { w: r.width, h: r.height };
  draw();
}

const RED = '#e03131';   // загруженный чертёж
const GREEN = '#16a34a'; // мои замеры и линии
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function palette() {
  return {
    paper: cssVar('--paper'), ink: cssVar('--ink'), ink2: cssVar('--ink2'), line: cssVar('--line'),
    card: cssVar('--card'), accent: cssVar('--accent'), accent2: cssVar('--accent2'),
    ok: cssVar('--ok'), warn: cssVar('--warn'), bad: cssVar('--bad'),
    dark: document.documentElement.dataset.theme === 'dark',
  };
}

// предрасчёт: что считать колоннами (малые замкнутые контуры)
function prepBlock(b) {
  if (b._prep) return b._prep;
  const diag = Math.hypot(b.bbox[2] - b.bbox[0], b.bbox[3] - b.bbox[1]);
  const verts = [];
  const polys = b.polys.map((q) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < q.p.length; i += 2) {
      x0 = Math.min(x0, q.p[i]); x1 = Math.max(x1, q.p[i]); y0 = Math.min(y0, q.p[i + 1]); y1 = Math.max(y1, q.p[i + 1]);
      verts.push(q.p[i], q.p[i + 1]);
    }
    const n = q.p.length;
    const closed = !!q.z || (n >= 8 && Math.hypot(q.p[0] - q.p[n - 2], q.p[1] - q.p[n - 1]) < 1e-6 * diag + 0.01);
    const size = Math.max(x1 - x0, y1 - y0);
    const column = closed && size < diag * 0.03 && Math.min(x1 - x0, y1 - y0) > size * 0.5;
    return { ...q, z: closed ? 1 : 0, column };
  });
  const walls = buildWalls(polys, unitM(), { minLen: S.settings.wallMin, columns: S.settings.wallColumns });
  b._prep = { polys, verts, diag, walls };
  return b._prep;
}

function drawPlan(c, b, v, pal, opts = {}) {
  const P = prepBlock(b);
  const lw = opts.lw || 1;
  // сетка-точки
  if (!opts.noGrid) {
    const step = niceStep(80 / v.s);
    const W0 = c.canvas.width / (opts.dpr || DPR), H0 = c.canvas.height / (opts.dpr || DPR);
    const cs = [screenToWorld(0, 0, v), screenToWorld(W0, 0, v), screenToWorld(0, H0, v), screenToWorld(W0, H0, v)];
    const a = { x: Math.min(...cs.map((q) => q.x)), y: Math.max(...cs.map((q) => q.y)) }, z = { x: Math.max(...cs.map((q) => q.x)), y: Math.min(...cs.map((q) => q.y)) };
    if ((z.x - a.x) / step < 200 && (a.y - z.y) / step < 300) {
      c.fillStyle = pal.dark ? 'rgba(148,160,184,.18)' : 'rgba(27,35,51,.12)';
      for (let x = Math.floor(a.x / step) * step; x < z.x; x += step)
        for (let y = Math.floor(z.y / step) * step; y < a.y; y += step) {
          const p = w2s(x, y, v); c.fillRect(p.x - 1, p.y - 1, 2, 2);
        }
    }
  }
  // загруженный чертёж — подложка красным («тень», не мешает замеру)
  if (!P.polys.length || !S.settings.layers.drawing) return;
  c.save();
  c.globalAlpha = opts.alpha ?? 0.5;
  c.lineJoin = 'round'; c.lineCap = 'round';
  c.strokeStyle = RED;
  c.lineWidth = 1.2 * lw;
  c.beginPath();
  for (const q of P.polys) { if (q.column) continue; path(c, q.p, v); if (q.z) c.closePath(); }
  c.stroke();
  c.fillStyle = RED; c.globalAlpha = (opts.alpha ?? 0.5) * 0.6;
  for (const q of P.polys) {
    if (!q.column) continue;
    c.beginPath(); path(c, q.p, v); c.closePath(); c.fill();
  }
  // тексты чертежа — постоянного размера на экране
  c.fillStyle = RED; c.globalAlpha = (opts.alpha ?? 0.5) * 0.9;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.font = '10px system-ui, sans-serif';
  for (const t of b.texts || []) {
    if (t.h * v.s < 4) continue;
    const p = w2s(t.x, t.y, v);
    c.fillText(t.t, p.x, p.y);
  }
  c.restore();
}
/** Ближайший другой этаж этого листа с данными — показывается бледной тенью */
function shadowFloor(block = S.block, floor = S.floor) {
  const fl = [...new Set(S.items.filter((i) => i.block === block && i.floor !== floor).map((i) => i.floor))];
  if (!fl.length) return null;
  fl.sort((a, b) => Math.abs(a - floor) - Math.abs(b - floor) || b - a);
  return fl[0];
}
function drawShadow(c, b, v, pal) {
  if (!S.settings.layers.shadow) return null;
  const f = shadowFloor(b.name, S.floor);
  if (f == null) return null;
  c.save();
  c.strokeStyle = pal.dark ? 'rgba(148,163,184,.45)' : 'rgba(71,85,105,.32)';
  c.lineWidth = 2; c.lineJoin = 'round';
  for (const it of S.items) {
    if (it.block !== b.name || it.floor !== f || it.kind !== 'sketch') continue;
    c.beginPath(); path(c, it.pts, v); if (it.closed) c.closePath(); c.stroke();
    if (S.settings.layers.shadowDims && it.dirs) for (const sg of sketchSegs(it)) {
      if (it.lens[sg.k] == null && it.noDims) continue;
      const a = w2s(sg.ax, sg.ay, v), e = w2s(sg.bx, sg.by, v);
      if (Math.hypot(e.x - a.x, e.y - a.y) < 34) continue;
      let rot = Math.atan2(e.y - a.y, e.x - a.x);
      if (rot > Math.PI / 2) rot -= Math.PI; if (rot < -Math.PI / 2) rot += Math.PI;
      const m0 = w2s((sg.ax + sg.bx) / 2, (sg.ay + sg.by) / 2, v), m1 = w2s((sg.ax + sg.bx) / 2 - sg.nx, (sg.ay + sg.by) / 2 - sg.ny, v);
      let nx = m1.x - m0.x, ny = m1.y - m0.y; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      pill(c, m0.x + nx * 13, m0.y + ny * 13, fmt(sg.len), pal.dark ? 'rgba(71,85,105,.75)' : 'rgba(148,163,184,.55)', '#fff', { rot, size: 10, shadow: false, bold: false });
    }
  }
  if (!b.blank) {
    const m = segMapFor(b.name, f);
    for (const room of prepBlock(b).walls.rooms) {
      if (!room.segs.some((q) => m.get(q.key)?.value != null)) continue;
      const ab = asBuilt(room, (q) => m.get(q.key), unitM());
      c.beginPath(); path(c, ab.pts, v); c.stroke();
    }
  }
  c.restore();
  return f;
}
function path(c, p, v) {
  for (let i = 0; i < p.length; i += 2) {
    const q = w2s(p[i], p[i + 1], v);
    i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y);
  }
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (p * m >= x) return p * m;
  return p * 10;
}

function devClass(it) {
  if (it.merged || it.value == null || it.design == null) return null;
  const d = Math.abs(it.value - it.design);
  return d <= 0.01 ? 'ok' : d <= 0.03 ? 'warn' : 'bad';
}

function pill(c, x, y, text, bg, fg, opts = {}) {
  c.font = `${opts.bold === false ? 600 : 800} ${opts.size || 14}px system-ui, -apple-system, sans-serif`;
  const w = c.measureText(text).width + 14, h = (opts.size || 14) + 10;
  c.save();
  c.translate(x, y);
  if (opts.rot) c.rotate(opts.rot);
  c.fillStyle = bg;
  c.shadowColor = 'rgba(0,0,0,.18)'; c.shadowBlur = opts.shadow === false ? 0 : 6; c.shadowOffsetY = 1;
  roundRect(c, -w / 2, -h / 2, w, h, h / 2); c.fill();
  c.shadowColor = 'transparent';
  if (opts.border) { c.strokeStyle = opts.border; c.lineWidth = 2; c.stroke(); }
  c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 0, 1);
  c.restore();
  return { w, h };
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

function drawItems(c, v, pal, items, opts = {}) {
  const now = performance.now();
  const sorted = [...items].sort((a, b) => (a.floor === S.floor) - (b.floor === S.floor));
  for (const it of sorted) {
    if (it.kind === 'seg' || it.kind === 'open' || it.kind === 'text') continue;
    const other = it.floor !== S.floor;
    const sel = !opts.export && it.id === S.selId;
    c.globalAlpha = other ? 0.28 : 1;
    const cls = devClass(it);
    const valCol = cls ? pal[cls] : pal.accent;
    if (it.kind === 'sketch') {
      const exact = it.closed && !(it.gap >= 0.005);
      c.strokeStyle = sel ? pal.accent2 : GREEN;
      c.lineWidth = sel ? 3.2 : 2.4;
      c.setLineDash([]);
      c.beginPath(); path(c, it.pts, v); if (exact) c.closePath(); c.stroke();
      if (it.closed && !exact) {
        // невязка: углы не сошлись — пунктир от конца к началу
        const n = it.pts.length, a = w2s(it.pts[n - 2], it.pts[n - 1], v), b = w2s(it.pts[0], it.pts[1], v);
        c.strokeStyle = '#ea580c'; c.lineWidth = 2; c.setLineDash([5, 4]);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.setLineDash([]);
        if (S.settings.layers.dims) pill(c, (a.x + b.x) / 2, (a.y + b.y) / 2 - 14, `невязка ${fmt(it.gap)} м`, '#ea580c', '#fff', { size: 11, shadow: false });
      }
      // текущая стена замера
      if (S.skm?.id === it.id && !opts.export) {
        const sg = sketchSegs(it)[S.skm.i];
        if (sg) {
          const a = w2s(sg.ax, sg.ay, v), b = w2s(sg.bx, sg.by, v), k = (performance.now() % 1200) / 1200;
          c.strokeStyle = pal.accent2; c.globalAlpha = 0.25 + 0.25 * Math.sin(k * Math.PI * 2); c.lineWidth = 14;
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
          c.globalAlpha = 1; c.lineWidth = 5; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
          requestDraw();
        }
      }
      if (S.settings.layers.dims) sketchLabels(c, it, v, pal, sel ? pal.accent2 : GREEN);
      if (it.closed && S.settings.layers.areas) {
        const cp = polyCentroid(it.pts), q = w2s(cp.x, cp.y, v);
        const no = curItems().filter((o) => o.kind === 'sketch' && o.closed).indexOf(it) + 1;
        const done = !it.lens || it.lens.every((x) => x != null);
        pill(c, q.x, q.y, `№${no} · ${fmt(polyArea(it.pts) * unitM() * unitM())} м²${done ? '' : ' *'}`, pal.card, pal.ink, { size: 12, border: done ? GREEN : pal.warn });
      }
    } else if (it.kind === 'line') {
      const a = w2s(it.x, it.y, v), b = w2s(it.x2, it.y2, v);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const col = sel ? pal.accent2 : it.value == null ? pal.warn : pal.accent;
      c.strokeStyle = col; c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      // засечки
      for (const p of [a, b]) {
        c.beginPath();
        c.moveTo(p.x + Math.cos(ang + Math.PI / 4) * 8, p.y + Math.sin(ang + Math.PI / 4) * 8);
        c.lineTo(p.x - Math.cos(ang + Math.PI / 4) * 8, p.y - Math.sin(ang + Math.PI / 4) * 8);
        c.stroke();
        c.beginPath(); c.arc(p.x, p.y, 3, 0, Math.PI * 2); c.fillStyle = col; c.fill();
      }
      let rot = ang; if (rot > Math.PI / 2) rot -= Math.PI; if (rot < -Math.PI / 2) rot += Math.PI;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const txt = it.value == null ? `№${it.no} · ?` : `${fmt(it.value)}`;
      const off = 16;
      pill(c, mx + Math.sin(rot) * off, my - Math.cos(rot) * off, txt, it.value == null ? pal.card : valCol, it.value == null ? pal.warn : '#fff', { rot, border: it.value == null ? pal.warn : sel ? pal.accent2 : null });
      if (it.design != null && (sel || opts.export)) {
        c.font = '600 11px system-ui, sans-serif';
        c.save(); c.translate(mx - Math.sin(rot) * 14, my + Math.cos(rot) * 14); c.rotate(rot);
        c.fillStyle = pal.ink2; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(`по чертежу ${fmt(it.design)}`, 0, 0); c.restore();
      }
      if (sel) { handle(c, a, pal); handle(c, b, pal); }
    } else {
      const p = w2s(it.x, it.y, v);
      const pending = it.value == null;
      // пульсация ожидания
      if (pending && !opts.export && !other) {
        const k = (now % 1400) / 1400;
        c.beginPath(); c.arc(p.x, p.y, 10 + k * 22, 0, Math.PI * 2);
        c.strokeStyle = pal.warn; c.globalAlpha = 1 - k; c.lineWidth = 2; c.stroke(); c.globalAlpha = 1;
      }
      c.beginPath(); c.arc(p.x, p.y, 11, 0, Math.PI * 2);
      c.fillStyle = sel ? pal.accent2 : pending ? pal.warn : valCol; c.fill();
      c.lineWidth = 3; c.strokeStyle = pal.card; c.stroke();
      // стрелка направления
      c.fillStyle = '#fff';
      c.beginPath();
      if (it.dir === 'up') { c.moveTo(p.x, p.y - 6); c.lineTo(p.x + 5, p.y + 3); c.lineTo(p.x - 5, p.y + 3); }
      else { c.moveTo(p.x, p.y + 6); c.lineTo(p.x + 5, p.y - 3); c.lineTo(p.x - 5, p.y - 3); }
      c.fill();
      // подпись
      const label = pending ? `№${it.no} · ожидает` : `№${it.no}  ${fmt(it.value)} м`;
      const { w } = measurePill(c, label);
      pill(c, p.x + 16 + w / 2, p.y - 16, label, pending ? pal.card : sel ? pal.accent2 : pal.card, pending ? pal.warn : sel ? '#fff' : pal.ink,
        { border: pending ? pal.warn : sel ? null : valCol, size: 13 });
      if (other || opts.export) {
        c.font = '600 11px system-ui, sans-serif'; c.fillStyle = pal.ink2; c.textAlign = 'left';
        c.fillText(`эт.${it.floor}${it.dir === 'up' ? '↑' : '↓'}${it.toFloor ?? ''}`, p.x + 16, p.y + 4);
      }
    }
  }
  c.globalAlpha = 1;
}
function sketchLabels(c, it, v, pal, col) {
  for (const sg of sketchSegs(it)) {
    const a = w2s(sg.ax, sg.ay, v), e = w2s(sg.bx, sg.by, v);
    const Lp = Math.hypot(e.x - a.x, e.y - a.y);
    if (Lp < 16) continue;
    if (!sg.measured && it.noDims) continue; // копия «только линии» — размеры появятся после замера
    let rot = Math.atan2(e.y - a.y, e.x - a.x);
    if (rot > Math.PI / 2) rot -= Math.PI; if (rot < -Math.PI / 2) rot += Math.PI;
    // подпись внутри комнаты
    const m0 = w2s((sg.ax + sg.bx) / 2, (sg.ay + sg.by) / 2, v), m1 = w2s((sg.ax + sg.bx) / 2 + sg.nx, (sg.ay + sg.by) / 2 + sg.ny, v);
    let nx = m1.x - m0.x, ny = m1.y - m0.y; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const txt = sg.measured ? fmt(sg.len) : '≈' + fmt(sg.len);
    pill(c, m0.x + nx * 14, m0.y + ny * 14, txt, sg.measured ? col : pal.card, sg.measured ? '#fff' : pal.ink2, { rot, size: 11, shadow: false, border: sg.measured ? null : pal.line });
  }
}
function measurePill(c, text) {
  c.font = '800 13px system-ui, -apple-system, sans-serif';
  return { w: c.measureText(text).width + 14 };
}
function handle(c, p, pal) {
  c.beginPath(); c.arc(p.x, p.y, 8, 0, Math.PI * 2);
  c.fillStyle = pal.card; c.fill(); c.lineWidth = 2.5; c.strokeStyle = pal.accent2; c.stroke();
}

let snapMark = null;
function draw() {
  if (!S.plan || !lastSize) return;
  if (!blk()) { drawEmpty(); return; }
  if (stepRotation()) requestDraw();
  syncCompass();
  const pal = palette();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = pal.paper;
  ctx.fillRect(0, 0, cv.width, cv.height);
  const v = V();
  drawPlan(ctx, blk(), v, pal);
  const shF = drawShadow(ctx, blk(), v, pal);
  drawThickWalls(ctx, S.block, S.floor, v, pal);
  drawWalls(ctx, blk(), v, pal);
  if (S.settings.layers.openings) drawOpenings(ctx, blk(), v, pal);
  drawItems(ctx, v, pal, visibleItems());
  drawTexts(ctx, S.block, S.floor, v, pal);
  drawRuler(ctx, v, pal);
  if (S.turnArm) drawTurnTip(ctx, v, pal);
  drawMini(pal);
  // черновик
  if (S.draft) {
    const d = S.draft;
    ctx.strokeStyle = pal.accent2; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]);
    ctx.beginPath(); path(ctx, d.pts.concat(d.hover ? [d.hover.x, d.hover.y] : []), v); ctx.stroke(); ctx.setLineDash([]);
    for (let i = 0; i < d.pts.length; i += 2) handle(ctx, w2s(d.pts[i], d.pts[i + 1], v), pal);

    if (d.hover && d.pts.length >= 2) {
      const n = d.pts.length;
      const dx = d.hover.x - d.pts[n - 2], dy = d.hover.y - d.pts[n - 1];
      const L = Math.hypot(dx, dy) * unitM();
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI; if (ang < 0) ang += 360;
      const a = w2s(d.hover.x, d.hover.y, v);
      pill(ctx, a.x, a.y - 30, `${fmt(L)} м · ${ang.toFixed(1).replace('.', ',')}°`, pal.accent2, '#fff');
    }
  }
  drawSnapMark(ctx, v, pal);
  // масштабная линейка
  scaleBar(ctx, v, pal);
  if (shF != null) { ctx.fillStyle = pal.ink2; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`тень: ${shF} этаж`, leftFree(), cv.clientHeight - 42); }
  if (S.selSeg || curItems().some((i) => i.value == null && i.kind === 'point')) requestDraw();
  updateProgress();
  syncMbar();
}
let raf = 0;
function drawEmpty() {
  const pal = palette();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = pal.paper; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = pal.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.fillText('Нажмите «+» вверху — новый лист', cv.clientWidth / 2, cv.clientHeight / 2 - 12);
  ctx.font = '400 13px system-ui, sans-serif';
  ctx.fillText('(наименование, блок и этаж)', cv.clientWidth / 2, cv.clientHeight / 2 + 12);
  $('prog').hidden = true; $('mbar').hidden = true;
}
function requestDraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

/** Отступ слева для подписей внизу плана: правее левого пульта, если он доходит до низа */
function leftFree() {
  const pad = $('dirPad');
  if (!pad || !pad.offsetParent) return 14;
  const r = pad.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  return r.bottom > cr.bottom - 50 ? Math.round(r.right - cr.left + 10) : 14;
}
function scaleBar(c, v, pal) {
  const um = unitM();
  const target = 110 / v.s * um; // метров на 110px
  const m = niceStep(target);
  const px = (m / um) * v.s;
  const x = leftFree(), y = cv.clientHeight - 18;
  c.strokeStyle = pal.ink; c.lineWidth = 2;
  c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x, y); c.lineTo(x + px, y); c.lineTo(x + px, y - 5); c.stroke();
  c.fillStyle = pal.ink; c.font = '700 11px system-ui, sans-serif'; c.textAlign = 'left';
  c.fillText(fmt(m) + ' м', x + 4, y - 7);
}

/* ---------- привязка (как в AutoCAD) и попадание ---------- */
function snapSegments() {
  const P = prepBlock(blk());
  if (!P.segFlat) {
    const a = [];
    for (const q of P.polys) for (let i = 0; i + 3 < q.p.length; i += 2) a.push(q.p[i], q.p[i + 1], q.p[i + 2], q.p[i + 3]);
    P.segFlat = a;
  }
  const extra = [];
  for (const it of curItems()) {
    if (it.kind === 'line') extra.push(it.x, it.y, it.x2, it.y2);
    else if (it.kind === 'sketch') for (let i = 0; i + 3 < it.pts.length; i += 2) extra.push(it.pts[i], it.pts[i + 1], it.pts[i + 2], it.pts[i + 3]);
  }
  return [P.segFlat, extra];
}
/** sx,sy — экранная точка; from — предыдущая точка (мир) для «Нормали» и «Орто»; skipId — не привязываться к себе */
function snap(sx, sy, from) {
  const v = V();
  let w = screenToWorld(sx, sy, v);
  snapMark = null;
  const M = S.settings.snapModes;
  const R = 16 / v.s;
  if (S.settings.snap) {
    let best = null, bd = R, rank = 9;
    const cand = (x, y, type, rk) => {
      const d = Math.hypot(x - w.x, y - w.y);
      if (d <= R && (rk < rank || (rk === rank && d < bd))) { best = { x, y, type }; bd = d; rank = rk; }
    };
    for (const arr of snapSegments()) {
      for (let i = 0; i < arr.length; i += 4) {
        const ax = arr[i], ay = arr[i + 1], bx = arr[i + 2], by = arr[i + 3];
        // быстрый отсев
        if (Math.min(ax, bx) - R > w.x || Math.max(ax, bx) + R < w.x || Math.min(ay, by) - R > w.y || Math.max(ay, by) + R < w.y) continue;
        if (M.end) { cand(ax, ay, 'end', 0); cand(bx, by, 'end', 0); }
        if (M.mid) cand((ax + bx) / 2, (ay + by) / 2, 'mid', 1);
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        if (M.perp && from) {
          const t = ((from.x - ax) * dx + (from.y - ay) * dy) / L2;
          if (t >= 0 && t <= 1) cand(ax + t * dx, ay + t * dy, 'perp', 2);
        }
        if (M.near) {
          let t = ((w.x - ax) * dx + (w.y - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
          cand(ax + t * dx, ay + t * dy, 'near', 3);
        }
      }
    }
    if (best) { snapMark = best; return { x: best.x, y: best.y }; }
  }
  if (S.settings.polar && from) {
    // полярные углы: шаг 5°, линия слежения
    const dx = w.x - from.x, dy = w.y - from.y, L = Math.hypot(dx, dy);
    if (L > 0) {
      const a = Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 5) * 5, r = (a * Math.PI) / 180;
      const d = dx * Math.cos(r) + dy * Math.sin(r);
      w = { x: from.x + Math.cos(r) * d, y: from.y + Math.sin(r) * d };
      snapMark = { x: w.x, y: w.y, type: 'polar', from, ang: ((a % 360) + 360) % 360 };
    }
  } else if (S.settings.ortho && from) {
    const dx = w.x - from.x, dy = w.y - from.y;
    w = Math.abs(dx) >= Math.abs(dy) ? { x: w.x, y: from.y } : { x: from.x, y: w.y };
    snapMark = { x: w.x, y: w.y, type: 'ortho' };
  }
  return w;
}
function drawSnapMark(c, v, pal) {
  if (!snapMark) return;
  const p = w2s(snapMark.x, snapMark.y, v);
  if (snapMark.type === 'polar') {
    const f = w2s(snapMark.from.x, snapMark.from.y, v);
    const dx = p.x - f.x, dy = p.y - f.y, L = Math.hypot(dx, dy) || 1;
    c.save(); c.strokeStyle = pal.accent2; c.lineWidth = 1; c.setLineDash([6, 5]);
    c.beginPath(); c.moveTo(f.x, f.y); c.lineTo(f.x + (dx / L) * 2000, f.y + (dy / L) * 2000); c.stroke(); c.setLineDash([]);
    pill(c, p.x + 26, p.y + 26, `${snapMark.ang}°`, pal.accent2, '#fff', { size: 11, shadow: false });
    c.restore();
    return;
  }
  c.save();
  c.strokeStyle = '#16a34a'; c.lineWidth = 2.2;
  c.beginPath();
  const r = 8;
  switch (snapMark.type) {
    case 'end': c.rect(p.x - r, p.y - r, r * 2, r * 2); break;
    case 'mid': c.moveTo(p.x, p.y - r - 1); c.lineTo(p.x + r + 1, p.y + r); c.lineTo(p.x - r - 1, p.y + r); c.closePath(); break;
    case 'perp': c.moveTo(p.x - r, p.y - r); c.lineTo(p.x - r, p.y + r); c.lineTo(p.x + r, p.y + r); c.moveTo(p.x - r, p.y); c.lineTo(p.x, p.y); c.lineTo(p.x, p.y + r); break;
    case 'near': c.moveTo(p.x - r, p.y - r); c.lineTo(p.x + r, p.y - r); c.lineTo(p.x - r, p.y + r); c.lineTo(p.x + r, p.y + r); c.closePath(); break;
    default: c.strokeStyle = pal.accent2; c.moveTo(p.x - r, p.y); c.lineTo(p.x + r, p.y); c.moveTo(p.x, p.y - r); c.lineTo(p.x, p.y + r);
  }
  c.stroke();
  const names = { end: 'Конточка', mid: 'Середина', perp: 'Нормаль', near: 'Ближайшая', ortho: 'Орто' };
  if (names[snapMark.type]) {
    c.font = '700 11px system-ui, sans-serif'; c.fillStyle = snapMark.type === 'ortho' ? pal.accent2 : '#16a34a';
    c.textAlign = 'left'; c.fillText(names[snapMark.type], p.x + 12, p.y + 22);
  }
  c.restore();
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function hit(sx, sy) {
  const v = V();
  const op = pickOpen(sx, sy);
  if (op) return { it: op, part: 'body' };
  const items = curItems().filter((i) => i.kind !== 'seg' && i.kind !== 'open').reverse();
  const sel = items.find((i) => i.id === S.selId);
  // ручки выбранного
  if (sel) {
    if (sel.kind === 'line') {
      for (const [k, x, y] of [['a', sel.x, sel.y], ['b', sel.x2, sel.y2]]) {
        const p = w2s(x, y, v); if (Math.hypot(p.x - sx, p.y - sy) < 20) return { it: sel, part: k };
      }
    }
    if (sel.kind === 'sketch') {
      for (let i = 0; i < sel.pts.length; i += 2) {
        const p = w2s(sel.pts[i], sel.pts[i + 1], v); if (Math.hypot(p.x - sx, p.y - sy) < 20) return { it: sel, part: i };
      }
    }
  }
  for (const it of items) {
    if (it.kind === 'point') {
      const p = w2s(it.x, it.y, v);
      if (Math.hypot(p.x - sx, p.y - sy) < 22) return { it, part: 'body' };
      const { w } = measurePill(ctx, 'x'.repeat(10));
      if (sx > p.x + 8 && sx < p.x + 16 + w + 30 && Math.abs(sy - (p.y - 16)) < 14) return { it, part: 'body' };
    } else if (it.kind === 'line') {
      const a = w2s(it.x, it.y, v), b = w2s(it.x2, it.y2, v);
      if (distSeg(sx, sy, a.x, a.y, b.x, b.y) < 14) return { it, part: 'body' };
      if (Math.hypot((a.x + b.x) / 2 - sx, (a.y + b.y) / 2 - sy) < 30) return { it, part: 'body' };
    } else if (it.kind === 'sketch') {
      for (let i = 0; i + 3 < it.pts.length; i += 2) {
        const a = w2s(it.pts[i], it.pts[i + 1], v), b = w2s(it.pts[i + 2], it.pts[i + 3], v);
        if (distSeg(sx, sy, a.x, a.y, b.x, b.y) < 12) return { it, part: 'body' };
      }
    }
  }
  return null;
}

/* ---------- жесты ---------- */
const ptrs = new Map();
let gesture = null;
function local(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

cv.addEventListener('pointerdown', (e) => {
  if (!blk()) { openNewSheet(); return; }
  cv.setPointerCapture(e.pointerId);
  const p = local(e);
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v: { ...V() } };
    return;
  }
  if (ptrs.size > 2) return;
  if (S.tool === 'walls' && S.selSeg && !S.draft) {
    const sh = slopeHandle();
    if (sh) {
      const q = w2s(sh.ex, sh.ey);
      if (Math.hypot(q.x - p.x, q.y - p.y) < 26) { gesture = { type: 'slope', sh, start: p, moved: false }; return; }
    }
  }
  if (S.turnArm) { pushUndo(); const t = turnToward(p.x, p.y); if (t) toast('Поворот: ' + t, true); gesture = { type: 'turn', start: p, moved: true }; requestDraw(); return; }
  // в режимах черчения/проёмов/рулетки нажатие идёт в инструмент; перетаскивать можно только двери и окна
  const freeHit = ['select', 'point', 'line', 'walls'].includes(S.tool) && !S.openArm;
  const op0 = !S.draft ? pickOpen(p.x, p.y) : null;
  let h = op0 ? { it: op0, part: 'body' } : S.draft || !freeHit ? null : hit(p.x, p.y);
  if (h && S.tool === 'walls' && h.it.kind === 'sketch') h = null; // в «Стенах» нарисованная стена — нажатие для замера
  if (h) {
    if (h.it.kind === 'open') {
      const now2 = Date.now();
      S.openEdit = lastOpenTap.id === h.it.id && now2 - lastOpenTap.t < 380;
      lastOpenTap = { id: h.it.id, t: now2 };
      select(h.it.id);
    } else if (S.selId !== h.it.id) select(h.it.id);
    gesture = { type: 'drag', h, start: p, moved: false, orig: JSON.parse(JSON.stringify(h.it)) };
  } else {
    gesture = { type: 'pan', start: p, v: { ...V() }, moved: false };
  }
});
cv.addEventListener('pointermove', (e) => {
  const p = local(e);
  if (S.draft && ptrs.size === 0) { if (e.pointerType === 'mouse') { S.draft.hover = snap(p.x, p.y, draftFrom()); requestDraw(); } return; }
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, p);
  if (!gesture) return;
  if (gesture.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = d / gesture.d;
    const v0 = gesture.v, v = V();
    v.s = v0.s * k;
    v.ox = c.x - (gesture.c.x - v0.ox) * k;
    v.oy = c.y - (gesture.c.y - v0.oy) * k;
    requestDraw();
    return;
  }
  if (gesture.type === 'turn') { const t = turnToward(p.x, p.y); if (t) toast('Поворот: ' + t, true); requestDraw(); return; }
  const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 7) return;
  if (!gesture.moved) { gesture.moved = true; if (gesture.type === 'drag' || gesture.type === 'slope') pushUndo(); }
  if (gesture.type === 'slope') {
    const { sh } = gesture;
    const w = screenToWorld(p.x, p.y);
    const base = Math.atan2(sh.seg.by - sh.seg.ay, sh.seg.bx - sh.seg.ax);
    let abs = Math.atan2(w.y - sh.sy, w.x - sh.sx);
    if (S.settings.polar) abs = Math.round(abs / (Math.PI / 36)) * (Math.PI / 36);
    else if (S.settings.ortho) abs = Math.round(abs / (Math.PI / 2)) * (Math.PI / 2);
    let ang = ((abs - base) * 180) / Math.PI;
    while (ang > 180) ang -= 360; while (ang <= -180) ang += 360;
    ang = Math.round(ang * 10) / 10;
    if (Math.abs(ang) < 0.2) ang = 0;
    const it = segItem(sh.seg.key, true);
    it.ang = ang;
    refreshSheet(); requestDraw();
    return;
  }
  if (gesture.type === 'pan') {
    const v = V(); v.ox = gesture.v.ox + dx; v.oy = gesture.v.oy + dy;
    if (S.draft && e.pointerType === 'mouse') S.draft.hover = snap(p.x, p.y, draftFrom());
    requestDraw();
  } else if (gesture.type === 'drag') {
    const { it, part } = gesture.h, o = gesture.orig, s = V().s;
    const ddx = dx / s, ddy = -dy / s;
    if (part === 'body') {
      if (it.kind === 'open') {
        const sg = wallDesc(it.block, it.floor, it.key);
        const w = screenToWorld(p.x, p.y);
        const L2 = (sg.bx - sg.ax) ** 2 + (sg.by - sg.ay) ** 2;
        it.t = Math.max(0, Math.min(1, ((w.x - sg.ax) * (sg.bx - sg.ax) + (w.y - sg.ay) * (sg.by - sg.ay)) / L2));
        it.manual = true;
      } else if (it.kind === 'point') {
        const w = snap(w2s(o.x, o.y).x + dx, w2s(o.x, o.y).y + dy);
        it.x = w.x; it.y = w.y; it.free = false;
      } else if (it.kind === 'line') {
        it.x = o.x + ddx; it.y = o.y + ddy; it.x2 = o.x2 + ddx; it.y2 = o.y2 + ddy;
      } else if (it.kind === 'sketch') {
        if (it.dirs) { it.start = [o.start[0] + ddx, o.start[1] + ddy]; rebuildSketch(it); }
        else it.pts = o.pts.map((q, i) => q + (i % 2 ? ddy : ddx));
      }
    } else if (part === 'a' || part === 'b') {
      const ox = part === 'a' ? o.x : o.x2, oy = part === 'a' ? o.y : o.y2;
      const sp = w2s(ox, oy);
      const w = snap(sp.x + dx, sp.y + dy, part === 'a' ? { x: it.x2, y: it.y2 } : { x: it.x, y: it.y });
      if (part === 'a') { it.x = w.x; it.y = w.y; } else { it.x2 = w.x; it.y2 = w.y; }
      autoDesign(it);
    } else if (typeof part === 'number') {
      const sp = w2s(o.pts[part], o.pts[part + 1]);
      const w = snap(sp.x + dx, sp.y + dy, part >= 2 ? { x: it.pts[part - 2], y: it.pts[part - 1] } : null);
      it.pts[part] = w.x; it.pts[part + 1] = w.y;
    }
    requestDraw();
  }
});
function endPtr(e) {
  const p = local(e);
  const had = ptrs.has(e.pointerId);
  ptrs.delete(e.pointerId);
  if (!had || !gesture) return;
  if (gesture.type === 'pinch') { if (ptrs.size === 0) gesture = null; else gesture = { type: 'none' }; return; }
  const g = gesture; gesture = null;
  if (g.type === 'slope') { if (g.moved) { save(); hint(''); } draw(); return; }
  if (g.type === 'turn') { save(); draw(); return; }
  if (g.type === 'drag') {
    snapMark = null;
    if (g.moved) { save(); refreshSheet(); }
    else if (S.tool === 'select' || S.tool === 'point' || S.tool === 'line') { /* только выбор */ }
    draw();
    return;
  }
  if (g.type === 'pan' && !g.moved) tap(p);
  snapMark = null;
  draw();
}
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); gesture = null; });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = local(e), v = V();
  const k = Math.exp(-e.deltaY * 0.0015);
  v.ox = p.x - (p.x - v.ox) * k; v.oy = p.y - (p.y - v.oy) * k; v.s *= k;
  requestDraw();
}, { passive: false });
let lastTap = 0, lastTapP = null;
let lastOpenTap = { id: null, t: 0 };
function tap(p) {
  const now = Date.now();
  // двойное нажатие — только в то же место (быстрые нажатия по углам комнаты не должны обрывать линию)
  const dbl = now - lastTap < 320 && lastTapP && Math.hypot(p.x - lastTapP.x, p.y - lastTapP.y) < 24;
  lastTap = now; lastTapP = { x: p.x, y: p.y };
  if (S.openArm) {
    const it = placeOpening(S.openArm, p.x, p.y);
    if (it) { S.openArm = null; syncOpenPad(); }
    return;
  }
  if (S.tool === 'walls') {
    const sg = pickSeg(p.x, p.y);
    if (!sg) {
      selectSeg(null);
      const hs = pickSketchSeg(p.x, p.y, false, 26);
      if (hs) { S.tool = 'sketch'; syncToolUI(); remeasure(hs.it, hs.k); }
      else if (!hasDrawing()) toast('Нажмите на стену нарисованной комнаты', true);
      return;
    }
    if (S.session) { selectSeg(sg.key); return; }
    selectSeg(sg.key);
    const was = segItem(sg.key);
    if (was?.value != null) { toast(`Перемер: было ${fmt(was.value)} м — меряйте лазером. Нажмите мимо — выйти`, true); return; }
    ask(`Начинаем замер?\nКомната ${sg.room}, стена ${sg.wall} из ${sg.of}. Замеры с лазера будут записываться автоматически, стена за стеной, затем соседние комнаты.`, 'Да, начать').then((yes) => {
      if (!yes) return;
      S.session = true; S.settings.autoNext = true; S.sheetFull = false;
      refreshSheet(); draw();
      hint('Замер начат — меряйте лазером');
    });
    return;
  }
  if (S.tool === 'select') { select(null); return; }
  if (S.tool === 'ruler') { rulerTap(snap(p.x, p.y, S.ruler && !S.ruler.done && S.ruler.pts.length ? { x: S.ruler.pts[S.ruler.pts.length - 2], y: S.ruler.pts[S.ruler.pts.length - 1] } : null), dbl, p); return; }
  if (S.tool === 'text') { textTap(snap(p.x, p.y)); return; }
  if (S.tool === 'open') {
    const it = placeOpening(S.openType, p.x, p.y);
    if (it) hint(`${it.otype === 'window' ? 'Окно' : 'Дверь'} поставлено по стандарту. Два раза нажмите — изменить`);
    return;
  }
  const w = snap(p.x, p.y, draftFrom());
  if (S.tool === 'point') {
    const it = addItem({ kind: 'point', x: w.x, y: w.y });
    select(it.id);
    hint('Точка №' + it.no + ' ждёт замер — измерьте лазером или введите значение');
  } else if (S.tool === 'line') {
    if (!S.draft) { S.draft = { kind: 'line', pts: [w.x, w.y] }; hint('Укажите вторую точку размера'); }
    else {
      const [x, y] = S.draft.pts;
      S.draft = null;
      if (Math.hypot(w.x - x, w.y - y) * V().s < 6) return;
      const it = addItem({ kind: 'line', x, y, x2: w.x, y2: w.y });
      select(it.id);
      hint(`Размер №${it.no} (по чертежу ${fmt(it.design)} м) ждёт замер`);
    }
  } else if (S.tool === 'sketch') {
    S.viewFollow = false; // рисуют пальцем — план не двигаем, иначе следующая точка «уедет»
    const d = S.draft;
    const nSeg = skItem()?.dirs.length || 0;
    if (!d || (nSeg === 0 && d.auto)) {
      // нажатие на стену готовой комнаты — замер этой стены
      // нажали на угол комнаты — новая комната начинается из этого угла (рядом с прежней, план не сдвигается)
      const cn = pickCorner(p.x, p.y, 16);
      if (cn) {
        S.skm = null; S.draft = { kind: 'sketch', pts: [cn.x, cn.y] };
        hint('Начало новой комнаты — из угла. Направление + лазер, или нажимайте точки'); draw(); return;
      }
      // нажали на середину стены — сразу её перемер
      const hs = pickSketchSeg(p.x, p.y, false);
      if (hs) { remeasure(hs.it, hs.k); return; }
      if (S.skm) { S.skm = null; hint(''); toast('Вышли без изменений', true); if (isBlank()) startBlankDraft(); draw(); return; }
      S.draft = { kind: 'sketch', pts: [w.x, w.y] };
      hint('Начало линии. Направление + лазер, или нажимайте точки');
      draw(); return;
    }
    const it = skItem();
    // нажатие на начало — замкнуть комнату, затем замер по очереди
    if (nSeg >= 2) {
      const f = w2s(it.start[0], it.start[1]);
      if (Math.hypot(f.x - p.x, f.y - p.y) < 18) {
        const last = draftFrom();
        skAddSeg((Math.atan2(it.start[1] - last.y, it.start[0] - last.x) * 180) / Math.PI, Math.hypot(it.start[0] - last.x, it.start[1] - last.y) * unitM(), false);
        closeSketch(it, true); return;
      }
    }
    if (dbl) { finishSketch(); return; }
    const last = draftFrom();
    const L = Math.hypot(w.x - last.x, w.y - last.y) * unitM();
    if (L < 0.02) return;
    skAddSeg((Math.atan2(w.y - last.y, w.x - last.x) * 180) / Math.PI, L, false);
    hint('Нажмите на начало — замкнуть комнату, затем замер лазером по очереди');
    draw();
  }
  updateDraftBar();
}
/* ---------- черчение: линия = отрезки «направление + длина» ---------- */
// Линия (эскиз): start [x,y], dirs[] (градусы), lens[] (замер, м или null), dlens[] (длина по рисунку, м),
// closed, gap (невязка, м). pts пересчитываются из этих данных.
function rebuildSketch(it) {
  if (!it.dirs) return;
  const u = unitM();
  let x = it.start[0], y = it.start[1];
  const pts = [x, y];
  for (let k = 0; k < it.dirs.length; k++) {
    const L = (it.lens[k] ?? it.dlens[k] ?? 0) / u, a = (it.dirs[k] * Math.PI) / 180;
    x += Math.cos(a) * L; y += Math.sin(a) * L;
    pts.push(x, y);
  }
  if (it.closed) {
    it.gap = Math.hypot(x - it.start[0], y - it.start[1]) * u;
    if (it.gap < 0.005) pts.splice(-2); // замкнулась точно
  } else delete it.gap;
  it.pts = pts;
}
function sketchSegs(it) {
  const P = it.pts, n = P.length / 2, u = unitM();
  const cnt = it.dirs ? it.dirs.length : it.closed ? n : n - 1;
  let A = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += P[i * 2] * P[j * 2 + 1] - P[j * 2] * P[i * 2 + 1]; }
  const side = it.closed && A < 0 ? -1 : 1;
  const out = [];
  for (let k = 0; k < cnt; k++) {
    let j = k + 1; if (j >= n) j = 0;
    const ax = P[k * 2], ay = P[k * 2 + 1], bx = P[j * 2], by = P[j * 2 + 1];
    const Lw = Math.hypot(bx - ax, by - ay) || 1e-9;
    out.push({
      key: `sk:${it.id}:${k}`, k, ax, ay, bx, by, len: Lw * u,
      nx: (-(by - ay) / Lw) * side, ny: ((bx - ax) / Lw) * side,
      measured: it.dirs ? it.lens[k] != null : true,
    });
  }
  return out;
}
const skItem = () => { const d = S.draft; return d?.itemId ? S.items.find((i) => i.id === d.itemId) : null; };
function skAddSeg(dirDeg, lenM, measured) {
  const d = S.draft;
  let it = skItem();
  if (!it) {
    pushUndo();
    it = { id: uid(), kind: 'sketch', start: [d.pts[0], d.pts[1]], dirs: [], lens: [], dlens: [], pts: [d.pts[0], d.pts[1]], block: S.block, floor: S.floor, t: Date.now() };
    if (d.auto) it.autoStart = true; // начало поставлено автоматически (лазером без нажатия)
    S.items.push(it); d.itemId = it.id;
  } else pushUndo();
  d.auto = false;
  it.dirs.push(Math.round(normDeg(dirDeg) * 100) / 100); it.dlens.push(lenM); it.lens.push(measured ? lenM : null);
  rebuildSketch(it);
  d.pts = it.pts.slice();
  growBlank(d.pts[d.pts.length - 2], d.pts[d.pts.length - 1]);
  save();
  return it;
}
/** Обход против часовой: если нарисовано по часовой — разворачиваем порядок стен */
function makeCCW(it) {
  const P = it.pts, n = P.length / 2;
  let A = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += P[i * 2] * P[j * 2 + 1] - P[j * 2] * P[i * 2 + 1]; }
  if (A >= 0) return;
  const m = it.dirs.length;
  it.dirs = it.dirs.slice().reverse().map((a) => normDeg(a + 180));
  it.lens = it.lens.slice().reverse(); it.dlens = it.dlens.slice().reverse();
  for (const o of S.items) if (o.kind === 'open' && o.key?.startsWith(`sk:${it.id}:`)) {
    const k = +o.key.split(':')[2]; o.key = `sk:${it.id}:${m - 1 - k}`; o.t = 1 - (o.t ?? 0.5);
  }
  rebuildSketch(it);
}
function bboxOf(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  return [x0, y0, x1, y1];
}
/** Комнаты не налезают друг на друга: новая отодвигается вправо на толщину стены */
function separateRoom(it) {
  if (!it.autoStart) return; // комнату начертили там, где нажали, — не двигаем
  const others = S.items.filter((o) => o !== it && o.kind === 'sketch' && o.closed && o.block === it.block && o.floor === it.floor);
  if (!others.length) return;
  const gap = (S.settings.wallTh > 0 ? S.settings.wallTh / 100 : 0.2) / unitM();
  const b = bboxOf(it.pts);
  const hit = others.some((o) => { const q = bboxOf(o.pts); return b[0] < q[2] + gap * 0.5 && b[2] > q[0] - gap * 0.5 && b[1] < q[3] && b[3] > q[1]; });
  if (!hit) return;
  const maxX = Math.max(...others.map((o) => bboxOf(o.pts)[2]));
  const dx = maxX + gap - b[0];
  it.start = [it.start[0] + dx, it.start[1]];
  rebuildSketch(it);
  for (const o of S.items) if (o.kind === 'open' && o.key?.startsWith(`sk:${it.id}:`)) { /* проёмы привязаны к стенам — сдвигаются вместе */ }
}
function closeSketch(it, viaTap) {
  it.closed = true;
  if (viaTap) makeCCW(it);
  rebuildSketch(it);
  separateRoom(it);
  S.draft = null;
  save();
  const open = it.lens.findIndex((v) => v == null);
  if (open >= 0) { startSkm(it, open); toast(`Комната замкнута — замер: стена ${open + 1} из ${it.dirs.length}`); }
  else {
    toast(`Комната замкнута · S ${fmt(polyArea(it.pts) * unitM() * unitM())} м²` + (it.gap >= 0.005 ? ` · невязка ${fmt(it.gap)} м` : ''));
    afterRoomDone();
  }
  draw();
}
function afterRoomDone() {
  S.skm = null;
  if (isBlank() && S.tool === 'sketch') { startBlankDraft(); S.sketchRel = 's'; } // вид не прыгает — план остаётся на месте
}
/** Ближайший угол начерченных комнат этажа (экран, px) */
function pickCorner(sx, sy, tol) {
  let best = null, bd = tol;
  for (const it of curItems()) {
    if (it.kind !== 'sketch' || !it.pts) continue;
    for (let i = 0; i < it.pts.length; i += 2) {
      const q = w2s(it.pts[i], it.pts[i + 1]), d = Math.hypot(q.x - sx, q.y - sy);
      if (d < bd) { bd = d; best = { x: it.pts[i], y: it.pts[i + 1] }; }
    }
  }
  return best;
}
/** Нажали на стену — сразу её замер (перемер). Передумали — нажать мимо, ✕ или «Готово» */
function remeasure(it, k) {
  if (S.draft && !S.draft.auto && skItem()?.dirs?.length) finishSketchQuiet();
  S.draft = null;
  startSkm(it, k);
  const cur = it.lens[k];
  toast(cur != null ? `Перемер стены ${k + 1}: было ${fmt(cur)} м — меряйте лазером. Нажмите мимо — выйти` : `Замер стены ${k + 1} из ${it.dirs.length} — меряйте лазером`, true);
}
function finishSketchQuiet() { S.draft = null; save(); }
/** Спросить перед замером стены нарисованной комнаты */
function askSkm(it, k, onYes, onNo) {
  const n = it.dirs.length, cur = it.lens[k];
  const txt = cur != null
    ? `Стена ${k + 1} из ${n} уже измерена: ${fmt(cur)} м.\nПеремерить её? Дальше замер пойдёт по очереди.`
    : `Начинаем замер?\nСтена ${k + 1} из ${n}. Замеры с лазера будут записываться по очереди, стена за стеной.`;
  ask(txt, cur != null ? 'Да, перемерить' : 'Да, начать').then((yes) => {
    if (yes) { onYes && onYes(); startSkm(it, k); }
    else if (onNo) onNo();
  });
}
/** Замер нарисованной линии/комнаты: стены по очереди */
function startSkm(it, k) { S.skm = { id: it.id, i: k }; S.draft = null; hint(`Замер: стена ${k + 1} из ${it.dirs.length} — меряйте лазером`); draw(); }
const skmItem = () => (S.skm ? S.items.find((i) => i.id === S.skm.id) : null);
function skmRecord(meters) {
  const it = skmItem();
  if (!it) { S.skm = null; return false; }
  pushUndo();
  const i = S.skm.i;
  it.lens[i] = meters;
  if (it.rect && it.dirs.length === 4) { const o = (i + 2) % 4; if (it.lens[o] == null) it.dlens[o] = meters; } // квадрат остаётся квадратом
  rebuildSketch(it); save(); feedback();
  const n = it.dirs.length;
  let next = -1;
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (it.lens[j] == null) { next = j; break; } }
  if (next < 0) {
    toast(`Обмерено · S ${fmt(polyArea(it.pts) * unitM() * unitM())} м²` + (it.closed && it.gap >= 0.005 ? ` · невязка ${fmt(it.gap)} м` : ''));
    // скопированный этаж: сразу к следующей комнате, где ещё нет замеров
    const nx = curItems().find((o) => o.kind === 'sketch' && o.dirs && o.id !== it.id && o.lens.some((l) => l == null) && o.noDims);
    if (nx) { const k0 = nx.lens.findIndex((l) => l == null); startSkm(nx, k0); toast(`Обмерено. Следующая комната — стена ${k0 + 1} из ${nx.dirs.length}`, true); draw(); return true; }
    afterRoomDone();
  } else { S.skm.i = next; toast(`${fmt(meters)} м → стена ${next + 1} из ${n}`); }
  draw();
  return true;
}
function skmGo(step) {
  const it = skmItem(); if (!it) return;
  const n = it.dirs.length;
  S.skm.i = (S.skm.i + step + n) % n; S.viewFollow = true; draw();
}
function skPrevDir(it, i) {
  if (i > 0) return it.dirs[i - 1];
  if (it.closed) return it.dirs[it.dirs.length - 1];
  return it.dirs[0];
}
function pickSketchSeg(sx, sy, closedOnly, tol = 18) {
  let best = null, bd = tol;
  for (const it of curItems()) {
    if (it.kind !== 'sketch' || !it.dirs || (closedOnly && !it.closed)) continue;
    for (const sg of sketchSegs(it)) {
      const a = w2s(sg.ax, sg.ay), b = w2s(sg.bx, sg.by);
      const d = distSeg(sx, sy, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = { it, k: sg.k, sg }; }
    }
  }
  return best;
}
/** Отрезок по направлению (кнопки) и длине с лазера */
function sketchAppend(meters) {
  const dir = sketchLastDir() + REL[S.sketchRel || 's'];
  const it = skAddSeg(dir, meters, true);
  feedback();
  toast(`${fmt(meters)} м · ${{ l: 'налево', s: 'прямо', r: 'направо' }[S.sketchRel || 's']}`);
  // вернулись точно в начало — комната замкнута сама
  if (it.dirs.length >= 3) {
    const n = it.pts.length;
    const gap = Math.hypot(it.pts[n - 2] - it.start[0], it.pts[n - 1] - it.start[1]) * unitM();
    if (gap < 0.005) { closeSketch(it, false); return; }
  }
  draw();
}
function polyArea(p) {
  let A = 0; const n = p.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  return Math.abs(A) / 2;
}
function polyCentroid(p) {
  let A = 0, cx = 0, cy = 0; const n = p.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; const f = p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; A += f; cx += (p[i * 2] + p[j * 2]) * f; cy += (p[i * 2 + 1] + p[j * 2 + 1]) * f; }
  if (Math.abs(A) < 1e-9) { let x = 0, y = 0; for (let i = 0; i < n; i++) { x += p[i * 2]; y += p[i * 2 + 1]; } return { x: x / n, y: y / n }; }
  return { x: cx / (3 * A), y: cy / (3 * A) };
}
function sketchUndo() { doUndo(); } // каждый отрезок сохраняется в истории — «Повторить» вернёт удалённое
function draftFrom() {
  const d = S.draft;
  return d && d.pts.length >= 2 ? { x: d.pts[d.pts.length - 2], y: d.pts[d.pts.length - 1] } : null;
}
/** ■ — закончить линию (открытой); «Замкнуть» — замкнуть с невязкой */
function finishSketch(closed = false) {
  const it = skItem();
  if (it && closed && it.dirs.length >= 2) { closeSketch(it, false); return; }
  S.draft = null;
  if (it) { save(); }
  updateDraftBar(); hint('');
  // начерченная линия — сразу замер её отрезков по очереди
  if (it && it.dirs?.length && it.lens.some((l) => l == null)) { startSkm(it, it.lens.findIndex((l) => l == null)); return; }
  draw();
}
function updateDraftBar() {
  $('draftbar').hidden = true; // управление линией — в нижней панели
}

/* ---------- выбор и карточка ---------- */
function select(id) {
  S.selId = id;
  if (id) S.selSeg = null;
  if (S.armedId && S.armedId !== id) S.armedId = null;
  refreshSheet();
  draw();
}
function refreshSheet() {
  const sh = $('sheet');
  $('shNav').hidden = !S.selSeg;
  $('shRoomOps').hidden = true;
  if (!S.selSeg) { $('shNav2').hidden = true; $('sheet').classList.remove('compact'); $('shSub').hidden = false; $('shDesignWrap').hidden = false; }
  if (S.selSeg) $('shOpen').hidden = true;
  if (S.selSeg && S.session && !S.sheetFull) { sh.hidden = true; syncMbar(); return; }
  if (S.selSeg) { sh.hidden = false; refreshSegSheet(); syncMbar(); return; }
  const it = S.items.find((i) => i.id === S.selId);
  if (!it) { sh.hidden = true; return; }
  sh.hidden = false;
  $('shActions').hidden = false; $('shNoteWrap').hidden = false;
  const isSk = it.kind === 'sketch' || it.kind === 'open';
  $('shRoomOps').hidden = !(it.kind === 'sketch' && S.settings.layers.roomOps);
  $('shOpen').hidden = it.kind !== 'open';
  if (it.kind === 'open') {
    if (!S.openEdit) { sh.hidden = true; return; }
    $('shTitle').textContent = it.otype === 'window' ? 'Окно' : 'Дверь';
    $('shSub').textContent = `${sheetHeader()} · этаж ${it.floor} · ${it.manual ? 'поставлено вручную' : 'по стандарту (по центру / равные промежутки)'}`;
    $('shOType').value = it.otype;
    if (document.activeElement !== $('shOW')) $('shOW').value = fmt(it.w);
    for (const el of sh.querySelectorAll('.grid2, #shDev, #shRemeasure, #shNoteWrap')) el.hidden = true;
    $('shFloorRow').hidden = true; $('shSlope').hidden = true; $('shRoom').hidden = true;
    $('shActions').hidden = false;
    return;
  }
  $('shTitle').textContent = isSk ? 'Линия эскиза' : `${it.kind === 'line' ? 'Размер' : 'Точка'} №${it.no}`;
  $('shSub').textContent = isSk
    ? `Блок ${it.block} · этаж ${it.floor} · ${it.pts.length / 2} точек`
    : `Блок ${it.block} · ${it.kind === 'point' ? `с ${it.floor} эт. ${it.dir === 'up' ? 'вверх' : 'вниз'}${it.toFloor != null ? ' до ' + it.toFloor + ' эт.' : ''}` : 'этаж ' + it.floor}` +
      (it.mt ? ' · ' + new Date(it.mt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '') +
      (it.src === 'manual' ? ' · вручную' : it.src ? ' · лазер' : '');
  for (const el of sh.querySelectorAll('.grid2, #shDev, #shRemeasure')) el.hidden = isSk;
  $('shSlope').hidden = true; $('shRoom').hidden = true; $('shOpen').hidden = true;
  $('shFloorRow').hidden = isSk || it.kind === 'line';
  const set = (el, val) => { if (document.activeElement !== el) el.value = val; };
  set($('shValue'), it.value == null ? '' : fmt(it.value));
  set($('shDesign'), it.design == null ? '' : fmt(it.design));
  set($('shFloor'), it.floor);
  $('shDir').value = it.dir || 'down';
  set($('shTo'), it.toFloor ?? '');
  set($('shNote'), it.note || '');
  const dv = $('shDev');
  const cls = devClass(it);
  dv.className = 'dev ' + (cls || '');
  dv.textContent = cls ? `Отклонение ${fmtSigned(it.value - it.design)} м от проекта` : '';
  const rb = $('shRemeasure');
  rb.classList.toggle('armed', S.armedId === it.id);
  rb.textContent = S.armedId === it.id ? '◎ Ждёт замер…' : '◎ Перемерить';
}
function bindSheet() {
  const cur = () => (S.selSeg ? segItem(S.selSeg, true) : S.items.find((i) => i.id === S.selId));
  let editSnap = false;
  const onEdit = (fn) => (e) => {
    if (S.selSeg && !editSnap) { pushUndo(); editSnap = true; }
    const it = cur(); if (!it) return;
    if (!editSnap) { pushUndo(); editSnap = true; }
    fn(it, e.target.value);
    save(); draw(); refreshSheet();
  };
  for (const id of ['shValue', 'shDesign', 'shFloor', 'shTo', 'shNote']) {
    $(id).addEventListener('focus', () => { editSnap = false; });
    $(id).addEventListener('blur', () => { refreshSheet(); });
  }
  $('shValue').addEventListener('input', onEdit((it, v) => {
    const n = parseNum(v); it.value = v.trim() === '' ? null : n; if (n != null) { it.src = 'manual'; it.mt = Date.now(); delete it.copied; }
  }));
  $('shValue').addEventListener('keydown', (e) => {
    // Enter в поле стены — записать и перейти к следующей
    if (e.key === 'Enter' && S.selSeg && S.settings.autoNext && parseNum(e.target.value) != null) { e.preventDefault(); e.target.blur(); gotoSeg(1, true); }
  });
  $('shAng').addEventListener('input', onEdit((it, v) => { const n = parseNum(v); it.ang = n == null ? 0 : Math.max(-89, Math.min(89, n)); }));
  $('shOff').addEventListener('input', onEdit((it, v) => {
    const n = parseNum(v); const sg = segInfo(it); const L = it.value ?? sg?.len ?? 1;
    it.ang = n == null ? 0 : Math.round((Math.asin(Math.max(-0.99, Math.min(0.99, n / L))) * 1800) / Math.PI) / 10;
  }));
  for (const id of ['shAng', 'shOff']) {
    $(id).addEventListener('focus', () => { editSnap = false; });
    $(id).addEventListener('blur', () => refreshSheet());
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  }
  $('shOType').onchange = onEdit((it, v) => { it.otype = v; });
  $('shOW').addEventListener('input', onEdit((it, v) => { const n = parseNum(v); if (n > 0.2 && n < 10) it.w = n; }));
  $('shOW').addEventListener('focus', () => { editSnap = false; });
  $('shOFlip').onclick = () => { const it = cur(); if (it) { pushUndo(); it.flip = !it.flip; save(); draw(); } };
  $('shOAuto').onclick = () => { const it = cur(); if (it) { pushUndo(); it.manual = false; save(); draw(); refreshSheet(); } };
  $('shMerge').onclick = async () => {
    if (!S.selSeg) return;
    const J = jogInfo(S.selSeg);
    const txt = J?.parallel ? `Удалить поворот? Выступ ${fmt(J.sg.len)} м уберётся, соседние стены станут одной ровной стеной.`
      : `Удалить эту стену (${fmt(J.sg.len)} м) как лишний поворот?`;
    if (!(await ask(txt, 'Удалить поворот'))) return;
    mergeTurn(S.selSeg); gotoSeg(1, true);
  };
  $('shMore').onclick = () => { S.sheetFull = !S.sheetFull; refreshSheet(); };
  for (const b of $('dpad').querySelectorAll('[data-d]')) b.onclick = () => onDpad(b.dataset.d);
  $('dpadC').onclick = () => {
    if (S.tool === 'sketch' && S.draft) { sketchUndo(); return; }
    doUndo();
  };
  $('shPrev').onclick = () => gotoSeg(-1);
  $('shClear').onclick = () => { const it = segItem(S.selSeg); if (it) { removeItem(it.id); toast('Замер и уклон стены очищены'); } };
  $('shNext').onclick = () => gotoSeg(1);
  $('shNextOpen').onclick = () => gotoSeg(1, true);
  $('shDesign').addEventListener('input', onEdit((it, v) => {
    if (v.trim() === '') { it.designManual = false; autoDesign(it); } else { it.design = parseNum(v); it.designManual = true; }
  }));
  $('shFloor').addEventListener('input', onEdit((it, v) => { const n = parseInt(v, 10); if (!isNaN(n)) { it.floor = n; autoDesign(it); } }));
  $('shTo').addEventListener('input', onEdit((it, v) => { const n = parseInt(v, 10); it.toFloor = isNaN(n) ? null : n; autoDesign(it); }));
  $('shDir').addEventListener('change', onEdit((it, v) => { it.dir = v; }));
  $('shNote').addEventListener('input', onEdit((it, v) => { it.note = v; }));
  for (const id of ['shValue', 'shDesign', 'shFloor', 'shTo', 'shNote'])
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('shClose').onclick = () => { if (S.session) hint('Замер остановлен'); S.session = false; S.selSeg = null; select(null); };
  $('shDelete').onclick = () => {
    if (S.selSeg) { const it = segItem(S.selSeg); if (it) { removeItem(it.id); refreshSheet(); toast('Замер стены очищен'); } return; }
    const it = cur(); if (it) { removeItem(it.id); toast('Удалено. «Отменить» — вернуть'); }
  };
  $('shRemeasure').onclick = () => {
    const it = cur(); if (!it) return;
    S.armedId = S.armedId === it.id ? null : it.id;
    refreshSheet();
    if (S.armedId) hint('Измерьте лазером — значение запишется в №' + it.no);
  };
}

/* ---------- стены: обмер по отрезкам ---------- */
function wallsOf(name = S.block) {
  const b = S.plan.blocks.find((x) => x.name === name);
  return b ? prepBlock(b).walls : { rooms: [], segs: [], byKey: new Map() };
}
function segItem(key, create, block = S.block, floor = S.floor) {
  let it = S.items.find((i) => i.kind === 'seg' && i.key === key && i.block === block && i.floor === floor);
  if (!it && create) {
    const sg = wallsOf(block).byKey.get(key);
    it = { id: uid(), kind: 'seg', key, block, floor, room: sg?.room, wall: sg?.wall, value: null, design: sg ? sg.len : null, t: Date.now() };
    S.items.push(it);
  }
  return it;
}
const isDone = (it) => !!it && (it.merged || (it.value != null && !it.copied));
function segInfo(it) { return wallsOf(it.block).byKey.get(it.key); }
function segLabel(it) { const sg = segInfo(it); return sg ? `К${sg.room}·${sg.wall}` : `К${it.room ?? '?'}·${it.wall ?? '?'}`; }
function floorSegMap() {
  const m = new Map();
  for (const i of S.items) if (i.kind === 'seg' && i.block === S.block && i.floor === S.floor) m.set(i.key, i);
  return m;
}
function firstOpenSeg() {
  const m = floorSegMap();
  const sg = wallsOf().segs.find((s) => !isDone(m.get(s.key)));
  return sg ? sg.key : null;
}
function recordSeg(key, meters, src) {
  pushUndo();
  const it = segItem(key, true);
  it.value = meters; it.src = src; it.mt = Date.now(); delete it.copied;
  if (!it.designManual) it.design = segInfo(it)?.len ?? it.design;
  const sg = segInfo(it);
  const d = it.design != null ? ` (${fmtSigned(meters - it.design)})` : '';
  toast(`Комната ${sg?.room} · стена ${sg?.wall}: ${fmt(meters)} м${d}`);
  feedback();
  save();
  if (S.settings.autoNext) { gotoSeg(1, true); maybeAskTurn(); }
  else { refreshSheet(); draw(); }
}
function selectSeg(key, noZoom) {
  const W = wallsOf();
  const prev = W.byKey.get(S.selSeg);
  S.selId = null; S.armedId = null;
  S.selSeg = key;
  refreshSheet();
  const sg = W.byKey.get(key);
  if (sg) {
    const room = W.rooms.find((r) => r.no === sg.room);
    if (!noZoom && room && (!prev || prev.room !== sg.room)) fitRoom(room);
    ensureVisible(sg);
  }
  draw();
}
function fitRoom(room) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of room.segs) for (const [x, y] of [[s.ax, s.ay], [s.bx, s.by]]) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const v = V();
  const sheetH = $('sheet').hidden ? 0 : $('sheet').offsetHeight;
  const Wd = cv.clientWidth, top = 60, H = Math.max(160, cv.clientHeight - sheetH - top - 20);
  const sc = Math.min((Wd - 90) / (x1 - x0 || 1), (H - 50) / (y1 - y0 || 1));
  // не мельчить сильнее, чем уже есть, если комната и так крупная
  const rw = (x1 - x0) * v.s, rh = (y1 - y0) * v.s;
  if (rw > Wd * 0.45 && rh > H * 0.45 && rw < Wd && rh < H) return;
  v.s = sc;
  v.ox = Wd / 2 - ((x0 + x1) / 2) * sc;
  v.oy = top + H / 2 + ((y0 + y1) / 2) * sc;
}
function gotoSeg(dir, onlyOpen, silent) {
  const W = wallsOf();
  const segs = W.segs;
  if (!segs.length) return;
  const m = floorSegMap();
  const N = segs.length;
  let idx = segs.findIndex((s) => s.key === S.selSeg);
  const prevRoom = idx >= 0 ? segs[idx].room : null;
  // авто-обход: после комнаты — ближайшая соседняя комната с неизмеренными стенами
  if (onlyOpen && dir > 0 && prevRoom != null) {
    const cur = W.rooms.find((r) => r.no === prevRoom);
    const restHere = cur.segs.slice(cur.segs.findIndex((q) => q.key === S.selSeg) + 1).concat(cur.segs).find((q) => !isDone(m.get(q.key)));
    if (restHere) { selectSeg(restHere.key); return; }
    const near = W.rooms
      .filter((r) => r !== cur && r.segs.some((q) => !isDone(m.get(q.key))))
      .sort((a, b) => Math.hypot(a.cx - cur.cx, a.cy - cur.cy) - Math.hypot(b.cx - cur.cx, b.cy - cur.cy))[0];
    if (near) {
      if (!silent) hint(`Комната ${prevRoom} обмерена ✓ Переход в соседнюю комнату ${near.no}`);
      selectSeg(near.segs.find((q) => !isDone(m.get(q.key))).key);
      return;
    }
  }
  if (idx < 0) idx = dir > 0 ? -1 : 0;
  for (let k = 1; k <= N; k++) {
    const s = segs[(((idx + dir * k) % N) + N) % N];
    if (onlyOpen && isDone(m.get(s.key))) continue;
    if (prevRoom != null && s.room !== prevRoom && !silent) {
      const done = segs.filter((q) => q.room === prevRoom).every((q) => isDone(m.get(q.key)));
      hint(done ? `Комната ${prevRoom} обмерена ✓ Переход в комнату ${s.room}` : `Комната ${s.room}`);
    }
    selectSeg(s.key);
    return;
  }
  if (!silent) { S.session = false; toast('Все стены блока ' + S.block + ' на этаже ' + S.floor + ' измерены ✓'); refreshSheet(); draw(); }
}
function ensureVisible(sg) {
  if (!sg) return;
  const v = V();
  const a = w2s((sg.ax + sg.bx) / 2, (sg.ay + sg.by) / 2, v);
  const sheetH = $('sheet').hidden ? 0 : $('sheet').offsetHeight;
  const W = cv.clientWidth, H = cv.clientHeight - sheetH;
  if (a.x < 40 || a.x > W - 40 || a.y < 70 || a.y > H - 30) {
    v.ox += W / 2 - a.x; v.oy += Math.max(120, H / 2) - a.y;
  }
}
function pickSeg(sx, sy) {
  const v = V();
  let best = null, bs = Infinity;
  for (const s of wallsOf().segs) {
    const a = w2s(s.ax, s.ay, v), b = w2s(s.bx, s.by, v);
    const d = distSeg(sx, sy, a.x, a.y, b.x, b.y);
    if (d > 26) continue;
    const w = screenToWorld(sx, sy, v);
    const inside = (w.x - (s.ax + s.bx) / 2) * s.nx + (w.y - (s.ay + s.by) / 2) * s.ny > 0;
    const score = d - (inside ? 8 : 0);
    if (score < bs) { bs = score; best = s; }
  }
  return best;
}
function segMapFor(block, floor) {
  const m = new Map();
  for (const i of S.items) if (i.kind === 'seg' && i.block === block && i.floor === floor) m.set(i.key, i);
  return m;
}
function roomAsBuilt(room, block = S.block, floor = S.floor, m) {
  m = m || segMapFor(block, floor);
  return asBuilt(room, (s) => m.get(s.key), unitM());
}
/** Ручка уклона выбранной стены: начало и конец стены по обмеру (мир) */
function slopeHandle() {
  const W = wallsOf();
  const sg = W.byKey.get(S.selSeg);
  if (!sg) return null;
  const room = W.rooms.find((r) => r.no === sg.room);
  const ab = roomAsBuilt(room);
  const sp = ab.segPts.find((q) => q.seg.key === sg.key);
  return sp ? { seg: sg, sx: sp.sx, sy: sp.sy, ex: sp.ex, ey: sp.ey } : null;
}
function gapClass(g) { return g == null ? null : g < 0.01 ? 'ok' : g < 0.05 ? 'warn' : 'bad'; }
function drawWalls(c, b, v, pal, opts = {}) {
  const W = prepBlock(b).walls;
  const floor = opts.floor ?? S.floor;
  const m = segMapFor(b.name, floor);
  const showMode = S.tool === 'walls' || opts.export;
  if (!showMode && !m.size) return;
  const now = performance.now();
  const selSg = !opts.export && S.selSeg ? W.byKey.get(S.selSeg) : null;
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';
  const labels = [];
  const rot0 = (a) => { if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI; return a; };
  for (const room of W.rooms) {
    const anyM = room.segs.some((s) => m.get(s.key)?.value != null);
    // длины по чертежу у неизмеренных стен
    if (showMode && !opts.export && S.settings.wallLabels) {
      for (const s of room.segs) {
        if (m.get(s.key)?.value != null || (selSg && s.key === selSg.key)) continue;
        const a = w2s(s.ax, s.ay, v), e = w2s(s.bx, s.by, v);
        const Lp = Math.hypot(e.x - a.x, e.y - a.y);
        if (Lp < 8) continue;
        if (Lp < 26) continue;
        const fs = 10;
        const rot = rot0(Math.atan2(e.y - a.y, e.x - a.x));
        c.save(); c.translate((a.x + e.x) / 2 + s.nx * (fs + 2), (a.y + e.y) / 2 - s.ny * (fs + 2)); c.rotate(rot);
        c.font = `600 ${fs}px system-ui, sans-serif`; c.fillStyle = pal.ink2; c.globalAlpha = 0.8;
        c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(fmt(s.len), 0, 0); c.restore();
      }
    }
    const cpt = w2s(room.cx, room.cy, v);
    if (!anyM) {
      if (showMode) labels.push(() => {
        c.beginPath(); c.arc(cpt.x, cpt.y, 11, 0, Math.PI * 2);
        c.fillStyle = pal.dark ? '#22304a' : '#e3e7ee'; c.fill();
        c.fillStyle = pal.ink2; c.font = '800 11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(room.no), cpt.x, cpt.y + 0.5);
      });
      continue;
    }
    const ab = asBuilt(room, (s) => m.get(s.key), unitM());
    // обмерный контур
    c.strokeStyle = GREEN; c.lineWidth = 2; c.setLineDash([]);
    c.globalAlpha = 0.9;
    c.beginPath(); path(c, ab.pts, v); c.stroke(); c.globalAlpha = 1;
    for (const sp of ab.segPts) {
      if (!sp.has) continue;
      const it = m.get(sp.seg.key);
      if (it.merged) continue;
      const col = it.copied ? '#9aa3b2' : GREEN;
      const a = w2s(sp.sx, sp.sy, v), e = w2s(sp.ex, sp.ey, v);
      c.strokeStyle = col; c.lineWidth = 3.5;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(e.x, e.y); c.stroke();
      const L = Math.hypot(e.x - a.x, e.y - a.y);
      const rot = rot0(Math.atan2(e.y - a.y, e.x - a.x));
      const ang = Math.atan2(e.y - a.y, e.x - a.x);
      // нормаль внутрь: поворот стены по чертежу на угол уклона
      const nx = sp.seg.nx, ny = -sp.seg.ny, da = (it.ang || 0) * Math.PI / 180;
      const nnx = nx * Math.cos(-da) - ny * Math.sin(-da), nny = nx * Math.sin(-da) + ny * Math.cos(-da);
      void ang;
      if (L > 6 || opts.export) {
        const txt = (it.copied ? '≈' : '') + fmt(it.value) + (it.ang ? ` ∠${it.ang.toFixed(1).replace('.', ',')}°` : '');
        const sz = 11;
        labels.push(() => pill(c, (a.x + e.x) / 2 + nnx * (sz + 3), (a.y + e.y) / 2 + nny * (sz + 3), txt, col, '#fff', { rot, size: sz, shadow: false }));
      }
    }
    // невязка
    if (ab.gap != null && ab.gap >= 0.005) {
      const f = w2s(ab.gapFrom[0], ab.gapFrom[1], v), t = w2s(ab.gapTo[0], ab.gapTo[1], v);
      c.strokeStyle = '#ea580c'; c.lineWidth = 2.5; c.setLineDash([5, 4]);
      c.beginPath(); c.moveTo(f.x, f.y); c.lineTo(t.x, t.y); c.stroke(); c.setLineDash([]);
      for (const q of [f, t]) { c.beginPath(); c.arc(q.x, q.y, 3.5, 0, Math.PI * 2); c.fillStyle = '#ea580c'; c.fill(); }
      labels.push(() => pill(c, (f.x + t.x) / 2, (f.y + t.y) / 2 - 16, `невязка ${fmt(ab.gap)} м`, '#ea580c', '#fff', { size: 11 }));
    }
    // площадь
    const done = ab.measured === ab.total;
    labels.push(() => {
      const cls = done ? gapClass(ab.gap) || 'ok' : null;
      const txt = ab.area != null ? `К${room.no} · ${fmt(ab.area)} м²${done ? '' : ' *'}` : `К${room.no}`;
      pill(c, cpt.x, cpt.y, txt, cls ? pal[cls] : pal.card, cls ? '#fff' : pal.ink, { size: 12, border: cls ? null : pal.warn });
    });
  }
  // активная стена: где мерить (по чертежу) + ручка уклона на обмерном контуре
  if (selSg) {
    const it = m.get(selSg.key);
    const a = w2s(selSg.ax, selSg.ay, v), e = w2s(selSg.bx, selSg.by, v);
    const nx = selSg.nx, ny = -selSg.ny, off = 3;
    const ax = a.x + nx * off, ay = a.y + ny * off, ex = e.x + nx * off, ey = e.y + ny * off;
    const k = (now % 1200) / 1200;
    c.strokeStyle = pal.accent2; c.globalAlpha = 0.25 + 0.25 * Math.sin(k * Math.PI * 2);
    c.lineWidth = 14; c.beginPath(); c.moveTo(ax, ay); c.lineTo(ex, ey); c.stroke();
    c.globalAlpha = 1; c.lineWidth = 5;
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(ex, ey); c.stroke();
    const rot = rot0(Math.atan2(e.y - a.y, e.x - a.x));
    labels.push(() => pill(c, (a.x + e.x) / 2 + nx * 19, (a.y + e.y) / 2 + ny * 19,
      `${it?.value != null ? fmt(it.value) : '?'}  · черт. ${fmt(it?.design ?? selSg.len)}`, pal.accent2, '#fff', { rot, size: 12 }));
    const h = slopeHandle();
    if (h) labels.push(() => {
      const p = w2s(h.ex, h.ey, v), s0 = w2s(h.sx, h.sy, v);
      c.strokeStyle = pal.accent2; c.lineWidth = 1.5; c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(s0.x, s0.y); c.lineTo(p.x, p.y); c.stroke(); c.setLineDash([]);
      c.beginPath(); c.arc(p.x, p.y, 11, 0, Math.PI * 2); c.fillStyle = pal.card; c.fill();
      c.lineWidth = 3; c.strokeStyle = pal.accent2; c.stroke();
      c.beginPath(); c.arc(p.x, p.y, 5, 0.3, Math.PI * 1.6); c.lineWidth = 2; c.stroke();
    });
  }
  for (const f of labels) f();
  c.restore();
}
function refreshSegSheet() {
  const W = wallsOf();
  const sg = W.byKey.get(S.selSeg);
  if (!sg) { S.selSeg = null; $('sheet').hidden = true; return; }
  const it = segItem(S.selSeg);
  const compact = S.session && !S.sheetFull;
  $('sheet').classList.toggle('compact', compact);
  $('shNav2').hidden = false;
  $('shMore').textContent = compact ? '⋯ Подробнее' : '⋯ Короче';
  $('shMore').hidden = !S.session;
  $('shTitle').textContent = `Комната ${sg.room} · стена ${sg.wall} из ${sg.of}` + (compact ? ` · черт. ${fmt(sg.len)}` : '');
  $('shSub').textContent = `Блок ${S.block} · этаж ${S.floor} · по чертежу ${fmt(sg.len)} м` +
    (it?.mt ? ' · ' + new Date(it.mt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (it.src === 'manual' ? ' · вручную' : ' · лазер') : '');
  for (const el of document.querySelectorAll('#sheet .grid2, #shDev')) el.hidden = false;
  $('shFloorRow').hidden = true;
  $('shActions').hidden = true;
  $('shNoteWrap').hidden = !it?.note;
  $('shClear').hidden = !(it && (it.value != null || it.ang));
  const set = (el, val) => { if (document.activeElement !== el) el.value = val; };
  set($('shValue'), it?.value == null ? '' : fmt(it.value));
  set($('shDesign'), fmt(it?.design ?? sg.len));
  set($('shNote'), it?.note || '');
  const ang = it?.ang || 0;
  const L = it?.value ?? sg.len;
  set($('shAng'), ang ? ang.toFixed(1).replace('.', ',') : '');
  set($('shOff'), ang ? fmt(L * Math.sin((ang * Math.PI) / 180)) : '');
  const dv = $('shDev');
  const cls = it ? devClass(it) : null;
  dv.className = 'dev ' + (cls || '');
  dv.textContent = it?.copied ? `Значение взято с ${it.copied.from} этажа — перемерьте стену` : cls ? `Отклонение ${fmtSigned(it.value - it.design)} м от чертежа` : 'Измерьте лазером или введите значение. Кривая стена — потяните ⟳ на конце';
  if (it?.copied) dv.className = 'dev warn';
  if (it?.merged) { dv.className = 'dev'; dv.textContent = 'Поворот удалён — стена ровная. «✕» — вернуть.'; }
  const room = W.rooms.find((r) => r.no === sg.room);
  const ab = roomAsBuilt(room);
  const ri = $('shRoom');
  ri.hidden = !ab.measured;
  if (compact) {
    // во время замера — только метры
    $('shSub').hidden = true; $('shDesignWrap').hidden = true; $('shSlope').hidden = true; ri.hidden = true; $('shNoteWrap').hidden = true;
    if (!it?.copied && !it?.merged) dv.hidden = true;
    return;
  }
  $('shSub').hidden = false; $('shDesignWrap').hidden = false; dv.hidden = false;
  if (ab.measured) {
    const gc = gapClass(ab.gap);
    ri.innerHTML = `Комната ${room.no}: стен <b>${ab.measured}/${ab.total}</b> · S черт. <b>${fmt(room.area)}</b> м² · S обмер <b>${fmt(ab.area)}</b> м²` +
      (ab.measured < ab.total ? ' *' : '') +
      (ab.gap != null ? `<br>Невязка (углы не сходятся): <b class="${gc}">${fmt(ab.gap)} м</b>` : '');
  }
}
function updateProgress() {
  const el = $('prog');
  if (!el) return;
  if (!hasDrawing()) { el.hidden = true; return; }
  const segs = wallsOf().segs;
  if (!segs.length) { el.hidden = true; return; }
  const m = floorSegMap();
  const done = segs.filter((s) => isDone(m.get(s.key))).length;
  const rooms = wallsOf().rooms;
  const rdone = rooms.filter((r) => r.segs.every((s) => isDone(m.get(s.key)))).length;
  el.hidden = false;
  el.innerHTML = (S.session ? '<span class="rec">● ЗАМЕР</span> ' : '') + `<b>${done}</b>/${segs.length} стен · <b>${rdone}</b>/${rooms.length} комн.<i style="width:${(done / segs.length) * 100}%"></i>`;
}

/* ---------- двери и окна (условные обозначения) ---------- */
const OPEN_W = { door: 0.9, window: 1.5 };
function wallThickness(block, sg) {
  const b = S.plan.blocks.find((x) => x.name === block);
  const P = prepBlock(b);
  P.thick = P.thick || new Map();
  if (P.thick.has(sg.key)) return P.thick.get(sg.key);
  if (!P.segFlat) snapSegments();
  const um = unitM();
  let best = Infinity;
  // несколько лучей наружу вдоль стены — берём типичное (медиану)
  const res = [];
  for (const t of [0.25, 0.5, 0.75]) {
    const px = sg.ax + (sg.bx - sg.ax) * t, py = sg.ay + (sg.by - sg.ay) * t;
    const dx = -sg.nx, dy = -sg.ny; // наружу
    best = Infinity;
    const arr = P.segFlat;
    for (let i = 0; i < arr.length; i += 4) {
      const ax = arr[i], ay = arr[i + 1], bx = arr[i + 2], by = arr[i + 3];
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const tt = ((ax - px) * ey - (ay - py) * ex) / den;
      const u = ((ax - px) * dy - (ay - py) * dx) / den;
      if (tt > 0.02 / um && u >= 0 && u <= 1 && tt < best) best = tt;
    }
    if (best * um <= 0.8) res.push(best);
  }
  res.sort((a, b) => a - b);
  const th = res.length ? res[Math.floor(res.length / 2)] : 0.25 / um;
  P.thick.set(sg.key, th);
  return th;
}
/** Геометрия проёма в мировых координатах (по обмерному контуру, если комната обмерена) */
/** Стена по ключу: стена чертежа (по обмеру, если обмерена) или отрезок начерченной линии ('sk:id:k') */
function wallDesc(block, floor, key, abCache) {
  if (key?.startsWith('sk:')) {
    const [, id, k] = key.split(':');
    const sk = S.items.find((i) => i.id === id);
    if (!sk) return null;
    const sg = sketchSegs(sk)[+k];
    if (!sg) return null;
    return { key, ax: sg.ax, ay: sg.ay, bx: sg.bx, by: sg.by, nx: sg.nx, ny: sg.ny, sketch: true };
  }
  const W = wallsOf(block);
  const sg = W.byKey.get(key);
  if (!sg) return null;
  let ax = sg.ax, ay = sg.ay, bx = sg.bx, by = sg.by;
  const room = W.rooms.find((r) => r.no === sg.room);
  const ck = block + '|' + floor + '|' + sg.room;
  let ab = abCache?.get(ck);
  if (ab === undefined) {
    const m = segMapFor(block, floor);
    ab = room.segs.some((q) => m.get(q.key)?.value != null) ? asBuilt(room, (q) => m.get(q.key), unitM()) : null;
    abCache?.set(ck, ab);
  }
  if (ab) { const sp = ab.segPts.find((q) => q.seg.key === sg.key); if (sp) { ax = sp.sx; ay = sp.sy; bx = sp.ex; by = sp.ey; } }
  const L = Math.hypot(bx - ax, by - ay) || 1;
  const inx = -(by - ay) / L, iny = (bx - ax) / L;
  const side = inx * sg.nx + iny * sg.ny >= 0 ? 1 : -1;
  return { key, ax, ay, bx, by, nx: inx * side, ny: iny * side, sg };
}
function openThick(block, d) {
  if (S.settings.wallTh > 0) return S.settings.wallTh / 100 / unitM();
  if (d.sg) return wallThickness(block, d.sg);
  return 0.2 / unitM();
}
/** Проёмы по стандарту: один — по центру стены; несколько — с равными промежутками.
 *  Передвинутый вручную проём остаётся там, где его поставили. */
function openGeom(it, abCache) {
  const d = wallDesc(it.block, it.floor, it.key, abCache);
  if (!d) return null;
  const { ax, ay, bx, by } = d;
  const L = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / L, uy = (by - ay) / L;
  const w = Math.min(it.w / unitM(), L);
  let c;
  if (it.manual) c = Math.max(w / 2, Math.min(L - w / 2, (it.t ?? 0.5) * L));
  else {
    const sib = S.items.filter((o) => o.kind === 'open' && !o.manual && o.block === it.block && o.floor === it.floor && o.key === it.key)
      .sort((p, q) => (p.t0 || 0) - (q.t0 || 0));
    const ws = sib.map((o) => Math.min(o.w / unitM(), L));
    const gap = Math.max(0, (L - ws.reduce((t, x) => t + x, 0)) / (sib.length + 1));
    let x = gap;
    for (let i = 0; i < sib.length; i++) { if (sib[i] === it) { c = x + ws[i] / 2; break; } x += ws[i] + gap; }
    if (c == null) c = L / 2;
  }
  const p0 = { x: ax + ux * (c - w / 2), y: ay + uy * (c - w / 2) };
  const p1 = { x: ax + ux * (c + w / 2), y: ay + uy * (c + w / 2) };
  return { p0, p1, n: { x: d.nx, y: d.ny }, th: openThick(it.block, d), w, d, c: { x: ax + ux * c, y: ay + uy * c } };
}
/** Ближайшая стена под пальцем: стены чертежа и начерченные линии */
function pointInPoly(x, y, p) {
  let c = false; const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function pickWall(sx, sy) {
  const direct = pickWallNear(sx, sy, 34);
  if (direct) return direct;
  // нажали внутри комнаты — ближайшая стена этой комнаты
  const w = screenToWorld(sx, sy);
  let best = null, bd = Infinity;
  for (const it of curItems()) {
    if (it.kind !== 'sketch' || !it.dirs || !it.closed || !pointInPoly(w.x, w.y, it.pts)) continue;
    for (const sg of sketchSegs(it)) {
      const a = w2s(sg.ax, sg.ay), b = w2s(sg.bx, sg.by), d = distSeg(sx, sy, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = sg; }
    }
  }
  if (!best && hasDrawing()) {
    const W = wallsOf();
    for (const room of W.rooms) {
      if (!room.closed) continue;
      const poly = room.segs.flatMap((q) => [q.ax, q.ay]);
      if (!pointInPoly(w.x, w.y, poly)) continue;
      for (const sg of room.segs) {
        const a = w2s(sg.ax, sg.ay), b = w2s(sg.bx, sg.by), d = distSeg(sx, sy, a.x, a.y, b.x, b.y);
        if (d < bd) { bd = d; best = { key: sg.key, ax: sg.ax, ay: sg.ay, bx: sg.bx, by: sg.by }; }
      }
    }
  }
  return best;
}
function pickWallNear(sx, sy, tol) {
  let best = null, bd = tol;
  if (hasDrawing()) {
    const sg = pickSeg(sx, sy);
    if (sg) {
      const a = w2s(sg.ax, sg.ay), b = w2s(sg.bx, sg.by);
      best = { key: sg.key, ax: sg.ax, ay: sg.ay, bx: sg.bx, by: sg.by }; bd = distSeg(sx, sy, a.x, a.y, b.x, b.y);
    }
  }
  const hs = pickSketchSeg(sx, sy, false, tol);
  if (hs) {
    const a = w2s(hs.sg.ax, hs.sg.ay), b = w2s(hs.sg.bx, hs.sg.by), dd = distSeg(sx, sy, a.x, a.y, b.x, b.y);
    if (dd <= bd) best = hs.sg;
  }
  return best;
}
function placeOpening(type, sx, sy) {
  const sg = pickWall(sx, sy);
  if (!sg) { toast('Нажмите на стену или внутри комнаты у стены', true); return null; }
  pushUndo();
  const it = { id: uid(), kind: 'open', otype: type, key: sg.key, t: 0.5, w: OPEN_W[type], block: S.block, floor: S.floor, t0: Date.now() };
  S.items.push(it); save(); draw();
  toast(type === 'window' ? 'Окно поставлено' : 'Дверь поставлена', true);
  return it;
}
/** Засечки двери: [x, y, половина длины] в единицах чертежа — края короче, середина длиннее */
function doorTicks(g) {
  const u = (UNIT_MM[S.plan.unit] || 1);
  const m = (v) => (v * 1000) / u; // метры → единицы чертежа
  const off = g.th / 2;
  const at = (t) => [g.p0.x + (g.p1.x - g.p0.x) * t - g.n.x * off, g.p0.y + (g.p1.y - g.p0.y) * t - g.n.y * off];
  const sh = Math.max(off, 0) + m(0.12), lg = Math.max(off, 0) + m(0.28);
  return [[...at(0), sh], [...at(0.5), lg], [...at(1), sh]];
}
/** Рисует условное обозначение. tr(x,y) → экранная точка; scale — px на единицу чертежа */
function drawOpeningSym(c, it, g, tr, scale, ink, paper, opts = {}) {
  const P0 = tr(g.p0.x, g.p0.y), P1 = tr(g.p1.x, g.p1.y);
  const Q0 = tr(g.p0.x - g.n.x * g.th, g.p0.y - g.n.y * g.th);
  const Q1 = tr(g.p1.x - g.n.x * g.th, g.p1.y - g.n.y * g.th);
  c.save();
  if (it.otype !== 'window') {
    // дверь: стена не прерывается, поперёк — короткие засечки по краям и длинная в середине
    c.lineWidth = (opts.lw || 1.3) * 1.2; c.strokeStyle = ink; c.lineCap = 'round';
    for (const [x, y, h] of doorTicks(g)) {
      const a = tr(x - g.n.x * h, y - g.n.y * h), b = tr(x + g.n.x * h, y + g.n.y * h);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    c.restore();
    return { P0, P1, Q0, Q1 };
  }
  // стереть стену в проёме
  c.fillStyle = paper;
  c.beginPath(); c.moveTo(P0.x, P0.y); c.lineTo(P1.x, P1.y); c.lineTo(Q1.x, Q1.y); c.lineTo(Q0.x, Q0.y); c.closePath();
  c.fill();
  c.lineWidth = opts.lw || 1.3; c.strokeStyle = ink; c.lineCap = 'butt';
  const L = (a, b) => { c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); };
  L(P0, Q0); L(P1, Q1);
  if (it.otype === 'window') {
    L(P0, P1); L(Q0, Q1);
    L({ x: (P0.x + Q0.x) / 2, y: (P0.y + Q0.y) / 2 }, { x: (P1.x + Q1.x) / 2, y: (P1.y + Q1.y) / 2 });
  } else {
    // дверь: полотно и дуга открывания внутрь комнаты
    const hinge = it.flip ? P1 : P0, other = it.flip ? P0 : P1;
    const inS = tr(g.c.x + g.n.x, g.c.y + g.n.y), cS = tr(g.c.x, g.c.y);
    let nx = inS.x - cS.x, ny = inS.y - cS.y; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const r = Math.hypot(other.x - hinge.x, other.y - hinge.y);
    const leaf = { x: hinge.x + nx * r, y: hinge.y + ny * r };
    c.lineWidth = (opts.lw || 1.3) * 1.2; L(hinge, leaf);
    c.lineWidth = (opts.lw || 1.3) * 0.7;
    const a0 = Math.atan2(leaf.y - hinge.y, leaf.x - hinge.x), a1 = Math.atan2(other.y - hinge.y, other.x - hinge.x);
    let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    c.beginPath(); c.arc(hinge.x, hinge.y, r, a0, a0 + d, d < 0); c.stroke();
  }
  c.restore();
  return { P0, P1, Q0, Q1 };
}
function drawOpenings(c, b, v, pal, opts = {}) {
  const floor = opts.floor ?? S.floor;
  const its = S.items.filter((i) => i.kind === 'open' && i.block === b.name && i.floor === floor);
  if (!its.length) return;
  const cache = new Map();
  const tr = (x, y) => w2s(x, y, v);
  for (const it of its) {
    const g = openGeom(it, cache);
    if (!g) continue;
    const sel = !opts.export && it.id === S.selId;
    drawOpeningSym(c, it, g, tr, v.s, opts.ink || (sel ? pal.accent2 : pal.ink), opts.paper || pal.paper, { lw: opts.lw || (sel ? 2.2 : 1.4) });
    if (sel) {
      const m = tr(g.c.x, g.c.y);
      handle(c, m, pal);
    }
  }
}
function pickOpen(sx, sy) {
  const cache = new Map();
  for (const it of curItems().filter((i) => i.kind === 'open').reverse()) {
    const g = openGeom(it, cache); if (!g) continue;
    const m = w2s(g.c.x, g.c.y);
    if (Math.hypot(m.x - sx, m.y - sy) < 22) return it;
  }
  return null;
}
/* ---------- пульт направлений (←↑→↓) и удаление поворотов ---------- */
const DIR_DEG = { r: 0, u: 90, l: 180, d: 270 };
function normDeg(a) { while (a > 180) a -= 360; while (a <= -180) a += 360; return a; }
function nearestDir(deg) {
  let best = 'r', bd = 999;
  for (const [k, v] of Object.entries(DIR_DEG)) { const d = Math.abs(normDeg(deg - v)); if (d < bd) { bd = d; best = k; } }
  return best;
}
function curWallDir() {
  const sg = wallsOf().byKey.get(S.selSeg);
  if (!sg) return null;
  const it = segItem(S.selSeg);
  return nearestDir((Math.atan2(sg.by - sg.ay, sg.bx - sg.ax) * 180) / Math.PI + (it?.ang || 0));
}
function syncDpad() {
  const dp = $('dpad');
  const show = (S.tool === 'walls' && !!S.selSeg) || S.tool === 'sketch';
  dp.hidden = !show;
  if (!show) return;
  const sh = $('sheet');
  dp.style.bottom = (sh.hidden ? 14 : sh.offsetHeight + 10) + 'px';
  const on = S.tool === 'walls' ? curWallDir() : S.sketchDir;
  for (const b of dp.querySelectorAll('[data-d]')) b.classList.toggle('on', b.dataset.d === on);
}
function onDpad(d) {
  if (S.tool === 'walls' && S.selSeg) {
    const sg = wallsOf().byKey.get(S.selSeg);
    pushUndo();
    const it = segItem(S.selSeg, true);
    const base = (Math.atan2(sg.by - sg.ay, sg.bx - sg.ax) * 180) / Math.PI;
    let a = Math.round(normDeg(DIR_DEG[d] - base) * 10) / 10;
    if (Math.abs(a) < 0.05) a = 0;
    it.ang = a;
    save(); refreshSheet(); draw();
  } else if (S.tool === 'sketch') {
    S.sketchDir = d;
    if (!S.draft) hint('Нажмите на план — начало линии, затем измерьте лазером');
    else hint('Направление выбрано — измерьте лазером');
  }
  syncDpad();
}
/** Стена-«выступ»: короткая, а стены по бокам параллельны (на самом деле стена ровная) */
function jogInfo(key) {
  const W = wallsOf();
  const sg = W.byKey.get(key);
  if (!sg) return null;
  const room = W.rooms.find((r) => r.no === sg.room);
  const i = room.segs.indexOf(sg), n = room.segs.length;
  const prev = room.closed || i > 0 ? room.segs[(i - 1 + n) % n] : null;
  const next = room.closed || i < n - 1 ? room.segs[(i + 1) % n] : null;
  let parallel = false;
  if (prev && next && prev !== next) {
    const u = (s) => { const L = Math.hypot(s.bx - s.ax, s.by - s.ay); return [(s.bx - s.ax) / L, (s.by - s.ay) / L]; };
    const [a, b] = [u(prev), u(next)];
    parallel = a[0] * b[0] + a[1] * b[1] > 0.985;
  }
  return { sg, prev, next, parallel, isJog: sg.len < 0.6 && parallel };
}
function mergeTurn(key) {
  const J = jogInfo(key);
  if (!J) return;
  pushUndo();
  const mark = (k) => { const it = segItem(k, true); it.merged = true; it.value = 0; delete it.copied; it.mt = Date.now(); };
  mark(key);
  // соседняя стена «съедается» только если её ещё не мерили (иначе замер сохраняется)
  if (J.parallel && J.next && !isDone(segItem(J.next.key)) && J.next.key !== key) {
    mark(J.next.key);
    const p = segItem(J.prev.key, true);
    if (!p.designManual) p.design = J.prev.len + J.next.len;
  }
  save();
  toast('Поворот удалён — стена считается ровной');
}
let askingTurn = false;
/** Во время замера: если следующая стена — короткий выступ, спросить, удалить ли поворот */
function maybeAskTurn() {
  if (focusMode || !S.session || askingTurn || !S.selSeg) return;
  const J = jogInfo(S.selSeg);
  if (!J?.isJog || isDone(segItem(S.selSeg))) return;
  askingTurn = true;
  ask(`Выступ ${fmt(J.sg.len)} м (комната ${J.sg.room}, стена ${J.sg.wall}).\nЕсли здесь стена ровная — удалить поворот?`, 'Удалить поворот').then((yes) => {
    askingTurn = false;
    if (yes) { mergeTurn(S.selSeg); gotoSeg(1, true); }
  });
}
/* ---------- компактная панель замера: налево / прямо / направо ---------- */
const REL = { l: 90, s: 0, r: -90 };
/** Направление предыдущей стены (по обмеру) — относительно него «налево/прямо/направо» */
function wallBaseDir(sg) {
  const W = wallsOf();
  const room = W.rooms.find((r) => r.no === sg.room);
  const ab = roomAsBuilt(room);
  const i = ab.segPts.findIndex((q) => q.seg.key === sg.key);
  const prev = i > 0 ? ab.segPts[i - 1] : room.closed ? ab.segPts[ab.segPts.length - 1] : null;
  if (prev && prev !== ab.segPts[i] && Math.hypot(prev.ex - prev.sx, prev.ey - prev.sy) > 1e-9) {
    return (Math.atan2(prev.ey - prev.sy, prev.ex - prev.sx) * 180) / Math.PI;
  }
  return (Math.atan2(sg.by - sg.ay, sg.bx - sg.ax) * 180) / Math.PI;
}
function wallCurDir(sg) {
  const it = segItem(sg.key);
  return (Math.atan2(sg.by - sg.ay, sg.bx - sg.ax) * 180) / Math.PI + (it?.ang || 0);
}
function relOf(diff) {
  diff = normDeg(diff);
  for (const [k, v] of Object.entries(REL)) if (Math.abs(normDeg(diff - v)) < 20) return k;
  return null;
}
function sketchLastDir() {
  const it = skItem();
  if (it?.dirs.length) return it.dirs[it.dirs.length - 1];
  return 90; // первая линия: «прямо» = вверх по плану
}
function onRel(r) {
  if (S.tool === 'sketch' && S.skm) {
    const it = skmItem();
    if (it) {
      pushUndo();
      const i = S.skm.i;
      it.dirs[i] = Math.round(normDeg(skPrevDir(it, i) + REL[r]) * 100) / 100;
      rebuildSketch(it); save(); draw();
    }
  } else if (S.tool === 'sketch') {
    S.sketchRel = r;
    if (!S.draft) hint('Нажмите на план — начало линии');
  } else if (S.selSeg) {
    const sg = wallsOf().byKey.get(S.selSeg);
    const target = wallBaseDir(sg) + REL[r];
    const design = (Math.atan2(sg.by - sg.ay, sg.bx - sg.ax) * 180) / Math.PI;
    pushUndo();
    const it = segItem(S.selSeg, true);
    let a = Math.round(normDeg(target - design) * 10) / 10;
    if (Math.abs(a) < 0.05) a = 0;
    it.ang = a;
    save(); draw();
  }
  syncMbar();
}
function syncLaserBtn() {
  const f = S.settings.laserRef === 'front';
  $('laserBtn').classList.toggle('on', f);
  $('laserTxt').textContent = f ? 'СПЕРЕДИ' : 'СЗАДИ';
}
function mbarMode() {
  if (S.tool === 'sketch') return 'sketch';
  if (S.tool === 'walls' && S.selSeg && S.session) return 'walls';
  return null;
}
function syncMbar() {
  const mode = mbarMode();
  const mb = $('mbar');
  mb.hidden = !mode;
  $('dirPad').hidden = !mode;
  $('openPad').hidden = !focusMode;
  const canEdit = S.tool === 'sketch' && !!turnTarget() && (S.draft || S.skm);
  for (const id of ['mFlip', 'mSplit', 'mDel', 'fsFlip', 'fsSplit', 'fsDel']) $(id).hidden = !canEdit;
  $('fsDone').hidden = !(S.tool === 'sketch' && (S.skm || (S.draft && skItem()?.dirs?.length)));
  $('dpad').hidden = true;
  if (!mode) return;
  const isW = mode === 'walls';
  for (const id of ['mPrev', 'mNext', 'mMerge', 'mMore']) $(id).hidden = !isW;
  $('mClose').hidden = true;
  let on = null;
  if (isW) {
    const sg = wallsOf().byKey.get(S.selSeg);
    if (!sg) return;
    const it = segItem(S.selSeg);
    $('mTitle').textContent = `К${sg.room} · стена ${sg.wall}/${sg.of} · черт. ${fmt(sg.len)}` + (it?.copied ? ` · с ${it.copied.from} эт.` : '') + (it?.merged ? ' · поворот удалён' : '');
    $('mVal').textContent = it?.value != null && !it.merged ? fmt(it.value) + ' м' : '?';
    on = relOf(wallCurDir(sg) - wallBaseDir(sg));
  } else {
    const sk = skmItem();
    $('mPrev').hidden = $('mNext').hidden = !sk;
    $('mClose').hidden = !(skItem()?.dirs.length >= 2);
    if (sk) {
      const i = S.skm.i, n = sk.dirs.length;
      $('mTitle').textContent = `Замер · стена ${i + 1}/${n} · рисунок ≈${fmt(sk.dlens[i])}`;
      $('mVal').textContent = sk.lens[i] != null ? fmt(sk.lens[i]) + ' м' : '?';
      on = relOf(sk.dirs[i] - skPrevDir(sk, i));
    } else {
      const it = skItem();
      const n = it?.dirs.length || 0;
      $('mTitle').textContent = S.draft ? (n ? `Линия · стен ${n}` : 'Начало линии стоит — направление + лазер') : 'Нажмите на план — начало линии';
      const l = n ? it.lens[n - 1] ?? it.dlens[n - 1] : null;
      $('mVal').textContent = l != null ? fmt(l) + ' м' : '';
      on = S.sketchRel;
    }
  }
  for (const b of document.querySelectorAll('#dirPad [data-r]')) b.classList.toggle('on', b.dataset.r === on);
}
function bindMbar() {
  for (const b of document.querySelectorAll('#dirPad [data-r]')) b.onclick = () => onRel(b.dataset.r);
  $('dirUndo').onclick = () => (S.tool === 'sketch' && S.draft ? sketchUndo() : doUndo());
  $('mUndo').onclick = () => (S.tool === 'sketch' && S.draft ? sketchUndo() : doUndo());
  $('mRedo').onclick = doRedo;
  $('dirRedo').onclick = doRedo;
  $('mPrev').onclick = () => (S.tool === 'sketch' ? skmGo(-1) : gotoSeg(-1));
  $('mNext').onclick = () => (S.tool === 'sketch' ? skmGo(1) : gotoSeg(1, true));
  $('mClose').onclick = () => finishSketch(true);
  $('laserBtn').onclick = () => {
    S.settings.laserRef = S.settings.laserRef === 'front' ? 'back' : 'front';
    syncLaserBtn(); save();
    toast(S.settings.laserRef === 'front' ? `Замер спереди: минус ${fmt(S.settings.laserOffset ?? 0.13)} м` : 'Замер сзади: как есть');
  };
  syncLaserBtn();
  $('mMerge').onclick = () => $('shMerge').click();
  $('mMore').onclick = () => { S.sheetFull = true; refreshSheet(); };
  $('mFlip').onclick = $('fsFlip').onclick = lineFlip;
  $('mSplit').onclick = $('fsSplit').onclick = lineSplit;
  $('mDel').onclick = $('fsDel').onclick = lineDel;
  $('fsDone').onclick = lineDoneBtn;
  $('mStop').onclick = () => {
    if (S.tool === 'sketch') { S.skm = null; finishSketch(false); hint('Линия завершена'); return; }
    S.session = false; S.sheetFull = false; hint('Замер остановлен'); refreshSheet(); draw();
  };
}
/* ---------- слои ---------- */
const LAYERS = [
  ['drawing', 'Чертёж (подложка, красный)', 'загруженный DWG/DXF'],
  ['shadow', 'Тень соседнего этажа', 'бледный контур этажа выше/ниже'],
  ['shadowDims', 'Размеры на тени', 'длины стен соседнего этажа, серым'],
  ['dims', 'Размеры', 'длины стен'],
  ['areas', 'Номера и площади комнат', ''],
  ['openings', 'Двери и окна', ''],
  ['thick', 'Толщина стен', 'наружный контур стен (толщина — в меню)'],
  ['hatch', 'Штриховка стен', 'заливка толщины стен'],
  ['text', 'Текст и выноски', 'добавляет инструмент «Текст»'],
  ['mini', 'Мини-карта слева', 'уменьшенный план без поворота'],
  ['redoBtn', 'Кнопка «Повторить»', 'рядом с «Отменить»'],
  ['roomOps', 'Копировать / повернуть / зеркало', 'кнопки у выбранной комнаты'],
];
function renderLayers() {
  const el = $('layersList');
  el.innerHTML = '';
  for (const [k, name, sub] of LAYERS) {
    const row = document.createElement('label'); row.className = 'layerRow';
    row.innerHTML = `<span>${name}${sub ? `<small>${sub}</small>` : ''}</span>`;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!S.settings.layers[k];
    cb.onchange = () => { S.settings.layers[k] = cb.checked; save(); syncToolUI(); draw(); };
    row.appendChild(cb); el.appendChild(row);
  }
}
/* ---------- перенос кнопок (по желанию; по умолчанию — стандартные места) ---------- */
function applyBtnPos() {
  const st = $('stage').getBoundingClientRect();
  for (const el of document.querySelectorAll('[data-fl]')) {
    const p = S.settings.btnPos?.[el.dataset.fl];
    if (!p) { el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = ''; continue; }
    el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
    el.style.left = Math.max(0, Math.min(st.width - 40, p.x * st.width)) + 'px';
    el.style.top = Math.max(0, Math.min(st.height - 40, p.y * st.height)) + 'px';
  }
}
let arrDrag = null;
function setArrange(on) {
  document.body.classList.toggle('arrange', on);
  $('arrangeBar').hidden = !on;
  if (on) { for (const el of document.querySelectorAll('[data-fl]')) el.hidden = false; $('openPad').style.display = 'flex'; }
  else { $('openPad').style.display = ''; syncMbar(); }
}
function bindArrange() {
  document.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('arrange')) return;
    const el = e.target.closest('[data-fl]');
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    arrDrag = { el, dx: e.clientX - r.left, dy: e.clientY - r.top };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!arrDrag) return;
    const st = $('stage').getBoundingClientRect();
    const x = (e.clientX - arrDrag.dx - st.left) / st.width, y = (e.clientY - arrDrag.dy - st.top) / st.height;
    S.settings.btnPos[arrDrag.el.dataset.fl] = { x: Math.max(0, Math.min(0.95, x)), y: Math.max(0, Math.min(0.95, y)) };
    applyBtnPos();
  }, true);
  document.addEventListener('pointerup', () => { if (arrDrag) { arrDrag = null; save(); } }, true);
  document.addEventListener('click', (e) => { if (document.body.classList.contains('arrange') && e.target.closest('[data-fl]')) { e.preventDefault(); e.stopPropagation(); } }, true);
  $('btnArrange').onclick = () => { $('layersModal').hidden = true; setArrange(true); };
  $('btnArrangeReset').onclick = () => { S.settings.btnPos = {}; save(); applyBtnPos(); toast('Кнопки — на стандартных местах'); };
  $('arrangeDone').onclick = () => setArrange(false);
}
/* ---------- толщина стен: наружный контур со смещением ---------- */
function offsetPoly(pts, d) {
  // pts — вершины замкнутого контура [x,y,...]; d > 0 — наружу
  const n = pts.length / 2;
  if (n < 3) return null;
  let A = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
  const sgn = A >= 0 ? -1 : 1; // наружная нормаль для обхода против часовой — справа
  const lines = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[j * 2], by = pts[j * 2 + 1];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    const nx = (-(by - ay) / L) * sgn, ny = ((bx - ax) / L) * sgn;
    lines.push({ ax: ax + nx * d, ay: ay + ny * d, dx: (bx - ax) / L, dy: (by - ay) / L });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = lines[(i - 1 + n) % n], q = lines[i];
    const den = p.dx * q.dy - p.dy * q.dx;
    if (Math.abs(den) < 1e-6) { out.push(q.ax, q.ay); continue; }
    const t = ((q.ax - p.ax) * q.dy - (q.ay - p.ay) * q.dx) / den;
    out.push(p.ax + p.dx * t, p.ay + p.dy * t);
  }
  return out;
}
/** Внутренние контуры комнат этажа (мои замеры): начерченные комнаты и обмерные контуры по чертежу */
function roomContours(block, floor) {
  const out = [];
  for (const it of S.items) {
    if (it.kind !== 'sketch' || it.block !== block || it.floor !== floor || !it.closed) continue;
    out.push(it.pts.slice());
  }
  const b = S.plan.blocks.find((x) => x.name === block);
  if (b && !b.blank) {
    const m = segMapFor(block, floor);
    for (const room of prepBlock(b).walls.rooms) {
      if (!room.closed || !room.segs.some((q) => m.get(q.key)?.value != null)) continue;
      out.push(asBuilt(room, (q) => m.get(q.key), unitM()).pts);
    }
  }
  return out;
}
function drawThickWalls(c, block, floor, v, pal, opts = {}) {
  const th = S.settings.wallTh / 100 / unitM();
  if (!(th > 0) || !S.settings.layers.thick) return;
  for (const p of roomContours(block, floor)) {
    const o = offsetPoly(p, th);
    if (!o) continue;
    c.save();
    c.beginPath(); path(c, o, v); c.closePath(); path(c, p, v); c.closePath();
    if (S.settings.layers.hatch) {
      c.clip('evenodd');
      c.strokeStyle = opts.ink || GREEN; c.globalAlpha = 0.45; c.lineWidth = 1;
      const W0 = c.canvas.width, H0 = c.canvas.height;
      for (let k = -H0; k < W0; k += 9) { c.beginPath(); c.moveTo(k, H0); c.lineTo(k + H0, 0); c.stroke(); }
    } else {
      c.fillStyle = opts.fill || 'rgba(22,163,74,.10)'; c.fill('evenodd');
    }
    c.restore();
    c.save(); c.strokeStyle = opts.ink || GREEN; c.lineWidth = opts.lw || 1.6;
    c.beginPath(); path(c, o, v); c.closePath(); c.stroke(); c.restore();
  }
}
/* ---------- рулетка: расстояние и площадь, без записи в чертёж ---------- */
function rulerTap(w, dbl, sp) {
  if (!S.ruler || S.ruler.done) S.ruler = { pts: [] };
  const R = S.ruler;
  if (R.pts.length >= 6) {
    const f = w2s(R.pts[0], R.pts[1]), q = sp || w2s(w.x, w.y);
    if (Math.hypot(f.x - q.x, f.y - q.y) < 18) { R.closed = true; R.done = true; draw(); return; }
  }
  if (dbl && R.pts.length >= 4) { R.done = true; draw(); return; }
  R.pts.push(w.x, w.y);
  draw();
}
function drawRuler(c, v, pal) {
  const R = S.ruler;
  if (!R || !R.pts.length) return;
  const u = unitM();
  c.save(); c.strokeStyle = '#7c3aed'; c.lineWidth = 2; c.setLineDash([7, 5]);
  c.beginPath(); path(c, R.pts, v); if (R.closed) c.closePath(); c.stroke(); c.setLineDash([]);
  let total = 0;
  const segs = R.pts.length / 2 - 1 + (R.closed ? 1 : 0);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % (R.pts.length / 2);
    const ax = R.pts[i * 2], ay = R.pts[i * 2 + 1], bx = R.pts[j * 2], by = R.pts[j * 2 + 1];
    const L = Math.hypot(bx - ax, by - ay) * u; total += L;
    const a = w2s(ax, ay, v), b = w2s(bx, by, v);
    pill(c, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12, fmt(L) + ' м', '#7c3aed', '#fff', { size: 11, shadow: false });
  }
  for (let i = 0; i < R.pts.length; i += 2) { const q = w2s(R.pts[i], R.pts[i + 1], v); c.fillStyle = '#7c3aed'; c.beginPath(); c.arc(q.x, q.y, 4, 0, 7); c.fill(); }
  const txt = R.closed ? `S = ${fmt(polyArea(R.pts) * u * u)} м² · P = ${fmt(total)} м` : segs > 1 ? `Σ ${fmt(total)} м` : '';
  if (txt) pill(c, cv.clientWidth / 2, 86, txt, '#7c3aed', '#fff', { size: 13 });
  c.restore();
}
/* ---------- текст и выноски ---------- */
async function textTap(w) {
  if (!S.textDraft) { S.textDraft = { tx: w.x, ty: w.y }; hint('Теперь нажмите, где поставить текст (то же место — без выноски)'); draw(); return; }
  const d = S.textDraft; S.textDraft = null;
  const txt = await ask('Текст на чертеже:', 'Добавить', false, '');
  if (!txt || typeof txt !== 'string' || !txt.trim()) { draw(); return; }
  pushUndo();
  const same = Math.hypot(d.tx - w.x, d.ty - w.y) * V().s < 10;
  S.items.push({ id: uid(), kind: 'text', text: txt.trim(), x: w.x, y: w.y, ...(same ? {} : { tx: d.tx, ty: d.ty }), block: S.block, floor: S.floor, t: Date.now() });
  save(); draw();
}
function drawTexts(c, block, floor, v, pal, opts = {}) {
  if (!S.settings.layers.text) return;
  for (const it of S.items) {
    if (it.kind !== 'text' || it.block !== block || it.floor !== floor) continue;
    const p = w2s(it.x, it.y, v);
    c.save();
    c.fillStyle = opts.ink || pal.ink; c.strokeStyle = opts.ink || pal.ink; c.lineWidth = 1.2;
    c.font = `600 ${opts.fs || 12}px system-ui, sans-serif`; c.textAlign = 'left'; c.textBaseline = 'bottom';
    const w = c.measureText(it.text).width;
    if (it.tx != null) {
      const t = w2s(it.tx, it.ty, v);
      c.beginPath(); c.moveTo(t.x, t.y); c.lineTo(p.x, p.y); c.lineTo(p.x + w + 4, p.y); c.stroke();
      const a = Math.atan2(t.y - p.y, t.x - p.x);
      c.beginPath(); c.moveTo(t.x, t.y); c.lineTo(t.x - 8 * Math.cos(a - 0.35), t.y - 8 * Math.sin(a - 0.35)); c.lineTo(t.x - 8 * Math.cos(a + 0.35), t.y - 8 * Math.sin(a + 0.35)); c.closePath(); c.fill();
    }
    c.fillText(it.text, p.x + 2, p.y - 2);
    c.restore();
  }
}
/* ---------- копировать / повернуть / зеркало (комната-линия) ---------- */
function roomCopy(it) {
  pushUndo();
  const c = JSON.parse(JSON.stringify(it)); c.id = uid(); c.t = Date.now();
  let x0 = Infinity, x1 = -Infinity; for (let i = 0; i < it.pts.length; i += 2) { x0 = Math.min(x0, it.pts[i]); x1 = Math.max(x1, it.pts[i]); }
  const dx = x1 - x0 + (S.settings.wallTh > 0 ? S.settings.wallTh / 100 : 0.5) / unitM();
  if (c.start) c.start[0] += dx; c.pts = c.pts.map((q, i) => (i % 2 ? q : q + dx));
  S.items.push(c);
  for (const o of S.items.filter((q) => q.kind === 'open' && q.key?.startsWith(`sk:${it.id}:`))) S.items.push({ ...o, id: uid(), key: o.key.replace(it.id, c.id) });
  if (c.dirs) rebuildSketch(c);
  save(); select(c.id); draw();
}
function roomRotate(it) {
  if (!it.dirs) return;
  pushUndo();
  const cp = polyCentroid(it.pts);
  const [sx, sy] = it.start;
  it.start = [cp.x - (sy - cp.y), cp.y + (sx - cp.x)];
  it.dirs = it.dirs.map((a) => normDeg(a + 90));
  rebuildSketch(it); save(); draw();
}
function roomMirror(it) {
  if (!it.dirs) return;
  pushUndo();
  const cp = polyCentroid(it.pts);
  it.start = [2 * cp.x - it.start[0], it.start[1]];
  it.dirs = it.dirs.map((a) => normDeg(180 - a));
  rebuildSketch(it);
  if (it.closed) makeCCW(it);
  save(); draw();
}
/* ---------- верхняя панель ---------- */
function renderBlocks() {
  const el = $('blocks');
  el.innerHTML = '';
  for (const b of S.plan.blocks) {
    const btn = document.createElement('button');
    btn.textContent = b.blank ? (b.blockLabel ? `${b.title} ${b.blockLabel}` : b.title || b.name) : (b.blockLabel || b.name);
    btn.className = b.name === S.block ? 'on' : '';
    btn.onclick = () => setBlock(b.name);
    el.appendChild(btn);
  }
  const add = document.createElement('button');
  add.textContent = '+'; add.className = 'addSheet'; add.title = 'Новый лист без чертежа';
  add.onclick = () => openNewSheet();
  el.appendChild(add);
}
/** Новый лист: наименование, блок, этаж */
function openNewSheet() {
  $('nsTitle').value = '';
  $('nsBlock').value = blk()?.blockLabel || '';
  $('nsFloor').value = S.floor ?? 1;
  $('sheetModal').hidden = false;
  setTimeout(() => { if (document.activeElement?.tagName !== 'INPUT') $('nsTitle').focus(); }, 60);
}
function uniqueSheetName(base) {
  let name = base || 'Лист', k = 2;
  while (S.plan.blocks.some((b) => b.name === name)) name = `${base} (${k++})`;
  return name;
}
function createSheet(title, blockLabel, floor) {
  title = title.trim() || `Лист ${S.plan.blocks.length + 1}`;
  blockLabel = blockLabel.trim();
  const name = uniqueSheetName(title + (blockLabel ? ' · ' + blockLabel : ''));
  const size = 24 / unitM(), h = 16 / unitM();
  S.plan.blocks.push({ id: 'sh' + Date.now(), name, title, blockLabel, blank: true, bbox: [0, 0, size, h], polys: [], texts: [] });
  DB.set('plan', stripPrep(S.plan));
  S.floor = floor;
  $('floorNum').textContent = S.floor;
  setBlock(name);
  setTool('sketch');
  startBlankDraft();
  save();
  toast(`${name}, этаж ${floor}: выберите направление и меряйте лазером`);
}
function isBlank() { return !!blk()?.blank; }
function growBlank(x, y) {
  const b = blk();
  if (!b.blank) return;
  const mg = 2 / unitM();
  const bb = b.bbox;
  if (x - mg < bb[0] || x + mg > bb[2] || y - mg < bb[1] || y + mg > bb[3]) {
    b.bbox = [Math.min(bb[0], x - mg), Math.min(bb[1], y - mg), Math.max(bb[2], x + mg), Math.max(bb[3], y + mg)];
    delete b._prep;
    DB.set('plan', stripPrep(S.plan));
  }
}
/** На пустом листе начало линии ставится само — сразу можно мерить */
function startBlankDraft() {
  if (!isBlank() || S.draft || S.skm) return;
  const b = blk();
  const has = curItems().filter((i) => i.kind === 'sketch');
  let x = (b.bbox[0] + b.bbox[2]) / 2, y = (b.bbox[1] + b.bbox[3]) / 2;
  if (has.length) {
    // следующая комната — вплотную справа от последней начерченной (не в другом конце плана)
    const lastR = has.slice().sort((a, b) => (b.t || 0) - (a.t || 0))[0];
    let mx = -Infinity, my = 0;
    for (let i = 0; i < lastR.pts.length; i += 2) { if (lastR.pts[i] > mx || (lastR.pts[i] === mx && lastR.pts[i + 1] > my)) { mx = lastR.pts[i]; my = lastR.pts[i + 1]; } }
    const th = S.settings.wallTh > 0 ? S.settings.wallTh / 100 : 0.5;
    x = mx + th / unitM(); y = my;
  }
  S.draft = { kind: 'sketch', pts: [x, y], auto: true };
  S.sketchRel = S.sketchRel || 's';
}
function setBlock(name) {
  S.block = name; S.draft = null; S.selSeg = null; S.session = false; select(null);
  if (S.plan.blocks.find((b) => b.name === name)?.blank) { if (S.tool === 'sketch') startBlankDraft(); }
  syncToolUI();
  renderBlocks(); updateDraftBar(); save(); draw();
}
const COPY_KINDS = ['sketch', 'open', 'seg', 'text'];
function floorHasData(f, block = S.block) {
  return S.items.some((i) => i.block === block && i.floor === f && COPY_KINDS.includes(i.kind));
}
function floorsWithDrawing(block = S.block) {
  return [...new Set(S.items.filter((i) => i.block === block && COPY_KINDS.includes(i.kind)).map((i) => i.floor))].sort((a, b) => b - a);
}
/** Копия этажа: mode 'lines' — только форма, 'dims' — с размерами */
function copyFloor(src, dst, mode, withOpen) {
  pushUndo();
  const idMap = new Map(), now = Date.now(), add = [];
  for (const it of S.items.filter((i) => i.block === S.block && i.floor === src && i.kind === 'sketch')) {
    const c = JSON.parse(JSON.stringify(it));
    c.id = uid(); c.floor = dst; c.t0 = now; c.t = now; idMap.set(it.id, c.id);
    if (mode === 'lines' && c.dirs) {
      c.dlens = c.dirs.map((_, k) => it.lens[k] ?? it.dlens[k] ?? 0);
      c.lens = c.dirs.map(() => null); c.noDims = true;
      delete c.value; delete c.mt; delete c.src;
    }
    if (c.dirs) rebuildSketch(c);
    add.push(c);
  }
  if (withOpen) for (const it of S.items.filter((i) => i.block === S.block && i.floor === src && i.kind === 'open')) {
    const c = JSON.parse(JSON.stringify(it));
    const m = /^sk:([^:]+):(\d+)$/.exec(c.key || '');
    if (m) { if (!idMap.has(m[1])) continue; c.key = `sk:${idMap.get(m[1])}:${m[2]}`; }
    c.id = uid(); c.floor = dst; c.t0 = now; add.push(c);
  }
  if (mode === 'dims') for (const it of S.items.filter((i) => i.block === S.block && i.floor === src && (i.kind === 'seg' || i.kind === 'text'))) {
    const c = JSON.parse(JSON.stringify(it)); c.id = uid(); c.floor = dst; add.push(c);
  }
  S.items.push(...add);
  // «только линии»: сразу начинаем перемер скопированных стен по очереди, с первой
  const first = mode === 'lines' && dst === S.floor ? add.find((c) => c.kind === 'sketch' && c.dirs?.length) : null;
  if (first) { S.tool = 'sketch'; syncToolUI(); startSkm(first, 0); }
  save(); draw();
  toast(`Этаж ${src} скопирован на этаж ${dst}` + (mode === 'lines' ? (first ? ' — меряйте стены лазером по очереди' : ' — только линии') : ' — с размерами'), true);
}
/** Окно «Копировать чертёж?» → { mode, open, src } или null */
function askCopy(src, dst, pickSrc) {
  return new Promise((res) => {
    const m = $('copyModal');
    $('cpTitle').textContent = pickSrc ? 'Копировать этаж' : 'Копировать чертёж?';
    $('cpFromWrap').hidden = !pickSrc;
    if (pickSrc) {
      const fl = floorsWithDrawing().filter((f) => f !== dst);
      $('cpFrom').innerHTML = fl.map((f) => `<option value="${f}"${f === src ? ' selected' : ''}>Этаж ${f}</option>`).join('');
    }
    const sub = () => { const s0 = pickSrc ? +$('cpFrom').value : src; $('cpSub').textContent = `С этажа ${s0} на этаж ${dst}. Выберите, что перенести:`; };
    sub(); $('cpFrom').onchange = sub;
    m.hidden = false; m._openT = Date.now();
    const done = (v) => { m.hidden = true; $('cpYes').onclick = $('cpNo').onclick = $('cpX').onclick = null; askDone = null; res(v); };
    askDone = () => done(null);
    $('cpNo').onclick = () => done(null);
    $('cpX').onclick = () => done(null);
    $('cpYes').onclick = () => done({ mode: m.querySelector('input[name=cpMode]:checked').value, open: $('cpOpen').checked, src: pickSrc ? +$('cpFrom').value : src });
  });
}
/** Смена этажа кнопками − / +: если на этом этаже есть чертёж, а на новом пусто — предложить копию */
async function changeFloor(f) {
  const from = S.floor;
  if (f !== from && floorHasData(from) && !floorHasData(f)) {
    const r = await askCopy(from, f);
    setFloor(f);
    if (r) copyFloor(r.src, f, r.mode, r.open);
    return;
  }
  setFloor(f);
}
function setFloor(f, keepTo, noCopy) {
  const from = S.floor;
  if (f !== from) {
    S.session = false; S.draft = null; S.selSeg = null;
    void noCopy;
  }
  S.floor = f;
  if (!keepTo) S.toFloor = S.dir === 'down' ? f - 1 : f + 1;
  $('floorNum').textContent = S.floor;
  $('toFloorNum').textContent = S.toFloor ?? '—';
  select(null); refreshSheet(); if (isBlank() && S.tool === 'sketch') startBlankDraft(); save(); draw();
}
function setDir(d) {
  S.dir = d;
  for (const b of $('dirSeg').children) b.classList.toggle('on', b.dataset.dir === d);
  if ((d === 'down' && S.toFloor > S.floor) || (d === 'up' && S.toFloor < S.floor)) S.toFloor = d === 'down' ? S.floor - 1 : S.floor + 1;
  $('toFloorNum').textContent = S.toFloor;
  save();
}
function syncToolUI() {
  const wb = $('tools').querySelector('[data-tool=walls]');
  if (wb) wb.hidden = false;
  $('toolText').hidden = !S.settings.layers.text;
  $('btnRedo').hidden = !S.settings.layers.redoBtn;
  $('mRedo').hidden = !S.settings.layers.redoBtn;
  $('dirRedo').hidden = !S.settings.layers.redoBtn;
  for (const b of $('tools').querySelectorAll('[data-tool]')) {
    const on = b.dataset.tool === S.tool;
    b.classList.toggle('on', on);
    if (on) { $('toolIcon').innerHTML = b.querySelector('svg').outerHTML; $('toolName').textContent = b.querySelector('span').textContent; }
  }
}
function syncSnapUI() {
  for (const b of $('snaps').children) {
    const k = b.dataset.snap;
    b.classList.toggle('on', k === 'ortho' ? !!S.settings.ortho : !!S.settings.snapModes[k]);
  }
  $('btnSnap').classList.toggle('on', !!S.settings.snap);
  $('btnOrtho').classList.toggle('on', !!S.settings.ortho);
  $('btnPolar').classList.toggle('on', !!S.settings.polar);
  $('btnRot').classList.toggle('on', !!S.settings.rotate);
  $('fsSnake').classList.toggle('on', !!S.settings.rotate);
  $('setSnap').checked = !!S.settings.snap;
}
function syncOpenPad() {
  for (const b of $('openPad').querySelectorAll('[data-ot]')) b.classList.toggle('on', b.dataset.ot === S.openArm);
  $('btnTurn').classList.toggle('on', !!S.turnArm);
}
/** Направление текущей линии/стены (градусы) — для поворота плана */
function currentDir() {
  if (S.tool === 'sketch') {
    const sk = skmItem();
    if (sk) return sk.dirs[S.skm.i];
    if (S.draft) return sketchLastDir(); // «голова змейки» — последняя линия смотрит вверх
    return null;
  }
  if (S.tool === 'walls' && S.selSeg) { const sg = wallsOf().byKey.get(S.selSeg); return sg ? wallCurDir(sg) : null; }
  return null;
}
/** «Голова змейки» — конец текущей линии (мир) */
function currentHead() {
  if (S.tool === 'sketch') {
    const sk = skmItem();
    if (sk) { const n = sk.pts.length / 2, j = (S.skm.i + 1) % n; return { x: sk.pts[j * 2], y: sk.pts[j * 2 + 1] }; }
    if (S.draft) return draftFrom();
    return null;
  }
  if (S.tool === 'walls' && S.selSeg) { const sg = wallsOf().byKey.get(S.selSeg); return sg ? { x: sg.bx, y: sg.by } : null; }
  return null;
}
/** Поворот «змейкой»: текущая линия смотрит вверх, её конец стоит в центре экрана, план движется вокруг; кнопки не крутятся */
/** Мини-карта: начерченные линии этажа, север вверх, без поворота; синяя — текущая линия, рамка — что видно на экране */
let miniMap = null;
function drawMini(pal) {
  const mc = $('mini');
  const sks = curItems().filter((i) => i.kind === 'sketch' && i.pts?.length >= 4);
  const show = !!S.settings.layers.mini && sks.length > 0;
  mc.hidden = !show; miniMap = null;
  if (!show) return;
  const W = 112, H = 112, dpr = DPR;
  if (mc.width !== W * dpr) { mc.width = W * dpr; mc.height = H * dpr; }
  const c = mc.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of sks) for (let i = 0; i < it.pts.length; i += 2) { x0 = Math.min(x0, it.pts[i]); x1 = Math.max(x1, it.pts[i]); y0 = Math.min(y0, it.pts[i + 1]); y1 = Math.max(y1, it.pts[i + 1]); }
  const pad = 10, k = Math.min((W - pad * 2) / Math.max(x1 - x0, 1e-6), (H - pad * 2) / Math.max(y1 - y0, 1e-6));
  const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
  const m = (x, y) => ({ x: ox + (x - x0) * k, y: H - oy - (y - y0) * k });
  miniMap = { m, k, x0, y0, ox, oy, H };
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const it of sks) {
    c.strokeStyle = GREEN; c.lineWidth = 1.6; c.beginPath();
    for (let i = 0; i < it.pts.length; i += 2) { const q = m(it.pts[i], it.pts[i + 1]); i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y); }
    if (it.closed) c.closePath();
    c.stroke();
  }
  const ln = currentLine();
  if (ln) {
    const a = m(ln.a.x, ln.a.y), b = m(ln.b.x, ln.b.y);
    c.strokeStyle = '#1f6feb'; c.lineWidth = 3; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    c.fillStyle = '#1f6feb'; c.beginPath(); c.arc(b.x, b.y, 3.5, 0, Math.PI * 2); c.fill();
  }
  // что видно на экране
  const cw = cv.clientWidth, ch = cv.clientHeight;
  const cs = [[0, 0], [cw, 0], [cw, ch], [0, ch]].map(([sx, sy]) => { const w = screenToWorld(sx, sy); return m(w.x, w.y); });
  c.strokeStyle = 'rgba(100,116,139,.8)'; c.lineWidth = 1; c.setLineDash([3, 2]);
  c.beginPath(); cs.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y))); c.closePath(); c.stroke(); c.setLineDash([]);
  // север
  c.fillStyle = '#e03131'; c.font = '800 9px system-ui'; c.textAlign = 'center'; c.fillText('N', W - 9, 11);
}
/** Текущая линия (мир): та, что меряем, или последняя начерченная */
function currentLine() {
  if (S.tool === 'sketch') {
    const sk = skmItem();
    if (sk) { const n = sk.pts.length / 2, k = S.skm.i, j = (k + 1) % n; return { a: { x: sk.pts[k * 2], y: sk.pts[k * 2 + 1] }, b: { x: sk.pts[j * 2], y: sk.pts[j * 2 + 1] } }; }
    const it = skItem();
    if (S.draft && it?.dirs?.length) { const k = it.dirs.length - 1; return { a: { x: it.pts[k * 2], y: it.pts[k * 2 + 1] }, b: { x: it.pts[k * 2 + 2], y: it.pts[k * 2 + 3] } }; }
    return null;
  }
  if (S.tool === 'walls' && S.selSeg) { const sg = wallsOf().byKey.get(S.selSeg); return sg ? { a: { x: sg.ax, y: sg.ay }, b: { x: sg.bx, y: sg.by } } : null; }
  return null;
}
/** Вид: «змейка» (поворот) и, в полноэкранном режиме, масштаб — текущая линия всегда одного размера на экране */
function stepRotation() {
  const v = V();
  if (gesture && gesture.type === 'turn') return false;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!S.viewFollow && (S.settings.rotate || focusMode)) return false;
  let target = 0, head = null, tS = v.s, ax = W / 2, ay = H * 0.55;
  if (S.settings.rotate) {
    const d = currentDir(); if (d == null && !focusMode) return false;
    if (d != null) { target = ((d - 90) * Math.PI) / 180; head = currentHead(); }
  } else target = baseRot(); // без «змейки» — поворот кнопкой «90°»
  const ln = focusMode ? currentLine() : null;
  if (ln) {
    const len = Math.hypot(ln.b.x - ln.a.x, ln.b.y - ln.a.y);
    if (len > 1e-9) tS = Math.max(0.02, Math.min(1e4, (Math.min(W, H) * 0.42) / len)); // линия ≈ 42% экрана
    if (!head) { head = { x: (ln.a.x + ln.b.x) / 2, y: (ln.a.y + ln.b.y) / 2 }; ax = W / 2; ay = H / 2; }
  }
  if (!S.settings.rotate && !ln) {
    // поворот выключен — плавно к повороту кнопки «90°» (обычно север вверх)
    let diff = baseRot() - (v.rot || 0);
    while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) < 0.002) { v.rot = baseRot(); v.pivot = null; return false; }
    // крутим вокруг середины чертежа, и он плавно встаёт в центр экрана
    const c0 = v.pivot || screenToWorld(W / 2, H / 2, v);
    const h = w2s(c0.x, c0.y, v);
    v.rot = (v.rot || 0) + diff * 0.22;
    placeWorldAt(v, c0.x, c0.y, v.pivot ? h.x + (W / 2 - h.x) * 0.22 : W / 2, v.pivot ? h.y + (H / 2 - h.y) * 0.22 : H / 2);
    return true;
  }
  if (!head) return false;
  let diff = target - (v.rot || 0);
  while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
  const key = [head.x, head.y, target, tS, ax, ay].map((q) => q.toFixed(3)).join(',');
  if (v.snakeDone === key) return false; // уже на месте — можно свободно двигать и масштабировать пальцами
  const h = w2s(head.x, head.y, v);
  const dx = ax - h.x, dy = ay - h.y, ks = tS / v.s;
  if (Math.hypot(dx, dy) <= 0.5 && Math.abs(diff) < 0.002 && Math.abs(ks - 1) < 0.003) {
    v.rot = target; v.s = tS; placeWorldAt(v, head.x, head.y, ax, ay); v.snakeDone = key; return false;
  }
  v.rot = (v.rot || 0) + diff * 0.22;
  v.s *= Math.pow(ks, 0.22);
  placeWorldAt(v, head.x, head.y, h.x + dx * 0.22, h.y + dy * 0.22);
  return true;
}
/** Квадратная (прямоугольная) комната одной кнопкой: 4 стены, сразу замер по очереди */
function addRectRoom() {
  if (!blk()) { toast('Сначала создайте лист: «+» вверху', true); return; }
  if (S.tool !== 'sketch') { S.tool = 'sketch'; syncToolUI(); }
  if (S.draft && !S.draft.auto && skItem()?.dirs?.length) finishSketchQuiet();
  S.skm = null;
  let x, y;
  const rooms = curItems().filter((i) => i.kind === 'sketch' && i.pts?.length >= 4);
  if (rooms.length) {
    // вплотную справа от последней комнаты, низом на одной линии
    const last = rooms.slice().sort((a, b) => (b.t || 0) - (a.t || 0))[0], bb = bboxOf(last.pts);
    const th = (S.settings.wallTh > 0 ? S.settings.wallTh / 100 : 0) / unitM();
    x = bb[2] + th; y = bb[1];
  } else if (S.draft?.auto && S.draft.pts.length >= 2) { x = S.draft.pts[0]; y = S.draft.pts[1]; }
  else {
    S.draft = null; startBlankDraft();
    if (S.draft?.pts?.length >= 2 && curItems().some((i) => i.kind === 'sketch')) { x = S.draft.pts[0]; y = S.draft.pts[1]; }
    else { const c = screenToWorld(cv.clientWidth / 2, cv.clientHeight / 2); const h = 1.5 / unitM(), w = 2 / unitM(); x = c.x - w; y = c.y - h; }
  }
  pushUndo();
  const it = { id: uid(), kind: 'sketch', start: [x, y], dirs: [0, 90, 180, 270], lens: [null, null, null, null], dlens: [4, 3, 4, 3], closed: true, rect: true, block: S.block, floor: S.floor, t: Date.now() };
  rebuildSketch(it);
  S.items.push(it); S.draft = null;
  save(); startSkm(it, 0);
  toast('Квадратная комната: меряйте лазером стены по очереди, с нижней', true);
}
/** Поворот чертежа кнопкой «90°» для текущего листа (радианы) */
function baseRot() { return (((S.settings.baseRot || {})[S.block] || 0) * Math.PI) / 2; }
function rotate90() {
  const br = (S.settings.baseRot = S.settings.baseRot || {});
  br[S.block] = ((br[S.block] || 0) + 1) % 4;
  if (S.settings.rotate) { S.settings.rotate = false; syncSnapUI(); }
  S.viewFollow = true; V().snakeDone = null;
  const pts = curItems().filter((i) => i.kind === 'sketch' && i.pts).flatMap((i) => i.pts);
  if (pts.length >= 2) { const b = bboxOf(pts); V().pivot = { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 }; }
  save(); draw();
  toast(br[S.block] ? `Чертёж повернут на ${br[S.block] * 90}°` : 'Чертёж как был: север вверху', true);
}
function syncCompass() {
  const r = V().rot || 0;
  const show = !!S.settings.rotate || Math.abs(r) > 0.01;
  $('compass').hidden = !show;
  if (show) $('compassNeedle').setAttribute('transform', `rotate(${(r * 180) / Math.PI} 20 20)`);
}
function bindTools() {
  for (const b of $('openBar').children) b.onclick = () => {
    S.openType = b.dataset.ot;
    for (const o of $('openBar').children) o.classList.toggle('on', o === b);
  };
  const pop = $('toolsPop');
  $('btnTools').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !$('btnTools').contains(e.target)) pop.hidden = true; });
  for (const b of $('tools').querySelectorAll('[data-tool]')) b.onclick = () => { setTool(b.dataset.tool); pop.hidden = true; };
  $('btnList').onclick = () => { pop.hidden = true; $('menuModal').hidden = true; renderList(); $('listModal').hidden = false; };
  $('btnAreas').onclick = () => { pop.hidden = true; $('menuModal').hidden = true; renderAreas(); $('areasModal').hidden = false; };
  $('btnShare').onclick = () => { pop.hidden = true; $('menuModal').hidden = true; openShare(); };
  $('btnReport').onclick = () => { pop.hidden = true; openShare(); };
  $('btnDocs').onclick = () => { pop.hidden = true; $('menuModal').hidden = true; renderDocs(); $('docsModal').hidden = false; };
  for (const b of $('snaps').children) b.onclick = () => {
    const k = b.dataset.snap;
    if (k === 'ortho') S.settings.ortho = !S.settings.ortho;
    else { S.settings.snapModes[k] = !S.settings.snapModes[k]; if (S.settings.snapModes[k]) S.settings.snap = true; }
    syncSnapUI(); save();
  };
  $('btnFocus').onclick = () => setFocus(true);
  $('btnPolar').onclick = () => { S.settings.polar = !S.settings.polar; if (S.settings.polar) S.settings.ortho = false; syncSnapUI(); save(); toast('Полярные углы 5° ' + (S.settings.polar ? 'включены' : 'выключены')); };
  $('btnRot').onclick = () => { S.viewFollow = true; S.settings.rotate = !S.settings.rotate; syncSnapUI(); save(); draw(); toast(S.settings.rotate ? 'Змейка: текущая линия в центре, план крутится вокруг неё' : 'Поворот плана выключен'); };
  $('compass').onclick = () => { S.settings.rotate = false; (S.settings.baseRot = S.settings.baseRot || {})[S.block] = 0; S.viewFollow = true; syncSnapUI(); save(); draw(); };
  $('btnRot90').onclick = rotate90;
  $('btnRect').onclick = () => { $('toolsPop').hidden = true; addRectRoom(); };
  $('fsRect').onclick = addRectRoom;
  $('fsSnake').onclick = () => $('btnRot').click();
  $('fsRot90').onclick = rotate90;
  for (const b of $('openPad').querySelectorAll('[data-ot]')) b.onclick = () => {
    S.turnArm = false; S.openArm = S.openArm === b.dataset.ot ? null : b.dataset.ot; syncOpenPad();
  };
  $('btnFocusExit').onclick = () => setFocus(false);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && focusMode && !/iPhone/.test(navigator.userAgent)) setFocus(false); });
  $('btnSnap').onclick = () => { S.settings.snap = !S.settings.snap; syncSnapUI(); save(); toast('Привязка ' + (S.settings.snap ? 'включена' : 'выключена')); };
  $('btnOrtho').onclick = () => { S.settings.ortho = !S.settings.ortho; syncSnapUI(); save(); toast('Орто ' + (S.settings.ortho ? 'включено' : 'выключено')); };
  syncToolUI(); syncSnapUI();
}
function setTool(t) {
  S.tool = t; S.draft = null; S.ruler = null; S.textDraft = null; S.skm = null; updateDraftBar(); if (t !== 'select') { S.selSeg = null; select(null); }
  syncToolUI();
  $('openBar').hidden = t !== 'open';
  S.sheetFull = false;
  if (t !== 'walls') S.session = false;
  if (t === 'walls' && !S.selSeg) gotoSeg(1, true, true);
  hint({
    walls: 'Нажмите на стену — начнём замер',
    open: 'Выберите «Дверь» или «Окно» и нажмите на стену',
    ruler: 'Рулетка: нажимайте точки. На первую точку — площадь. Ничего не сохраняется',
    text: 'Нажмите, куда указывает выноска, затем — где текст',
    select: '',
    point: 'Нажмите на план, где стоите с лазером — появится точка замера',
    line: 'Укажите первую точку размера (привязка к углам)',
    sketch: S.plan.blocks.find((b) => b.name === S.block)?.blank ? 'Выберите направление и меряйте лазером — комната замкнётся сама' : 'Нажмите на план — начало линии. Дальше: направление + замер лазером',
  }[t]);
  draw();
}

/* ---------- сообщения ---------- */
let askDone = null;
function ask(text, okText = 'Да', danger = false, input = null) {
  return new Promise((res) => {
    const m = $('askModal');
    $('askText').textContent = text;
    const ok = $('askOk'), no = $('askNo'), inp = $('askInput');
    ok.textContent = okText; ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    no.hidden = okText === 'OK';
    inp.hidden = input == null; if (input != null) { inp.value = input; setTimeout(() => inp.focus(), 60); }
    m.hidden = false; m._openT = Date.now();
    const done = (v) => { m.hidden = true; ok.onclick = no.onclick = $('askX').onclick = null; askDone = null; res(v && input != null ? inp.value : v); };
    askDone = done;
    ok.onclick = () => done(true); no.onclick = () => done(false); $('askX').onclick = () => done(false);
  });
}
const notice = (text) => ask(text, 'OK');
let toastT;
let focusMode = false;
function setFocus(on) {
  focusMode = on; S.viewFollow = true;
  document.body.classList.toggle('focus', on);
  if (on) {
    $('toolsPop').hidden = true;
    if (!blk()) { focusMode = false; document.body.classList.remove('focus'); openNewSheet(); return; }
    if (isBlank()) { if (S.tool !== 'sketch') setTool('sketch'); startBlankDraft(); }
    else {
      if (S.tool !== 'walls') setTool('walls');
      S.session = true; S.sheetFull = false;
      if (!S.selSeg) gotoSeg(1, true, true);
    }
    try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch (e) { /* iPhone не поддерживает — достаточно скрыть панели */ }
  } else {
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* */ }
  }
  refreshSheet();
  requestAnimationFrame(() => { resize(); if (S.selSeg) ensureVisible(wallsOf().byKey.get(S.selSeg)); draw(); });
}
function toast(s, force) {
  if (focusMode && !force) return;
  const t = $('toast'); t.textContent = s; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}
let hintT;
function hint(s) {
  if (focusMode) return;
  $('hint').textContent = s || '';
  clearTimeout(hintT); if (s) hintT = setTimeout(() => ($('hint').textContent = ''), 6000);
}
function busy(on, text) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; }

/* ---------- журнал ---------- */
let listScope = 'floor';
function listItems() {
  return S.items
    .filter((i) => i.kind !== 'sketch' && i.kind !== 'open')
    .filter((i) => listScope === 'all' || (i.block === S.block && (listScope === 'block' || i.floor === S.floor)))
    .sort((a, b) => a.block.localeCompare(b.block, 'ru') || b.floor - a.floor || (a.kind === 'seg') - (b.kind === 'seg') || sortNo(a) - sortNo(b));
}
function sortNo(i) { if (i.kind !== 'seg') return i.no || 0; const sg = segInfo(i); return sg ? sg.room * 1000 + sg.wall : 1e9; }
function itemNo(i) { return i.kind === 'seg' ? segLabel(i) : String(i.no); }
function itemType(i) { return i.kind === 'seg' ? 'стена' : i.kind === 'line' ? 'размер' : `${i.dir === 'up' ? '↑' : '↓'} до ${i.toFloor ?? '—'}`; }
function renderList() {
  const rows = listItems();
  const t = $('listTable');
  const head = '<tr><th>Блок</th><th>Эт.</th><th>№</th><th>Тип</th><th style="text-align:right">Замер, м</th><th style="text-align:right">Проект, м</th><th style="text-align:right">Δ, м</th><th>Примечание</th></tr>';
  t.innerHTML = head + (rows.length ? rows.map((i) => {
    const d = i.value != null && i.design != null ? i.value - i.design : null;
    const cls = devClass(i);
    const type = itemType(i);
    return `<tr class="clk" data-id="${i.id}"><td>${esc(i.block)}</td><td>${i.floor}</td><td>${itemNo(i)}</td><td>${type}</td>` +
      `<td class="num">${i.value == null ? '<span class="pend">ожидает</span>' : fmt(i.value)}</td><td class="num">${fmt(i.design)}</td>` +
      `<td class="num" style="color:var(--${cls || 'ink2'})">${d == null ? '—' : fmtSigned(d)}</td><td>${esc(i.note || '')}</td></tr>`;
  }).join('') : '<tr><td colspan="8" class="muted">Замеров пока нет</td></tr>');
  for (const tr of t.querySelectorAll('tr.clk')) tr.onclick = () => {
    const it = S.items.find((x) => x.id === tr.dataset.id);
    $('listModal').hidden = true;
    if (it.block !== S.block) setBlock(it.block);
    if (it.floor !== S.floor) setFloor(it.floor, true);
    if (it.kind === 'seg') { if (S.tool !== 'walls') setTool('walls'); selectSeg(it.key); return; }
    centerOn(it); select(it.id);
  };
  const done = rows.filter((i) => i.value != null);
  const devs = done.filter((i) => i.design != null).map((i) => Math.abs(i.value - i.design));
  $('listStats').textContent = `Всего: ${rows.length}, измерено: ${done.length}, ожидают: ${rows.length - done.length}` +
    (devs.length ? ` · макс. отклонение ${fmt(Math.max(...devs))} м` : '');
}
function centerOn(it) {
  const v = V();
  const x = it.kind === 'line' ? (it.x + it.x2) / 2 : it.kind === 'sketch' ? it.pts[0] : it.x;
  const y = it.kind === 'line' ? (it.y + it.y2) / 2 : it.kind === 'sketch' ? it.pts[1] : it.y;
  v.ox = cv.clientWidth / 2 - x * v.s; v.oy = cv.clientHeight / 2.6 + y * v.s;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- выгрузки ---------- */
function stamp() { const d = new Date(); return d.toISOString().slice(0, 10) + '_' + d.toTimeString().slice(0, 5).replace(':', '-'); }
// Внутри страницы claude.ai скачивание идёт через её механизм сохранения
let hostDl;
function hostDownloads() {
  if (hostDl !== undefined) return Promise.resolve(hostDl);
  if (!window.claude?.use) { hostDl = null; return Promise.resolve(null); }
  return window.claude.use('downloads').then((d) => (hostDl = d || null)).catch(() => (hostDl = null));
}
const HOST_OK = /\.(png|jpe?g|webp|gif|txt|json|md|csv|pdf|zip|svg|html|xlsx|docx)$/i;
async function deliver(name, blob, mode = 'save') {
  const host = await hostDownloads();
  if (host) {
    try {
      if (!HOST_OK.test(name)) { blob = await zipOne(name, blob); name = name.replace(/\.[^.]+$/, '') + '.zip'; }
      const r = await host.save({ filename: name, data: blob });
      if (r?.status === 'saved') toast('Готово: ' + name);
    } catch (e) {
      if (e?.code !== 'declined') toast('Не удалось сохранить: ' + (e?.message || e?.code || e));
    }
    return;
  }
  if (mode === 'share') {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) {
        if (e.name === 'AbortError') return;
        if (e.name === 'NotAllowedError') { offerShare(file); return; }
      }
    } else {
      toast('Этот тип файла телефон не даёт отправить напрямую — файл сохранён. В Telegram: 📎 → Файл → Загрузки');
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  if (mode !== 'share') toast('Сохранено: ' + name);
}
const download = (name, data, type) => deliver(name, data instanceof Blob ? data : new Blob([data], { type }), 'save');
function offerShare(file) {
  const bar = $('readyBar');
  bar.hidden = false;
  $('readyName').textContent = file.name;
  $('readyGo').onclick = async () => {
    bar.hidden = true;
    try { await navigator.share({ files: [file], title: file.name }); } catch (e) { /* отмена */ }
  };
}
/** Имя файла без пробелов и спецсимволов: «ЖК_блок_А_этаж_16_…» */
const safeName = (t) => String(t).replace(/\s*·\s*/g, '_').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
const fileBase = (floorTxt) => safeName(`${sheetHeader()}_${floorTxt}_${stamp()}`);

function buildCsv() {
  const rows = listItems();
  const head = ['Блок', 'Этаж', '№', 'Тип', 'Направление', 'До этажа', 'Замер, м', 'Проект, м', 'Отклонение, м', 'Уклон, °', 'Источник', 'Дата', 'Примечание'];
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(';')];
  for (const i of rows) {
    const d = i.value != null && i.design != null ? i.value - i.design : null;
    const pt = i.kind === 'point';
    lines.push([i.block, i.floor, itemNo(i), i.kind === 'seg' ? 'стена' : i.kind === 'line' ? 'размер' : 'точка', pt ? (i.dir === 'up' ? 'вверх' : 'вниз') : '',
      pt ? i.toFloor ?? '' : '', i.value == null ? '' : fmt(i.value), i.design == null ? '' : fmt(i.design),
      d == null ? '' : fmt(d), i.ang ? i.ang.toFixed(1).replace('.', ',') : '', i.src === 'manual' ? 'вручную' : i.src ? 'лазер' : '',
      i.mt ? new Date(i.mt).toLocaleString('ru-RU') : '', i.note || ''].map(q).join(';'));
  }
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
}
function floorsWithData(block = S.block) {
  return [...new Set(S.items.filter((i) => i.block === block).map((i) => i.floor))].sort((a, b) => b - a);
}
/** Линии условного обозначения проёма (мир) — для DXF */
function openingPaths(it, g) {
  const o = (p) => ({ x: p.x - g.n.x * g.th, y: p.y - g.n.y * g.th });
  const P0 = g.p0, P1 = g.p1, Q0 = o(P0), Q1 = o(P1);
  if (it.otype !== 'window') {
    return doorTicks(g).map(([x, y, h]) => [{ x: x - g.n.x * h, y: y - g.n.y * h }, { x: x + g.n.x * h, y: y + g.n.y * h }]);
  }
  const out = [[P0, Q0], [P1, Q1]];
  if (it.otype === 'window') {
    out.push([P0, P1], [Q0, Q1], [{ x: (P0.x + Q0.x) / 2, y: (P0.y + Q0.y) / 2 }, { x: (P1.x + Q1.x) / 2, y: (P1.y + Q1.y) / 2 }]);
  } else {
    const hinge = it.flip ? P1 : P0, other = it.flip ? P0 : P1;
    const r = Math.hypot(other.x - hinge.x, other.y - hinge.y);
    const leaf = { x: hinge.x + g.n.x * r, y: hinge.y + g.n.y * r };
    out.push([hinge, leaf]);
    const a0 = Math.atan2(leaf.y - hinge.y, leaf.x - hinge.x), a1 = Math.atan2(other.y - hinge.y, other.x - hinge.x);
    let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const arc = [];
    for (let i = 0; i <= 16; i++) { const a = a0 + (d * i) / 16; arc.push({ x: hinge.x + r * Math.cos(a), y: hinge.y + r * Math.sin(a) }); }
    out.push(arc);
  }
  return out;
}
function buildDxf(allFloors) {
  const b = blk();
  const k = UNIT_MM[S.plan.unit] || 1; // в мм
  const w = new DxfWriter();
  // цвета AutoCAD: 1 — красный (загруженный чертёж), 3 — зелёный (замеры)
  const LY = {
    plan: w.layer('ЧЕРТЕЖ', 1), asb: w.layer('ОБМЕР', 3), col: w.layer('ЧЕРТЕЖ_КОЛОННЫ', 1),
    open: w.layer('ПРОЁМЫ', 3), dim: w.layer('РАЗМЕРЫ', 3), dimg: w.layer('РАЗМЕРЫ_ЧЕРТЕЖ', 1), room: w.layer('КОМНАТЫ', 3),
    gap: w.layer('НЕВЯЗКА', 30), stamp: w.layer('ШТАМП', 7), wall: w.layer('СТЕНЫ_ТОЛЩИНА', 3), txt: w.layer('ТЕКСТ', 7),
  };
  const floors = allFloors ? floorsWithData() : [S.floor];
  if (!floors.length) floors.push(S.floor);
  const [bx0, by0, bx1, by1] = modelBox(floorModel(floors[0])).map((q) => q * k);
  const bw = bx1 - bx0, bh = by1 - by0;
  const rd = (a) => { if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI; return a; };
  floors.forEach((fl, fi) => {
    const OX = fi * (bw + 8000);
    const X = (v) => v * k + OX, Y = (v) => v * k;
    const XP = (p) => p.map((v, i) => (i % 2 ? Y(v) : X(v)));
    const M = floorModel(fl);
    // рамка и заголовок
    const fx0 = bx0 + OX - 2000, fx1 = bx1 + OX + 2000, fy0 = by0 - 4200, fy1 = by1 + 1800;
    w.poly(LY.stamp, [fx0, fy0, fx1, fy0, fx1, fy1, fx0, fy1], true);
    w.text(LY.stamp, (fx0 + fx1) / 2, by1 + 900, 400, `ПОЭТАЖНЫЙ ПЛАН - ${sheetHeader()} - этаж ${fl}`, 0, 'center');
    if (S.settings.objName) w.text(LY.stamp, (fx0 + fx1) / 2, by1 + 400, 250, S.settings.objName, 0, 'center');
    for (const q of M.contours) {
      w.poly(q.color === RED ? (q.column ? LY.col : LY.plan) : LY.asb, XP(q.p), q.closed);
      if (q.gap) {
        w.line(LY.gap, X(q.gap.a[0]), Y(q.gap.a[1]), X(q.gap.b[0]), Y(q.gap.b[1]));
        w.text(LY.gap, (X(q.gap.a[0]) + X(q.gap.b[0])) / 2, (Y(q.gap.a[1]) + Y(q.gap.b[1])) / 2 + 150, 110, `невязка ${fmt(q.gap.val)} м`, 0, 'center');
      }
    }
    // толщина стен
    if (S.settings.wallTh > 0 && S.settings.layers.thick)
      for (const pc of roomContours(S.block, fl)) { const o = offsetPoly(pc, S.settings.wallTh / 100 / unitM()); if (o) w.poly(LY.wall, XP(o), true); }
    // текст и выноски
    if (S.settings.layers.text) for (const t of S.items.filter((i) => i.kind === 'text' && i.block === S.block && i.floor === fl)) {
      if (t.tx != null) w.poly(LY.txt, [X(t.tx), Y(t.ty), X(t.x), Y(t.y)], false);
      w.text(LY.txt, X(t.x) + 50, Y(t.y) + 50, 180, t.text);
    }
    // проёмы
    const cache = new Map();
    if (S.settings.layers.openings) for (const it of S.items.filter((i) => i.kind === 'open' && i.block === S.block && i.floor === fl)) {
      const g = openGeom(it, cache); if (!g) continue;
      for (const pl of openingPaths(it, g)) w.poly(LY.open, pl.flatMap((p) => [X(p.x), Y(p.y)]), false);
    }
    // размеры стен
    if (S.settings.layers.dims) for (const d of M.dims) {
      const x1 = X(d.ax), y1 = Y(d.ay), x2 = X(d.bx), y2 = Y(d.by);
      const ang = rd(Math.atan2(y2 - y1, x2 - x1));
      w.text(d.color === RED ? LY.dimg : LY.dim, (x1 + x2) / 2 + d.nx * 170, (y1 + y2) / 2 + d.ny * 170, 140, (d.measured ? '' : '~') + fmt(d.val), (ang * 180) / Math.PI, 'center');
    }
    // комнаты: номер над чертой, площадь под чертой
    for (const r of M.rooms) {
      if (!r.closed || !S.settings.layers.areas) continue;
      const cx = X(r.cx), cy = Y(r.cy);
      w.text(LY.room, cx, cy + 160, 170, String(r.no), 0, 'center');
      w.line(LY.room, cx - 380, cy, cx + 380, cy);
      w.text(LY.room, cx, cy - 190, 190, fmt(r.area), 0, 'center');
      if (!r.sketch && r.ab?.gap != null && r.ab.gap >= 0.005 && r.ab.gapFrom) {
        const g0 = r.ab.gapFrom, g1 = r.ab.gapTo;
        w.line(LY.gap, X(g0[0]), Y(g0[1]), X(g1[0]), Y(g1[1]));
        w.text(LY.gap, (X(g0[0]) + X(g1[0])) / 2, (Y(g0[1]) + Y(g1[1])) / 2 + 150, 110, `невязка ${fmt(r.ab.gap)} м`, 0, 'center');
      }
    }
    // штамп
    const sumA = M.rooms.filter((r) => r.closed).reduce((t, r) => t + r.area, 0);
    const sx = fx0 + 600, sy = by0 - 1200;
    w.text(LY.stamp, sx, sy, 230, `Общая площадь помещений: ${fmt(sumA)} м2`);
    w.text(LY.stamp, sx, sy - 600, 230, `Түзүлгөн датасы / Дата составления: ${todayRu()} г.`);
    w.text(LY.stamp, sx, sy - 1300, 230, 'Планды түзгөн / План составил:');
    const lx = sx + 5200;
    w.line(LY.stamp, lx, sy - 1400, lx + 3500, sy - 1400);
    w.line(LY.stamp, lx + 3800, sy - 1400, lx + 7300, sy - 1400); // ФИО — от руки
    // точки и размеры лазером (вертикальные замеры)
    for (const i of S.items.filter((q) => q.block === S.block && q.floor === fl)) {
      if (i.kind === 'line') {
        const ly = w.layer('ЗАМЕРЫ_РАЗМЕРЫ', 4);
        const x1 = X(i.x), y1 = Y(i.y), x2 = X(i.x2), y2 = Y(i.y2);
        w.line(ly, x1, y1, x2, y2);
        const ang = rd(Math.atan2(y2 - y1, x2 - x1));
        w.text(ly, (x1 + x2) / 2 - Math.sin(ang) * 200, (y1 + y2) / 2 + Math.cos(ang) * 200, 200, i.value == null ? `N${i.no} ?` : fmt(i.value), (ang * 180) / Math.PI, 'center');
      } else if (i.kind === 'point') {
        const ly = w.layer('ЗАМЕРЫ_ТОЧКИ', 6);
        const px = X(i.x), py = Y(i.y);
        w.circle(ly, px, py, 150);
        w.text(ly, px + 220, py + 60, 200, `№${i.no} ${i.value == null ? '-' : fmt(i.value) + ' м'} эт.${i.floor} ${i.dir === 'up' ? 'вверх' : 'вниз'}${i.toFloor != null ? ' до ' + i.toFloor : ''}`);
      }
    }
  });
  return new Blob([w.toBytes()], { type: 'application/dxf' });
}

/** Сводка по комнатам этажа */
function roomRows(floor = S.floor) {
  const m = segMapFor(S.block, floor);
  const W = wallsOf();
  const rows = W.rooms.map((room) => {
    const any = room.segs.some((s) => m.get(s.key)?.value != null);
    const ab = any ? asBuilt(room, (s) => m.get(s.key), unitM()) : null;
    return { room, ab, m };
  });
  // комнаты, начерченные «направление + метр»
  let k = 0;
  for (const it of S.items.filter((i) => i.kind === 'sketch' && i.closed && i.block === S.block && i.floor === floor)) {
    k++;
    const c0 = polyCentroid(it.pts), area = polyArea(it.pts) * unitM() * unitM();
    rows.push({ room: { no: W.rooms.length + k, segs: [], closed: true, area, cx: c0.x, cy: c0.y, sketch: true }, ab: { area, gap: it.gap ?? 0, measured: it.pts.length / 2 - 1, total: it.pts.length / 2 - 1, segPts: [] }, m });
  }
  return rows;
}
function withFloor(f, fn) { const keep = S.floor; S.floor = f; try { return fn(); } finally { S.floor = keep; } }

const PAL_PRINT = () => ({ ...palette(), paper: '#ffffff', ink: '#1b2333', ink2: '#5b6476', card: '#ffffff', line: '#d9dde4', dark: false });
/* ---------- чертёж в стиле образца (поэтажный план) ---------- */
const PRINT = { ink: '#111111', grey: '#8a8a8a', paper: '#ffffff' };
function todayRu() { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; }
/** Всё, что нужно для чертежа этажа: контуры (обмерные, где есть данные), размеры стен, комнаты, проёмы */
function floorModel(floor, block = S.block) {
  const b = S.plan.blocks.find((x) => x.name === block);
  const P = prepBlock(b);
  const W = P.walls;
  const m = segMapFor(block, floor);
  const roomByPi = new Map(W.rooms.map((r) => [r.pi, r]));
  const contours = [];
  const dims = [];
  const rooms = [];
  const L = S.settings.layers;
  if (!b.blank) P.polys.forEach((q, pi) => {
    const room = roomByPi.get(pi);
    const has = room && room.segs.some((s) => m.get(s.key)?.value != null);
    if (!has && L.drawing) contours.push({ p: q.p, closed: !!q.z, column: q.column, color: RED });
    if (!room) return;
    let ab = null;
    if (has) {
      ab = asBuilt(room, (s) => m.get(s.key), unitM());
      contours.push({ p: ab.pts, closed: ab.gap != null && ab.gap < 0.005, asBuilt: true, color: GREEN });
    }
    for (const s of room.segs) {
      const it = m.get(s.key);
      if (it?.merged) continue;
      let ax = s.ax, ay = s.ay, bx = s.bx, by = s.by;
      if (ab) { const sp = ab.segPts.find((q2) => q2.seg.key === s.key); ax = sp.sx; ay = sp.sy; bx = sp.ex; by = sp.ey; }
      const measured = it?.value != null;
      if (!measured && !L.drawing) continue;
      dims.push({ ax, ay, bx, by, nx: s.nx, ny: s.ny, val: measured ? it.value : s.len, measured, color: measured ? GREEN : RED });
    }
    if (has || L.drawing) rooms.push({ no: room.no, cx: room.cx, cy: room.cy, area: ab?.area ?? room.area, areaDesign: room.area, measured: !!ab, closed: room.closed, ab, color: ab ? GREEN : RED });
  });
  let skNo = 0;
  for (const it of S.items.filter((i) => i.kind === 'sketch' && i.block === block && i.floor === floor)) {
    const exact = it.closed && !(it.gap >= 0.005);
    const n = it.pts.length;
    contours.push({ p: it.pts, closed: exact, color: GREEN, sketch: true, gap: it.closed && !exact ? { a: [it.pts[n - 2], it.pts[n - 1]], b: [it.pts[0], it.pts[1]], val: it.gap } : null });
    if (it.closed) {
      skNo++;
      const c0 = polyCentroid(it.pts);
      const area = polyArea(it.pts) * unitM() * unitM();
      rooms.push({ no: W.rooms.length + skNo, cx: c0.x, cy: c0.y, area, areaDesign: area, measured: true, closed: true, sketch: true, color: GREEN,
        ab: { gap: it.gap ?? 0, area, measured: 1, total: 1, gapFrom: it.pts.slice(-2), gapTo: it.pts.slice(0, 2) } });
    }
    for (const sg of sketchSegs(it)) dims.push({ ax: sg.ax, ay: sg.ay, bx: sg.bx, by: sg.by, nx: sg.nx, ny: sg.ny, val: sg.len, measured: sg.measured, color: GREEN });
  }
  return { b, P, contours, dims, rooms };
}
const PX_MM = 150 / 25.4; // 150 dpi
/** Формат листа и масштаб подбираются по размеру чертежа (A4 или A3, книжный или альбомный) */
function choosePaper(wm, hm) {
  const SC = [20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 2000];
  const papers = [['A4', 297, 210, true], ['A4', 210, 297, false], ['A3', 420, 297, true], ['A3', 297, 420, false]];
  const best = {};
  for (const [name, w, h, land] of papers) {
    const aw = w - 25 - 4, ah = h - 10 - 14 - 34;
    for (const den of SC) {
      if ((wm * 1000) / den <= aw && (hm * 1000) / den <= ah) {
        if (!best[name] || den < best[name].den) best[name] = { size: name, w, h, landscape: land, den, aw, ah };
        break;
      }
    }
  }
  const a4 = best.A4, a3 = best.A3;
  if (a4 && (!a3 || a4.den <= 100 || a4.den <= a3.den)) return a4;
  return a3 || a4 || { size: 'A3', w: 420, h: 297, landscape: true, den: 2000, aw: 391, ah: 239 };
}
function modelBox(M) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of M.contours) for (let i = 0; i < q.p.length; i += 2) { x0 = Math.min(x0, q.p[i]); x1 = Math.max(x1, q.p[i]); y0 = Math.min(y0, q.p[i + 1]); y1 = Math.max(y1, q.p[i + 1]); }
  if (!isFinite(x0)) [x0, y0, x1, y1] = viewBox(M.b);
  const th = (S.settings.wallTh > 0 ? S.settings.wallTh / 100 : 0) / unitM() + 0.5 / unitM();
  return [x0 - th, y0 - th, x1 + th, y1 + th];
}
/** Поэтажный план для PDF/PNG: рамка, масштаб, штамп. Чертёж — красным, замеры — зелёным */
function renderPlanCanvas(floor) {
  const block = S.block;
  const M = withFloor(floor, () => floorModel(floor, block));
  const u = unitM();
  const [bx0, by0, bx1, by1] = modelBox(M);
  const paper = choosePaper((bx1 - bx0) * u, (by1 - by0) * u);
  const W = Math.round(paper.w * PX_MM), H = Math.round(paper.h * PX_MM);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const mm = (v) => v * PX_MM;
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  // рамка: слева 20 мм, остальные 5 мм
  x.strokeStyle = '#111'; x.lineWidth = mm(0.5);
  x.strokeRect(mm(20), mm(5), W - mm(25), H - mm(10));
  // заголовок
  x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 ${mm(4.2)}px "Times New Roman", Times, serif`;
  x.fillText(`ПОЭТАЖНЫЙ ПЛАН · ${sheetHeader(M.b)} · этаж ${floor}`, mm(20) + (W - mm(25)) / 2, mm(11));
  // вид: точный масштаб
  const s = ((1000 * u) / paper.den) * PX_MM; // px на единицу чертежа
  const areaL = mm(22), areaT = mm(5 + 14), aw = mm(paper.aw), ah = mm(paper.ah);
  const v = { s, ox: 0, oy: 0, rot: 0 };
  v.ox = areaL + aw / 2 - ((bx0 + bx1) / 2) * s;
  v.oy = areaT + ah / 2 + ((by0 + by1) / 2) * s;
  const tr = (px, py) => w2s(px, py, v);
  const fsDim = mm(2.4), fsNo = mm(2.8), fsArea = mm(3.2);
  // толщина стен
  if (S.settings.wallTh > 0 && S.settings.layers.thick) drawThickWalls(x, block, floor, v, PAL_PRINT(), { ink: GREEN, lw: mm(0.35), fill: 'rgba(22,163,74,.12)' });
  // контуры
  x.lineJoin = 'miter';
  for (const q of M.contours) {
    x.beginPath(); path(x, q.p, v); if (q.closed) x.closePath();
    x.strokeStyle = q.color; x.lineWidth = q.column ? mm(0.25) : mm(0.45); x.stroke();
    if (q.gap && S.settings.layers.dims) {
      const a = tr(q.gap.a[0], q.gap.a[1]), b = tr(q.gap.b[0], q.gap.b[1]);
      x.save(); x.strokeStyle = '#ea580c'; x.setLineDash([mm(1.2), mm(0.8)]); x.lineWidth = mm(0.3);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.restore();
      x.fillStyle = '#ea580c'; x.font = `600 ${fsDim}px Arial, sans-serif`; x.textAlign = 'center';
      x.fillText(`невязка ${fmt(q.gap.val)}`, (a.x + b.x) / 2, (a.y + b.y) / 2 - fsDim);
    }
  }
  // двери и окна
  if (S.settings.layers.openings) {
    const cache = new Map();
    for (const it of S.items.filter((i) => i.kind === 'open' && i.block === block && i.floor === floor)) {
      const g = openGeom(it, cache);
      if (g) drawOpeningSym(x, it, g, tr, v.s, GREEN, '#fff', { lw: mm(0.3) });
    }
  }
  // размеры стен — внутри комнаты вдоль стены
  if (S.settings.layers.dims) {
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (const d of M.dims) {
      const a = tr(d.ax, d.ay), e = tr(d.bx, d.by);
      const Lp = Math.hypot(e.x - a.x, e.y - a.y);
      const txt = (d.measured ? '' : '≈') + fmt(d.val);
      let fs = fsDim;
      x.font = `400 ${fs}px Arial, sans-serif`;
      while (fs > mm(1.4) && x.measureText(txt).width > Lp * 0.95) { fs -= 1; x.font = `400 ${fs}px Arial, sans-serif`; }
      let rot = Math.atan2(e.y - a.y, e.x - a.x);
      if (rot > Math.PI / 2) rot -= Math.PI; if (rot < -Math.PI / 2) rot += Math.PI;
      const m0 = tr((d.ax + d.bx) / 2, (d.ay + d.by) / 2), m1 = tr((d.ax + d.bx) / 2 + d.nx, (d.ay + d.by) / 2 + d.ny);
      let nx = m1.x - m0.x, ny = m1.y - m0.y; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      x.save(); x.translate(m0.x + nx * fs * 0.9, m0.y + ny * fs * 0.9); x.rotate(rot);
      x.fillStyle = d.color; x.fillText(txt, 0, 0); x.restore();
    }
  }
  // номер комнаты над чертой, площадь под чертой
  let sumA = 0;
  for (const r of M.rooms) {
    if (!r.closed) continue;
    sumA += r.area;
    if (!S.settings.layers.areas) continue;
    const p = tr(r.cx, r.cy);
    x.fillStyle = r.color; x.textAlign = 'center';
    x.font = `400 ${fsNo}px Arial, sans-serif`; x.fillText(String(r.no), p.x, p.y - fsNo * 0.75);
    const txt = fmt(r.area);
    x.font = `400 ${fsArea}px Arial, sans-serif`;
    const tw = x.measureText(txt).width;
    x.fillText(txt, p.x, p.y + fsArea * 0.7);
    x.strokeStyle = r.color; x.lineWidth = mm(0.25); x.beginPath(); x.moveTo(p.x - tw / 2 - 4, p.y); x.lineTo(p.x + tw / 2 + 4, p.y); x.stroke();
  }
  drawTexts(x, block, floor, v, PAL_PRINT(), { ink: '#111', fs: mm(2.6) });
  // штамп внизу справа
  const sw = mm(185), sh = mm(30), sx = W - mm(5) - sw, sy = H - mm(5) - sh;
  x.fillStyle = '#fff'; x.fillRect(sx, sy, sw, sh);
  x.strokeStyle = '#111'; x.lineWidth = mm(0.35); x.strokeRect(sx, sy, sw, sh);
  const rowsY = [sy + mm(7.5), sy + mm(15), sy + mm(22.5)];
  x.lineWidth = mm(0.2);
  for (const ry of rowsY) { x.beginPath(); x.moveTo(sx, ry); x.lineTo(sx + sw, ry); x.stroke(); }
  x.beginPath(); x.moveTo(sx + mm(130), sy); x.lineTo(sx + mm(130), sy + mm(15)); x.stroke();
  x.fillStyle = '#111'; x.textAlign = 'left'; x.textBaseline = 'middle';
  const t1 = `${mm(2.8)}px "Times New Roman", Times, serif`;
  x.font = `700 ${t1}`; x.fillText(`${sheetHeader(M.b)} · этаж ${floor}`, sx + mm(2), sy + mm(3.75));
  x.font = `400 ${t1}`; x.fillText(`Общая площадь помещений: ${fmt(sumA)} м²`, sx + mm(2), sy + mm(11.25));
  x.font = `700 ${t1}`; x.fillText(`М 1:${paper.den}`, sx + mm(133), sy + mm(3.75));
  x.font = `400 ${t1}`; x.fillText(`${paper.size}`, sx + mm(133), sy + mm(11.25));
  x.fillText(`Түзүлгөн датасы / Дата составления: ${todayRu()} г.`, sx + mm(2), sy + mm(18.75));
  x.fillText('Планды түзгөн / План составил:', sx + mm(2), sy + mm(26.25));
  x.beginPath(); x.moveTo(sx + mm(70), sy + mm(28)); x.lineTo(sx + mm(120), sy + mm(28)); x.moveTo(sx + mm(128), sy + mm(28)); x.lineTo(sx + mm(182), sy + mm(28)); x.stroke();
  c._paper = paper;
  return c;
}
/** Таблица на страницах A4 (книжная). cols: [{h, w, a:'l'|'r'}]; rows: [[{t, c?, b?}|string]] */
function tablePages(title, sub, cols, rows, foot) {
  const W = 1754, H = 2480, M = 90, rowH = 50, top = 300;
  const per = Math.floor((H - top - 160) / rowH);
  const pages = [];
  const total = Math.max(1, Math.ceil(rows.length / per));
  for (let pi = 0; pi < total; pi++) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#14213d'; x.fillRect(0, 0, W, 190);
    x.fillStyle = '#ff5a1f'; x.fillRect(0, 184, W, 6);
    x.textBaseline = 'middle'; x.textAlign = 'left';
    x.fillStyle = '#fff'; x.font = '800 50px system-ui, sans-serif'; x.fillText(title, M, 75);
    x.fillStyle = '#cfd8ea'; x.font = '500 26px system-ui, sans-serif'; x.fillText(sub, M, 135);
    const tw = W - M * 2;
    const xs = []; let acc = M;
    for (const col of cols) { xs.push(acc); acc += col.w * tw; }
    // шапка
    x.fillStyle = '#eef0f3'; x.fillRect(M, top - rowH, tw, rowH);
    x.font = '700 22px system-ui, sans-serif'; x.fillStyle = '#5b6476';
    cols.forEach((col, i) => {
      x.textAlign = col.a === 'r' ? 'right' : 'left';
      x.fillText(col.h, col.a === 'r' ? xs[i] + col.w * tw - 14 : xs[i] + 14, top - rowH / 2);
    });
    const slice = rows.slice(pi * per, (pi + 1) * per);
    slice.forEach((r, ri) => {
      const y = top + ri * rowH;
      if (ri % 2) { x.fillStyle = '#f7f8fa'; x.fillRect(M, y, tw, rowH); }
      r.forEach((cell, i) => {
        const col = cols[i]; const o = typeof cell === 'object' && cell ? cell : { t: cell };
        x.font = `${o.b ? 800 : 500} 25px system-ui, sans-serif`;
        x.fillStyle = o.c || '#1b2333';
        x.textAlign = col.a === 'r' ? 'right' : 'left';
        x.fillText(String(o.t ?? ''), col.a === 'r' ? xs[i] + col.w * tw - 14 : xs[i] + 14, y + rowH / 2);
      });
      x.strokeStyle = '#e3e6eb'; x.lineWidth = 1; x.beginPath(); x.moveTo(M, y + rowH); x.lineTo(M + tw, y + rowH); x.stroke();
    });
    x.font = '500 22px system-ui, sans-serif'; x.fillStyle = '#5b6476'; x.textAlign = 'left';
    if (foot && pi === total - 1) x.fillText(foot, M, top + slice.length * rowH + 50);
    x.textAlign = 'right'; x.fillText(`стр. ${pi + 1} из ${total}`, W - M, H - 60);
    if (pi === total - 1) {
      // штамп: дата и подпись
      const sy = H - 260;
      x.textAlign = 'left'; x.fillStyle = '#111'; x.font = '400 30px "Times New Roman", Times, serif';
      x.fillText(`Түзүлгөн датасы / Дата составления: ${todayRu()} г.`, M, sy);
      x.fillText('Планды түзгөн / План составил:', M, sy + 80);
      x.lineWidth = 2; x.strokeStyle = '#111'; x.beginPath(); x.moveTo(M + 470, sy + 98); x.lineTo(M + 870, sy + 98); x.stroke();
      x.beginPath(); x.moveTo(M + 900, sy + 98); x.lineTo(M + 1300, sy + 98); x.stroke();
    }
    pages.push({ canvas: c, landscape: false });
  }
  return pages;
}
function pdfPagesForFloor(floor) {
  const plan = renderPlanCanvas(floor);
  return [{ canvas: plan, landscape: plan._paper.landscape, size: plan._paper.size }];
}
function buildPdf(allFloors) {
  const floors = allFloors ? floorsWithData() : [S.floor];
  if (!floors.length) floors.push(S.floor);
  const pages = [];
  for (const f of floors) pages.push(...pdfPagesForFloor(f));
  return canvasesToPdf(pages, 0.88);
}
/** Полный отчёт: сводка + все блоки и все этажи, где есть замеры */
function buildFullReport() {
  const keepB = S.block, keepF = S.floor;
  const pairs = [];
  for (const b of S.plan.blocks) for (const f of floorsWithData(b.name)) pairs.push([b.name, f]);
  if (!pairs.length) pairs.push([S.block, S.floor]);
  const pal = PAL_PRINT();
  const rows = [];
  const tot = { segs: 0, done: 0, rooms: 0, rdone: 0, sD: 0, sM: 0 };
  try {
    for (const [bn, f] of pairs) {
      S.block = bn; S.floor = f;
      const rr = roomRows(f);
      const segs = rr.reduce((t, r) => t + r.room.segs.length, 0);
      const done = rr.reduce((t, r) => t + r.room.segs.filter((q) => isDone(r.m.get(q.key))).length, 0);
      const rdone = rr.filter((r) => r.room.segs.every((q) => isDone(r.m.get(q.key)))).length;
      const sD = rr.reduce((t, r) => t + (r.room.closed ? r.room.area : 0), 0);
      const sM = rr.reduce((t, r) => t + (r.ab?.area || 0), 0);
      const gaps = rr.filter((r) => r.ab?.gap != null).map((r) => r.ab.gap);
      const mg = gaps.length ? Math.max(...gaps) : null;
      rows.push([{ t: bn, b: true }, String(f), `${done}/${segs}`, `${rdone}/${rr.length}`, fmt(sD), sM ? { t: fmt(sM), b: true } : '—',
        mg == null ? '—' : { t: fmt(mg), c: pal[gapClass(mg)] }]);
      Object.assign(tot, { segs: tot.segs + segs, done: tot.done + done, rooms: tot.rooms + rr.length, rdone: tot.rdone + rdone, sD: tot.sD + sD, sM: tot.sM + sM });
    }
    rows.push([{ t: 'Итого', b: true }, '', { t: `${tot.done}/${tot.segs}`, b: true }, { t: `${tot.rdone}/${tot.rooms}`, b: true }, { t: fmt(tot.sD), b: true }, { t: tot.sM ? fmt(tot.sM) : '—', b: true }, '']);
    const pages = tablePages('Полный отчёт по обмеру', `${S.settings.objName ? S.settings.objName + ' · ' : ''}${S.plan.name} · сформирован ${new Date().toLocaleString('ru-RU')}`,
      [{ h: 'Блок', w: 0.1 }, { h: 'Этаж', w: 0.1, a: 'r' }, { h: 'Стен изм.', w: 0.15, a: 'r' }, { h: 'Комнат', w: 0.13, a: 'r' }, { h: 'S черт., м²', w: 0.17, a: 'r' }, { h: 'S обмер, м²', w: 0.17, a: 'r' }, { h: 'Невязка, м', w: 0.18, a: 'r' }],
      rows, 'Далее по каждому блоку и этажу: поэтажный план, площади комнат, ведомость стен.');
    for (const [bn, f] of pairs) { S.block = bn; S.floor = f; pages.push(...pdfPagesForFloor(f)); }
    return canvasesToPdf(pages, 0.85);
  } finally { S.block = keepB; S.floor = keepF; }
}
/** Всё одним файлом: ZIP с полным PDF-отчётом, DXF по блокам, Excel и копией данных */
async function buildReportZip() {
  const st = stamp();
  const files = [{ name: `Полный_отчёт_${st}.pdf`, blob: buildFullReport() }];
  const keepB = S.block, keepScope = listScope;
  try {
    for (const b of S.plan.blocks) {
      if (!floorsWithData(b.name).length) continue;
      S.block = b.name;
      files.push({ name: safeName(`${sheetHeader()}_все_этажи_мм`) + '.dxf', blob: buildDxf(true) });
    }
    listScope = 'all';
    files.push({ name: `Замеры_${st}.csv`, blob: buildCsv() });
  } finally { S.block = keepB; listScope = keepScope; }
  files.push({ name: `Копия_данных_${st}.json`, blob: new Blob([JSON.stringify({ app: 'disto-plan', v: VERSION, items: S.items, settings: S.settings, plan: stripPrep(S.plan) })], { type: 'application/json' }) });
  return zipMany(files);
}
function canvasBlob(c, type = 'image/png') { return new Promise((r) => c.toBlob(r, type)); }

/* ---------- архив документов ---------- */
async function addDoc(name, blob) {
  try {
    const id = uid();
    const buf = await blob.arrayBuffer();
    const list = (await DB.get('docs')) || [];
    list.unshift({ id, name, size: buf.byteLength, type: blob.type, date: Date.now(), block: S.block, floor: S.floor });
    await DB.set('doc:' + id, buf);
    await DB.set('docs', list);
  } catch (e) { console.warn('архив', e); }
}
async function renderDocs() {
  const list = (await DB.get('docs')) || [];
  const el = $('docsList');
  if (!list.length) { el.innerHTML = '<p class="muted">Пока пусто. Документы появятся после «Отправить» / «Сохранить».</p>'; return; }
  el.innerHTML = '';
  for (const d of list) {
    const row = document.createElement('div'); row.className = 'docRow';
    row.innerHTML = `<div class="dn"><b>${esc(d.name)}</b><span>${new Date(d.date).toLocaleString('ru-RU')} · ${(d.size / 1024).toFixed(0)} КБ</span></div>`;
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; row.appendChild(b); };
    const getBlob = async () => new Blob([await DB.get('doc:' + d.id)], { type: d.type || 'application/octet-stream' });
    mk('Отправить', 'primary', async () => deliver(d.name, await getBlob(), 'share'));
    mk('Сохранить', '', async () => deliver(d.name, await getBlob(), 'save'));
    mk('✕', 'danger', async () => {
      if (!(await ask('Удалить документ «' + d.name + '» из архива?', 'Удалить', true))) return;
      const l2 = ((await DB.get('docs')) || []).filter((q) => q.id !== d.id);
      await DB.set('docs', l2); await DB.set('doc:' + d.id, null); renderDocs();
    });
    el.appendChild(row);
  }
}
async function shareKind(kind, mode) {
  try { await shareKindInner(kind, mode); } catch (e) { busy(false); console.error(e); notice('Не удалось сформировать файл: ' + (e.message || e)); }
}
async function shareKindInner(kind, mode) {
  busy(true, 'Готовлю файл…');
  await new Promise((r) => setTimeout(r, 30));
  let name, blob;
  try {
    if (kind === 'tg' || kind === 'floor') { busy(false); await shareBundle('floor', mode); return; }
    if (kind === 'all') { busy(false); await shareBundle('all', mode); return; }
    if (kind === 'pdf1') { blob = buildPdf(false); name = fileBase('этаж_' + S.floor) + '.pdf'; }
    else if (kind === 'pdf') { blob = buildPdf(true); name = fileBase('поэтажный_план') + '.pdf'; }
    else if (kind === 'full') { blob = await buildReportZip(); name = `Отчёт_${stamp()}.zip`; }
    else if (kind === 'fullpdf') { blob = buildFullReport(); name = `Полный_отчёт_${stamp()}.pdf`; }
    else if (kind === 'pdfall') { blob = buildPdf(true); name = fileBase('все_этажи') + '.pdf'; }
    else if (kind === 'dxf') { blob = buildDxf(false); name = fileBase('этаж_' + S.floor) + '.dxf'; }
    else if (kind === 'dxfall') { blob = buildDxf(true); name = fileBase('все_этажи') + '.dxf'; }
    else if (kind === 'csv') { blob = buildCsv(); name = `Замеры_${stamp()}.csv`; }
    else if (kind === 'png') { blob = await canvasBlob(renderPlanCanvas(S.floor)); name = fileBase('этаж_' + S.floor) + '.png'; }
    else if (kind === 'json') {
      blob = new Blob([JSON.stringify({ app: 'disto-plan', v: VERSION, items: S.items, settings: S.settings, plan: stripPrep(S.plan) })], { type: 'application/json' });
      name = `Копия_замеров_${stamp()}.json`;
    }
  } finally { busy(false); }
  if (kind !== 'json') addDoc(name, blob);
  await deliver(name, blob, mode);
}
/** Telegram: собрать файлы (PDF поэтажный, DXF этажа, DXF всех этажей) и открыть «Поделиться» */
/** Отправка: scope 'all' — все этажи (PDF + DXF всех этажей), 'floor' — только текущий этаж (PDF + DXF этажа) */
async function shareBundle(scope = 'floor', mode = 'share') {
  if (!blk()) { toast('Сначала создайте лист'); return; }
  busy(true, 'Собираю файлы…');
  await new Promise((r) => setTimeout(r, 30));
  const files = [];
  try {
    if (scope === 'all') {
      files.push(new File([buildPdf(true)], fileBase('все_этажи') + '.pdf', { type: 'application/pdf' }));
      files.push(new File([buildDxf(true)], fileBase('все_этажи_мм') + '.dxf', { type: 'application/dxf' }));
    } else {
      files.push(new File([buildPdf(false)], fileBase('этаж_' + S.floor) + '.pdf', { type: 'application/pdf' }));
      files.push(new File([buildDxf(false)], fileBase('этаж_' + S.floor + '_мм') + '.dxf', { type: 'application/dxf' }));
    }
  } finally { busy(false); }
  for (const f of files) addDoc(f.name, f);
  if (mode === 'save') { for (const f of files) await deliver(f.name, f, 'save'); return; }
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title: sheetHeader() }); return; }
    catch (e) { if (e.name === 'AbortError') return; if (e.name === 'NotAllowedError') { offerShareFiles(files); return; } }
  }
  // если телефон не пропускает DXF — один ZIP со всеми файлами
  const zip = await zipMany(files.map((f) => ({ name: f.name, blob: f })));
  await deliver(fileBase(scope === 'all' ? 'все_этажи' : 'этаж_' + S.floor) + '.zip', zip, 'share');
}
function offerShareFiles(files) {
  const bar = $('readyBar');
  bar.hidden = false;
  $('readyName').textContent = files.map((f) => f.name).join(', ');
  $('readyGo').onclick = async () => { bar.hidden = true; try { await navigator.share({ files }); } catch (e) { /* отмена */ } };
}
let shareMode = 'share';
function openShare() {
  if (!blk()) { toast('Сначала создайте лист'); return; }
  const fl = floorsWithData();
  $('shareScope').textContent = `${sheetHeader()} · этаж ${S.floor}` + (fl.length ? ` · этажей с замерами: ${fl.length}` : ' · замеров пока нет');
  const all = document.querySelector('.shareItem[data-kind=dxfall]');
  all.disabled = fl.length <= 1; all.classList.toggle('off', fl.length <= 1);
  $('sendFloorT').textContent = `Отправить этаж ${S.floor}`;
  $('sendAllSub').textContent = fl.length > 1 ? `PDF и DXF — этажи ${fl.slice().sort((a, b) => a - b).join(', ')}` : 'PDF и DXF — пока замерен один этаж';
  $('shareModal').hidden = false;
}
function renderAreas() {
  if (!blk()) return;
  const rows = roomRows(S.floor).filter((r) => r.room.closed && (r.ab || hasDrawing()));
  $('areasScope').textContent = `${sheetHeader()} · этаж ${S.floor}`;
  let sum = 0;
  const drw = hasDrawing();
  const body = rows.map(({ room, ab }) => {
    const a = ab?.area ?? (drw ? room.area : null);
    if (a) sum += a;
    return `<tr><td><b>№${room.no}</b></td><td class="num">${a != null ? fmt(a) : '—'}${ab ? '' : ' (черт.)'}</td>` + (drw ? `<td class="num">${room.sketch ? '—' : fmt(room.area)}</td>` : '') + '</tr>';
  }).join('');
  $('areasTable').innerHTML = `<tr><th>Комната</th><th style="text-align:right">Площадь, м²</th>${drw ? '<th style="text-align:right">По чертежу, м²</th>' : ''}</tr>` +
    (body || '<tr><td colspan="3" class="muted">Комнат пока нет — замкните комнату</td></tr>') +
    `<tr><td><b>Общая площадь</b></td><td class="num"><b>${fmt(sum)}</b></td>${drw ? '<td></td>' : ''}</tr>`;
  $('areasStats').textContent = '';
}

/* ---------- загрузка плана ---------- */
async function loadPlanFile(file) {
  busy(true, 'Чтение чертежа…');
  try {
    let plan;
    if (/\.json$/i.test(file.name)) plan = JSON.parse(await file.text());
    else {
      busy(true, 'Загрузка модуля DWG (один раз, ~8 МБ)…');
      const { parseCadFile } = await import('./cad.js');
      busy(true, 'Разбор чертежа и поиск блоков…');
      plan = await parseCadFile(await file.arrayBuffer(), file.name, BASE);
    }
    if (!plan?.blocks?.length) throw new Error('В чертеже не найдено линий');
    if (/\.json$/i.test(file.name) && plan.blocks.every((b) => b.blank || b.title)) { setPlan(plan); await DB.set('plan', stripPrep(S.plan)); return; }
    // чертёж — подложка (красным), переводим в сантиметры
    const k = (UNIT_M[plan.unit] || 0.001) / 0.01;
    const title = (plan.name || file.name.replace(/\.[^.]+$/, '')).slice(0, 40);
    const added = [];
    for (const b0 of plan.blocks) {
      const b = { id: 'dw' + Date.now() + added.length, title, blockLabel: b0.name, drawing: true,
        bbox: b0.bbox.map((v) => v * k), polys: b0.polys.map((q) => ({ ...q, p: q.p.map((v) => v * k) })),
        texts: (b0.texts || []).map((t) => ({ ...t, x: t.x * k, y: t.y * k, h: t.h * k })) };
      b.name = uniqueSheetName(title + ' · ' + b0.name);
      S.plan.blocks.push(b); added.push(b);
    }
    S.plan.unit = 'cm';
    await DB.set('plan', stripPrep(S.plan));
    setBlock(added[0].name); renderBlocks(); renderPlanInfo();
    toast(`Чертёж загружен как подложка: ${added.map((b) => b.blockLabel).join(', ')}`);
    $('menuModal').hidden = true;
  } catch (e) {
    console.error(e);
    notice('Не удалось открыть файл: ' + (e.message || e));
  } finally { busy(false); }
}
function stripPrep(plan) { return { ...plan, blocks: plan.blocks.map(({ _prep, ...b }) => b) }; }
function setPlan(plan) {
  S.plan = plan; S.views = {};
  if (!plan.blocks.find((b) => b.name === S.block)) S.block = plan.blocks[0]?.name ?? null;
  renderBlocks(); renderPlanInfo(); draw();
}
function renderPlanInfo() {
  $('planInfo').textContent = S.plan.blocks.length ? `Листов: ${S.plan.blocks.length}` : 'Листов пока нет — нажмите «+» вверху.';
  const el = $('blockNames');
  el.innerHTML = S.plan.blocks.length ? '<p class="muted small">Наименование и блок можно изменить:</p>' : '';
  S.plan.blocks.forEach((b) => {
    const row = document.createElement('div'); row.className = 'bn';
    const it = document.createElement('input'); it.value = b.title || b.name; it.placeholder = 'Наименование'; it.style.width = '140px';
    const ib = document.createElement('input'); ib.value = b.blockLabel || ''; ib.placeholder = 'Блок'; ib.style.width = '64px';
    const apply = async () => {
      const t = it.value.trim() || b.title || b.name, bl = ib.value.trim();
      const old = b.name;
      b.title = t; b.blockLabel = bl;
      const nn = b.blank ? (S.plan.blocks.some((o) => o !== b && o.name === t + (bl ? ' · ' + bl : '')) ? old : t + (bl ? ' · ' + bl : '')) : old;
      if (nn !== old) { for (const i of S.items) if (i.block === old) i.block = nn; if (S.block === old) S.block = nn; b.name = nn; }
      renderBlocks(); save(); await DB.set('plan', stripPrep(S.plan)); draw();
    };
    it.onchange = apply; ib.onchange = apply;
    const n = S.items.filter((i) => i.block === b.name).length;
    const del = document.createElement('button'); del.className = 'btn danger'; del.textContent = '✕'; del.title = 'Удалить лист'; del.style.cssText = 'height:38px;width:44px;flex:0 0 auto';
    del.onclick = async () => {
      if (!(await ask(`Удалить лист «${sheetHeader(b)}» со всеми его этажами и замерами (${n})?`, 'Удалить', true))) return;
      pushUndo();
      S.items = S.items.filter((i) => i.block !== b.name);
      S.plan.blocks = S.plan.blocks.filter((x) => x !== b);
      if (S.block === b.name) S.block = S.plan.blocks[0]?.name ?? null;
      await DB.set('plan', stripPrep(S.plan)); save(); renderBlocks(); renderPlanInfo(); draw();
    };
    row.append(it, ib, Object.assign(document.createElement('span'), { className: 'muted small', textContent: (b.blank ? 'лист' : 'чертёж') + ` · ${n}` }), del);
    el.appendChild(row);
  });
}

/* ---------- DISTO ---------- */
const disto = new Disto();
function bindDisto() {
  const btn = $('btnDisto');
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  $('distoHelp').innerHTML = 'Лазерный дальномер подключается к телефону по Bluetooth как клавиатура. Нажмите кнопку измерения на приборе — число само запишется в выбранную стену (поле ввода трогать не нужно, русская раскладка тоже подходит: «ю» читается как запятая).';
  btn.onclick = async () => {
    if (disto.state === 'on') {
      if (await ask('Отключить ' + (disto.device?.name || 'DISTO') + '?', 'Отключить')) disto.disconnect();
      return;
    }
    if (!Disto.supported()) { $('menuModal').hidden = false; renderPlanInfo(); $('distoHelp').scrollIntoView(); return; }
    try { await disto.connect(); } catch (e) { if (e.name !== 'NotFoundError') toast('DISTO: ' + e.message); }
  };
  disto.addEventListener('state', (e) => {
    btn.dataset.state = e.detail.state;
    $('distoLabel').textContent = e.detail.state === 'on' ? (disto.device?.name || 'DISTO').replace(/^DISTO\s*/i, 'DISTO ') : e.detail.state === 'connecting' ? 'Связь…' : 'DISTO';
    $('btnTrigger').hidden = !(e.detail.state === 'on' && disto.cmd);
    if (e.detail.msg) toast(e.detail.msg);
  });
  disto.addEventListener('measure', (e) => onMeasure(e.detail.meters, 'disto'));
  disto.addEventListener('battery', (e) => toast(`DISTO подключён · батарея ${e.detail}%`));
  disto.addEventListener('log', () => { $('distoLog').textContent = disto.log.join('\n'); });
  $('btnTrigger').onclick = async () => { try { await disto.trigger(); } catch (e) { toast(e.message); $('btnTrigger').hidden = true; } };
}

/* ---------- ввод с клавиатуры (и режим клавиатуры DISTO) ---------- */
/** Esc / ✕: закрыть верхний экран без изменений */
function closeTopmost() {
  if (kpOpen()) { kpClose(); return true; }
  if (!$('askModal').hidden) { askDone ? askDone(false) : ($('askModal').hidden = true); return true; }
  if (!$('copyModal').hidden) { askDone ? askDone(null) : ($('copyModal').hidden = true); return true; }
  const mods = [...document.querySelectorAll('.modal')].filter((m) => !m.hidden && m.id !== 'askModal');
  if (mods.length) { mods[mods.length - 1].hidden = true; return true; }
  if (document.body.classList.contains('arrange')) { setArrange(false); return true; }
  if (!$('toolsPop').hidden) { $('toolsPop').hidden = true; return true; }
  if (!$('sheet').hidden) { $('shClose').click(); return true; }
  if (S.openArm || S.turnArm) { S.openArm = null; S.turnArm = false; syncOpenPad(); return true; }
  if (focusMode) { setFocus(false); return true; }
  return false;
}
let kpStr = '';
const kpOpen = () => !$('keypad').hidden;
let kpAngle = false;
function kpShow(angle = false) {
  kpAngle = angle; kpStr = ''; $('kpVal').textContent = '0';
  $('kpUnit').textContent = angle ? '°' : 'м';
  $('kpOk').hidden = angle; $('kpTurn').hidden = !angle;
  $('keypad').hidden = false;
}
function editPrep() {
  const tt = turnTarget();
  if (!tt) { toast('Нет линии', true); return null; }
  pushUndo(); return tt;
}
function editDone(it, msg) {
  if (it.dirs.length) rebuildSketch(it);
  if (S.draft?.itemId === it.id) S.draft.pts = it.pts.slice();
  if (S.skm && S.skm.id === it.id) S.skm.i = Math.min(S.skm.i, it.dirs.length - 1);
  S.viewFollow = true; save(); draw(); toast(msg, true);
}
/** Ошибся направлением: налево ↔ направо (линия и всё после неё зеркально поворачиваются) */
function lineFlip() {
  const tt = editPrep(); if (!tt) return;
  const { it, k } = tt;
  if (k === 0 && !it.closed) {
    it.dirs[0] = (540 - it.dirs[0]) % 360;
    for (let j = 1; j < it.dirs.length; j++) it.dirs[j] = (540 - it.dirs[j]) % 360;
    editDone(it, 'Линия развернута в другую сторону'); return;
  }
  const rel = normDeg(it.dirs[k] - skPrevDir(it, k));
  if (Math.abs(rel) < 0.01 || Math.abs(Math.abs(rel) - 180) < 0.01) { toast('Здесь линия идёт прямо — поворачивать некуда', true); return; }
  const delta = -2 * rel;
  for (let j = k; j < it.dirs.length; j++) it.dirs[j] = ((it.dirs[j] + delta) % 360 + 360) % 360;
  editDone(it, rel > 0 ? 'Было налево — стало направо' : 'Было направо — стало налево');
}
/** Добавить линию: делит текущую пополам — новую точку можно повернуть кнопкой «угол» */
function lineSplit() {
  const tt = editPrep(); if (!tt) return;
  const { it, k } = tt;
  const L = it.lens[k] ?? it.dlens[k] ?? 1;
  it.dirs.splice(k + 1, 0, it.dirs[k]);
  it.dlens.splice(k, 1, L / 2, L / 2);
  it.lens.splice(k, 1, null, null);
  if (S.skm && S.skm.id === it.id) S.skm.i = k + 1; // новая (вторая) половина — текущая
  editDone(it, 'Добавлена линия — поверните её кнопкой «угол» или стрелками');
}
/** Удалить текущую линию */
function lineDel() {
  const tt = editPrep(); if (!tt) return;
  const { it, k } = tt;
  it.dirs.splice(k, 1); it.dlens.splice(k, 1); it.lens.splice(k, 1);
  if (!it.dirs.length) {
    S.items = S.items.filter((o) => o !== it); S.skm = null;
    if (S.draft?.itemId === it.id) S.draft = { kind: 'sketch', pts: it.start.slice() };
    save(); draw(); toast('Линия удалена', true); return;
  }
  if (S.skm && S.skm.id === it.id && S.skm.i >= k && S.skm.i > 0) S.skm.i--;
  editDone(it, 'Линия удалена');
}
function lineDoneBtn() {
  if (S.tool !== 'sketch') return;
  if (S.draft && skItem()?.dirs?.length) { finishSketch(false); toast('Линия закончена — меряйте отрезки лазером', true); return; }
  S.skm = null; S.draft = null; hint(''); toast('Готово', true); draw();
}
/** Последняя линия: та, что сейчас чертится, или стена, которую сейчас меряем */
function turnTarget() {
  const sk = skmItem();
  if (sk && sk.dirs) return { it: sk, k: S.skm.i };
  const it = skItem();
  if (it?.dirs?.length) return { it, k: it.dirs.length - 1 };
  const last = curItems().filter((i) => i.kind === 'sketch' && i.dirs?.length && !i.closed).sort((a, b) => (b.t || 0) - (a.t || 0))[0];
  return last ? { it: last, k: last.dirs.length - 1 } : null;
}
/** Режим «угол»: последняя линия и её конец — синим */
function drawTurnTip(c, v, pal) {
  const tt = turnTarget(); if (!tt) return;
  const { it, k } = tt;
  const n = it.pts.length / 2, j = (k + 1) % n;
  const a = w2s(it.pts[k * 2], it.pts[k * 2 + 1], v), b = w2s(it.pts[j * 2], it.pts[j * 2 + 1], v);
  c.save();
  c.strokeStyle = '#1f6feb'; c.lineWidth = 5; c.lineCap = 'round';
  c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
  // угол наклона: дуга от продолжения предыдущей линии до этой + подпись
  const first = k === 0 && !it.closed;
  const prev = first ? 0 : skPrevDir(it, k);
  let rel = it.dirs[k] - prev; while (rel > 180) rel -= 360; while (rel <= -180) rel += 360;
  const sa = -(prev * Math.PI) / 180 + (v.rot || 0), ea = -(it.dirs[k] * Math.PI) / 180 + (v.rot || 0);
  if (Math.abs(rel) > 0.01) {
    c.save(); c.strokeStyle = '#1f6feb'; c.lineWidth = 2; c.setLineDash([5, 4]);
    const ex = Math.cos(sa) * 70, ey = Math.sin(sa) * 70;
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(a.x + ex, a.y + ey); c.stroke(); c.setLineDash([]);
    c.lineWidth = 2.5; c.beginPath(); c.arc(a.x, a.y, 42, sa, ea, rel > 0); c.stroke(); c.restore();
  }
  const mid = (sa + ea) / 2;
  const txt = first ? `${Math.round(it.dirs[k])}°` : rel === 0 ? '0° прямо' : `${rel > 0 ? '↺' : '↻'} ${Math.abs(Math.round(rel * 10) / 10).toString().replace('.', ',')}°`;
  pill(c, a.x + Math.cos(mid) * 72, a.y + Math.sin(mid) * 72, txt, '#1f6feb', '#fff', { size: 13 });
  c.fillStyle = 'rgba(31,111,235,.18)'; c.beginPath(); c.arc(b.x, b.y, 22, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#1f6feb'; c.strokeStyle = '#fff'; c.lineWidth = 3;
  c.beginPath(); c.arc(b.x, b.y, 11, 0, Math.PI * 2); c.fill(); c.stroke();
  c.restore();
}
/** Повернуть последнюю линию к точке экрана (шаг 5°) */
function turnToward(sx, sy) {
  const tt = turnTarget(); if (!tt) return null;
  const { it, k } = tt;
  const a = { x: it.pts[k * 2], y: it.pts[k * 2 + 1] }, w = screenToWorld(sx, sy);
  if (Math.hypot(w.x - a.x, w.y - a.y) * V().s < 10) return null;
  let deg = Math.round(((Math.atan2(w.y - a.y, w.x - a.x) * 180) / Math.PI) / 5) * 5;
  deg = ((deg % 360) + 360) % 360;
  if (it.dirs[k] !== deg) {
    it.dirs[k] = deg; rebuildSketch(it);
    if (S.draft?.itemId === it.id) S.draft.pts = it.pts.slice();
  }
  let rel = deg - skPrevDir(it, k); while (rel > 180) rel -= 360; while (rel <= -180) rel += 360;
  return k === 0 && !it.closed ? `${deg}°` : rel === 0 ? 'прямо' : `${rel > 0 ? 'налево' : 'направо'} ${Math.abs(rel)}°`;
}
function turnLast(sign) {
  const n = parseNum(kpStr);
  if (n == null || n <= 0 || n >= 360) { toast('Введите угол в градусах, например 15', true); return; }
  const tt = turnTarget();
  if (!tt) { kpClose(); toast('Нет линии для поворота', true); return; }
  pushUndo();
  const { it, k } = tt;
  it.dirs[k] = (((it.dirs[k] + sign * n) % 360) + 360) % 360;
  rebuildSketch(it);
  if (S.draft?.itemId === it.id) S.draft.pts = it.pts.slice();
  save(); kpClose(); draw();
  toast(`Линия повернута ${sign > 0 ? 'налево' : 'направо'} на ${String(n).replace('.', ',')}°`, true);
}
function kpClose() { $('keypad').hidden = true; kpStr = ''; kpAngle = false; }
function kpKey(k) {
  if (k === 'bs') kpStr = kpStr.slice(0, -1);
  else if (k === ',') { if (!kpStr.includes(',')) kpStr = (kpStr || '0') + ','; }
  else if (kpStr.replace(',', '').length < 7) kpStr = kpStr === '0' ? k : kpStr + k;
  $('kpVal').textContent = kpStr || '0';
}
function kpOk() {
  const n = parseNum(kpStr);
  if (n == null || n <= 0) { toast('Введите число, например 2,85'); return; }
  kpClose();
  onMeasure(Math.round(n * 10000) / 10000, 'manual');
}
function bindEntry() {
  const inp = $('entry');
  $('entryForm').onsubmit = (e) => { e.preventDefault(); kpShow(); };
  inp.addEventListener('click', (e) => { e.preventDefault(); inp.blur(); kpShow(); });
  inp.addEventListener('focus', () => { inp.blur(); });
  for (const b of $('keypad').querySelectorAll('[data-k]')) b.onclick = () => kpKey(b.dataset.k);
  $('kpOk').onclick = kpOk;
  $('mini').addEventListener('pointerdown', (e) => {
    e.stopPropagation(); if (!miniMap) return;
    const r = $('mini').getBoundingClientRect(), mm = miniMap;
    const wx = mm.x0 + (e.clientX - r.left - mm.ox) / mm.k, wy = mm.y0 + (mm.H - mm.oy - (e.clientY - r.top)) / mm.k;
    const v = V(); placeWorldAt(v, wx, wy, cv.clientWidth / 2, cv.clientHeight / 2); draw();
  });
  $('kpLeft').onclick = () => turnLast(1);
  $('kpRight').onclick = () => turnLast(-1);
  $('btnTurn').onclick = () => {
    if (S.turnArm) { S.turnArm = false; syncOpenPad(); draw(); return; }
    if (!turnTarget()) { toast('Сначала начертите линию', true); return; }
    S.openArm = null; S.turnArm = true; syncOpenPad();
    toast('Конец линии синий — нажимайте на экран, куда повернуть. Ещё раз «°» — готово', true); draw();
  };
  $('kpClose').onclick = kpClose;
  // в любом поле для чисел: «ю»/«б» (русская раскладка) → запятая
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.inputMode === 'decimal' && /[юЮбБ.]/.test(t.value)) {
      const pos = t.selectionStart;
      t.value = t.value.replace(/[юЮбБ.]/g, ',');
      try { t.setSelectionRange(pos, pos); } catch (er) { /* */ }
    }
  });
  // DISTO по Bluetooth работает как клавиатура: печатает число и Enter/Tab.
  // Собираем цифры сами, даже если ни одно поле не в фокусе (экранная клавиатура не появляется).
  let kb = '', kbT = 0;
  const isSep = (e) => /^[.,юЮбБ]$/.test(e.key) || e.code === 'Period' || e.code === 'Comma' || e.code === 'NumpadDecimal';
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeTopmost()) { e.preventDefault(); return; }
    if (kpOpen()) {
      if (/^[0-9]$/.test(e.key)) kpKey(e.key);
      else if (isSep(e)) kpKey(',');
      else if (e.key === 'Backspace') kpKey('bs');
      else if (e.key === 'Enter' || e.key === 'Tab') kpOk();
      else return;
      e.preventDefault(); return;
    }
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
    if (/^[0-9]$/.test(e.key) || /^Digit[0-9]$|^Numpad[0-9]$/.test(e.code) || (isSep(e) && kb)) {
      e.preventDefault();
      const ch = /^[0-9]$/.test(e.key) ? e.key : /[0-9]$/.test(e.code) && !isSep(e) ? e.code.slice(-1) : ',';
      if (ch === ',' && kb.includes(',')) return;
      kb += ch; inp.value = kb;
      clearTimeout(kbT); kbT = setTimeout(() => { kb = ''; inp.value = ''; }, 5000);
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab' || e.code === 'NumpadEnter') && kb) {
      e.preventDefault();
      const n = parseNum(kb); kb = ''; inp.value = ''; clearTimeout(kbT);
      if (n > 0) onMeasure(Math.round(n * 10000) / 10000, 'disto');
      return;
    }
    if (e.key === 'Backspace' && kb) { e.preventDefault(); kb = kb.slice(0, -1); inp.value = kb; return; }
    if (e.key === 'Escape') { S.draft = null; S.ruler = null; updateDraftBar(); S.selSeg = null; select(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selId) { removeItem(S.selId); }
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) doRedo();
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) doUndo();
    else if (e.key === 'y' && (e.ctrlKey || e.metaKey)) doRedo();
    else if (e.key === 'F3') { e.preventDefault(); $('btnSnap').click(); }
    else if (e.key === 'F8') { e.preventDefault(); $('btnOrtho').click(); }
  });
}

/* ---------- меню ---------- */
function bindMenu() {
  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { m.hidden = true; return; }
      // фон: окно-вопрос закрывается только кнопками (иначе «клик» после касания сразу его закрывает)
      if (e.target === m && m.id !== 'askModal' && m.id !== 'copyModal' && Date.now() - (m._openT || 0) > 500) m.hidden = true;
    });
  }
  $('btnMenu').onclick = () => {
    renderPlanInfo();
    $('setShadow').checked = !!S.settings.layers.shadow; $('setShadowDims').checked = !!S.settings.layers.shadowDims;
    $('menuModal').hidden = false;
  };
  $('setShadow').onchange = (e) => { S.settings.layers.shadow = e.target.checked; save(); draw(); };
  $('setShadowDims').onchange = (e) => { S.settings.layers.shadowDims = e.target.checked; if (e.target.checked) { S.settings.layers.shadow = true; $('setShadow').checked = true; } save(); draw(); };
  $('btnCopyFloor').onclick = async () => {
    const fl = floorsWithDrawing().filter((f) => f !== S.floor);
    if (!fl.length) { toast('Нет других этажей с чертежом', true); return; }
    $('menuModal').hidden = true;
    if (floorHasData(S.floor) && !(await ask(`На этаже ${S.floor} уже есть чертёж. Копия добавится поверх него. Продолжить?`, 'Продолжить'))) return;
    const near = shadowFloor() ?? fl[0];
    const r = await askCopy(fl.includes(near) ? near : fl[0], S.floor, true);
    if (r) copyFloor(r.src, S.floor, r.mode, r.open);
  };
  for (const b of $('listScope').children) b.onclick = () => {
    listScope = b.dataset.scope;
    for (const o of $('listScope').children) o.classList.toggle('on', o === b);
    renderList();
  };
  $('listShare').onclick = () => { $('listModal').hidden = true; openShare(); };
  for (const b of $('shareMode').children) b.onclick = () => {
    shareMode = b.dataset.mode;
    for (const o of $('shareMode').children) o.classList.toggle('on', o === b);
  };
  for (const b of document.querySelectorAll('.shareItem')) b.onclick = () => shareKind(b.dataset.kind, shareMode);
  $('sendAll').onclick = () => { $('shareModal').hidden = true; shareKind('all', shareMode); };
  $('sendFloor').onclick = () => { $('shareModal').hidden = true; shareKind('floor', shareMode); };
  $('areasPdf').onclick = () => shareKind('tg', 'share');
  $('areasPdfSave').onclick = () => shareKind('pdf', 'save');
  $('filePlan').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadPlanFile(f); };
  if ($('btnDefaultPlan')) $('btnDefaultPlan').onclick = async () => {
    if (!(await ask('Вернуть встроенный план (блоки А, Б, В, Г)? Замеры сохранятся.', 'Вернуть'))) return;
    $('menuModal').hidden = true;
  };
  for (const [id, key] of [['setObj', 'objName']]) {
    $(id).value = S.settings[key] || '';
    $(id).oninput = (e) => { S.settings[key] = e.target.value.trim(); save(); };
  }
  $('setWallTh').value = S.settings.wallTh || '';
  $('setWallTh').onchange = () => { const n = parseNum($('setWallTh').value); S.settings.wallTh = n > 0 ? Math.round(n) : 0; $('setWallTh').value = S.settings.wallTh || ''; save(); draw(); };
  $('setLaserOff').value = fmt(S.settings.laserOffset ?? 0.13);
  $('setLaserOff').onchange = () => { const n = parseNum($('setLaserOff').value); S.settings.laserOffset = n >= 0 && n < 1 ? n : 0.13; $('setLaserOff').value = fmt(S.settings.laserOffset); save(); syncLaserBtn(); };
  const fh = $('setFloorH');
  fh.value = S.settings.floorH ? fmt(S.settings.floorH) : '';
  fh.onchange = () => {
    const n = parseNum(fh.value); S.settings.floorH = n > 0 ? n : 0;
    fh.value = S.settings.floorH ? fmt(S.settings.floorH) : '';
    for (const i of S.items) if (i.kind === 'point') autoDesign(i);
    save(); draw();
  };
  $('setTheme').value = S.settings.theme;
  $('setTheme').onchange = (e) => { S.settings.theme = e.target.value; applyTheme(); save(); };
  for (const [id, key] of [['setOtherFloors', 'otherFloors'], ['setSnap', 'snap'], ['setBeep', 'beep'], ['setAutoNext', 'autoNext'], ['setWallLabels', 'wallLabels'], ['setWallCols', 'wallColumns']]) {
    $(id).checked = !!S.settings[key];
    $(id).onchange = (e) => { S.settings[key] = e.target.checked; if (key === 'wallColumns') resetPrep(); syncSnapUI(); save(); draw(); };
  }
  const wm = $('setWallMin');
  wm.value = fmt(S.settings.wallMin);
  wm.onchange = () => { const n = parseNum(wm.value); S.settings.wallMin = n >= 0 ? n : 0.15; wm.value = fmt(S.settings.wallMin); resetPrep(); save(); draw(); };
  $('btnBackup').onclick = () => download(`Копия_замеров_${stamp()}.json`,
    JSON.stringify({ app: 'disto-plan', v: VERSION, items: S.items, settings: S.settings, plan: stripPrep(S.plan) }), 'application/json');
  $('fileBackup').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.items)) throw new Error('нет замеров');
      if (!(await ask(`Восстановить ${d.items.length} замеров? Текущие будут заменены.`, 'Восстановить'))) return;
      pushUndo(); S.items = d.items; if (d.settings) Object.assign(S.settings, d.settings);
      if (d.plan?.blocks) { setPlan(d.plan); await DB.set('plan', d.plan); }
      save(); draw(); toast('Восстановлено'); $('menuModal').hidden = true;
    } catch (err) { notice('Файл не подходит: ' + err.message); }
  };
  $('btnClear').onclick = async () => {
    if (!(await ask('Удалить ВСЕ замеры во всех блоках? (можно вернуть кнопкой «Отменить»)', 'Удалить', true))) return;
    pushUndo(); S.items = []; select(null); save(); draw(); $('menuModal').hidden = true;
  };
  // до этажа
  // выбор этажа: нажмите на номер этажа
  $('floorVal').onclick = () => {
    $('flIn').value = S.floor;
    $('floorModal').hidden = false;
    setTimeout(() => { $('flIn').focus(); $('flIn').select(); }, 50);
  };
  $('flMinus').onclick = () => { $('flIn').value = (parseInt($('flIn').value, 10) || S.floor) - 1; };
  $('flPlus').onclick = () => { $('flIn').value = (parseInt($('flIn').value, 10) || S.floor) + 1; };
  const applyFloor = () => {
    const f = parseInt($('flIn').value, 10);
    if (isNaN(f)) { toast('Введите номер этажа'); return; }
    $('floorModal').hidden = true;
    changeFloor(f);
    toast(`Этаж ${f}`);
  };
  $('flApply').onclick = applyFloor;
  $('flIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyFloor(); } });
  // очистить этаж
  const clearFloor = async () => {
    const its = curItems();
    if (!its.length) { toast('На этом этаже нечего очищать'); return; }
    if (!(await ask(`Очистить блок ${S.block}, этаж ${S.floor}?\nУдалится всё на этом этаже: замеры стен, двери и окна, линии, точки (${its.length}). Другие этажи не затрагиваются. Можно вернуть кнопкой «Отменить».`, 'Очистить', true))) return;
    pushUndo();
    S.items = S.items.filter((i) => !(i.block === S.block && i.floor === S.floor));
    S.session = false; S.selSeg = null; S.draft = null; select(null);
    if (isBlank()) startBlankDraft();
    save(); draw(); toast(`Этаж ${S.floor} очищен`);
  };
  $('btnClearFloor').onclick = () => { $('toolsPop').hidden = true; $('menuModal').hidden = true; clearFloor(); };
  $('toFloorChip').onclick = () => {
    $('toFrom').textContent = S.floor; $('toFloorIn').value = S.floor; $('toFloorTo').value = S.toFloor ?? '';
    $('toModal').hidden = false;
  };
  $('toApply').onclick = () => {
    const f = parseInt($('toFloorIn').value, 10), t = parseInt($('toFloorTo').value, 10);
    if (!isNaN(f)) S.floor = f;
    S.toFloor = isNaN(t) ? null : t;
    if (S.toFloor != null) setDir(S.toFloor < S.floor ? 'down' : 'up');
    setFloor(S.floor, true);
    $('toModal').hidden = true;
  };
  $('ver').textContent = VERSION;
}
function resetPrep() { for (const b of S.plan.blocks) delete b._prep; S.selSeg = null; refreshSheet(); }
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  document.querySelector('meta[name=theme-color]').content = S.settings.theme === 'dark' ? '#08101f' : '#14213d';
  draw();
}

/* ---------- запуск ---------- */
async function init() {
  await DB.open();
  const [items, settings, session, plan] = await Promise.all([DB.get('items'), DB.get('settings'), DB.get('session'), DB.get('plan')]);
  if (Array.isArray(items)) S.items = items;
  if (settings) {
    const lay = { ...S.settings.layers, ...(settings.layers || {}) };
    Object.assign(S.settings, settings); S.settings.layers = lay;
    S.settings.btnPos = S.settings.btnPos || {};
  }
  if (session) Object.assign(S, { block: session.block, floor: session.floor ?? 1, dir: session.dir || 'down', toFloor: session.toFloor ?? 0 });
  S.plan = plan?.blocks ? plan : EMPTY_PLAN();
  // версия 2: встроенный план и старые замеры убираются (архив «Документы» не трогаем)
  if (!S.settings.v23) { S.settings.layers.redoBtn = true; S.settings.v23 = true; }
  if (!S.settings.v2) {
    S.items = []; S.plan = EMPTY_PLAN(); S.settings.v2 = true; S.floor = 1;
    await DB.set('plan', S.plan); await DB.set('items', []); await DB.set('settings', S.settings);
  }
  S.plan.unit = S.plan.unit || 'cm';
  if (!S.plan.blocks.find((b) => b.name === S.block)) S.block = S.plan.blocks[0]?.name ?? null;

  applyTheme();
  renderBlocks();
  $('floorNum').textContent = S.floor;
  $('toFloorNum').textContent = S.toFloor ?? '—';
  setDir(S.dir);
  $('floorDown').onclick = () => changeFloor(S.floor - 1);
  $('floorUp').onclick = () => changeFloor(S.floor + 1);
  for (const b of $('dirSeg').children) b.onclick = () => setDir(b.dataset.dir);
  $('btnUndo').onclick = doUndo;
  $('btnFit').onclick = () => { S.views[S.block] = fitView(blk()); draw(); };
  $('draftDone').onclick = () => finishSketch(false);
  $('draftUndo').onclick = () => sketchUndo();
  $('draftCancel').onclick = () => { S.draft = null; updateDraftBar(); hint(''); draw(); };
  bindSheet(); bindEntry(); bindMenu(); bindTools(); bindMbar(); bindArrange();
  $('nsCreate').onclick = () => {
    const f = parseInt($('nsFloor').value, 10);
    if (isNaN(f)) { toast('Укажите этаж'); return; }
    $('sheetModal').hidden = true;
    createSheet($('nsTitle').value, $('nsBlock').value, f);
  };
  for (const id of ['nsTitle', 'nsBlock', 'nsFloor']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nsCreate').click(); });
  $('btnLayers').onclick = () => { $('toolsPop').hidden = true; $('menuModal').hidden = true; renderLayers(); $('layersModal').hidden = false; };
  $('toolsX').onclick = () => { $('toolsPop').hidden = true; };
  $('btnRedo').onclick = doRedo;
  $('shRCopy').onclick = () => { const it = S.items.find((i) => i.id === S.selId); if (it) roomCopy(it); };
  $('shRRot').onclick = () => { const it = S.items.find((i) => i.id === S.selId); if (it) roomRotate(it); };
  $('shRMir').onclick = () => { const it = S.items.find((i) => i.id === S.selId); if (it) roomMirror(it); };
  syncToolUI();
  $('distoHelp').textContent = 'Лазерный дальномер подключается к телефону по Bluetooth как клавиатура. Нажмите кнопку измерения на приборе — число само запишется в выбранную стену. Русская раскладка тоже подходит: «ю» читается как запятая.';
  new ResizeObserver(() => { resize(); applyBtnPos(); }).observe(cv);
  resize();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // подсказка: на весь экран — только с иконки «На экран Домой»
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let tipSeen = false; try { tipSeen = localStorage.getItem('tipHome') === '1'; } catch (e) { /* */ }
  if (!standalone && /iPhone|iPad|Android/i.test(navigator.userAgent) && !tipSeen) {
    $('homeTip').hidden = false;
    $('homeTipClose').onclick = () => { $('homeTip').hidden = true; try { localStorage.setItem('tipHome', '1'); } catch (e) { /* */ } };
  }
  window.__app = { S, onMeasure, draw, w2s: (x, y) => w2s(x, y), sketchSegs }; // для отладки
}
init();
