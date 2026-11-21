// Чтение DWG/DXF (через libredwg-web) и разбивка чертежа на блоки.
// Формат плана:
// { name, unit:'cm'|'mm'|'m', blocks:[{id,name,bbox:[x0,y0,x1,y1],polys:[{p:[x,y,...],c:aci,z:closed}],texts:[{t,x,y,h}]}] }

const TAU = Math.PI * 2;

function angRad(a) {
  // libredwg отдаёт радианы; на всякий случай поддерживаем градусы
  return Math.abs(a) > TAU + 0.01 ? (a * Math.PI) / 180 : a;
}

function arcPts(cx, cy, r, a0, a1, out) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  const n = Math.max(4, Math.ceil((sweep / TAU) * 48));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

function bulgeSeg(x1, y1, x2, y2, b, out) {
  // добавляет промежуточные точки дуги между (x1,y1) и (x2,y2), без конечной точки
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (!chord) return;
  const theta = 4 * Math.atan(b);
  const r = chord / (2 * Math.sin(theta / 2));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const h = r * Math.cos(theta / 2);
  const nx = -dy / chord, ny = dx / chord;
  const cx = mx + nx * h, cy = my + ny * h;
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(3, Math.ceil(Math.abs(theta) / (Math.PI / 16)));
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    out.push(cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a));
  }
}

function polyFromVerts(verts, closed) {
  const p = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    p.push(v.x, v.y);
    const b = v.bulge || 0;
    if (b && (i < n - 1 || closed)) {
      const w = verts[(i + 1) % n];
      bulgeSeg(v.x, v.y, w.x, w.y, b, p);
    }
  }
  if (closed && n > 1) p.push(verts[0].x, verts[0].y);
  return p;
}

function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\~/g, ' ')
    .trim();
}

// Матрица 2D: [a,b,c,d,e,f] -> x' = a*x + c*y + e, y' = b*x + d*y + f
const I = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function tp(m, p) {
  const out = new Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    out[i] = m[0] * p[i] + m[2] * p[i + 1] + m[4];
    out[i + 1] = m[1] * p[i] + m[3] * p[i + 1] + m[5];
  }
  return out;
}
function scaleOf(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** Достаёт примитивы из DwgDatabase (libredwg-web convert()) */
export function extractGeometry(db) {
  const polys = [];
  const texts = [];
  const blocks = {};
  for (const br of db.tables?.BLOCK_RECORD?.entries || []) blocks[br.name] = br;
  const layers = {};
  for (const l of db.tables?.LAYER?.entries || []) layers[l.name] = l;

  const colorOf = (e, parentColor) => {
    let c = e.colorIndex;
    if (c === 0) c = parentColor ?? 7; // BYBLOCK
    if (c == null || c === 256) c = layers[e.layer]?.colorIndex ?? 7; // BYLAYER
    return Math.abs(c) || 7;
  };
  const layerOff = (e) => {
    const l = layers[e.layer];
    return l && (l.off || l.frozen || (l.colorIndex != null && l.colorIndex < 0));
  };

  function walk(ents, m, depth, parentColor) {
    for (const e of ents || []) {
      if (e.isVisible === false) continue;
      if (layerOff(e)) continue;
      const c = colorOf(e, parentColor);
      switch (e.type) {
        case 'LINE':
          polys.push({ p: tp(m, [e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y]), c });
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE2D':
        case 'POLYLINE3D': {
          const closed = !!(e.flag & 1) || !!(e.flag & 512);
          const v = (e.vertices || []).map((q) => ({ x: q.x ?? q.point?.x, y: q.y ?? q.point?.y, bulge: q.bulge || 0 }));
          if (v.length < 2) break;
          polys.push({ p: tp(m, polyFromVerts(v, closed)), c, z: closed ? 1 : 0 });
          break;
        }
        case 'ARC': {
          const p = arcPts(e.center.x, e.center.y, e.radius, angRad(e.startAngle), angRad(e.endAngle), []);
          polys.push({ p: tp(m, p), c });
          break;
        }
        case 'CIRCLE': {
          const p = arcPts(e.center.x, e.center.y, e.radius, 0, TAU, []);
          polys.push({ p: tp(m, p), c, z: 1 });
          break;
        }
        case 'ELLIPSE': {
          const cx = e.center.x, cy = e.center.y;
          const ax = e.majorAxisEndPoint.x, ay = e.majorAxisEndPoint.y;
          const a = Math.hypot(ax, ay), b = a * e.axisRatio, rot = Math.atan2(ay, ax);
          let s = e.startAngle || 0, en = e.endAngle || TAU;
          let sweep = en - s; while (sweep <= 0) sweep += TAU;
          const p = [];
          for (let i = 0; i <= 48; i++) {
            const t = s + (sweep * i) / 48;
            const x = a * Math.cos(t), y = b * Math.sin(t);
            p.push(cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot));
          }
          polys.push({ p: tp(m, p), c });
          break;
        }
        case 'TEXT':
        case 'MTEXT':
        case 'ATTRIB': {
          const t = cleanText(e.text);
          if (!t) break;
          const pt = e.insertionPoint || e.startPoint;
          if (!pt) break;
          const q = tp(m, [pt.x, pt.y]);
          texts.push({ t, x: q[0], y: q[1], h: (e.textHeight || 100) * scaleOf(m) });
          break;
        }
        case 'INSERT': {
          if (depth > 4) break;
          const br = blocks[e.name];
          if (!br) break;
          const bp = br.basePoint || { x: 0, y: 0 };
          const r = angRad(e.rotation || 0);
          const sx = e.xScale || 1, sy = e.yScale || 1;
          const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
          for (let ci = 0; ci < cols; ci++)
            for (let ri = 0; ri < rows; ri++) {
              const ox = ci * (e.columnSpacing || 0), oy = ri * (e.rowSpacing || 0);
              let t = [1, 0, 0, 1, -bp.x, -bp.y];
              t = mul([sx, 0, 0, sy, 0, 0], t);
              t = mul([1, 0, 0, 1, ox, oy], t);
              t = mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0], t);
              t = mul([1, 0, 0, 1, e.insertionPoint.x, e.insertionPoint.y], t);
              walk(br.entities, mul(m, t), depth + 1, c);
            }
          for (const a of e.attribs || []) walk([a], m, depth + 1, c);
          break;
        }
        default:
          break;
      }
    }
  }
  walk(db.entities, I, 0);
  // единицы: INSUNITS 1=дюйм 4=мм 5=см 6=м. Многие чертежи в см помечены как мм — определим по масштабу.
  return { polys, texts, insunits: db.header?.INSUNITS };
}

