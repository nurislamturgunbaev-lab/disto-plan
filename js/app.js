import DEFAULT_PLAN from './default-plan.js';
import { Disto } from './disto.js';
import { DxfWriter } from './dxf.js';
import { buildWalls, asBuilt } from './walls.js';
import { canvasesToPdf } from './pdf.js';
import { zipOne, zipMany } from './zip.js';

const VERSION = '1.7.1';
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
  settings: { floorH: 0, theme: 'light', otherFloors: false, snap: true, beep: true, autoNext: true, wallMin: 0.15, wallColumns: false, wallLabels: true, ortho: false, snapModes: { end: true, mid: true, perp: true, near: false } },
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
}
function doUndo() {
  if (S.draft) { S.draft.pts.splice(-2); if (!S.draft.pts.length) S.draft = null; updateDraftBar(); draw(); return; }
  const s = S.undo.pop();
  if (!s) return toast('Нечего отменять');
  S.items = JSON.parse(s);
  if (!S.items.find((i) => i.id === S.selId)) select(null);
  save(); draw(); refreshSheet();
  toast('Отменено');
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const blk = () => S.plan.blocks.find((b) => b.name === S.block) || S.plan.blocks[0];
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
    if (!S.draft || !S.draft.pts.length) { toast(`${fmt(meters)} м — сначала нажмите на план (начало линии)`); return; }
    sketchAppend(meters, src);
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
function fitView(b, w = cv.clientWidth, h = cv.clientHeight, pad = 36) {
  const [x0, y0, x1, y1] = b.bbox;
  const s = Math.min((w - pad * 2) / (x1 - x0 || 1), (h - pad * 2) / (y1 - y0 || 1));
  return { s, ox: w / 2 - ((x0 + x1) / 2) * s, oy: h / 2 + ((y0 + y1) / 2) * s };
}
const w2s = (x, y, v = V()) => ({ x: x * v.s + v.ox, y: -y * v.s + v.oy });
const screenToWorld = (sx, sy, v = V()) => ({ x: (sx - v.ox) / v.s, y: -(sy - v.oy) / v.s });

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * DPR);
  cv.height = Math.round(r.height * DPR);
  if (lastSize && r.width && r.height) {
    for (const v of Object.values(S.views)) { v.ox += (r.width - lastSize.w) / 2; v.oy += (r.height - lastSize.h) / 2; }
  } else S.views = {};
  if (r.width && r.height) lastSize = { w: r.width, h: r.height };
  draw();
}

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
    const a = screenToWorld(0, 0, v), z = screenToWorld(c.canvas.width / (opts.dpr || DPR), c.canvas.height / (opts.dpr || DPR), v);
    if ((z.x - a.x) / step < 200) {
      c.fillStyle = pal.dark ? 'rgba(148,160,184,.18)' : 'rgba(27,35,51,.12)';
      for (let x = Math.floor(a.x / step) * step; x < z.x; x += step)
        for (let y = Math.floor(z.y / step) * step; y < a.y; y += step) {
          const p = w2s(x, y, v); c.fillRect(p.x - 1, p.y - 1, 2, 2);
        }
    }
  }
  // заливка помещений
  c.lineJoin = 'round'; c.lineCap = 'round';
  for (const q of P.polys) {
    if (!q.z || q.column) continue;
    c.beginPath(); path(c, q.p, v); c.closePath();
    c.fillStyle = pal.dark ? 'rgba(96,135,210,.07)' : 'rgba(31,111,235,.035)';
    c.fill();
  }
  // линии
  c.strokeStyle = pal.ink;
  c.lineWidth = 1.4 * lw;
  c.beginPath();
  for (const q of P.polys) { if (q.column) continue; path(c, q.p, v); if (q.z) c.closePath(); }
  c.stroke();
  // колонны
  c.fillStyle = pal.dark ? '#c7d2e8' : '#2a3448';
  for (const q of P.polys) {
    if (!q.column) continue;
    c.beginPath(); path(c, q.p, v); c.closePath(); c.fill();
  }
  // тексты чертежа
  c.fillStyle = pal.ink2;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  for (const t of b.texts || []) {
    const hpx = t.h * v.s;
    if (hpx < 6) continue;
    c.font = `${Math.min(hpx, 60)}px system-ui, sans-serif`;
    const p = w2s(t.x, t.y, v);
    c.fillText(t.t, p.x, p.y);
  }
}
function path(c, p, v) {
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i] * v.s + v.ox, y = -p[i + 1] * v.s + v.oy;
    i ? c.lineTo(x, y) : c.moveTo(x, y);
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
    if (it.kind === 'seg' || it.kind === 'open') continue;
    const other = it.floor !== S.floor;
    const sel = !opts.export && it.id === S.selId;
    c.globalAlpha = other ? 0.28 : 1;
    const cls = devClass(it);
    const valCol = cls ? pal[cls] : pal.accent;
    if (it.kind === 'sketch') {
      c.strokeStyle = sel ? pal.accent2 : pal.accent;
      c.lineWidth = sel ? 3.5 : 2.5;
      c.setLineDash([]);
      c.beginPath(); path(c, it.pts, v); if (it.closed) c.closePath(); c.stroke();
      sketchLabels(c, it.pts, v, pal, sel ? pal.accent2 : pal.accent);
      if (sel) for (let i = 0; i < it.pts.length; i += 2) handle(c, w2s(it.pts[i], it.pts[i + 1], v), pal);
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
function sketchLabels(c, pts, v, pal, col) {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const a = w2s(pts[i], pts[i + 1], v), e = w2s(pts[i + 2], pts[i + 3], v);
    const Lp = Math.hypot(e.x - a.x, e.y - a.y);
    if (Lp < 14) continue;
    let rot = Math.atan2(e.y - a.y, e.x - a.x);
    if (rot > Math.PI / 2) rot -= Math.PI; if (rot < -Math.PI / 2) rot += Math.PI;
    const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]) * unitM();
    pill(c, (a.x + e.x) / 2 - Math.sin(rot) * 14, (a.y + e.y) / 2 + Math.cos(rot) * -14, fmt(L), col, '#fff', { rot, size: Lp > 34 ? 11 : 9, shadow: false });
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
  const pal = palette();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = pal.paper;
  ctx.fillRect(0, 0, cv.width, cv.height);
  const v = V();
  drawPlan(ctx, blk(), v, pal);
  drawWalls(ctx, blk(), v, pal);
  drawOpenings(ctx, blk(), v, pal);
  drawItems(ctx, v, pal, visibleItems());
  // черновик
  if (S.draft) {
    const d = S.draft;
    ctx.strokeStyle = pal.accent2; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]);
    ctx.beginPath(); path(ctx, d.pts.concat(d.hover ? [d.hover.x, d.hover.y] : []), v); ctx.stroke(); ctx.setLineDash([]);
    for (let i = 0; i < d.pts.length; i += 2) handle(ctx, w2s(d.pts[i], d.pts[i + 1], v), pal);
    if (d.kind === 'sketch' && d.pts.length >= 4) sketchLabels(ctx, d.pts, v, pal, pal.accent2);
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
  if (S.selSeg || curItems().some((i) => i.value == null && i.kind === 'point')) requestDraw();
  updateProgress();
  syncMbar();
}
let raf = 0;
function requestDraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

