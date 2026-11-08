/**
 * 画像の色空間を読み、成分の数と「いちばん暗い色」の値を求める。
 * 墨消しの範囲の画素は、この色で塗りつぶす（情報を残さないことが目的なので、色そのものは何でもよい）。
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFObject, PDFStream } from 'pdf-lib';
import { getArray, getNum, numbersOf, resolve, streamBytes, stringBytes } from '../pdf-objects';
import type { ResourceEditor } from '../resources';

export interface ColorSpaceInfo {
  family: string;
  ncomp: number;
  /** いちばん暗い色の、各成分の値（色空間の値域で） */
  darkest: number[];
  /** 既定の Decode 配列 */
  defaultDecode: (bpc: number) => number[];
}

export class UnsupportedColorSpaceError extends Error {}

const NAME_ABBREVIATIONS: Record<string, string> = {
  G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed',
};

const unit = (n: number) => () => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0 : 1));

function simple(family: string): ColorSpaceInfo | null {
  switch (family) {
    case 'DeviceGray':
    case 'CalGray':
      return { family, ncomp: 1, darkest: [0], defaultDecode: unit(2) };
    case 'DeviceRGB':
    case 'CalRGB':
      return { family, ncomp: 3, darkest: [0, 0, 0], defaultDecode: unit(6) };
    case 'DeviceCMYK':
      return { family, ncomp: 4, darkest: [0, 0, 0, 1], defaultDecode: unit(8) };
    default:
      return null;
  }
}

export function resolveColorSpace(
  ctx: PDFContext,
  obj: PDFObject | undefined,
  resources?: ResourceEditor,
  depth = 0,
): ColorSpaceInfo {
  if (depth > 8) throw new UnsupportedColorSpaceError('色空間の入れ子が深すぎる');
  const cs = resolve(ctx, obj);
  if (cs instanceof PDFName) {
    const name = NAME_ABBREVIATIONS[cs.decodeText()] ?? cs.decodeText();
    const s = simple(name);
    if (s) return s;
    // インライン画像では、資源の ColorSpace の名前を指せる
    const res = resources?.lookup('ColorSpace', cs.decodeText());
    if (res) return resolveColorSpace(ctx, res, resources, depth + 1);
    throw new UnsupportedColorSpaceError(`色空間 ${name} を読めない`);
  }
  if (cs instanceof PDFArray && cs.size() > 0) {
    const head = resolve(ctx, cs.get(0));
    const family = head instanceof PDFName ? NAME_ABBREVIATIONS[head.decodeText()] ?? head.decodeText() : '';
    const s = simple(family);
    if (s) return s;
    switch (family) {
      case 'ICCBased': {
        const stream = resolve(ctx, cs.get(1));
        const n = stream instanceof PDFStream ? getNum(ctx, stream.dict, 'N') : undefined;
        const info = simple(n === 1 ? 'DeviceGray' : n === 3 ? 'DeviceRGB' : n === 4 ? 'DeviceCMYK' : '');
        if (!info) throw new UnsupportedColorSpaceError(`ICCBased の成分の数 ${n} を扱えない`);
        // Range があれば Decode の既定はそれに従う
        const range = stream instanceof PDFStream ? numbersOf(ctx, getArray(ctx, stream.dict, 'Range')) : [];
        return { ...info, family, defaultDecode: range.length === info.ncomp * 2 ? () => range : info.defaultDecode };
      }
      case 'Lab': {
        const dict = resolve(ctx, cs.get(1));
        const range = dict instanceof PDFDict ? numbersOf(ctx, getArray(ctx, dict, 'Range')) : [];
        const [amin, amax, bmin, bmax] = range.length === 4 ? range : [-100, 100, -100, 100];
        return { family, ncomp: 3, darkest: [0, 0, 0], defaultDecode: () => [0, 100, amin, amax, bmin, bmax] };
      }
      case 'Indexed': {
        const base = resolveColorSpace(ctx, cs.get(1), resources, depth + 1);
        const hivalObj = resolve(ctx, cs.get(2));
        const hival = hivalObj instanceof PDFNumber ? hivalObj.asNumber() : 255;
        const lookupObj = resolve(ctx, cs.get(3));
        let lookup: Uint8Array | undefined = stringBytes(lookupObj);
        if (!lookup && lookupObj instanceof PDFStream) lookup = streamBytes(ctx, lookupObj);
        const darkestIndex = lookup ? darkestPaletteIndex(base, lookup, hival) : 0;
        return { family, ncomp: 1, darkest: [darkestIndex], defaultDecode: (bpc) => [0, 2 ** bpc - 1] };
      }
      case 'Separation':
        return { family, ncomp: 1, darkest: [1], defaultDecode: unit(2) };
      case 'DeviceN': {
        const names = resolve(ctx, cs.get(1));
        const n = names instanceof PDFArray ? names.size() : 1;
        return { family, ncomp: n, darkest: Array(n).fill(1), defaultDecode: unit(2 * n) };
      }
      case 'Pattern':
        throw new UnsupportedColorSpaceError('画像に Pattern の色空間は使えない');
    }
    throw new UnsupportedColorSpaceError(`色空間 ${family} を読めない`);
  }
  throw new UnsupportedColorSpaceError('色空間を読めない');
}

/** パレットのうち、いちばん暗い色の番号 */
function darkestPaletteIndex(base: ColorSpaceInfo, lookup: Uint8Array, hival: number): number {
  let best = 0;
  let bestL = Infinity;
  const n = base.ncomp;
  for (let i = 0; i <= hival && (i + 1) * n <= lookup.length; i++) {
    const c = Array.from(lookup.subarray(i * n, (i + 1) * n), (v) => v / 255);
    let l: number;
    if (n === 1) l = c[0];
    else if (n === 3) l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    else if (n === 4) l = (1 - Math.min(1, c[0] + c[3])) * 0.3 + (1 - Math.min(1, c[1] + c[3])) * 0.59 + (1 - Math.min(1, c[2] + c[3])) * 0.11;
    else l = c.reduce((a, b) => a + b, 0);
    if (base.family === 'Lab') l = c[0];
    if (l < bestL) {
      bestL = l;
      best = i;
    }
  }
  return best;
}
