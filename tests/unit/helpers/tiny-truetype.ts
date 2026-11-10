/**
 * 試験用の小さな TrueType フォントを作る（head・maxp・loca・glyf だけ。輪郭の中身は空）。
 * 字形ごとの外接矩形だけを指定できる。sumikeshi の字形の外接矩形の読み取りを試すためのもの。
 */
/** (3,1) の cmap（形式 4、1 文字 1 区切り） */
function cmap31(pairs: [number, number][]): Uint8Array {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const segs = [...sorted.map(([c, g]) => [c, c, (g - c) & 0xffff]), [0xffff, 0xffff, 1]];
  const n = segs.length;
  const sub = new DataView(new ArrayBuffer(16 + n * 8));
  sub.setUint16(0, 4);
  sub.setUint16(2, 16 + n * 8);
  sub.setUint16(6, n * 2);
  let o = 14;
  for (const [, end] of segs) { sub.setUint16(o, end); o += 2; }
  o += 2;
  for (const [start] of segs) { sub.setUint16(o, start); o += 2; }
  for (const [, , d] of segs) { sub.setUint16(o, d); o += 2; }
  for (let i = 0; i < n; i++) { sub.setUint16(o, 0); o += 2; }
  const head = new DataView(new ArrayBuffer(12));
  head.setUint16(2, 1);
  head.setUint16(4, 3);
  head.setUint16(6, 1);
  head.setUint32(8, 12);
  const out = new Uint8Array(12 + sub.byteLength);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(new Uint8Array(sub.buffer), 12);
  return out;
}

export function tinyTrueType(boxes: ([number, number, number, number] | null)[], unitsPerEm = 1000, cmapPairs?: [number, number][]): Uint8Array {
  const glyphs = boxes.map((b) => {
    if (!b) return new Uint8Array(0);
    const g = new DataView(new ArrayBuffer(12));
    g.setInt16(0, 1); // 輪郭の数
    g.setInt16(2, b[0]);
    g.setInt16(4, b[1]);
    g.setInt16(6, b[2]);
    g.setInt16(8, b[3]);
    g.setUint16(10, 0); // endPtsOfContours（中身は使わない）
    return new Uint8Array(g.buffer);
  });
  const glyfLen = glyphs.reduce((n, g) => n + g.length, 0);
  const glyf = new Uint8Array(glyfLen);
  const loca = new DataView(new ArrayBuffer((glyphs.length + 1) * 4));
  let off = 0;
  glyphs.forEach((g, i) => {
    loca.setUint32(i * 4, off);
    glyf.set(g, off);
    off += g.length;
  });
  loca.setUint32(glyphs.length * 4, off);
  const head = new DataView(new ArrayBuffer(54));
  head.setUint32(0, 0x00010000);
  head.setUint32(12, 0x5f0f3cf5);
  head.setUint16(18, unitsPerEm);
  head.setInt16(50, 1); // loca は 4 バイト
  const maxp = new DataView(new ArrayBuffer(6));
  maxp.setUint32(0, 0x00005000);
  maxp.setUint16(4, glyphs.length);
  // hhea と hmtx（送り幅は 600 そろい）
  const hhea = new DataView(new ArrayBuffer(36));
  hhea.setUint32(0, 0x00010000);
  hhea.setUint16(34, glyphs.length);
  const hmtx = new DataView(new ArrayBuffer(glyphs.length * 4));
  glyphs.forEach((_, i) => hmtx.setUint16(i * 4, 600));
  const tables: [string, Uint8Array][] = [
    ['glyf', glyf], ['head', new Uint8Array(head.buffer)], ['hhea', new Uint8Array(hhea.buffer)],
    ['hmtx', new Uint8Array(hmtx.buffer)], ['loca', new Uint8Array(loca.buffer)], ['maxp', new Uint8Array(maxp.buffer)],
  ];
  if (cmapPairs) tables.unshift(['cmap', cmap31(cmapPairs)]);
  const headerLen = 12 + tables.length * 16;
  const total = headerLen + tables.reduce((n, [, d]) => n + ((d.length + 3) & ~3), 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, tables.length);
  let pos = headerLen;
  tables.forEach(([tag, d], i) => {
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = tag.charCodeAt(k);
    dv.setUint32(rec + 8, pos);
    dv.setUint32(rec + 12, d.length);
    out.set(d, pos);
    pos += (d.length + 3) & ~3;
  });
  return out;
}
