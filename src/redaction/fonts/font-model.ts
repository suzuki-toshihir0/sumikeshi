/**
 * フォントの寸法（文字送りと文字の箱）。
 *
 * 墨消しでは、文字列の中の 1 文字ずつが頁のどこに描かれるかを、
 * ビューアーと同じ規則（ISO 32000-1 9.4.4, 9.7.4）で求める必要がある。
 * 幅が分からない文字は「分からない」と返し、呼び出し側で安全側に倒す。
 */
import { PDFContext, PDFDict, PDFName, PDFArray, PDFNumber, PDFStream, StandardFontEmbedder } from 'pdf-lib';
import type { FontNames } from '@pdf-lib/standard-fonts';
import { get, getArray, getDict, getName, getNum, numbersOf, resolve, streamBytes } from '../pdf-objects';
import { getEncoding, STANDARD_FONT_ALIASES } from '../vendor/pdfjs-encodings';
import { CMap, loadPredefinedCMap, parseEmbeddedCMap, type CMapLoader } from './cmap';
import { parseTrueType, simpleTrueTypeGid, type TrueTypeInfo } from './truetype';
import type { Matrix } from '../geometry';

export interface CharCode {
  code: number;
  /** 文字列の中での位置（バイト） */
  start: number;
  length: number;
}

export interface FontModel {
  readonly vertical: boolean;
  /** テキスト空間の 1 単位あたりのグリフ空間（Type3 以外は 1/1000） */
  readonly fontMatrix: Matrix;
  split(bytes: Uint8Array): CharCode[];
  /** 幅が分かるか */
  widthKnown(c: CharCode): boolean;
  /** 文字の大きさ 1 のときの文字送り。横書きは x 方向、縦書きは y 方向（下が負） */
  advance(c: CharCode): number;
  /** 文字の大きさ 1 のときの文字の箱 [x0, y0, x1, y1]（テキスト空間、現在の点が原点） */
  box(c: CharCode): [number, number, number, number];
  /** 語間（Tw）がかかる符号か（1 バイトの 32） */
  isWordSpace(c: CharCode): boolean;
}

export class UnsupportedFontError extends Error {}

const STANDARD_14 = new Set([
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
]);

function standardFontName(baseFont: string | undefined): string | undefined {
  if (!baseFont) return undefined;
  const name = baseFont.replace(/^[A-Z]{6}\+/, '');
  if (STANDARD_14.has(name)) return name;
  const normalized = name.replaceAll(/[,_]/g, '-').replaceAll(/\s/g, '');
  return STANDARD_FONT_ALIASES[normalized] ?? STANDARD_FONT_ALIASES[name];
}

/** 字形の上下の範囲（グリフ空間、1/1000 単位） */
function verticalExtent(ctx: PDFContext, descriptor: PDFDict | undefined, fallback?: [number, number]): [number, number] {
  let ascent = getNum(ctx, descriptor, 'Ascent');
  let descent = getNum(ctx, descriptor, 'Descent');
  const bbox = numbersOf(ctx, getArray(ctx, descriptor, 'FontBBox'));
  if (ascent === undefined || !(ascent > 0)) ascent = bbox.length === 4 && bbox[3] > 0 ? bbox[3] : fallback?.[1] ?? 800;
  if (descent === undefined || descent > 0) descent = bbox.length === 4 && bbox[1] < 0 ? bbox[1] : fallback?.[0] ?? -200;
  // 値が壊れているとき（Descent が -1 など）でも、最低限の高さを取る
  if (ascent < 500) ascent = Math.max(ascent, fallback?.[1] ?? 750);
  if (descent > -100) descent = Math.min(descent, fallback?.[0] ?? -200);
  return [descent, ascent];
}

type Box4 = [number, number, number, number];