function bboxOf(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function bboxDist(a, b) {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

/** Определяет единицы чертежа по типичному размеру элементов */
export function guessUnit(polys, insunits) {
  const sizes = polys
    .filter((q) => q.z)
    .map((q) => { const b = bboxOf(q.p); return Math.max(b[2] - b[0], b[3] - b[1]); })
    .sort((a, b) => a - b);
  const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  // комната/квартира обычно 2..15 м
  if (med) {
    if (med > 1500) return 'mm';
    if (med > 150) return 'cm';
    return 'm';
  }
  return { 4: 'mm', 5: 'cm', 6: 'm' }[insunits] || 'mm';
}

/** Разбивает геометрию на блоки (кластеры) и подписывает их по ближайшим коротким надписям */
export function splitBlocks(geom) {
  const { polys, texts } = geom;
  const items = polys.filter((q) => q.p.length >= 4).map((q) => ({ q, b: bboxOf(q.p) }));
  if (!items.length) return [];
  let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
  for (const it of items) {
    X0 = Math.min(X0, it.b[0]); Y0 = Math.min(Y0, it.b[1]);
    X1 = Math.max(X1, it.b[2]); Y1 = Math.max(Y1, it.b[3]);
  }
  const diag = Math.hypot(X1 - X0, Y1 - Y0);
  const tol = diag * 0.015;

  // union-find по пересечению расширенных bbox (сетка для скорости)
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = Math.max(tol * 4, diag / 60);
  const grid = new Map();
  items.forEach((it, i) => {
    const gx0 = Math.floor((it.b[0] - tol) / cell), gx1 = Math.floor((it.b[2] + tol) / cell);
    const gy0 = Math.floor((it.b[1] - tol) / cell), gy1 = Math.floor((it.b[3] + tol) / cell);
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = gx + ',' + gy;
        const arr = grid.get(k);
        if (arr) {
          for (const j of arr) if (find(i) !== find(j) && bboxDist(it.b, items[j].b) <= tol) parent[find(i)] = find(j);
          arr.push(i);
        } else grid.set(k, [i]);
      }
  });
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { items: [], b: [Infinity, Infinity, -Infinity, -Infinity] });
    const g = groups.get(r);
    g.items.push(it);
    g.b = [Math.min(g.b[0], it.b[0]), Math.min(g.b[1], it.b[1]), Math.max(g.b[2], it.b[2]), Math.max(g.b[3], it.b[3])];
  });
  let gs = [...groups.values()];
  // мелкие группы присоединяем к ближайшей крупной
  const sizeOf = (g) => Math.hypot(g.b[2] - g.b[0], g.b[3] - g.b[1]);
  const big = gs.filter((g) => sizeOf(g) > diag * 0.12 && g.items.length >= 5);
  const main = big.length ? big : [gs.sort((a, b) => sizeOf(b) - sizeOf(a))[0]];
  for (const g of gs) {
    if (main.includes(g)) continue;
    let best = main[0], bd = Infinity;
    for (const m of main) { const d = bboxDist(g.b, m.b); if (d < bd) { bd = d; best = m; } }
    best.items.push(...g.items);
    best.b = [Math.min(best.b[0], g.b[0]), Math.min(best.b[1], g.b[1]), Math.max(best.b[2], g.b[2]), Math.max(best.b[3], g.b[3])];
  }
  gs = main;
  // сортировка: сверху вниз, слева направо
  gs.sort((a, b) => (Math.abs(a.b[3] - b.b[3]) > diag * 0.2 ? b.b[3] - a.b[3] : a.b[0] - b.b[0]));

  // надписи: короткие (1-3 символа) и крупные — кандидаты в имена блоков
  const blocks = gs.map((g, i) => ({ id: 'b' + (i + 1), name: '', bbox: g.b, polys: g.items.map((it) => it.q), texts: [] }));
  const maxH = Math.max(0, ...texts.map((t) => t.h));
  for (const t of texts) {
    let best = blocks[0], bd = Infinity;
    for (const bl of blocks) {
      const d = bboxDist([t.x, t.y, t.x, t.y], bl.bbox);
      if (d < bd) { bd = d; best = bl; }
    }
    const isLabel = t.t.length <= 4 && t.h >= maxH * 0.6 && bd > 0;
    if (isLabel && !best.name) best.name = t.t;
    else if (!isLabel && bd < tol * 3) best.texts.push(t);
  }
  blocks.forEach((bl, i) => { if (!bl.name) bl.name = String(i + 1); });
  // имена блоков по алфавиту
  blocks.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return blocks;
}

