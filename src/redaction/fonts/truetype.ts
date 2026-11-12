/**
 * 埋め込みの TrueType フォント（FontFile2）から、字形ごとの外接矩形を読む。
 *
 * PDF の文字送り（Widths / W）の箱と、実際に描かれる字形の範囲は一致するとは限らない
 * （斜体の張り出し、左にはみ出す字形、文字送りが 0 の字形など）。
 * 墨消しでは、字形の外接矩形が範囲にかかる文字も消すために使う。
 * 読むのは head・maxp・loca・glyf・cmap・post だけ（字形の輪郭は解釈しない）。
 */
import { MacStandardGlyphOrdering } from '../vendor/pdfjs-encodings';

export interface TrueTypeInfo {
  unitsPerEm: number;
  numGlyphs: number;
  /** 字形の外接矩形（フォントの単位）。輪郭の無い字形や読めないものは null */
  glyphBox(gid: number): [number, number, number, number] | null;
  /** cmap の表（platformID, encodingID）→ 符号から字形の番号を引く関数 */
  cmaps: Map<string, (code: number) => number | undefined>;
  /** post 表（形式 2）の字形名 → 字形の番号（同じ名前が複数あれば最初のもの）。無ければ空 */
  postNames: Map<string, number>;
}

export class TrueTypeParseError extends Error {}

class Reader {
  constructor(readonly b: Uint8Array) {}
  u8(o: number): number {
    if (o < 0 || o >= this.b.length) throw new TrueTypeParseError('範囲の外を読んだ');
    return this.b[o];
  }
  u16(o: number): number {
    return (this.u8(o) << 8) | this.u8(o + 1);
  }
  i16(o: number): number {
    const v = this.u16(o);
    return v & 0x8000 ? v - 0x10000 : v;
  }
  u32(o: number): number {
    return ((this.u8(o) << 24) | (this.u8(o + 1) << 16) | (this.u8(o + 2) << 8) | this.u8(o + 3)) >>> 0;
  }
  tag(o: number): string {
    return String.fromCharCode(this.u8(o), this.u8(o + 1), this.u8(o + 2), this.u8(o + 3));
  }
}

export function parseTrueType(bytes: Uint8Array): TrueTypeInfo {
  const r = new Reader(bytes);
  let base = 0;
  if (r.tag(0) === 'ttcf') base = r.u32(12); // コレクションなら最初のフォント
  const numTables = r.u16(base + 4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    tables.set(r.tag(rec), { offset: r.u32(rec + 8), length: r.u32(rec + 12) });
  }
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (!head || !maxp) throw new TrueTypeParseError('head か maxp が無い');
  const unitsPerEm = r.u16(head.offset + 18) || 1000;
  const indexToLocFormat = r.i16(head.offset + 50);
  const numGlyphs = r.u16(maxp.offset + 4);

  const glyphBox = (gid: number): [number, number, number, number] | null => {
    if (!loca || !glyf || gid < 0 || gid >= numGlyphs) return null;
    try {
      let start: number;
      let end: number;
      if (indexToLocFormat === 0) {
        start = r.u16(loca.offset + gid * 2) * 2;
        end = r.u16(loca.offset + (gid + 1) * 2) * 2;
      } else {
        start = r.u32(loca.offset + gid * 4);
        end = r.u32(loca.offset + (gid + 1) * 4);
      }
      if (end <= start || end - start < 10) return null; // 輪郭の無い字形（空白など）
      const g = glyf.offset + start;
      return [r.i16(g + 2), r.i16(g + 4), r.i16(g + 6), r.i16(g + 8)];
    } catch {
      return null;
    }
  };

  const cmaps = new Map<string, (code: number) => number | undefined>();
  const cmap = tables.get('cmap');
  if (cmap) {
    try {
      const n = r.u16(cmap.offset + 2);
      for (let i = 0; i < n; i++) {
        const rec = cmap.offset + 4 + i * 8;
        const key = `${r.u16(rec)},${r.u16(rec + 2)}`;
        const sub = cmap.offset + r.u32(rec + 4);
        const fn = parseCmapSubtable(r, sub);
        if (fn && !cmaps.has(key)) cmaps.set(key, fn);
      }
    } catch {
      // cmap が読めなくても、外接矩形は CID からも引ける
    }
  }
  const postNames = new Map<string, number>();
  const post = tables.get('post');
  if (post) {
    try {
      if (r.u32(post.offset) === 0x00020000) {
        const n = r.u16(post.offset + 32);
        const custom: string[] = [];
        let p = post.offset + 34 + n * 2;
        const end = post.offset + post.length;
        while (p < end) {
          const len = r.u8(p);
          let nm = '';
          for (let k = 1; k <= len; k++) nm += String.fromCharCode(r.u8(p + k));
          custom.push(nm);
          p += 1 + len;
        }
        for (let g = 0; g < n && g < numGlyphs; g++) {
          const ix = r.u16(post.offset + 34 + g * 2);
          const nm = ix < 258 ? MacStandardGlyphOrdering[ix] : custom[ix - 258];
          if (nm && !postNames.has(nm)) postNames.set(nm, g);
        }
      } else if (r.u32(post.offset) === 0x00010000) {
        MacStandardGlyphOrdering.forEach((nm, g) => {
          if (g < numGlyphs && !postNames.has(nm)) postNames.set(nm, g);
        });
      }
    } catch {
      // 読めない post 表は使わない
    }
  }
  return { unitsPerEm, numGlyphs, glyphBox, cmaps, postNames };
}

