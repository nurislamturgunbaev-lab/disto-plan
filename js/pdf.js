// Минимальный PDF из JPEG-страниц (без внешних библиотек; кириллица рисуется на canvas).
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** pages: [{canvas, landscape}] → Blob application/pdf (A4) */
export function canvasesToPdf(pages, quality = 0.9) {
  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const offsets = [];
  const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : data; chunks.push(b); len += b.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // объекты: 1 каталог, 2 страницы, далее по 3 на страницу (page, content, image)
  const obj = (id, body) => { offsets[id] = len; push(`${id} 0 obj\n`); body(); push('\nendobj\n'); };
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  pages.forEach((pg, i) => {
    const W = pg.landscape ? 841.89 : 595.28, H = pg.landscape ? 595.28 : 841.89;
    const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
    const jpg = b64ToBytes(pg.canvas.toDataURL('image/jpeg', quality).split(',')[1]);
    // вписываем картинку в страницу с сохранением пропорций
    const k = Math.min(W / pg.canvas.width, H / pg.canvas.height);
    const w = pg.canvas.width * k, h = pg.canvas.height * k;
    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${((W - w) / 2).toFixed(2)} ${((H - h) / 2).toFixed(2)} cm /Im0 Do Q`;
    obj(pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`));
    obj(cid, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(iid, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${pg.canvas.width} /Height ${pg.canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
      push(jpg);
      push('\nendstream');
    });
  });
  const total = 3 + n * 3;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