/** 2 つの箱を両方含む箱 */
function union(a: Box4, b: Box4 | null): Box4 {
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** 埋め込みの TrueType（FontFile2）を読む。読めなければ null（字形の外接矩形は使わない） */
function embeddedTrueType(ctx: PDFContext, descriptor: PDFDict | undefined): TrueTypeInfo | null {
  const ff = get(ctx, descriptor, 'FontFile2');
  if (!(ff instanceof PDFStream)) return null;
  try {
    return parseTrueType(streamBytes(ctx, ff));
  } catch {
    return null;
  }
}

/** 単純フォント（1 バイトの符号）: Type1, MMType1, TrueType, Type3 */
class SimpleFont implements FontModel {
  readonly vertical = false;
  constructor(
    readonly fontMatrix: Matrix,
    private readonly widths: (code: number) => number | undefined,
    private readonly extent: [number, number],
    private readonly zeroWidthHalf: number,
    /** 字形の外接矩形（テキスト空間、大きさ 1）。分からなければ null */
    private readonly ink: (code: number) => Box4 | null = () => null,
  ) {}

  split(bytes: Uint8Array): CharCode[] {
    return Array.from(bytes, (code, i) => ({ code, start: i, length: 1 }));
  }

  widthKnown(c: CharCode): boolean {
    return this.widths(c.code) !== undefined;
  }

  advance(c: CharCode): number {
    const w = this.widths(c.code) ?? 0;
    return w * this.fontMatrix[0];
  }

  box(c: CharCode): [number, number, number, number] {
    const adv = this.advance(c);
    const [d, a] = this.extent;
    const ink = this.ink(c.code);
    if (adv > 0) return union([0, d, adv, a], ink);
    if (adv < 0) return union([adv, d, 0, a], ink);
    // 幅 0 の文字（結合文字や、幅を 0 にして Td で並べる PDF）。原点のまわりに箱を取る
    return union([-this.zeroWidthHalf, d, this.zeroWidthHalf, a], ink);
  }

  isWordSpace(c: CharCode): boolean {
    return c.code === 32;
  }
}

/** 複合フォント（Type0）。符号の長さは CMap で決まり、幅は CID ごと */
class CompositeFont implements FontModel {
  readonly fontMatrix: Matrix = [0.001, 0, 0, 0.001, 0, 0];
  constructor(
    private readonly cmap: CMap,
    private readonly w: Map<number, number>,
    private readonly dw: number,
    private readonly w2: Map<number, [number, number, number]>,
    private readonly dw2: [number, number],
    private readonly extent: [number, number],
    /** CID ごとの字形の外接矩形（1/1000 em）。分からなければ null */
    private readonly ink: (cid: number) => Box4 | null = () => null,
  ) {}

  get vertical(): boolean {
    return this.cmap.vertical;
  }

  split(bytes: Uint8Array): CharCode[] {
    const out: CharCode[] = [];
    let i = 0;
    while (i < bytes.length) {
      const { code, length } = this.cmap.readCharCode(bytes, i);
      out.push({ code, start: i, length: Math.min(length, bytes.length - i) });
      i += length;
    }
    return out;
  }

  widthKnown(): boolean {
    return true;
  }

  private cid(c: CharCode): number {
    return this.cmap.lookupCid(c.code);
  }

  private hWidth(cid: number): number {
    return this.w.get(cid) ?? this.dw;
  }

  private vMetrics(cid: number): [number, number, number] {
    const m = this.w2.get(cid);
    if (m) return m;
    return [this.dw2[1], this.hWidth(cid) / 2, this.dw2[0]];
  }

  advance(c: CharCode): number {
    const cid = this.cid(c);
    if (this.vertical) return this.vMetrics(cid)[0] / 1000;
    return this.hWidth(cid) / 1000;
  }

  box(c: CharCode): [number, number, number, number] {
    const cid = this.cid(c);
    const w0 = this.hWidth(cid) / 1000;
    const [d, a] = this.extent.map((v) => v / 1000);
    const width = w0 > 0 ? w0 : 0.5;
    const inkRaw = this.ink(cid);
    const ink: Box4 | null = inkRaw ? [inkRaw[0] / 1000, inkRaw[1] / 1000, inkRaw[2] / 1000, inkRaw[3] / 1000] : null;
    if (!this.vertical) {
      return union(w0 > 0 ? [0, d, w0, a] : [-width / 2, d, width / 2, a], ink);
    }
    const [, vx, vy] = this.vMetrics(cid);
    const ox = -vx / 1000;
    const oy = -vy / 1000;
    const shifted: Box4 | null = ink ? [ink[0] + ox, ink[1] + oy, ink[2] + ox, ink[3] + oy] : null;
    return union([ox, oy + d, ox + width, oy + a], shifted);
  }

  isWordSpace(c: CharCode): boolean {
    return c.length === 1 && c.code === 32;
  }
}

function parseW(ctx: PDFContext, arr: PDFArray | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!arr) return out;
  const items = Array.from({ length: arr.size() }, (_, i) => resolve(ctx, arr.get(i)));
  for (let i = 0; i < items.length;) {
    const first = items[i];
    const next = items[i + 1];
    if (!(first instanceof PDFNumber)) break;
    if (next instanceof PDFArray) {
      const ws = numbersOf(ctx, next);
      ws.forEach((w, k) => out.set(first.asNumber() + k, w));
      i += 2;
    } else if (next instanceof PDFNumber && items[i + 2] instanceof PDFNumber) {
      const lo = first.asNumber();
      const hi = next.asNumber();
      const w = (items[i + 2] as PDFNumber).asNumber();
      if (hi - lo > 0x10000) throw new UnsupportedFontError('W の範囲が大きすぎる');
      for (let c = lo; c <= hi; c++) out.set(c, w);
      i += 3;
    } else {
      break;
    }
  }
  return out;
}

