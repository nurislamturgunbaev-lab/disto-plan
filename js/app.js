import DEFAULT_PLAN from './default-plan.js';
import { Disto } from './disto.js';
import { DxfWriter } from './dxf.js';
import { buildWalls } from './walls.js';

const VERSION = '1.1.0';
const $ = (id) => document.getElementById(id);
const BASE = new URL('../', import.meta.url).href;

/* ---------- форматирование: метры, 2 знака, запятая ---------- */
const fmt = (m) => (m == null || !isFinite(m) ? '—' : m.toFixed(2).replace('.', ','));
const fmtSigned = (m) => (m > 0 ? '+' : m < 0 ? '−' : '±') + Math.abs(m).toFixed(2).replace('.', ',');
function parseNum(s) {
  if (s == null) return null;
  const m = String(s).replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
const UNIT_M = { mm: 0.001, cm: 0.01, m: 1 };
const UNIT_MM = { mm: 1, cm: 10, m: 1000 };

/* ---------- хранилище (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('disto-plan', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  get(k) {
    return new Promise((res) => {
      const t = this.db.transaction('kv').objectStore('kv').get(k);
      t.onsuccess = () => res(t.result);
      t.onerror = () => res(undefined);
    });
  },
  set(k, v) {
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
  items: [],
  selId: null,
  armedId: null,
  draft: null, // {kind:'line'|'sketch', pts:[]}
  settings: { floorH: 0, theme: 'light', otherFloors: false, snap: true, beep: true, autoNext: true, wallMin: 0.15, wallColumns: false, wallLabels: true },
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
  $('lastSrc').textContent = src === 'manual' ? 'вручную' : 'DISTO';
  lb.classList.remove('flash'); void lb.offsetWidth; lb.classList.add('flash');

  let target = null;
  const sel = S.items.find((i) => i.id === S.selId);
  if (S.armedId) target = S.items.find((i) => i.id === S.armedId);
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
  if (it.value == null || it.design == null) return null;
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
  drawItems(ctx, v, pal, visibleItems().filter((i) => i.kind !== 'seg'));
  // черновик
  if (S.draft) {
    const d = S.draft;
    ctx.strokeStyle = pal.accent2; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]);
    ctx.beginPath(); path(ctx, d.pts.concat(d.hover ? [d.hover.x, d.hover.y] : []), v); ctx.stroke(); ctx.setLineDash([]);
    for (let i = 0; i < d.pts.length; i += 2) handle(ctx, w2s(d.pts[i], d.pts[i + 1], v), pal);
    if (d.kind === 'line' && d.hover && d.pts.length === 2) {
      const L = Math.hypot(d.hover.x - d.pts[0], d.hover.y - d.pts[1]) * unitM();
      const a = w2s(d.hover.x, d.hover.y, v);
      pill(ctx, a.x, a.y - 26, fmt(L) + ' м', pal.accent2, '#fff');
    }
  }
  if (snapMark) {
    const p = w2s(snapMark.x, snapMark.y, v);
    ctx.strokeStyle = pal.accent2; ctx.lineWidth = 2; ctx.strokeRect(p.x - 7, p.y - 7, 14, 14);
  }
  // масштабная линейка
  scaleBar(ctx, v, pal);
  if (S.selSeg || curItems().some((i) => i.value == null && i.kind === 'point')) requestDraw();
  updateProgress();
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

/* ---------- привязка и попадание ---------- */
function snap(sx, sy) {
  const w = screenToWorld(sx, sy);
  snapMark = null;
  if (!S.settings.snap) return w;
  const P = prepBlock(blk());
  const r = 14 / V().s;
  let best = null, bd = r * r;
  const vs = P.verts;
  for (let i = 0; i < vs.length; i += 2) {
    const dx = vs[i] - w.x, dy = vs[i + 1] - w.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = { x: vs[i], y: vs[i + 1] }; }
  }
  if (best) { snapMark = best; return best; }
  return w;
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function hit(sx, sy) {
  const v = V();
  const items = curItems().filter((i) => i.kind !== 'seg').reverse();
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
  if (S.draft && ptrs.size === 0) { S.draft.hover = snap(p.x, p.y); requestDraw(); return; }
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
  if (!gesture.moved) { gesture.moved = true; if (gesture.type === 'drag') pushUndo(); }
  if (gesture.type === 'pan') {
    const v = V(); v.ox = gesture.v.ox + dx; v.oy = gesture.v.oy + dy;
    if (S.draft) S.draft.hover = snap(p.x, p.y);
    requestDraw();
  } else if (gesture.type === 'drag') {
    const { it, part } = gesture.h, o = gesture.orig, s = V().s;
    const ddx = dx / s, ddy = -dy / s;
    if (part === 'body') {
      if (it.kind === 'point') {
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
      const w = snap(sp.x + dx, sp.y + dy);
      if (part === 'a') { it.x = w.x; it.y = w.y; } else { it.x2 = w.x; it.y2 = w.y; }
      autoDesign(it);
    } else if (typeof part === 'number') {
      const sp = w2s(o.pts[part], o.pts[part + 1]);
      const w = snap(sp.x + dx, sp.y + dy);
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
  if (S.tool === 'walls') { const sg = pickSeg(p.x, p.y); selectSeg(sg ? sg.key : null); return; }
  if (S.tool === 'select') { select(null); return; }
  const w = snap(p.x, p.y);
  if (S.tool === 'point') {
    const it = addItem({ kind: 'point', x: w.x, y: w.y });
    select(it.id);
    hint('Точка №' + it.no + ' ждёт замер — нажмите кнопку на DISTO или введите значение');
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
    hint('Ставьте точки линии. «Готово» — завершить, нажатие на первую точку — замкнуть');
  }
  updateDraftBar();
}
function finishSketch(closed = false) {
  const d = S.draft; S.draft = null;
  if (d && d.kind === 'sketch' && d.pts.length >= 4) {
    const it = addItem({ kind: 'sketch', pts: d.pts, closed });
    select(it.id);
  }
  updateDraftBar(); hint(''); draw();
}
function updateDraftBar() {
  $('draftbar').hidden = !(S.draft && S.draft.kind === 'sketch');
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
  if (S.selSeg) { sh.hidden = false; refreshSegSheet(); return; }
  const it = S.items.find((i) => i.id === S.selId);
  if (!it) { sh.hidden = true; return; }
  sh.hidden = false;
  $('shActions').hidden = false; $('shNoteWrap').hidden = false;
  const isSk = it.kind === 'sketch';
  $('shTitle').textContent = isSk ? 'Линия эскиза' : `${it.kind === 'line' ? 'Размер' : 'Точка'} №${it.no}`;
  $('shSub').textContent = isSk
    ? `Блок ${it.block} · этаж ${it.floor} · ${it.pts.length / 2} точек`
    : `Блок ${it.block} · ${it.kind === 'point' ? `с ${it.floor} эт. ${it.dir === 'up' ? 'вверх' : 'вниз'}${it.toFloor != null ? ' до ' + it.toFloor + ' эт.' : ''}` : 'этаж ' + it.floor}` +
      (it.mt ? ' · ' + new Date(it.mt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '') +
      (it.src === 'manual' ? ' · вручную' : it.src ? ' · DISTO' : '');
  for (const el of sh.querySelectorAll('.grid2, #shDev, #shRemeasure')) el.hidden = isSk;
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
  rb.textContent = S.armedId === it.id ? '◎ Ждёт замер с DISTO…' : '◎ Перемерить';
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
    const n = parseNum(v); it.value = v.trim() === '' ? null : n; if (n != null) { it.src = 'manual'; it.mt = Date.now(); }
  }));
  $('shValue').addEventListener('keydown', (e) => {
    // Enter в поле стены — записать и перейти к следующей
    if (e.key === 'Enter' && S.selSeg && S.settings.autoNext && parseNum(e.target.value) != null) { e.preventDefault(); e.target.blur(); gotoSeg(1, true); }
  });
  $('shPrev').onclick = () => gotoSeg(-1);
  $('shClear').onclick = () => { const it = segItem(S.selSeg); if (it) { removeItem(it.id); toast('Замер стены очищен'); } };
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
  $('shClose').onclick = () => { S.selSeg = null; select(null); };
  $('shDelete').onclick = () => {
    if (S.selSeg) { const it = segItem(S.selSeg); if (it) { removeItem(it.id); refreshSheet(); toast('Замер стены очищен'); } return; }
    const it = cur(); if (it) { removeItem(it.id); toast('Удалено. «Отменить» — вернуть'); }
  };
  $('shRemeasure').onclick = () => {
    const it = cur(); if (!it) return;
    S.armedId = S.armedId === it.id ? null : it.id;
    refreshSheet();
    if (S.armedId) hint('Нажмите кнопку на DISTO — значение запишется в №' + it.no);
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
function segInfo(it) { return wallsOf(it.block).byKey.get(it.key); }
function segLabel(it) { const sg = segInfo(it); return sg ? `К${sg.room}·${sg.wall}` : `К${it.room ?? '?'}·${it.wall ?? '?'}`; }
function floorSegMap() {
  const m = new Map();
  for (const i of S.items) if (i.kind === 'seg' && i.block === S.block && i.floor === S.floor) m.set(i.key, i);
  return m;
}
function firstOpenSeg() {
  const m = floorSegMap();
  const sg = wallsOf().segs.find((s) => m.get(s.key)?.value == null);
  return sg ? sg.key : null;
}
function recordSeg(key, meters, src) {
  pushUndo();
  const it = segItem(key, true);
  it.value = meters; it.src = src; it.mt = Date.now();
  if (!it.designManual) it.design = segInfo(it)?.len ?? it.design;
  const sg = segInfo(it);
  const d = it.design != null ? ` (${fmtSigned(meters - it.design)})` : '';
  toast(`Комната ${sg?.room} · стена ${sg?.wall}: ${fmt(meters)} м${d}`);
  feedback();
  save();
  if (S.settings.autoNext) gotoSeg(1, true);
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
  const segs = wallsOf().segs;
  if (!segs.length) return;
  const m = floorSegMap();
  const N = segs.length;
  let idx = segs.findIndex((s) => s.key === S.selSeg);
  const prevRoom = idx >= 0 ? segs[idx].room : null;
  if (idx < 0) idx = dir > 0 ? -1 : 0;
  for (let k = 1; k <= N; k++) {
    const s = segs[(((idx + dir * k) % N) + N) % N];
    if (onlyOpen && m.get(s.key)?.value != null) continue;
    if (prevRoom != null && s.room !== prevRoom && !silent) {
      const done = segs.filter((q) => q.room === prevRoom).every((q) => m.get(q.key)?.value != null);
      hint(done ? `Комната ${prevRoom} обмерена ✓ Переход в комнату ${s.room}` : `Комната ${s.room}`);
    }
    selectSeg(s.key);
    return;
  }
  if (!silent) { toast('Все стены блока ' + S.block + ' на этаже ' + S.floor + ' измерены ✓'); refreshSheet(); draw(); }
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
function drawWalls(c, b, v, pal, opts = {}) {
  const W = prepBlock(b).walls;
  const m = new Map();
  for (const i of S.items) if (i.kind === 'seg' && i.block === b.name && i.floor === S.floor) m.set(i.key, i);
  const showMode = S.tool === 'walls' || opts.export;
  if (!showMode && !m.size) return;
  const now = performance.now();
  c.save();
  c.lineCap = 'round';
  // номера комнат
  if (showMode) {
    for (const r of W.rooms) {
      const p = w2s(r.cx, r.cy, v);
      const done = r.segs.every((s) => m.get(s.key)?.value != null);
      const any = r.segs.some((s) => m.get(s.key)?.value != null);
      c.beginPath(); c.arc(p.x, p.y, 11, 0, Math.PI * 2);
      c.fillStyle = done ? pal.ok : any ? pal.warn : (pal.dark ? '#22304a' : '#e3e7ee');
      c.fill();
      c.fillStyle = done || any ? '#fff' : pal.ink2;
      c.font = '800 11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(r.no), p.x, p.y + 0.5);
    }
  }
  const lab = [];
  for (const s of W.segs) {
    const it = m.get(s.key);
    const active = !opts.export && s.key === S.selSeg;
    const has = it && it.value != null;
    if (!has && !active && !showMode) continue;
    const a = w2s(s.ax, s.ay, v), e = w2s(s.bx, s.by, v);
    const L = Math.hypot(e.x - a.x, e.y - a.y);
    const nx = s.nx, ny = -s.ny; // нормаль внутрь в экранных координатах
    const off = 3;
    const ax = a.x + nx * off, ay = a.y + ny * off, ex = e.x + nx * off, ey = e.y + ny * off;
    let col = null;
    if (has) { const cl = devClass(it); col = cl ? pal[cl] : pal.accent; }
    if (active) {
      const k = (now % 1200) / 1200;
      c.strokeStyle = pal.accent2; c.globalAlpha = 0.25 + 0.25 * Math.sin(k * Math.PI * 2);
      c.lineWidth = 14; c.beginPath(); c.moveTo(ax, ay); c.lineTo(ex, ey); c.stroke();
      c.globalAlpha = 1; c.lineWidth = 5; c.strokeStyle = pal.accent2;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(ex, ey); c.stroke();
      // засечки на концах — откуда и докуда мерить
      for (const [px, py] of [[ax, ay], [ex, ey]]) {
        c.beginPath(); c.moveTo(px + nx * 12, py + ny * 12); c.lineTo(px - nx * 4, py - ny * 4); c.lineWidth = 3; c.stroke();
      }
    } else if (has) {
      c.strokeStyle = col; c.lineWidth = 3.5;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(ex, ey); c.stroke();
    }
    // подпись
    let rot = Math.atan2(e.y - a.y, e.x - a.x);
    if (rot > Math.PI / 2) rot -= Math.PI; if (rot < -Math.PI / 2) rot += Math.PI;
    const mx = (a.x + e.x) / 2 + nx * 15, my = (a.y + e.y) / 2 + ny * 15;
    if (active) lab.push(() => {
      const t = has ? fmt(it.value) : '?';
      pill(c, mx + nx * 4, my + ny * 4, `${t}  · черт. ${fmt(it?.design ?? s.len)}`, pal.accent2, '#fff', { rot, size: 12 });
    });
    else if (has && (L > 34 || opts.export)) lab.push(() => pill(c, mx, my, fmt(it.value), col, '#fff', { rot, size: 11, shadow: false }));
    else if (!has && showMode && S.settings.wallLabels && !opts.export && L > 46) {
      c.save(); c.translate(mx, my); c.rotate(rot);
      c.font = '600 10px system-ui, sans-serif'; c.fillStyle = pal.ink2; c.globalAlpha = 0.8;
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(fmt(s.len), 0, 0); c.restore();
    }
  }
  for (const f of lab) f();
  c.restore();
}
function refreshSegSheet() {
  const sg = wallsOf().byKey.get(S.selSeg);
  if (!sg) { S.selSeg = null; $('sheet').hidden = true; return; }
  const it = segItem(S.selSeg);
  $('shTitle').textContent = `Комната ${sg.room} · стена ${sg.wall} из ${sg.of}`;
  $('shSub').textContent = `Блок ${S.block} · этаж ${S.floor} · по чертежу ${fmt(sg.len)} м` +
    (it?.mt ? ' · ' + new Date(it.mt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (it.src === 'manual' ? ' · вручную' : ' · DISTO') : '');
  for (const el of document.querySelectorAll('#sheet .grid2, #shDev')) el.hidden = false;
  $('shFloorRow').hidden = true;
  $('shActions').hidden = true;
  $('shNoteWrap').hidden = !it?.note;
  $('shClear').hidden = !(it && it.value != null);
  const set = (el, val) => { if (document.activeElement !== el) el.value = val; };
  set($('shValue'), it?.value == null ? '' : fmt(it.value));
  set($('shDesign'), fmt(it?.design ?? sg.len));
  set($('shNote'), it?.note || '');
  const dv = $('shDev');
  const cls = it ? devClass(it) : null;
  dv.className = 'dev ' + (cls || '');
  dv.textContent = cls ? `Отклонение ${fmtSigned(it.value - it.design)} м от чертежа` : 'Измерьте DISTO или введите значение';
  if (!cls) dv.className = 'dev';
}
function updateProgress() {
  const el = $('prog');
  if (!el) return;
  const segs = wallsOf().segs;
  if (!segs.length) { el.hidden = true; return; }
  const m = floorSegMap();
  const done = segs.filter((s) => m.get(s.key)?.value != null).length;
  const rooms = wallsOf().rooms;
  const rdone = rooms.filter((r) => r.segs.every((s) => m.get(s.key)?.value != null)).length;
  el.hidden = false;
  el.innerHTML = `<b>${done}</b>/${segs.length} стен · <b>${rdone}</b>/${rooms.length} комн.<i style="width:${(done / segs.length) * 100}%"></i>`;
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
function setFloor(f, keepTo) {
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
function setTool(t) {
  S.tool = t; S.draft = null; updateDraftBar(); if (t !== 'select') { S.selSeg = null; select(null); }
  for (const b of $('tools').querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  if (t === 'walls' && !S.selSeg) gotoSeg(1, true, true);
  hint({
    walls: 'Нажмите на стену или меряйте по порядку: замер DISTO запишется в синюю стену',
    select: '',
    point: 'Нажмите на план, где стоите с DISTO — появится точка замера',
    line: 'Укажите первую точку размера (привязка к углам)',
    sketch: 'Чертите: нажимайте точки линии',
  }[t]);
  draw();
}

/* ---------- сообщения ---------- */
let toastT;
function toast(s) {
  const t = $('toast'); t.textContent = s; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}
let hintT;
function hint(s) {
  $('hint').textContent = s || '';
  clearTimeout(hintT); if (s) hintT = setTimeout(() => ($('hint').textContent = ''), 6000);
}
function busy(on, text) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; }

/* ---------- журнал ---------- */
let listScope = 'floor';
function listItems() {
  return S.items
    .filter((i) => i.kind !== 'sketch')
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
async function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportCsv() {
  const rows = listItems();
  const head = ['Блок', 'Этаж', '№', 'Тип', 'Направление', 'До этажа', 'Замер, м', 'Проект, м', 'Отклонение, м', 'Источник', 'Дата', 'Примечание'];
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(';')];
  for (const i of rows) {
    const d = i.value != null && i.design != null ? i.value - i.design : null;
    const pt = i.kind === 'point';
    lines.push([i.block, i.floor, itemNo(i), i.kind === 'seg' ? 'стена' : i.kind === 'line' ? 'размер' : 'точка', pt ? (i.dir === 'up' ? 'вверх' : 'вниз') : '',
      pt ? i.toFloor ?? '' : '', i.value == null ? '' : fmt(i.value), i.design == null ? '' : fmt(i.design),
      d == null ? '' : fmt(d), i.src === 'manual' ? 'вручную' : i.src ? 'DISTO' : '', i.mt ? new Date(i.mt).toLocaleString('ru-RU') : '', i.note || ''].map(q).join(';'));
  }
  download(`Замеры_${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
}
function exportDxf(allFloors) {
  const b = blk();
  const k = UNIT_MM[S.plan.unit] || 1; // в мм
  const X = (x) => x * k;
  const w = new DxfWriter();
  const L_PLAN = w.layer('ПЛАН', 7), L_COL = w.layer('ПЛАН_КОЛОННЫ', 1);
  const P = prepBlock(b);
  for (const q of P.polys) w.poly(q.column ? L_COL : L_PLAN, q.p.map(X), !!q.z);
  for (const t of b.texts || []) w.text(L_PLAN, X(t.x), X(t.y), X(t.h), t.t);
  const items = S.items.filter((i) => i.block === S.block && (allFloors || i.floor === S.floor));
  const R = 150, H = 250; // мм
  const LR = w.layer('КОМНАТЫ', 8);
  for (const r of prepBlock(b).walls.rooms) w.text(LR, X(r.cx), X(r.cy), 200, 'К' + r.no, 0, 'center');
  for (const i of items) {
    const sfx = allFloors ? '_ЭТ' + i.floor : '';
    if (i.kind === 'seg') {
      const sg = segInfo(i);
      if (!sg || i.value == null) continue;
      const x1 = X(sg.ax), y1 = X(sg.ay), x2 = X(sg.bx), y2 = X(sg.by);
      let ang = Math.atan2(y2 - y1, x2 - x1);
      if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      w.text(w.layer('ОБМЕРЫ' + sfx, 3), mx + sg.nx * 220, my + sg.ny * 220, 150, fmt(i.value), ang * 180 / Math.PI, 'center');
      if (i.design != null && Math.abs(i.value - i.design) >= 0.005)
        w.text(w.layer('ОБМЕРЫ_ОТКЛ' + sfx, 1), mx + sg.nx * 420, my + sg.ny * 420, 100, `${fmtSigned(i.value - i.design).replace('−', '-')} (черт. ${fmt(i.design)})`, ang * 180 / Math.PI, 'center');
    } else if (i.kind === 'sketch') {
      w.poly(w.layer('ЭСКИЗ' + sfx, 30), i.pts.map(X), !!i.closed);
    } else if (i.kind === 'line') {
      const ly = w.layer('РАЗМЕРЫ' + sfx, 4);
      const x1 = X(i.x), y1 = X(i.y), x2 = X(i.x2), y2 = X(i.y2);
      w.line(ly, x1, y1, x2, y2);
      let ang = Math.atan2(y2 - y1, x2 - x1);
      if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      const nx = -Math.sin(ang), ny = Math.cos(ang);
      const tk = 120;
      for (const [x, y] of [[x1, y1], [x2, y2]]) w.line(ly, x - tk * Math.cos(ang + Math.PI / 4), y - tk * Math.sin(ang + Math.PI / 4), x + tk * Math.cos(ang + Math.PI / 4), y + tk * Math.sin(ang + Math.PI / 4));
      w.text(ly, (x1 + x2) / 2 + nx * H * 0.8, (y1 + y2) / 2 + ny * H * 0.8, H, i.value == null ? `№${i.no} ?` : fmt(i.value), ang * 180 / Math.PI, 'center');
    } else {
      const ly = w.layer('ЗАМЕРЫ' + sfx, 6);
      const x = X(i.x), y = X(i.y);
      w.circle(ly, x, y, R);
      w.line(ly, x, y - R * 0.7, x, y + R * 0.7);
      w.text(ly, x + R * 1.5, y + H * 0.3, H, `№${i.no} ${i.value == null ? '—' : fmt(i.value) + ' м'}`);
      w.text(ly, x + R * 1.5, y - H * 1.1, H * 0.6, `эт.${i.floor} ${i.dir === 'up' ? 'вверх' : 'вниз'}${i.toFloor != null ? ' до ' + i.toFloor : ''}${i.design != null ? ' · проект ' + fmt(i.design) : ''}${i.note ? ' · ' + i.note : ''}`);
    }
  }
  download(`Блок_${S.block}_${allFloors ? 'все_этажи' : 'этаж_' + S.floor}_${stamp()}.dxf`, new Blob([w.toBytes()]), 'application/dxf');
}
function exportPng() {
  const b = blk();
  const W = 2400, Hh = 1700, head = 150;
  const c = document.createElement('canvas'); c.width = W; c.height = Hh + head;
  const x = c.getContext('2d');
  const pal = { ...palette(), paper: '#ffffff', ink: '#1b2333', ink2: '#5b6476', card: '#ffffff', dark: false };
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#14213d'; x.fillRect(0, 0, W, head);
  x.fillStyle = '#fff'; x.font = '800 56px system-ui, sans-serif'; x.textBaseline = 'middle';
  x.fillText(`Блок ${S.block} · этаж ${S.floor}`, 50, 62);
  x.font = '500 30px system-ui, sans-serif'; x.fillStyle = '#cfd8ea';
  const segsN = prepBlock(b).walls.segs.length;
  const segDone = curItems().filter((i) => i.kind === 'seg' && i.value != null).length;
  x.fillText(`Обмерный план · стен измерено: ${segDone} из ${segsN} · ${new Date().toLocaleString('ru-RU')} · значения в метрах`, 50, 116);
  x.fillStyle = '#ff5a1f'; x.fillRect(0, head - 6, W, 6);
  x.save(); x.translate(0, head);
  const v = fitView(b, W, Hh, 120);
  // крупнее для печати
  const sc = 1.8;
  x.scale(sc, sc);
  const v2 = { s: v.s / sc, ox: v.ox / sc, oy: v.oy / sc };
  drawPlan(x, b, v2, pal, { noGrid: true, dpr: sc });
  drawWalls(x, b, v2, pal, { export: true });
  drawItems(x, v2, pal, curItems().filter((i) => i.kind !== 'seg'), { export: true });
  x.restore();
  c.toBlob((blob) => download(`Блок_${S.block}_этаж_${S.floor}_${stamp()}.png`, blob, 'image/png'), 'image/png');
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
    alert('Не удалось открыть файл: ' + (e.message || e));
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
  $('distoHelp').innerHTML = Disto.supported()
    ? 'Включите Bluetooth на DISTO (кнопка Bluetooth), затем нажмите «DISTO» вверху и выберите прибор. Каждое измерение (кнопка ON/DIST на приборе) автоматически записывается в выбранную или ожидающую точку. Если точки нет — создаётся новая.'
    : (ios ? 'Safari на iPhone не поддерживает Bluetooth для сайтов. Откройте приложение в браузере <b>Bluefy</b> (бесплатный, App Store) — там DISTO подключается напрямую. ' : 'Этот браузер не поддерживает Web Bluetooth — используйте Chrome на Android. ') +
      'Либо включите на DISTO режим клавиатуры (Bluetooth HID): значения будут вводиться в поле ввода внизу автоматически.';
  btn.onclick = async () => {
    if (disto.state === 'on') {
      if (confirm('Отключить ' + (disto.device?.name || 'DISTO') + '?')) disto.disconnect();
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
  // DISTO в режиме клавиатуры «печатает» цифры и Enter — перехватываем, даже если поле не в фокусе
  document.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
    if (/^[0-9.,]$/.test(e.key)) { inp.focus(); }
    else if (e.key === 'Escape') { S.draft = null; updateDraftBar(); S.selSeg = null; select(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selId) { removeItem(S.selId); }
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) doUndo();
  });
}

/* ---------- меню ---------- */
function bindMenu() {
  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
  }
  $('btnMenu').onclick = () => { renderPlanInfo(); $('menuModal').hidden = false; };
  $('btnList').onclick = () => { renderList(); $('listModal').hidden = false; };
  for (const b of $('listScope').children) b.onclick = () => {
    listScope = b.dataset.scope;
    for (const o of $('listScope').children) o.classList.toggle('on', o === b);
    renderList();
  };
  $('expCsv').onclick = exportCsv;
  $('expDxf').onclick = () => exportDxf(false);
  $('expDxfAll').onclick = () => exportDxf(true);
  $('expPng').onclick = exportPng;
  $('filePlan').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadPlanFile(f); };
  $('btnDefaultPlan').onclick = async () => {
    if (!confirm('Вернуть встроенный план (блоки А, Б, В, Г)? Замеры сохранятся.')) return;
    setPlan(structuredClone(DEFAULT_PLAN)); await DB.set('plan', null); $('menuModal').hidden = true;
  };
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
    $(id).onchange = (e) => { S.settings[key] = e.target.checked; if (key === 'wallColumns') resetPrep(); save(); draw(); };
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
      if (!confirm(`Восстановить ${d.items.length} замеров? Текущие будут заменены.`)) return;
      pushUndo(); S.items = d.items; if (d.settings) Object.assign(S.settings, d.settings);
      if (d.plan?.blocks) { setPlan(d.plan); await DB.set('plan', d.plan); }
      save(); draw(); toast('Восстановлено'); $('menuModal').hidden = true;
    } catch (err) { alert('Файл не подходит: ' + err.message); }
  };
  $('btnClear').onclick = () => {
    if (!confirm('Удалить ВСЕ замеры во всех блоках? (можно отменить кнопкой «Отменить»)')) return;
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
  S.plan = plan?.blocks?.length ? plan : structuredClone(DEFAULT_PLAN);
  if (!S.plan.blocks.find((b) => b.name === S.block)) S.block = S.plan.blocks[0].name;

  applyTheme();
  renderBlocks();
  $('floorNum').textContent = S.floor;
  $('toFloorNum').textContent = S.toFloor ?? '—';
  setDir(S.dir);
  $('floorDown').onclick = () => setFloor(S.floor - 1);
  $('floorUp').onclick = () => setFloor(S.floor + 1);
  for (const b of $('dirSeg').children) b.onclick = () => setDir(b.dataset.dir);
  for (const b of $('tools').querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('btnUndo').onclick = doUndo;
  $('btnFit').onclick = () => { S.views[S.block] = fitView(blk()); draw(); };
  $('draftDone').onclick = () => finishSketch(false);
  $('draftUndo').onclick = () => { if (S.draft) { S.draft.pts.splice(-2); draw(); } };
  $('draftCancel').onclick = () => { S.draft = null; updateDraftBar(); hint(''); draw(); };
  bindSheet(); bindEntry(); bindMenu(); bindDisto();
  for (const b of $('tools').querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === S.tool);
  new ResizeObserver(resize).observe(cv);
  resize();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__app = { S, onMeasure, draw }; // для отладки
}
init();
