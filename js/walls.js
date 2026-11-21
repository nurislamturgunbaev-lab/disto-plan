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
    // обход каждой комнаты — против часовой стрелки (как видно на плане);
    // ключ стены остаётся прежним (по исходному номеру отрезка), чтобы старые замеры не потерялись
    const reverse = closed && A < 0;
    const side = closed ? 1 : 1;
    let segs = [];
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n;
      let ax = v[i * 2], ay = v[i * 2 + 1], bx = v[j * 2], by = v[j * 2 + 1];
      if (reverse) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
      const L = Math.hypot(bx - ax, by - ay);
      if (L < minLen) continue;
      segs.push({
        key: pi + ':' + i, pi, ax, ay, bx, by,
        len: L * unitM,
        nx: (-(by - ay) / L) * side, ny: ((bx - ax) / L) * side, // нормаль внутрь комнаты (слева при обходе против часовой)
        rev: reverse,
      });
    }
    if (reverse) segs.reverse();
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

/**
 * Обмерный контур комнаты: стены откладываются по порядку с измеренной длиной
 * и направлением по чертежу + уклон (it.ang, градусы, + против часовой).
 * Неизмеренные стены берутся по чертежу. Если контур не замыкается — возвращается невязка.
 * getIt(seg) -> {value (м), ang} | undefined
 */
export function asBuilt(room, getIt, unitM) {
  const segs = room.segs;
  const pts = [];
  let x = segs[0].ax, y = segs[0].ay;
  pts.push(x, y);
  const segPts = [];
  let measured = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i > 0) {
      const p = segs[i - 1];
      const dx = s.ax - p.bx, dy = s.ay - p.by;
      if (Math.abs(dx) + Math.abs(dy) > 1e-9) { x += dx; y += dy; pts.push(x, y); }
    }
    const it = getIt(s);
    const has = it && it.value != null;
    if (has) measured++;
    const L = has ? it.value / unitM : Math.hypot(s.bx - s.ax, s.by - s.ay);
    const a = Math.atan2(s.by - s.ay, s.bx - s.ax) + ((it?.ang || 0) * Math.PI) / 180;
    const sx = x, sy = y;
    x += L * Math.cos(a); y += L * Math.sin(a);
    pts.push(x, y);
    segPts.push({ seg: s, sx, sy, ex: x, ey: y, has });
  }
  let gap = null, gapFrom = null;
  if (room.closed) {
    const last = segs[segs.length - 1];
    const dx = segs[0].ax - last.bx, dy = segs[0].ay - last.by;
    if (Math.abs(dx) + Math.abs(dy) > 1e-9) { x += dx; y += dy; pts.push(x, y); }
    gapFrom = [x, y];
    gap = Math.hypot(pts[0] - x, pts[1] - y) * unitM;
  }
  let A = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    A += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return {
    pts, segPts, gap, gapFrom, gapTo: [pts[0], pts[1]],
    area: room.closed ? (Math.abs(A) / 2) * unitM * unitM : null,
    measured, total: segs.length,
  };
}