function parseW2(ctx: PDFContext, arr: PDFArray | undefined): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  if (!arr) return out;
  const items = Array.from({ length: arr.size() }, (_, i) => resolve(ctx, arr.get(i)));
  for (let i = 0; i < items.length;) {
    const first = items[i];
    const next = items[i + 1];
    if (!(first instanceof PDFNumber)) break;
    if (next instanceof PDFArray) {
      const vs = numbersOf(ctx, next);
      for (let k = 0; k + 2 < vs.length; k += 3) out.set(first.asNumber() + k / 3, [vs[k], vs[k + 1], vs[k + 2]]);
      i += 2;
    } else if (next instanceof PDFNumber && items.length >= i + 5) {
      const [w1y, vx, vy] = [items[i + 2], items[i + 3], items[i + 4]].map((o) => (o instanceof PDFNumber ? o.asNumber() : 0));
      const lo = first.asNumber();
      const hi = next.asNumber();
      if (hi - lo > 0x10000) throw new UnsupportedFontError('W2 の範囲が大きすぎる');
      for (let c = lo; c <= hi; c++) out.set(c, [w1y, vx, vy]);
      i += 5;
    } else {
      break;
    }
  }
  return out;
}

/** 単純フォントの、符号 → グリフ名（標準 14 フォントで幅を引くため） */
function glyphNames(ctx: PDFContext, fontDict: PDFDict, stdName: string): (string | undefined)[] {
  const builtin = stdName === 'Symbol' ? 'SymbolSetEncoding' : stdName === 'ZapfDingbats' ? 'ZapfDingbatsEncoding' : 'StandardEncoding';
  const enc = get(ctx, fontDict, 'Encoding');
  let base = builtin;
  let differences: PDFArray | undefined;
  if (enc instanceof PDFName) base = enc.decodeText();
  else if (enc instanceof PDFDict) {
    base = getName(ctx, enc, 'BaseEncoding') ?? builtin;
    differences = getArray(ctx, enc, 'Differences');
  }
  const table = getEncoding(base) ?? getEncoding(builtin)!;
  const names: (string | undefined)[] = table.map((n) => n || undefined);
  if (differences) {
    let code = 0;
    for (let i = 0; i < differences.size(); i++) {
      const o = resolve(ctx, differences.get(i));
      if (o instanceof PDFNumber) code = o.asNumber();
      else if (o instanceof PDFName) names[code++] = o.decodeText();
    }
  }
  return names;
}

