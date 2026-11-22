/**
 * 写真の試験の素材に、墨消しで消えるべきメタデータ（Exif の位置情報・説明・縮小画像、XMP、コメント、PNG の文字の欄）を仕込む。
 * 中身はすべて架空。どれにも "SECRET" を含めておき、書き出した画像のバイト列に残らないことを確かめる
 */

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** JPEG のセグメント（FF マーカー、長さ 2 バイト、中身） */
function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  return concat(new Uint8Array([0xff, marker, len >> 8, len & 0xff]), payload);
}

type Entry = { tag: number; type: number; count: number; value: Uint8Array | number; pointsTo?: string };

/** TIFF（ビッグエンディアン）の IFD を並べて、Exif の中身を作る */
function buildTiff(ifds: { name: string; entries: Entry[]; next?: string }[], blobs: Record<string, Uint8Array>): Uint8Array {
  // 置く位置を先に決める: ヘッダー 8 バイト、IFD を順に、続けて値の領域と blobs
  const offsets: Record<string, number> = {};
  let o = 8;
  for (const ifd of ifds) {
    offsets[ifd.name] = o;
    o += 2 + ifd.entries.length * 12 + 4;
  }
  const extra: { at: number; data: Uint8Array }[] = [];
  const valueOffsets = new Map<Entry, number>();
  for (const ifd of ifds) {
    for (const e of ifd.entries) {
      if (e.value instanceof Uint8Array && e.value.length > 4) {
        valueOffsets.set(e, o);
        extra.push({ at: o, data: e.value });
        o += e.value.length + (e.value.length % 2);
      }
    }
  }
  for (const [name, data] of Object.entries(blobs)) {
    offsets[name] = o;
    extra.push({ at: o, data });
    o += data.length;
  }
  const buf = new Uint8Array(o);
  const dv = new DataView(buf.buffer);
  buf.set(enc.encode('MM'), 0);
  dv.setUint16(2, 42);
  dv.setUint32(4, 8);
  for (const ifd of ifds) {
    let p = offsets[ifd.name];
    dv.setUint16(p, ifd.entries.length);
    p += 2;
    for (const e of ifd.entries) {
      dv.setUint16(p, e.tag);
      dv.setUint16(p + 2, e.type);
      // 文字の欄（ASCII・UNDEFINED）の数は、中身のバイト数にする
      dv.setUint32(p + 4, e.value instanceof Uint8Array && (e.type === 2 || e.type === 7) ? e.value.length : e.count);
      if (e.pointsTo) dv.setUint32(p + 8, offsets[e.pointsTo]);
      else if (typeof e.value === 'number') {
        if (e.type === 3) dv.setUint16(p + 8, e.value);
        else dv.setUint32(p + 8, e.value);
      } else if (e.value.length > 4) dv.setUint32(p + 8, valueOffsets.get(e)!);
      else buf.set(e.value, p + 8);
      p += 12;
    }
    dv.setUint32(p, ifd.next ? offsets[ifd.next] : 0);
  }
  for (const x of extra) buf.set(x.data, x.at);
  return buf;
}

const ascii = (s: string) => enc.encode(`${s}\0`);
function rationals(...pairs: [number, number][]): Uint8Array {
  const b = new Uint8Array(pairs.length * 8);
  const dv = new DataView(b.buffer);
  pairs.forEach(([n, d], i) => {
    dv.setUint32(i * 8, n);
    dv.setUint32(i * 8 + 4, d);
  });
  return b;
}

/**
 * JPEG に、Exif（向き・説明・位置情報・縮小画像）、XMP、コメントを差し込む。
 * thumbnail は縮小画像として埋め込む JPEG（その中にも秘密のコメントを入れておく）
 */
export function addJpegMetadata(jpeg: Uint8Array, opts: { orientation: number; thumbnail: Uint8Array }): Uint8Array {
  const thumb = addJpegComment(opts.thumbnail, 'THUMBSECRET');
  const tiff = buildTiff(
    [
      {
        name: 'ifd0',
        next: 'ifd1',
        entries: [
          { tag: 0x010e, type: 2, count: 18, value: ascii('EXIFSECRET 架空') },
          { tag: 0x0112, type: 3, count: 1, value: opts.orientation },
          { tag: 0x8825, type: 4, count: 1, value: 0, pointsTo: 'gps' },
        ],
      },
      {
        name: 'ifd1',
        entries: [
          { tag: 0x0201, type: 4, count: 1, value: 0, pointsTo: 'thumb' },
          { tag: 0x0202, type: 4, count: 1, value: thumb.length },
        ],
      },
      {
        name: 'gps',
        entries: [
          { tag: 0x0001, type: 2, count: 2, value: ascii('N') },
          { tag: 0x0002, type: 5, count: 3, value: rationals([35, 1], [41, 1], [2234, 100]) },
          { tag: 0x0003, type: 2, count: 2, value: ascii('E') },
          { tag: 0x0004, type: 5, count: 3, value: rationals([139, 1], [41, 1], [3056, 100]) },
          { tag: 0x001b, type: 7, count: 13, value: enc.encode('GPSSECRET!!!!') },
        ],
      },
    ],
    { thumb },
  );
  const exif = jpegSegment(0xe1, concat(enc.encode('Exif\0\0'), tiff));
  const xmp = jpegSegment(
    0xe1,
    concat(enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode('<x:xmpmeta xmlns:x="adobe:ns:meta/">XMPSECRET</x:xmpmeta>')),
  );
  return concat(jpeg.subarray(0, 2), exif, xmp, jpeg.subarray(2)).slice();
}

/** JPEG の先頭にコメント（COM）を差し込む */
export function addJpegComment(jpeg: Uint8Array, text: string): Uint8Array {
  return concat(jpeg.subarray(0, 2), jpegSegment(0xfe, enc.encode(text)), jpeg.subarray(2));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG の IHDR の直後に、文字の欄（tEXt）と Exif（eXIf）を差し込む */
export function addPngMetadata(png: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = concat(enc.encode(type), data);
    const out = new Uint8Array(body.length + 8);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(body, 4);
    dv.setUint32(body.length + 4, crc32(body));
    return out;
  };
  const ihdrEnd = 8 + 8 + 13 + 4;
  const text = chunk('tEXt', enc.encode('Comment\0PNGSECRET'));
  const exif = chunk('eXIf', buildTiff([{ name: 'ifd0', entries: [{ tag: 0x010e, type: 2, count: 14, value: ascii('PNGEXIFSECRET') }] }], {}));
  return concat(png.subarray(0, ihdrEnd), text, exif, png.subarray(ihdrEnd));
}

/** バイト列に文字列が含まれるか（Latin-1 として見る） */
export function containsAscii(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes).toString('latin1').includes(needle);
}