function scaleBar(c, v, pal) {
  const um = unitM();
  const target = 110 / v.s * um; // метров на 110px
  const m = niceStep(target);
  const px = (m / um) * v.s;
  const x = 14, y = cv.clientHeight - 18;
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
  if (S.settings.ortho && from) {
    const dx = w.x - from.x, dy = w.y - from.y;
    w = Math.abs(dx) >= Math.abs(dy) ? { x: w.x, y: from.y } : { x: from.x, y: w.y };
    snapMark = { x: w.x, y: w.y, type: 'ortho' };
  }
  return w;
}
function drawSnapMark(c, v, pal) {
  if (!snapMark) return;
  const p = w2s(snapMark.x, snapMark.y, v);
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
  const h = S.draft ? null : hit(p.x, p.y);
  if (h) {
    if (S.selId !== h.it.id) select(h.it.id);
    gesture = { type: 'drag', h, start: p, moved: false, orig: JSON.parse(JSON.stringify(h.it)) };
  } else {
    gesture = { type: 'pan', start: p, v: { ...V() }, moved: false };
  }
});
cv.addEventListener('pointermove', (e) => {
  const p = local(e);
  if (S.draft && ptrs.size === 0) { S.draft.hover = snap(p.x, p.y, draftFrom()); requestDraw(); return; }
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
  const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 7) return;
  if (!gesture.moved) { gesture.moved = true; if (gesture.type === 'drag' || gesture.type === 'slope') pushUndo(); }
  if (gesture.type === 'slope') {
    const { sh } = gesture;
    const w = screenToWorld(p.x, p.y);
    const base = Math.atan2(sh.seg.by - sh.seg.ay, sh.seg.bx - sh.seg.ax);
    let abs = Math.atan2(w.y - sh.sy, w.x - sh.sx);
    if (S.settings.ortho) abs = Math.round(abs / (Math.PI / 2)) * (Math.PI / 2);
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
    if (S.draft) S.draft.hover = snap(p.x, p.y, draftFrom());
    requestDraw();
  } else if (gesture.type === 'drag') {
    const { it, part } = gesture.h, o = gesture.orig, s = V().s;
    const ddx = dx / s, ddy = -dy / s;
    if (part === 'body') {
      if (it.kind === 'open') {
        const sg = wallsOf(it.block).byKey.get(it.key);
        const w = screenToWorld(p.x, p.y);
        const L2 = (sg.bx - sg.ax) ** 2 + (sg.by - sg.ay) ** 2;
        it.t = Math.max(0, Math.min(1, ((w.x - sg.ax) * (sg.bx - sg.ax) + (w.y - sg.ay) * (sg.by - sg.ay)) / L2));
      } else if (it.kind === 'point') {
        const w = snap(w2s(o.x, o.y).x + dx, w2s(o.x, o.y).y + dy);
        it.x = w.x; it.y = w.y; it.free = false;
      } else if (it.kind === 'line') {
        it.x = o.x + ddx; it.y = o.y + ddy; it.x2 = o.x2 + ddx; it.y2 = o.y2 + ddy;
      } else if (it.kind === 'sketch') {
        it.pts = o.pts.map((q, i) => q + (i % 2 ? ddy : ddx));
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
let lastTap = 0;
function tap(p) {
  const now = Date.now();
  const dbl = now - lastTap < 320; lastTap = now;
  if (S.tool === 'walls') {
    const sg = pickSeg(p.x, p.y);
    if (!sg) { selectSeg(null); return; }
    if (S.session) { selectSeg(sg.key); return; }
    selectSeg(sg.key);
    ask(`Начинаем замер?\nКомната ${sg.room}, стена ${sg.wall} из ${sg.of}. Замеры с лазера будут записываться автоматически, стена за стеной, затем соседние комнаты.`, 'Да, начать').then((yes) => {
      if (!yes) return;
      S.session = true; S.settings.autoNext = true; S.sheetFull = false;
      refreshSheet(); draw();
      hint('Замер начат — меряйте лазером');
    });
    return;
  }
  if (S.tool === 'select') { select(null); return; }
  if (S.tool === 'open') {
    const sg = pickSeg(p.x, p.y);
    if (!sg) { hint('Нажмите точно на стену'); return; }
    const w = screenToWorld(p.x, p.y);
    const L2 = (sg.bx - sg.ax) ** 2 + (sg.by - sg.ay) ** 2;
    const t = Math.max(0, Math.min(1, ((w.x - sg.ax) * (sg.bx - sg.ax) + (w.y - sg.ay) * (sg.by - sg.ay)) / L2));
    pushUndo();
    const it = { id: uid(), kind: 'open', otype: S.openType, key: sg.key, t, w: Math.min(OPEN_W[S.openType], sg.len), block: S.block, floor: S.floor, t0: Date.now() };
    S.items.push(it); save();
    select(it.id);
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
    if (!S.draft) S.draft = { kind: 'sketch', pts: [] };
    const d = S.draft;
    if (dbl && d.pts.length >= 4) { finishSketch(); return; }
    // замыкание по первой точке
    if (d.pts.length >= 6) {
      const f = w2s(d.pts[0], d.pts[1]);
      if (Math.hypot(f.x - p.x, f.y - p.y) < 18) { finishSketch(true); return; }
    }
    d.pts.push(w.x, w.y);
    if (d.itemId) { const it = S.items.find((i) => i.id === d.itemId); if (it) { it.pts = d.pts.slice(); save(); } }
    hint('Направление + замер лазером. ■ — завершить линию, нажатие на первую точку — замкнуть');
  }
  updateDraftBar();
}
/** Эскиз стрелками: добавить отрезок в выбранном направлении и сразу сохранить */
function sketchAppend(meters, src) {
  const d = S.draft;
  const n = d.pts.length;
  const a = ((sketchLastDir() + REL[S.sketchRel || 's']) * Math.PI) / 180, L = meters / unitM();
  d.pts.push(d.pts[n - 2] + Math.cos(a) * L, d.pts[n - 1] + Math.sin(a) * L);
  d.lens = d.lens || []; d.lens.push(meters);
  let it = d.itemId && S.items.find((i) => i.id === d.itemId);
  if (!it) {
    pushUndo();
    it = { id: uid(), kind: 'sketch', pts: [], lens: [], block: S.block, floor: S.floor, t: Date.now() };
    S.items.push(it); d.itemId = it.id;
  }
  it.pts = d.pts.slice(); it.lens = d.lens.slice();
  save(); feedback();
  toast(`${fmt(meters)} м · ${{ l: 'налево', s: 'прямо', r: 'направо' }[S.sketchRel || 's']}`);
  draw();
}
function sketchUndo() {
  const d = S.draft;
  if (!d) return;
  d.pts.splice(-2); if (d.lens) d.lens.pop();
  const it = d.itemId && S.items.find((i) => i.id === d.itemId);
  if (it) { if (d.pts.length >= 4) { it.pts = d.pts.slice(); it.lens = (d.lens || []).slice(); } else { S.items = S.items.filter((i) => i !== it); d.itemId = null; } save(); }
  if (!d.pts.length) S.draft = null;
  updateDraftBar(); draw();
}
function draftFrom() {
  const d = S.draft;
  return d && d.pts.length >= 2 ? { x: d.pts[d.pts.length - 2], y: d.pts[d.pts.length - 1] } : null;
}
function finishSketch(closed = false) {
  const d = S.draft; S.draft = null;
  if (d && d.itemId) {
    const it = S.items.find((i) => i.id === d.itemId);
    if (it) { it.pts = d.pts.slice(); it.closed = closed; save(); select(it.id); }
  } else if (d && d.kind === 'sketch' && d.pts.length >= 4) {
    const it = addItem({ kind: 'sketch', pts: d.pts, closed });
    select(it.id);
  }
  updateDraftBar(); hint(''); draw();
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
  if (!S.selSeg) { $('shNav2').hidden = true; $('sheet').classList.remove('compact'); $('shSub').hidden = false; $('shDesignWrap').hidden = false; }
  if (S.selSeg) $('shOpen').hidden = true;
  if (S.selSeg && S.session && !S.sheetFull) { sh.hidden = true; syncMbar(); return; }
  if (S.selSeg) { sh.hidden = false; refreshSegSheet(); syncMbar(); return; }
  const it = S.items.find((i) => i.id === S.selId);
  if (!it) { sh.hidden = true; return; }
  sh.hidden = false;
  $('shActions').hidden = false; $('shNoteWrap').hidden = false;
  const isSk = it.kind === 'sketch' || it.kind === 'open';
  $('shOpen').hidden = it.kind !== 'open';
  if (it.kind === 'open') {
    $('shTitle').textContent = it.otype === 'window' ? 'Окно' : 'Дверь';
    $('shSub').textContent = `Блок ${it.block} · этаж ${it.floor} · комната ${segInfo(it)?.room ?? '?'} · схематично, без замера`;
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
        const fs = Lp > 40 ? 10 : Lp > 24 ? 8 : 7;
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
    c.strokeStyle = pal.dark ? '#fb923c' : '#ea580c'; c.lineWidth = 1.6; c.setLineDash([]);
    c.globalAlpha = 0.9;
    c.beginPath(); path(c, ab.pts, v); c.stroke(); c.globalAlpha = 1;
    for (const sp of ab.segPts) {
      if (!sp.has) continue;
      const it = m.get(sp.seg.key);
      if (it.merged) continue;
      const cl = it.copied ? null : devClass(it); const col = it.copied ? '#9aa3b2' : cl ? pal[cl] : pal.accent;
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
        const sz = L > 34 ? 11 : 9;
        labels.push(() => pill(c, (a.x + e.x) / 2 + nnx * (sz + 3), (a.y + e.y) / 2 + nny * (sz + 3), txt, col, '#fff', { rot, size: sz, shadow: false }));
      }
    }
    // невязка
    if (ab.gap != null && ab.gap >= 0.005) {
      const f = w2s(ab.gapFrom[0], ab.gapFrom[1], v), t = w2s(ab.gapTo[0], ab.gapTo[1], v);
      c.strokeStyle = pal.bad; c.lineWidth = 2.5; c.setLineDash([5, 4]);
      c.beginPath(); c.moveTo(f.x, f.y); c.lineTo(t.x, t.y); c.stroke(); c.setLineDash([]);
      for (const q of [f, t]) { c.beginPath(); c.arc(q.x, q.y, 3.5, 0, Math.PI * 2); c.fillStyle = pal.bad; c.fill(); }
      labels.push(() => pill(c, (f.x + t.x) / 2, (f.y + t.y) / 2 - 16, `невязка ${fmt(ab.gap)} м`, pal.bad, '#fff', { size: 11 }));
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
function openGeom(it, abCache) {
  const W = wallsOf(it.block);
  const sg = W.byKey.get(it.key);
  if (!sg) return null;
  let ax = sg.ax, ay = sg.ay, bx = sg.bx, by = sg.by;
  const room = W.rooms.find((r) => r.no === sg.room);
  const ck = it.block + '|' + it.floor + '|' + sg.room;
  let ab = abCache?.get(ck);
  if (ab === undefined) {
    const m = segMapFor(it.block, it.floor);
    ab = room.segs.some((q) => m.get(q.key)?.value != null) ? asBuilt(room, (q) => m.get(q.key), unitM()) : null;
    abCache?.set(ck, ab);
  }
  if (ab) { const sp = ab.segPts.find((q) => q.seg.key === sg.key); if (sp) { ax = sp.sx; ay = sp.sy; bx = sp.ex; by = sp.ey; } }
  const L = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / L, uy = (by - ay) / L;
  // нормаль внутрь: та же сторона, что у стены по чертежу
  const inx = -uy, iny = ux;
  const side = inx * sg.nx + iny * sg.ny >= 0 ? 1 : -1;
  const n = { x: inx * side, y: iny * side };
  const w = Math.min(it.w / unitM(), L);
  const c = Math.max(w / 2, Math.min(L - w / 2, it.t * L));
  const p0 = { x: ax + ux * (c - w / 2), y: ay + uy * (c - w / 2) };
  const p1 = { x: ax + ux * (c + w / 2), y: ay + uy * (c + w / 2) };
  const th = wallThickness(it.block, sg);
  return { p0, p1, n, th, w, sg, c: { x: ax + ux * c, y: ay + uy * c } };
}
/** Рисует условное обозначение. tr(x,y) → экранная точка; scale — px на единицу чертежа */
function drawOpeningSym(c, it, g, tr, scale, ink, paper, opts = {}) {
  const P0 = tr(g.p0.x, g.p0.y), P1 = tr(g.p1.x, g.p1.y);
  const Q0 = tr(g.p0.x - g.n.x * g.th, g.p0.y - g.n.y * g.th);
  const Q1 = tr(g.p1.x - g.n.x * g.th, g.p1.y - g.n.y * g.th);
  c.save();
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
  const p = S.draft?.pts;
  if (!p || p.length < 4) return 90; // первая линия: «прямо» = вверх по экрану
  const n = p.length;
  return (Math.atan2(p[n - 1] - p[n - 3], p[n - 2] - p[n - 4]) * 180) / Math.PI;
}
function onRel(r) {
  if (S.tool === 'sketch') {
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
function mbarMode() {
  if (S.tool === 'sketch') return 'sketch';
  if (S.tool === 'walls' && S.selSeg && S.session) return 'walls';
  return null;
}
function syncMbar() {
  const mode = mbarMode();
  const mb = $('mbar');
  mb.hidden = !mode;
  $('dpad').hidden = true;
  if (!mode) return;
  const isW = mode === 'walls';
  for (const id of ['mPrev', 'mNext', 'mMerge', 'mMore']) $(id).hidden = !isW;
  let on = null;
  if (isW) {
    const sg = wallsOf().byKey.get(S.selSeg);
    if (!sg) return;
    const it = segItem(S.selSeg);
    $('mTitle').textContent = `К${sg.room} · стена ${sg.wall}/${sg.of} · черт. ${fmt(sg.len)}` + (it?.copied ? ` · с ${it.copied.from} эт.` : '') + (it?.merged ? ' · поворот удалён' : '');
    $('mVal').textContent = it?.value != null && !it.merged ? fmt(it.value) + ' м' : '?';
    on = relOf(wallCurDir(sg) - wallBaseDir(sg));
  } else {
    const n = S.draft ? S.draft.pts.length / 2 : 0;
    $('mTitle').textContent = n ? `Линия · отрезков ${Math.max(0, n - 1)}` : 'Нажмите на план — начало линии';
    const l = S.draft?.lens?.length ? S.draft.lens[S.draft.lens.length - 1] : null;
    $('mVal').textContent = l != null ? fmt(l) + ' м' : '';
    on = S.sketchRel;
  }
  for (const b of $('mbar').querySelectorAll('[data-r]')) b.classList.toggle('on', b.dataset.r === on);
}
function bindMbar() {
  for (const b of $('mbar').querySelectorAll('[data-r]')) b.onclick = () => onRel(b.dataset.r);
  $('mUndo').onclick = () => (S.tool === 'sketch' && S.draft ? sketchUndo() : doUndo());
  $('mPrev').onclick = () => gotoSeg(-1);
  $('mNext').onclick = () => gotoSeg(1, true);
  $('mMerge').onclick = () => $('shMerge').click();
  $('mMore').onclick = () => { S.sheetFull = true; refreshSheet(); };
  $('mStop').onclick = () => {
    if (S.tool === 'sketch') { finishSketch(false); setTool('walls'); return; }
    S.session = false; S.sheetFull = false; hint('Замер остановлен'); refreshSheet(); draw();
  };
}
/* ---------- верхняя панель ---------- */
function renderBlocks() {
  const el = $('blocks');
  el.innerHTML = '';
  for (const b of S.plan.blocks) {
    const btn = document.createElement('button');
    btn.textContent = b.name;
    btn.className = b.name === S.block ? 'on' : '';
    btn.onclick = () => setBlock(b.name);
    el.appendChild(btn);
  }
}
function setBlock(name) {
  S.block = name; S.draft = null; S.selSeg = null; select(null);
  renderBlocks(); updateDraftBar(); save(); draw();
}
/** Копирует обмер (стены, уклоны, двери/окна, эскизы) с этажа from на этаж to, если там пусто */
function copyFloor(from, to) {
  if (from === to) return 0;
  let n = 0;
  const blocks = [...new Set(S.items.filter((i) => i.floor === from).map((i) => i.block))];
  for (const b of blocks) {
    if (S.items.some((i) => i.block === b && i.floor === to)) continue;
    const src = S.items.filter((i) => i.block === b && i.floor === from && (i.kind === 'seg' || i.kind === 'open' || i.kind === 'sketch'));
    for (const i of src) {
      const c = JSON.parse(JSON.stringify(i));
      c.id = uid(); c.floor = to; c.t = Date.now();
      if (c.kind === 'seg' && c.value != null) c.copied = { from };
      delete c.mt; delete c.src;
      S.items.push(c); n++;
    }
  }
  return n;
}
function setFloor(f, keepTo) {
  const from = S.floor;
  if (f !== from) {
    pushUndo();
    const n = copyFloor(from, f);
    if (n) toast(`Схема ${from} этажа скопирована на ${f} этаж — перемерьте стены, серые значения взяты с ${from} эт.`);
    else S.undo.pop();
    S.session = false;
  }
  S.floor = f;
  if (!keepTo) S.toFloor = S.dir === 'down' ? f - 1 : f + 1;
  $('floorNum').textContent = S.floor;
  $('toFloorNum').textContent = S.toFloor ?? '—';
  const keepSeg = S.selSeg; select(null); S.selSeg = keepSeg; refreshSheet(); save(); draw();
}
function setDir(d) {
  S.dir = d;
  for (const b of $('dirSeg').children) b.classList.toggle('on', b.dataset.dir === d);
  if ((d === 'down' && S.toFloor > S.floor) || (d === 'up' && S.toFloor < S.floor)) S.toFloor = d === 'down' ? S.floor - 1 : S.floor + 1;
  $('toFloorNum').textContent = S.toFloor;
  save();
}
function syncToolUI() {
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
  $('setSnap').checked = !!S.settings.snap;
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
  $('btnList').onclick = () => { pop.hidden = true; renderList(); $('listModal').hidden = false; };
  $('btnAreas').onclick = () => { pop.hidden = true; renderAreas(); $('areasModal').hidden = false; };
  $('btnShare').onclick = () => { pop.hidden = true; openShare(); };
  $('btnReport').onclick = () => { pop.hidden = true; shareKind('full', 'share'); };
  $('btnDocs').onclick = () => { pop.hidden = true; renderDocs(); $('docsModal').hidden = false; };
  for (const b of $('snaps').children) b.onclick = () => {
    const k = b.dataset.snap;
    if (k === 'ortho') S.settings.ortho = !S.settings.ortho;
    else { S.settings.snapModes[k] = !S.settings.snapModes[k]; if (S.settings.snapModes[k]) S.settings.snap = true; }
    syncSnapUI(); save();
  };
  $('btnFocus').onclick = () => setFocus(true);
  $('btnFocusExit').onclick = () => setFocus(false);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && focusMode && !/iPhone/.test(navigator.userAgent)) setFocus(false); });
  $('btnSnap').onclick = () => { S.settings.snap = !S.settings.snap; syncSnapUI(); save(); toast('Привязка ' + (S.settings.snap ? 'включена' : 'выключена')); };
  $('btnOrtho').onclick = () => { S.settings.ortho = !S.settings.ortho; syncSnapUI(); save(); toast('Орто ' + (S.settings.ortho ? 'включено' : 'выключено')); };
  syncToolUI(); syncSnapUI();
}
function setTool(t) {
  S.tool = t; S.draft = null; updateDraftBar(); if (t !== 'select') { S.selSeg = null; select(null); }
  syncToolUI();
  $('openBar').hidden = t !== 'open';
  S.sheetFull = false;
  if (t !== 'walls') S.session = false;
  if (t === 'walls' && !S.selSeg) gotoSeg(1, true, true);
  hint({
    walls: 'Нажмите на стену — начнём замер',
    open: 'Выберите «Дверь» или «Окно» и нажмите на стену',
    select: '',
    point: 'Нажмите на план, где стоите с лазером — появится точка замера',
    line: 'Укажите первую точку размера (привязка к углам)',
    sketch: 'Нажмите на план — начало линии. Дальше: направление + замер лазером',
  }[t]);
  draw();
}

/* ---------- сообщения ---------- */
function ask(text, okText = 'Да', danger = false) {
  return new Promise((res) => {
    const m = $('askModal');
    $('askText').textContent = text;
    const ok = $('askOk'), no = $('askNo');
    ok.textContent = okText; ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    no.hidden = okText === 'OK';
    m.hidden = false;
    const done = (v) => { m.hidden = true; ok.onclick = no.onclick = null; res(v); };
    ok.onclick = () => done(true); no.onclick = () => done(false);
  });
}
const notice = (text) => ask(text, 'OK');
let toastT;
let focusMode = false;
function setFocus(on) {
  focusMode = on;
  document.body.classList.toggle('focus', on);
  if (on) {
    $('toolsPop').hidden = true;
    if (S.tool !== 'walls') setTool('walls');
    S.session = true; S.sheetFull = false;
    if (!S.selSeg) gotoSeg(1, true, true);
    try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch (e) { /* iPhone не поддерживает — достаточно скрыть панели */ }
  } else {
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* */ }
  }
  refreshSheet();
  requestAnimationFrame(() => { resize(); if (S.selSeg) ensureVisible(wallsOf().byKey.get(S.selSeg)); draw(); });
}
function toast(s) {
  if (focusMode) return;
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
const fileBase = (floorTxt) => `Блок_${S.block}_${floorTxt}_${stamp()}`;

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
  const LY = {
    plan: w.layer('ПЛАН', 7), asb: w.layer('ПЛАН_ОБМЕР', 7), col: w.layer('ПЛАН_КОЛОННЫ', 7), src: w.layer('ИСХОДНЫЙ_ЧЕРТЕЖ', 8),
    open: w.layer('ПРОЁМЫ', 7), dim: w.layer('РАЗМЕРЫ', 7), dimg: w.layer('РАЗМЕРЫ_НЕ_ИЗМЕРЕНО', 8), room: w.layer('КОМНАТЫ', 7),
    gap: w.layer('НЕВЯЗКА', 1), stamp: w.layer('ШТАМП', 7),
  };
  const floors = allFloors ? floorsWithData() : [S.floor];
  if (!floors.length) floors.push(S.floor);
  const [bx0, by0, bx1, by1] = b.bbox.map((q) => q * k);
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
    w.text(LY.stamp, (fx0 + fx1) / 2, by1 + 900, 400, `ПОЭТАЖНЫЙ ПЛАН - блок ${S.block} - этаж ${fl}`, 0, 'center');
    if (S.settings.objName) w.text(LY.stamp, (fx0 + fx1) / 2, by1 + 400, 250, S.settings.objName, 0, 'center');
    // исходный чертёж (для сравнения, серым)
    for (const q of M.P.polys) w.poly(LY.src, XP(q.p), !!q.z);
    for (const q of M.contours) w.poly(q.column ? LY.col : q.asBuilt ? LY.asb : LY.plan, XP(q.p), q.closed);
    // проёмы
    const cache = new Map();
    for (const it of S.items.filter((i) => i.kind === 'open' && i.block === S.block && i.floor === fl)) {
      const g = openGeom(it, cache); if (!g) continue;
      for (const pl of openingPaths(it, g)) w.poly(LY.open, pl.flatMap((p) => [X(p.x), Y(p.y)]), false);
    }
    for (const it of S.items.filter((i) => i.kind === 'sketch' && i.block === S.block && i.floor === fl)) w.poly(LY.plan, XP(it.pts), !!it.closed);
    // размеры стен
    for (const d of M.dims) {
      const x1 = X(d.ax), y1 = Y(d.ay), x2 = X(d.bx), y2 = Y(d.by);
      const ang = rd(Math.atan2(y2 - y1, x2 - x1));
      w.text(d.measured && !d.copied ? LY.dim : LY.dimg, (x1 + x2) / 2 + d.nx * 170, (y1 + y2) / 2 + d.ny * 170, 140, fmt(d.val), (ang * 180) / Math.PI, 'center');
    }
    // комнаты: номер над чертой, площадь под чертой
    for (const r of M.rooms) {
      if (!r.closed) continue;
      const cx = X(r.cx), cy = Y(r.cy);
      w.text(LY.room, cx, cy + 160, 170, String(r.no), 0, 'center');
      w.line(LY.room, cx - 380, cy, cx + 380, cy);
      w.text(LY.room, cx, cy - 190, 190, fmt(r.area), 0, 'center');
      if (r.ab?.gap != null && r.ab.gap >= 0.005) {
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
  return wallsOf().rooms.map((room) => {
    const any = room.segs.some((s) => m.get(s.key)?.value != null);
    const ab = any ? asBuilt(room, (s) => m.get(s.key), unitM()) : null;
    return { room, ab, m };
  });
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
  P.polys.forEach((q, pi) => {
    const room = roomByPi.get(pi);
    const has = room && room.segs.some((s) => m.get(s.key)?.value != null);
    if (!has) { contours.push({ p: q.p, closed: !!q.z, column: q.column }); }
    if (!room) return;
    let ab = null;
    if (has) {
      ab = asBuilt(room, (s) => m.get(s.key), unitM());
      contours.push({ p: ab.pts, closed: ab.gap != null && ab.gap < 0.005, asBuilt: true });
    }
    for (const s of room.segs) {
      const it = m.get(s.key);
      let ax = s.ax, ay = s.ay, bx = s.bx, by = s.by;
      if (ab) { const sp = ab.segPts.find((q2) => q2.seg.key === s.key); ax = sp.sx; ay = sp.sy; bx = sp.ex; by = sp.ey; }
      const measured = it?.value != null;
      if (it?.merged) continue;
      dims.push({ ax, ay, bx, by, nx: s.nx, ny: s.ny, val: measured ? it.value : s.len, measured, copied: !!it?.copied });
    }
    rooms.push({ no: room.no, cx: room.cx, cy: room.cy, area: ab?.area ?? room.area, areaDesign: room.area, measured: !!ab, closed: room.closed, ab });
  });
  for (const it of S.items.filter((i) => i.kind === 'sketch' && i.block === block && i.floor === floor)) {
    for (let i = 0; i + 3 < it.pts.length; i += 2) {
      const ax = it.pts[i], ay = it.pts[i + 1], bx = it.pts[i + 2], by = it.pts[i + 3];
      const L = Math.hypot(bx - ax, by - ay);
      if (!L) continue;
      dims.push({ ax, ay, bx, by, nx: -(by - ay) / L, ny: (bx - ax) / L, val: L * unitM(), measured: true });
    }
  }
  return { b, P, contours, dims, rooms };
}
function renderPlanCanvas(floor, W, H) {
  const block = S.block;
  const M = floorModel(floor, block);
  if (!W) {
    // книжная ориентация для «высоких» блоков, альбомная — для широких
    const [x0, y0, x1, y1] = M.b.bbox;
    const tall = (y1 - y0) > (x1 - x0) * 0.85;
    W = tall ? 2480 : 3508; H = tall ? 3508 : 2480;
  }
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = PRINT.paper; x.fillRect(0, 0, W, H);
  const mg = 60;
  x.strokeStyle = PRINT.ink; x.lineWidth = 3; x.strokeRect(mg, mg, W - mg * 2, H - mg * 2);
  // заголовок
  x.fillStyle = PRINT.ink; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '700 54px "Times New Roman", Times, serif';
  x.fillText(`ПОЭТАЖНЫЙ ПЛАН · блок ${block} · этаж ${floor}`, W / 2, mg + 70);
  if (S.settings.objName) { x.font = '400 36px "Times New Roman", Times, serif'; x.fillText(S.settings.objName, W / 2, mg + 128); }
  // поле чертежа
  const top = mg + 170, bottom = 300;
  const v = fitView(M.b, W, H - top - bottom, 140);
  v.oy += top;
  const tr = (px, py) => ({ x: px * v.s + v.ox, y: -py * v.s + v.oy });
  const um = unitM();
  // контуры
  x.lineJoin = 'miter'; x.lineCap = 'square';
  for (const q of M.contours) {
    x.beginPath();
    for (let i = 0; i < q.p.length; i += 2) { const t = tr(q.p[i], q.p[i + 1]); i ? x.lineTo(t.x, t.y) : x.moveTo(t.x, t.y); }
    if (q.closed) x.closePath();
    x.strokeStyle = PRINT.ink; x.lineWidth = q.column ? 2 : 2.6; x.stroke();
    if (q.column) {
      // штриховка колонны
      x.save(); x.clip(); x.lineWidth = 1;
      const bb = q.p.reduce((a, val, i) => (i % 2 ? [a[0], Math.min(a[1], val), a[2], Math.max(a[3], val)] : [Math.min(a[0], val), a[1], Math.max(a[2], val), a[3]]), [Infinity, Infinity, -Infinity, -Infinity]);
      const p0 = tr(bb[0], bb[3]), p1 = tr(bb[2], bb[1]);
      for (let k = p0.x - (p1.y - p0.y); k < p1.x; k += 8) { x.beginPath(); x.moveTo(k, p1.y); x.lineTo(k + (p1.y - p0.y), p0.y); x.stroke(); }
      x.restore();
    }
  }
  // двери и окна
  const cache = new Map();
  for (const it of S.items.filter((i) => i.kind === 'open' && i.block === block && i.floor === floor)) {
    const g = openGeom(it, cache);
    if (g) drawOpeningSym(x, it, g, tr, v.s, PRINT.ink, PRINT.paper, { lw: 2.2 });
  }
  // эскизы
  for (const it of S.items.filter((i) => i.kind === 'sketch' && i.block === block && i.floor === floor)) {
    x.beginPath(); for (let i = 0; i < it.pts.length; i += 2) { const t = tr(it.pts[i], it.pts[i + 1]); i ? x.lineTo(t.x, t.y) : x.moveTo(t.x, t.y); }
    if (it.closed) x.closePath(); x.strokeStyle = PRINT.ink; x.lineWidth = 2.2; x.stroke();
  }
  // размеры стен — внутри комнаты вдоль стены
  const fsBase = Math.max(15, Math.min(30, 0.2 / um * v.s));
  x.textAlign = 'center'; x.textBaseline = 'middle';
  for (const d of M.dims) {
    const a = tr(d.ax, d.ay), e = tr(d.bx, d.by);
    const L = Math.hypot(e.x - a.x, e.y - a.y);
    const txt = fmt(d.val);
    let fs = fsBase;
    x.font = `400 ${fs}px Arial, sans-serif`;
    while (fs > 11 && x.measureText(txt).width > L * 0.95) { fs -= 1; x.font = `400 ${fs}px Arial, sans-serif`; }
    let rot = Math.atan2(e.y - a.y, e.x - a.x);
    if (rot > Math.PI / 2) rot -= Math.PI; if (rot < -Math.PI / 2) rot += Math.PI;
    const nx = d.nx, ny = -d.ny; // внутрь, экранные
    x.save(); x.translate((a.x + e.x) / 2 + nx * fs * 0.85, (a.y + e.y) / 2 + ny * fs * 0.85); x.rotate(rot);
    x.fillStyle = d.measured && !d.copied ? PRINT.ink : PRINT.grey;
    x.fillText(txt, 0, 0);
    x.restore();
  }
  // номер комнаты над чертой, площадь под чертой
  for (const r of M.rooms) {
    if (!r.closed) continue;
    const p = tr(r.cx, r.cy);
    const fsN = Math.max(18, Math.min(30, fsBase * 1.05)), fsA = Math.max(20, Math.min(34, fsBase * 1.2));
    x.fillStyle = r.measured ? PRINT.ink : PRINT.grey;
    x.font = `400 ${fsN}px Arial, sans-serif`; x.fillText(String(r.no), p.x, p.y - fsN * 0.75);
    const txt = fmt(r.area);
    x.font = `400 ${fsA}px Arial, sans-serif`;
    const tw = x.measureText(txt).width;
    x.fillText(txt, p.x, p.y + fsA * 0.7);
    x.strokeStyle = x.fillStyle; x.lineWidth = 1.6; x.beginPath(); x.moveTo(p.x - tw / 2 - 4, p.y); x.lineTo(p.x + tw / 2 + 4, p.y); x.stroke();
  }
  // штамп
  const sy = H - mg - bottom + 60, sx = mg + 120;
  x.textAlign = 'left'; x.fillStyle = PRINT.ink;
  const sumA = M.rooms.filter((r) => r.closed).reduce((t, r) => t + r.area, 0);
  x.font = '400 34px "Times New Roman", Times, serif';
  x.fillText(`Общая площадь помещений: ${fmt(sumA)} м²`, sx, sy);
  x.fillText(`Түзүлгөн датасы / Дата составления:   ${todayRu()} г.`, sx, sy + 70);
  const lineX = sx + 760;
  x.fillText('Планды түзгөн / План составил:', sx, sy + 150);
  x.lineWidth = 2; x.beginPath(); x.moveTo(lineX, sy + 170); x.lineTo(lineX + 520, sy + 170); x.stroke();
  // подпись и ФИО — от руки на распечатке
  x.beginPath(); x.moveTo(lineX + 580, sy + 170); x.lineTo(lineX + 1100, sy + 170); x.stroke();
  x.textAlign = 'right'; x.fillStyle = PRINT.grey; x.font = '400 24px Arial, sans-serif';
  x.fillText('Размеры и площади — в метрах. Серым — не измерено (по чертежу) или скопировано с другого этажа.', W - mg - 30, H - mg - 30);
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
  const pal = PAL_PRINT();
  const plan = renderPlanCanvas(floor);
  const pages = [{ canvas: plan, landscape: plan.width > plan.height }];
  const rows = roomRows(floor);
  const colGap = (g) => (g == null ? '—' : { t: fmt(g), c: pal[gapClass(g)] });
  let sD = 0, sM = 0, sDm = 0;
  const arows = rows.map(({ room, ab }) => {
    if (room.closed) sD += room.area;
    if (ab?.area) { sM += ab.area; sDm += room.area; }
    const dS = ab?.area != null && room.closed ? ab.area - room.area : null;
    return [{ t: 'К' + room.no, b: true }, ab ? `${ab.measured}/${ab.total}` : `0/${room.segs.length}`,
      room.closed ? fmt(room.area) : '—', ab?.area != null ? { t: fmt(ab.area) + (ab.measured < ab.total ? ' *' : ''), b: true } : '—',
      dS == null ? '—' : fmtSigned(dS), colGap(ab?.gap)];
  });
  arows.push([{ t: 'Итого', b: true }, '', { t: fmt(sD), b: true }, { t: fmt(sM), b: true }, { t: sM ? fmtSigned(sM - sDm) : '—', b: true }, '']);
  pages.push(...tablePages(`Площади комнат · блок ${S.block} · этаж ${floor}`, `Площади в м², невязка — на сколько не сходятся углы обмерного контура, м · ${new Date().toLocaleDateString('ru-RU')}`,
    [{ h: 'Комната', w: 0.14 }, { h: 'Стен изм.', w: 0.14, a: 'r' }, { h: 'S черт., м²', w: 0.18, a: 'r' }, { h: 'S обмер, м²', w: 0.18, a: 'r' }, { h: 'ΔS, м²', w: 0.16, a: 'r' }, { h: 'Невязка, м', w: 0.2, a: 'r' }],
    arows, '* — не все стены измерены, для неизмеренных взята длина по чертежу'));
  const wrows = [];
  for (const { room, m } of rows) {
    for (const s of room.segs) {
      const it = m.get(s.key);
      if (!it || (it.value == null && !it.ang)) continue;
      const d = it.value != null ? it.value - (it.design ?? s.len) : null;
      const cl = it.value != null ? devClass(it) : null;
      wrows.push([`К${room.no} · ${s.wall}`, fmt(it.design ?? s.len), { t: it.value == null ? '—' : fmt(it.value), b: true },
        d == null ? '—' : { t: fmtSigned(d), c: cl ? pal[cl] : null }, it.ang ? it.ang.toFixed(1).replace('.', ',') : '', it.note || '']);
    }
  }
  if (wrows.length) pages.push(...tablePages(`Ведомость стен · блок ${S.block} · этаж ${floor}`, 'Длины в метрах; уклон — отклонение направления стены от чертежа, градусы',
    [{ h: 'Стена', w: 0.16 }, { h: 'По черт., м', w: 0.16, a: 'r' }, { h: 'Замер, м', w: 0.16, a: 'r' }, { h: 'Δ, м', w: 0.14, a: 'r' }, { h: 'Уклон, °', w: 0.12, a: 'r' }, { h: 'Примечание', w: 0.26 }], wrows));
  return pages;
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
      files.push({ name: `Блок_${b.name}_все_этажи_мм.dxf`, blob: buildDxf(true) });
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
  busy(true, 'Готовлю файл…');
  await new Promise((r) => setTimeout(r, 30));
  let name, blob;
  try {
    if (kind === 'pdf') { blob = buildPdf(false); name = fileBase('этаж_' + S.floor) + '.pdf'; }
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
let shareMode = 'share';
function openShare() {
  $('shareScope').textContent = `Блок ${S.block} · этаж ${S.floor}`;
  $('shareModal').hidden = false;
}
function renderAreas() {
  const pal = palette();
  const rows = roomRows(S.floor);
  $('areasScope').textContent = `Блок ${S.block} · этаж ${S.floor}. Нажмите на строку — откроется комната.`;
  let sD = 0, sM = 0;
  const body = rows.map(({ room, ab }) => {
    if (room.closed) sD += room.area;
    if (ab?.area) sM += ab.area;
    const dS = ab?.area != null && room.closed ? ab.area - room.area : null;
    const gc = gapClass(ab?.gap);
    return `<tr class="clk" data-room="${room.no}"><td><b>К${room.no}</b></td><td class="num">${ab ? ab.measured : 0}/${room.segs.length}</td>` +
      `<td class="num">${room.closed ? fmt(room.area) : '—'}</td><td class="num">${ab?.area != null ? fmt(ab.area) + (ab.measured < ab.total ? '*' : '') : '—'}</td>` +
      `<td class="num">${dS == null ? '—' : fmtSigned(dS)}</td><td class="num" style="color:${gc ? pal[gc] : 'inherit'}">${ab?.gap != null ? fmt(ab.gap) : '—'}</td></tr>`;
  }).join('');
  $('areasTable').innerHTML = '<tr><th>Комната</th><th style="text-align:right">Стен</th><th style="text-align:right">S черт., м²</th><th style="text-align:right">S обмер, м²</th><th style="text-align:right">ΔS</th><th style="text-align:right">Невязка, м</th></tr>' + body;
  const sDm = rows.reduce((t, r) => t + (r.ab?.area ? r.room.area : 0), 0);
  $('areasStats').textContent = `Итого по чертежу ${fmt(sD)} м². Обмерено комнат на ${fmt(sDm)} м² по чертежу → ${fmt(sM)} м² по обмеру${sM ? ` (${fmtSigned(sM - sDm)})` : ''}. * — не все стены измерены.`;
  for (const tr of $('areasTable').querySelectorAll('tr.clk')) tr.onclick = () => {
    const room = wallsOf().rooms.find((r) => r.no === +tr.dataset.room);
    $('areasModal').hidden = true;
    if (S.tool !== 'walls') setTool('walls');
    selectSeg(room.segs[0].key);
  };
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
    setPlan(plan);
    await DB.set('plan', stripPrep(plan));
    toast(`План загружен: блоков ${plan.blocks.length} (${plan.blocks.map((b) => b.name).join(', ')})`);
    $('menuModal').hidden = true;
  } catch (e) {
    console.error(e);
    notice('Не удалось открыть файл: ' + (e.message || e));
  } finally { busy(false); }
}
function stripPrep(plan) { return { ...plan, blocks: plan.blocks.map(({ _prep, ...b }) => b) }; }
function setPlan(plan) {
  S.plan = plan; S.views = {};
  if (!plan.blocks.find((b) => b.name === S.block)) S.block = plan.blocks[0].name;
  renderBlocks(); renderPlanInfo(); draw();
}
function renderPlanInfo() {
  $('planInfo').textContent = `«${S.plan.name}» · блоков: ${S.plan.blocks.length} · единицы чертежа: ${{ mm: 'мм', cm: 'см', m: 'м' }[S.plan.unit]}`;
  const el = $('blockNames');
  el.innerHTML = '<p class="muted small">Названия блоков (можно переименовать):</p>';
  S.plan.blocks.forEach((b) => {
    const row = document.createElement('div'); row.className = 'bn';
    const inp = document.createElement('input'); inp.value = b.name;
    inp.onchange = async () => {
      const nn = inp.value.trim(); if (!nn || S.plan.blocks.some((o) => o !== b && o.name === nn)) { inp.value = b.name; return; }
      for (const i of S.items) if (i.block === b.name) i.block = nn;
      if (S.block === b.name) S.block = nn;
      b.name = nn; renderBlocks(); save(); await DB.set('plan', stripPrep(S.plan)); draw();
    };
    const n = S.items.filter((i) => i.block === b.name && i.kind !== 'sketch').length;
    row.append(inp, Object.assign(document.createElement('span'), { className: 'muted small', textContent: `замеров: ${n}` }));
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
function bindEntry() {
  const inp = $('entry');
  $('entryForm').onsubmit = (e) => {
    e.preventDefault();
    const n = parseNum(inp.value);
    if (n == null || n <= 0) { toast('Введите число, например 2,85'); return; }
    inp.value = '';
    onMeasure(Math.round(n * 10000) / 10000, 'manual');
  };
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
    if (e.key === 'Escape' && focusMode) { setFocus(false); return; }
    if (e.key === 'Escape') { S.draft = null; updateDraftBar(); S.selSeg = null; select(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selId) { removeItem(S.selId); }
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) doUndo();
    else if (e.key === 'F3') { e.preventDefault(); $('btnSnap').click(); }
    else if (e.key === 'F8') { e.preventDefault(); $('btnOrtho').click(); }
  });
}

/* ---------- меню ---------- */
function bindMenu() {
  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
  }
  $('btnMenu').onclick = () => { renderPlanInfo(); $('menuModal').hidden = false; };
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
  $('areasPdf').onclick = () => shareKind('pdf', 'share');
  $('areasPdfSave').onclick = () => shareKind('pdf', 'save');
  $('filePlan').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadPlanFile(f); };
  $('btnDefaultPlan').onclick = async () => {
    if (!(await ask('Вернуть встроенный план (блоки А, Б, В, Г)? Замеры сохранятся.', 'Вернуть'))) return;
    setPlan(JSON.parse(JSON.stringify(DEFAULT_PLAN))); await DB.set('plan', null); $('menuModal').hidden = true;
  };
  for (const [id, key] of [['setObj', 'objName']]) {
    $(id).value = S.settings[key] || '';
    $(id).oninput = (e) => { S.settings[key] = e.target.value.trim(); save(); };
  }
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
  $('toFloorChip').onclick = $('floorVal').onclick = () => {
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
  if (settings) Object.assign(S.settings, settings);
  if (session) Object.assign(S, { block: session.block, floor: session.floor ?? 16, dir: session.dir || 'down', toFloor: session.toFloor ?? 15 });
  S.plan = plan?.blocks?.length ? plan : JSON.parse(JSON.stringify(DEFAULT_PLAN));
  if (!S.plan.blocks.find((b) => b.name === S.block)) S.block = S.plan.blocks[0].name;

  applyTheme();
  renderBlocks();
  $('floorNum').textContent = S.floor;
  $('toFloorNum').textContent = S.toFloor ?? '—';
  setDir(S.dir);
  $('floorDown').onclick = () => setFloor(S.floor - 1);
  $('floorUp').onclick = () => setFloor(S.floor + 1);
  for (const b of $('dirSeg').children) b.onclick = () => setDir(b.dataset.dir);
  $('btnUndo').onclick = doUndo;
  $('btnFit').onclick = () => { S.views[S.block] = fitView(blk()); draw(); };
  $('draftDone').onclick = () => finishSketch(false);
  $('draftUndo').onclick = () => sketchUndo();
  $('draftCancel').onclick = () => { S.draft = null; updateDraftBar(); hint(''); draw(); };
  bindSheet(); bindEntry(); bindMenu(); bindTools(); bindMbar();
  $('distoHelp').textContent = 'Лазерный дальномер подключается к телефону по Bluetooth как клавиатура. Нажмите кнопку измерения на приборе — число само запишется в выбранную стену. Русская раскладка тоже подходит: «ю» читается как запятая.';
  new ResizeObserver(resize).observe(cv);
  resize();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // подсказка: на весь экран — только с иконки «На экран Домой»
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let tipSeen = false; try { tipSeen = localStorage.getItem('tipHome') === '1'; } catch (e) { /* */ }
  if (!standalone && /iPhone|iPad|Android/i.test(navigator.userAgent) && !tipSeen) {
    $('homeTip').hidden = false;
    $('homeTipClose').onclick = () => { $('homeTip').hidden = true; try { localStorage.setItem('tipHome', '1'); } catch (e) { /* */ } };
  }
  window.__app = { S, onMeasure, draw }; // для отладки
}
init();