function simpleWidths(ctx: PDFContext, fontDict: PDFDict, descriptor: PDFDict | undefined): (code: number) => number | undefined {
  const widthsArr = getArray(ctx, fontDict, 'Widths');
  const missing = getNum(ctx, descriptor, 'MissingWidth') ?? 0;
  if (widthsArr) {
    const first = getNum(ctx, fontDict, 'FirstChar') ?? 0;
    const widths = numbersOf(ctx, widthsArr);
    return (code) => {
      const w = widths[code - first];
      return w === undefined || Number.isNaN(w) ? missing : w;
    };
  }
  const baseFont = getName(ctx, fontDict, 'BaseFont');
  const std = standardFontName(baseFont);
  if (!std) {
    // 幅の表が無く、標準 14 フォントでもない。字形のデータを読まないと幅が分からない
    return () => undefined;
  }
  const metrics = StandardFontEmbedder.for(std as FontNames).font;
  const names = glyphNames(ctx, fontDict, std);
  return (code) => {
    const name = names[code];
    if (!name || name === '.notdef') return 0;
    const w = metrics.getWidthOfGlyph(name);
    return typeof w === 'number' ? w : undefined;
  };
}

/** フォントの辞書から、寸法の模型を作る */
export async function createFontModel(ctx: PDFContext, fontDict: PDFDict, loader?: CMapLoader): Promise<FontModel> {
  const subtype = getName(ctx, fontDict, 'Subtype');
  if (subtype === 'Type0') return createCompositeFont(ctx, fontDict, loader);

  const descriptor = getDict(ctx, fontDict, 'FontDescriptor');
  if (subtype === 'Type3') {
    const fm = numbersOf(ctx, getArray(ctx, fontDict, 'FontMatrix'));
    const fontMatrix: Matrix = fm.length === 6 && fm.every(Number.isFinite) ? (fm as Matrix) : [0.001, 0, 0, 0.001, 0, 0];
    const widthsFn = simpleWidths(ctx, fontDict, descriptor);
    const bbox = numbersOf(ctx, getArray(ctx, fontDict, 'FontBBox'));
    let extent: [number, number] = [-0.2, 0.8];
    if (bbox.length === 4 && bbox[3] !== bbox[1]) {
      const ys = [bbox[1], bbox[3]].map((y) => y * fontMatrix[3]);
      extent = [Math.min(...ys), Math.max(...ys)];
    }
    // Type3 の箱はテキスト空間で持つ（fontMatrix を掛けた後）
    return new SimpleFont(fontMatrix, widthsFn, extent, 0.25);
  }

  const std = standardFontName(getName(ctx, fontDict, 'BaseFont'));
  let fallback: [number, number] | undefined;
  if (std) {
    const f = StandardFontEmbedder.for(std as FontNames).font;
    fallback = [Math.min(f.FontBBox[1], (f.Descender as number | undefined) ?? -200), Math.max(f.FontBBox[3], (f.Ascender as number | undefined) ?? 800)];
    if (!descriptor) fallback = [(f.Descender as number | undefined) ?? f.FontBBox[1], (f.Ascender as number | undefined) ?? f.FontBBox[3]];
  }
  const [d, a] = verticalExtent(ctx, descriptor, fallback);
  let ink: (code: number) => Box4 | null = () => null;
  const tt = embeddedTrueType(ctx, descriptor);
  if (tt) {
    const symbolic = ((getNum(ctx, descriptor, 'Flags') ?? 0) & 4) !== 0;
    const upem = tt.unitsPerEm;
    ink = (code) => {
      // 符号から Unicode は、ASCII の範囲だけ素直に対応させる（それ以外は cmap の (3,0) / (1,0) に頼る）
      const gid = simpleTrueTypeGid(tt, code, code >= 0x20 && code < 0x7f ? code : undefined, symbolic);
      const b = gid !== undefined ? tt.glyphBox(gid) : null;
      return b ? [b[0] / upem, b[1] / upem, b[2] / upem, b[3] / upem] : null;
    };
  }
  return new SimpleFont([0.001, 0, 0, 0.001, 0, 0], simpleWidths(ctx, fontDict, descriptor), [d / 1000, a / 1000], 0.25, ink);
}

