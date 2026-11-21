// Стены: разбивка контуров комнат на отрезки, нумерация комнат и стен.

const SIN_TOL = Math.sin((0.6 * Math.PI) / 180);

/** Убирает дубли и точки на одной прямой; возвращает вершины [x,y,...] без повтора первой */
function simplify(p, closed, eps) {
  const v = [];
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    const n = v.length;
    if (n && Math.hypot(x - v[n - 2], y - v[n - 1]) < eps) continue;
    v.push(x, y);
  }
  if (closed && v.length >= 4 && Math.hypot(v[0] - v[v.length - 2], v[1] - v[v.length - 1]) < eps) v.splice(-2);
  let changed = true;
  while (changed && v.length >= 6) {
    changed = false;
    const n = v.length / 2;
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const a = ((i - 1 + n) % n) * 2, b = i * 2, c = ((i + 1) % n) * 2;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], wx = v[c] - v[b], wy = v[c + 1] - v[b + 1];
      const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
      if (!lu || !lw) { v.splice(b, 2); changed = true; break; }
      const cross = (ux * wy - uy * wx) / (lu * lw), dot = ux * wx + uy * wy;
      if (Math.abs(cross) < SIN_TOL && dot > 0) { v.splice(b, 2); changed = true; break; }
    }
  }
  return v;
}

/**
 * polys — подготовленные контуры блока ({p, z, column}); unitM — метров в единице чертежа.
 * Возвращает { rooms:[{no, pi, cx, cy, segs:[...]}], segs:[...], byKey:Map }
 */
export function buildWalls(polys, unitM, opts = {}) {
  const minLen = (opts.minLen ?? 0.15) / unitM;
  const eps = 0.002 / unitM;
  const rooms = [];
  polys.forEach((q, pi) => {
    if (q.column && !opts.columns) return;
    const closed = !!q.z;
    const v = simplify(q.p, closed, eps);
    const n = v.length / 2;
    if (n < 2) return;
    // площадь со знаком: >0 — против часовой, внутренняя сторона слева
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const f = v[i * 2] * v[j * 2 + 1] - v[j * 2] * v[i * 2 + 1];
      A += f; cx += (v[i * 2] + v[j * 2]) * f; cy += (v[i * 2 + 1] + v[j * 2 + 1]) * f;
    }
    A /= 2;
    if (closed && Math.abs(A) > 1e-9) { cx /= 6 * A; cy /= 6 * A; }
    else { cx = 0; cy = 0; for (let i = 0; i < n; i++) { cx += v[i * 2]; cy += v[i * 2 + 1]; } cx /= n; cy /= n; }
    const side = closed ? (A >= 0 ? 1 : -1) : 1;
    const segs = [];
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n;
      const ax = v[i * 2], ay = v[i * 2 + 1], bx = v[j * 2], by = v[j * 2 + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < minLen) continue;
      segs.push({
        key: pi + ':' + i, pi, ax, ay, bx, by,
        len: L * unitM,
        nx: (-(by - ay) / L) * side, ny: ((bx - ax) / L) * side, // нормаль внутрь комнаты
      });
    }
    const total = segs.reduce((t, s) => t + s.len, 0);
    if (!closed && total < 1) return; // обрывки линий
    if (segs.length) rooms.push({ pi, cx, cy, area: Math.abs(A) * unitM * unitM, closed, segs });
  });
  // нумерация: сверху вниз, слева направо (полосами)
  const band = (opts.bandH ?? 4) / unitM; // полоса ~4 м
  rooms.sort((a, b) => {
    const ba = Math.floor(-a.cy / band), bb = Math.floor(-b.cy / band);
    return ba - bb || a.cx - b.cx;
  });
  const all = [];
  const byKey = new Map();
  rooms.forEach((r, ri) => {
    r.no = ri + 1;
    // начинаем обход с верхней левой стены
    let start = 0, best = Infinity;
    r.segs.forEach((s, k) => { const t = s.ax - s.ay * 4; if (t < best) { best = t; start = k; } });
    r.segs = r.segs.slice(start).concat(r.segs.slice(0, start));
    r.segs.forEach((s, k) => { s.room = r.no; s.wall = k + 1; s.of = r.segs.length; all.push(s); byKey.set(s.key, s); });
  });
  return { rooms, segs: all, byKey };
}