function parseCmapSubtable(r: Reader, o: number): ((code: number) => number | undefined) | null {
  const format = r.u16(o);
  if (format === 0) {
    return (c) => (c >= 0 && c < 256 ? r.u8(o + 6 + c) : undefined);
  }
  if (format === 4) {
    const segX2 = r.u16(o + 6);
    const ends = o + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    return (c) => {
      for (let i = 0; i < segX2; i += 2) {
        if (c > r.u16(ends + i)) continue;
        const start = r.u16(starts + i);
        if (c < start) return undefined;
        const delta = r.u16(deltas + i);
        const ro = r.u16(ranges + i);
        if (ro === 0) return (c + delta) & 0xffff;
        const gi = r.u16(ranges + i + ro + (c - start) * 2);
        return gi === 0 ? 0 : (gi + delta) & 0xffff;
      }
      return undefined;
    };
  }
  if (format === 6) {
    const first = r.u16(o + 6);
    const count = r.u16(o + 8);
    return (c) => (c >= first && c < first + count ? r.u16(o + 10 + (c - first) * 2) : undefined);
  }
  if (format === 12) {
    const groups = r.u32(o + 12);
    return (c) => {
      for (let i = 0; i < groups; i++) {
        const g = o + 16 + i * 12;
        const s = r.u32(g);
        const e = r.u32(g + 4);
        if (c >= s && c <= e) return r.u32(g + 8) + (c - s);
      }
      return undefined;
    };
  }
  return null;
}

/** 単純フォント（TrueType）の符号 → 字形の番号（ISO 32000-1 9.6.6.4 のうち、よく使われる道筋） */
export function simpleTrueTypeGid(tt: TrueTypeInfo, code: number, unicode: number | undefined, symbolic: boolean): number | undefined {
  const c30 = tt.cmaps.get('3,0');
  const c31 = tt.cmaps.get('3,1');
  const c10 = tt.cmaps.get('1,0');
  if (!symbolic && c31 && unicode !== undefined) {
    const g = c31(unicode);
    if (g) return g;
  }
  if (c30) {
    for (const v of [code, 0xf000 + code, 0xf100 + code, 0xf200 + code]) {
      const g = c30(v);
      if (g) return g;
    }
  }
  if (c10) {
    const g = c10(code);
    if (g) return g;
  }
  if (c31 && unicode !== undefined) {
    const g = c31(unicode);
    if (g) return g;
  }
  return undefined;
}