async function createCompositeFont(ctx: PDFContext, fontDict: PDFDict, loader?: CMapLoader): Promise<FontModel> {
  const descendants = getArray(ctx, fontDict, 'DescendantFonts');
  const cidFontObj = descendants ? resolve(ctx, descendants.get(0)) : undefined;
  const cidFont = cidFontObj instanceof PDFDict ? cidFontObj : undefined;
  if (!cidFont) throw new UnsupportedFontError('Type0 フォントに DescendantFonts が無い');

  const enc = get(ctx, fontDict, 'Encoding');
  let cmap: CMap;
  if (enc instanceof PDFName) {
    cmap = await loadPredefinedCMap(enc.decodeText(), loader);
  } else if (enc instanceof PDFStream) {
    const useCMapObj = get(ctx, enc.dict, 'UseCMap');
    let parent: CMap | undefined;
    if (useCMapObj instanceof PDFName) parent = await loadPredefinedCMap(useCMapObj.decodeText(), loader);
    else if (useCMapObj instanceof PDFStream) parent = await parseEmbeddedCMap(streamBytes(ctx, useCMapObj), loader);
    const wmode = getNum(ctx, enc.dict, 'WMode');
    cmap = await parseEmbeddedCMap(streamBytes(ctx, enc), loader, parent, wmode);
  } else {
    throw new UnsupportedFontError('Type0 フォントの Encoding が読めない');
  }

  const descriptor = getDict(ctx, cidFont, 'FontDescriptor');
  const dw = getNum(ctx, cidFont, 'DW') ?? 1000;
  const w = parseW(ctx, getArray(ctx, cidFont, 'W'));
  const dw2Arr = numbersOf(ctx, getArray(ctx, cidFont, 'DW2'));
  const dw2: [number, number] = dw2Arr.length === 2 ? [dw2Arr[0], dw2Arr[1]] : [880, -1000];
  const w2 = parseW2(ctx, getArray(ctx, cidFont, 'W2'));
  const extent = verticalExtent(ctx, descriptor, [-120, 880]);
  let ink: (cid: number) => Box4 | null = () => null;
  const tt = getName(ctx, cidFont, 'Subtype') === 'CIDFontType2' ? embeddedTrueType(ctx, descriptor) : null;
  if (tt) {
    // CID → 字形の番号。CIDToGIDMap が無いか Identity なら同じ番号、ストリームなら 2 バイトずつの表
    const mapObj = get(ctx, cidFont, 'CIDToGIDMap');
    let toGid: (cid: number) => number = (cid) => cid;
    if (mapObj instanceof PDFStream) {
      const table = streamBytes(ctx, mapObj);
      toGid = (cid) => (cid * 2 + 1 < table.length ? (table[cid * 2] << 8) | table[cid * 2 + 1] : 0);
    }
    const scale = 1000 / tt.unitsPerEm;
    ink = (cid) => {
      const b = tt.glyphBox(toGid(cid));
      return b ? [b[0] * scale, b[1] * scale, b[2] * scale, b[3] * scale] : null;
    };
  }
  return new CompositeFont(cmap, w, dw, w2, dw2, extent, ink);
}

export { PDFName };
