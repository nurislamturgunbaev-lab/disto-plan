// Экспорт в DXF (AutoCAD R12, ASCII). Все координаты — в миллиметрах.

// Текст пишется в кодировке Windows-1251 ($DWGCODEPAGE ANSI_1251) — так кириллицу читают все версии AutoCAD.
const SUB = { '−': '-', '—': '-', '–': '-', '↓': 'v', '↑': '^', '·': '.' };
function enc(s) { return String(s).replace(/[−—–↓↑·]/g, (c) => SUB[c]); }
function cp1251(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out[i] = c;
    else if (c >= 0x410 && c <= 0x44f) out[i] = c - 0x350;
    else if (c === 0x401) out[i] = 0xa8;
    else if (c === 0x451) out[i] = 0xb8;
    else if (c === 0x2116) out[i] = 0xb9; // №
    else if (c === 0xb0) out[i] = 0xb0; // °
    else out[i] = 0x3f; // ?
  }
  return out;
}

export class DxfWriter {
  constructor() {
    this.ents = [];
    this.layers = new Map();
  }
  layer(name, color = 7) {
    if (!this.layers.has(name)) this.layers.set(name, color);
    return name;
  }
  _push(...pairs) {
    for (let i = 0; i < pairs.length; i += 2) this.ents.push(String(pairs[i]), String(pairs[i + 1]));
  }
  n(v) { return (Math.round(v * 1000) / 1000).toString(); }
  line(layer, x1, y1, x2, y2, color) {
    this._push(0, 'LINE', 8, enc(layer));
    if (color) this._push(62, color);
    this._push(10, this.n(x1), 20, this.n(y1), 30, 0, 11, this.n(x2), 21, this.n(y2), 31, 0);
  }
  poly(layer, pts, closed, color) {
    this._push(0, 'POLYLINE', 8, enc(layer));
    if (color) this._push(62, color);
    this._push(66, 1, 10, 0, 20, 0, 30, 0, 70, closed ? 1 : 0);
    let n = pts.length;
    if (closed && n >= 4 && pts[0] === pts[n - 2] && pts[1] === pts[n - 1]) n -= 2;
    for (let i = 0; i < n; i += 2) this._push(0, 'VERTEX', 8, enc(layer), 10, this.n(pts[i]), 20, this.n(pts[i + 1]), 30, 0);
    this._push(0, 'SEQEND', 8, enc(layer));
  }
  circle(layer, x, y, r, color) {
    this._push(0, 'CIRCLE', 8, enc(layer));
    if (color) this._push(62, color);
    this._push(10, this.n(x), 20, this.n(y), 30, 0, 40, this.n(r));
  }
  text(layer, x, y, h, s, rot = 0, align = 'left', color) {
    // align: left | center
    this._push(0, 'TEXT', 8, enc(layer));
    if (color) this._push(62, color);
    this._push(10, this.n(x), 20, this.n(y), 30, 0, 40, this.n(h), 1, enc(s));
    if (rot) this._push(50, this.n(rot));
    if (align === 'center') this._push(72, 1, 11, this.n(x), 21, this.n(y), 31, 0, 73, 2);
  }
  toString() {
    const out = [];
    const p = (...a) => { for (let i = 0; i < a.length; i += 2) out.push(String(a[i]), String(a[i + 1])); };
    p(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 9, '$DWGCODEPAGE', 3, 'ANSI_1251', 0, 'ENDSEC');
    p(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, this.layers.size);
    for (const [name, color] of this.layers) p(0, 'LAYER', 2, enc(name), 70, 0, 62, color, 6, 'CONTINUOUS');
    p(0, 'ENDTAB', 0, 'ENDSEC');
    p(0, 'SECTION', 2, 'ENTITIES');
    out.push(...this.ents);
    p(0, 'ENDSEC', 0, 'EOF');
    return out.join('\r\n') + '\r\n';
  }
  toBytes() { return cp1251(this.toString()); }
}