function round(p) { return p.map((v) => Math.round(v * 10) / 10); }

export function buildPlan(db, name) {
  const geom = extractGeometry(db);
  const unit = guessUnit(geom.polys, geom.insunits);
  const blocks = splitBlocks(geom).map((b) => ({
    ...b,
    polys: b.polys.map((q) => ({ p: round(q.p), c: q.c, ...(q.z ? { z: 1 } : {}) })),
    bbox: round(b.bbox),
  }));
  return { name: name || 'План', unit, blocks };
}

let libPromise = null;
/** Загружает libredwg-web (WASM, ~8 МБ) только при первом открытии DWG/DXF */
export async function loadLib(base) {
  if (!libPromise) {
    libPromise = (async () => {
      const mod = await import(base + 'lib/libredwg/dist/libredwg-web.js');
      const lib = await mod.LibreDwg.create(base + 'lib/libredwg/wasm');
      return { lib, Dwg_File_Type: mod.Dwg_File_Type };
    })();
  }
  return libPromise;
}

export async function parseCadFile(arrayBuffer, fileName, base = './') {
  const { lib, Dwg_File_Type } = await loadLib(base);
  const isDxf = /\.dxf$/i.test(fileName);
  const dwg = lib.dwg_read_data(arrayBuffer, isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG);
  if (!dwg) throw new Error('Не удалось прочитать файл');
  const db = lib.convert(dwg);
  try { lib.dwg_free(dwg); } catch (e) { /* ignore */ }
  return buildPlan(db, fileName.replace(/\.(dwg|dxf)$/i, ''));
}
