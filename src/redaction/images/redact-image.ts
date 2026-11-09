/**
 * 画像の、墨消しの範囲にかかる画素を塗りつぶした新しい画像を作る。
 *
 * 元の画像（JBIG2, CCITT, JPEG, JPEG 2000, Flate など）を復号し、範囲にかかる画素を一色にしてから、
 * Flate で圧縮し直した画像に差し替える。元の画像は、ほかから参照されていなければ保存の前に消える。
 * 透明度（SMask）や、マスクの画像（Mask）も同じ範囲を塗りつぶす。
 */
import {
  PDFArray, PDFBool, PDFContext, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFRawStream,
  PDFRef, PDFStream, PDFString,
} from 'pdf-lib';
import type { Operand, Operation } from '../content/lexer';
import type { RedactionContext } from '../content-redactor';
import { type Matrix, invert, apply, transformBox, quadOverlapsRect, boundsOf } from '../geometry';
import type { ResourceEditor } from '../resources';
import { get, getArray, getBool, getName, getNum, numbersOf, resolve } from '../pdf-objects';
import { decodeImageSamples, type DecodedImage } from './decode-image';
import { resolveColorSpace, type ColorSpaceInfo } from './colorspace';
import { FILTER_ABBREVIATIONS } from './filters';
import { RedactionError } from '../errors';
import type { PdfRect } from '../../utils/coordinates';

/** 画像の単位正方形が、頁の上でどこに来るか */
function imageQuad(ctm: Matrix) {
  return transformBox(ctm, 0, 0, 1, 1);
}

function rawContents(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) return s.getContents();
  const any = s as unknown as { getContents?: () => Uint8Array };
  if (typeof any.getContents === 'function') return any.getContents();
  throw new Error('画像のデータを読めない');
}

/** 標本の読み書き（1 行ごとにバイト境界にそろえた並び） */
class Samples {
  readonly rowBytes: number;
  constructor(readonly img: DecodedImage, readonly width: number) {
    this.rowBytes = Math.ceil((width * img.bpc * img.ncomp) / 8);
  }

  set(x: number, y: number, values: number[]): void {
    const { bpc, ncomp, data } = this.img;
    const base = y * this.rowBytes;
    for (let c = 0; c < ncomp; c++) {
      const v = values[c];
      const index = x * ncomp + c;
      if (bpc === 8) data[base + index] = v;
      else if (bpc === 16) {
        data[base + index * 2] = (v >> 8) & 0xff;
        data[base + index * 2 + 1] = v & 0xff;
      } else {
        const bit = index * bpc;
        const byte = base + (bit >> 3);
        const shift = 8 - bpc - (bit & 7);
        const mask = ((1 << bpc) - 1) << shift;
        data[byte] = (data[byte] & ~mask) | ((v << shift) & mask);
      }
    }
  }
}

/** 色空間の値 → 標本の値（Decode 配列で逆算する） */
function sampleValues(target: number[], decode: number[], bpc: number): number[] {
  const max = 2 ** bpc - 1;
  return target.map((v, i) => {
    const dmin = decode[2 * i];
    const dmax = decode[2 * i + 1];
    if (dmax === dmin) return 0;
    const s = Math.round(((v - dmin) / (dmax - dmin)) * max);
    return Math.max(0, Math.min(max, s));
  });
}

/**
 * 画素のうち、範囲にかかるものを values で塗る。塗った画素の数を返す。
 * 画素 (i, j) は単位正方形の [i/W, (i+1)/W] × [1-(j+1)/H, 1-j/H] を占める（画像の 1 行目が上）。
 */
function paint(samples: Samples, width: number, height: number, ctm: Matrix, rects: PdfRect[], values: number[]): number {
  let count = 0;
  const inv = invert(ctm);
  if (!inv) {
    // 大きさ 0 の画像（見えない）。念のため全部塗る
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) samples.set(i, j, values);
    return width * height;
  }
  // 軸にそろった配置なら、範囲の内側の画素はすべてかかる（端だけ確かめる）
  const axisAligned = (ctm[1] === 0 && ctm[2] === 0) || (ctm[0] === 0 && ctm[3] === 0);
  for (const r of rects) {
    const corners = [
      apply(inv, r.x, r.y), apply(inv, r.x + r.width, r.y),
      apply(inv, r.x + r.width, r.y + r.height), apply(inv, r.x, r.y + r.height),
    ];
    const b = boundsOf(corners);
    const i0 = Math.max(0, Math.floor(b.x * width));
    const i1 = Math.min(width - 1, Math.ceil((b.x + b.width) * width) - 1);
    const j0 = Math.max(0, Math.floor((1 - (b.y + b.height)) * height));
    const j1 = Math.min(height - 1, Math.ceil((1 - b.y) * height) - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const edge = i === i0 || i === i1 || j === j0 || j === j1;
        if (!axisAligned || edge) {
          const quad = transformBox(ctm, i / width, 1 - (j + 1) / height, (i + 1) / width, 1 - j / height);
          if (!quadOverlapsRect(quad, r)) continue;
        }
        samples.set(i, j, values);
        count++;
      }
    }
  }
  return count;
}

/** 8bit の標本に PNG の予測子をかける（行ごとに、いちばん小さくなりそうな方式を選ぶ） */
function pngPredict(data: Uint8Array, rowBytes: number, bytesPerPixel: number, rows: number): Uint8Array {
  const out = new Uint8Array(rows * (rowBytes + 1));
  const zero = new Uint8Array(rowBytes);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  for (let r = 0; r < rows; r++) {
    const cur = data.subarray(r * rowBytes, (r + 1) * rowBytes);
    const prev = r > 0 ? data.subarray((r - 1) * rowBytes, r * rowBytes) : zero;
    let best = 0;
    let bestSum = Infinity;
    for (let t = 0; t < 5; t++) {
      const c = cand[t];
      let sum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0;
        const up = prev[i];
        const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
        let pred = 0;
        if (t === 1) pred = left;
        else if (t === 2) pred = up;
        else if (t === 3) pred = (left + up) >> 1;
        else if (t === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        const v = (cur[i] - pred) & 0xff;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = t;
      }
    }
    out[r * (rowBytes + 1)] = best;
    out.set(cand[best], r * (rowBytes + 1) + 1);
  }
  return out;
}

/** 標本を Flate で圧縮した画像のストリームにする */
function encodeImage(ctx: PDFContext, img: DecodedImage, width: number, height: number, dictEntries: [string, PDFObject][]): PDFRef {
  const rowBytes = Math.ceil((width * img.bpc * img.ncomp) / 8);
  let data = img.data;
  const entries = [...dictEntries];
  if (img.bpc === 8 && width > 1) {
    data = pngPredict(img.data, rowBytes, img.ncomp, height);
    entries.push(['DecodeParms', ctx.obj({ Predictor: 15, Colors: img.ncomp, BitsPerComponent: 8, Columns: width })]);
  }
  const stream = ctx.flateStream(data);
  for (const [k, v] of entries) stream.dict.set(PDFName.of(k), v);
  return ctx.register(stream);
}

interface ImageSource {
  dict: PDFDict;
  encoded: Uint8Array;
}

/** 画像（または SMask / Mask の画像）を復号し、範囲を塗って作り直す */
async function rebuildImage(
  rc: RedactionContext,
  src: ImageSource,
  ctm: Matrix,
  resources: ResourceEditor | undefined,
  role: 'image' | 'smask' | 'mask',
): Promise<{ ref: PDFRef; painted: number }> {
  const { ctx } = rc;
  const dict = src.dict;
  const width = getNum(ctx, dict, 'Width') ?? 0;
  const height = getNum(ctx, dict, 'Height') ?? 0;
  if (!(width > 0 && height > 0)) {
    throw new RedactionError(`${rc.pageNumber} 頁: 大きさの分からない画像があり、墨消しできません。`);
  }
  const isMask = role === 'mask' || (getBool(ctx, dict, 'ImageMask') ?? false);
  let bpc = isMask ? 1 : getNum(ctx, dict, 'BitsPerComponent') ?? 8;
  const csObj = get(ctx, dict, 'ColorSpace');
  let cs: ColorSpaceInfo | undefined;
  try {
    if (role === 'smask') cs = resolveColorSpace(ctx, PDFName.of('DeviceGray'));
    else if (!isMask && csObj !== undefined) cs = resolveColorSpace(ctx, csObj, resources);
  } catch (e) {
    throw new RedactionError(`${rc.pageNumber} 頁: 画像の色空間を読めないため、墨消しできません（${(e as Error).message}）。`);
  }

  const filter = getName(ctx, dict, 'Filter') ?? (() => {
    const arr = getArray(ctx, dict, 'Filter');
    const last = arr ? resolve(ctx, arr.get(arr.size() - 1)) : undefined;
    return last instanceof PDFName ? last.decodeText() : undefined;
  })();
  const isJpx = filter === 'JPXDecode';
  if (!isMask && !cs && !isJpx) {
    throw new RedactionError(`${rc.pageNumber} 頁: 色空間の無い画像があり、墨消しできません。`);
  }

  let decoded: DecodedImage;
  try {
    decoded = await decodeImageSamples(ctx, dict, src.encoded, { width, height, bpc, ncomp: isMask ? 1 : cs?.ncomp, isMask });
  } catch (e) {
    const name = filter ? FILTER_ABBREVIATIONS[filter] ?? filter : '圧縮なし';
    throw new RedactionError(`${rc.pageNumber} 頁: 画像（${name}）を読めないため、墨消しできません（${(e as Error).message}）。`);
  }
  bpc = decoded.bpc;

  let colorSpaceOut: PDFObject | undefined = csObj;
  if (isJpx && !cs) {
    const n = decoded.ncomp;
    const name = n === 1 ? 'DeviceGray' : n === 3 ? 'DeviceRGB' : n === 4 ? 'DeviceCMYK' : '';
    if (!name) throw new RedactionError(`${rc.pageNumber} 頁: 成分が ${n} の JPEG 2000 の画像は墨消しできません。`);
    cs = resolveColorSpace(ctx, PDFName.of(name));
    colorSpaceOut = PDFName.of(name);
  }
  if (!isMask && cs && decoded.ncomp !== cs.ncomp) {
    throw new RedactionError(`${rc.pageNumber} 頁: 画像の成分の数が色空間と合わないため、墨消しできません。`);
  }

  // 塗る値
  const decodeArr = numbersOf(ctx, getArray(ctx, dict, 'Decode'));
  let values: number[];
  if (isMask) {
    // 画像マスク: 「塗らない」側の値。Decode が [1 0] なら逆
    const inverted = decodeArr.length === 2 && decodeArr[0] === 1;
    values = role === 'mask' ? [0] : [inverted ? 0 : 1];
  } else if (role === 'smask') {
    values = sampleValues([1], decodeArr.length === 2 ? decodeArr : [0, 1], bpc);
  } else {
    // JPEG 2000 の Decode は無視される（ISO 32000-1 8.9.5.2 の注）ので既定を使う
    const dec = decodeArr.length === cs!.ncomp * 2 && !isJpx ? decodeArr : cs!.defaultDecode(bpc);
    values = sampleValues(cs!.darkest, dec, bpc);
  }

  const samples = new Samples(decoded, width);
  const painted = paint(samples, width, height, ctm, rc.rects, values);

  // 新しい画像の辞書。元の辞書から、描画に要るものだけを写す
  // （Alternates, Metadata, OPI, Measure など、元の画像の写しや情報を持ちうるものは写さない）
  const entries: [string, PDFObject][] = [
    ['Type', PDFName.of('XObject')],
    ['Subtype', PDFName.of('Image')],
    ['Width', PDFNumber.of(width)],
    ['Height', PDFNumber.of(height)],
  ];
  if (isMask) {
    // 画像マスク（Do で描く型）と、/Mask の型は、どちらも ImageMask のまま（色空間は持たない）
    entries.push(['ImageMask', PDFBool.True]);
    if (decodeArr.length === 2) entries.push(['Decode', ctx.obj(decodeArr)]);
  } else {
    entries.push(['BitsPerComponent', PDFNumber.of(bpc)]);
    if (role === 'smask') {
      entries.push(['ColorSpace', PDFName.of('DeviceGray')]);
      const matte = get(ctx, dict, 'Matte');
      if (matte) entries.push(['Matte', matte]);
      if (decodeArr.length === 2) entries.push(['Decode', ctx.obj(decodeArr)]);
    } else {
      entries.push(['ColorSpace', inlineCsToPdf(ctx, colorSpaceOut!, resources)]);
      if (decodeArr.length > 0 && !isJpx) entries.push(['Decode', ctx.obj(decodeArr)]);
    }
  }
  for (const key of ['Interpolate', 'Intent']) {
    const v = get(ctx, dict, key);
    if (v) entries.push([key, v]);
  }

  if (role === 'image') {
    const smask = get(ctx, dict, 'SMask');
    if (smask instanceof PDFStream) {
      const r = await rebuildImage(rc, { dict: smask.dict, encoded: rawContents(smask) }, ctm, undefined, 'smask');
      entries.push(['SMask', r.ref]);
    }
    const mask = get(ctx, dict, 'Mask');
    if (mask instanceof PDFStream) {
      const r = await rebuildImage(rc, { dict: mask.dict, encoded: rawContents(mask) }, ctm, undefined, 'mask');
      entries.push(['Mask', r.ref]);
    } else if (mask instanceof PDFArray) {
      entries.push(['Mask', mask]);
    }
  }

  return { ref: encodeImage(ctx, decoded, width, height, entries), painted };
}

/** インライン画像の色空間（略記や資源の名前）を、XObject に書ける形にする */
function inlineCsToPdf(ctx: PDFContext, cs: PDFObject, resources: ResourceEditor | undefined): PDFObject {
  const r = resolve(ctx, cs);
  if (r instanceof PDFName) {
    const n = r.decodeText();
    const full = ({ G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK' } as Record<string, string>)[n];
    if (full) return PDFName.of(full);
    if (['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(n)) return r;
    const res = resources?.lookupRaw('ColorSpace', n);
    if (res) return res;
    return r;
  }
  if (r instanceof PDFArray && r.size() > 0) {
    const head = resolve(ctx, r.get(0));
    if (head instanceof PDFName && head.decodeText() === 'I') {
      const arr = ctx.obj([]) as PDFArray;
      arr.push(PDFName.of('Indexed'));
      arr.push(inlineCsToPdf(ctx, r.get(1), resources));
      for (let i = 2; i < r.size(); i++) arr.push(r.get(i));
      return arr;
    }
  }
  return cs;
}

/** Do で描く画像の XObject を処理する。範囲にかからなければ null */
export async function redactImageXObject(
  rc: RedactionContext,
  image: PDFStream,
  ctm: Matrix,
  resources: ResourceEditor,
): Promise<PDFRef | null> {
  if (!rc.rects.some((r) => quadOverlapsRect(imageQuad(ctm), r))) return null;
  const { ref, painted } = await rebuildImage(rc, { dict: image.dict, encoded: rawContents(image) }, ctm, resources, 'image');
  if (painted === 0) return null;
  return ref;
}

/** インライン画像の略記のキーを正式名に */
const INLINE_KEYS: Record<string, string> = {
  W: 'Width', H: 'Height', BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms',
  F: 'Filter', IM: 'ImageMask', I: 'Interpolate', L: 'Length',
};

function operandToPdf(ctx: PDFContext, o: Operand, key?: string): PDFObject {
  switch (o.type) {
    case 'number': return PDFNumber.of(o.value);
    case 'bool': return o.value ? PDFBool.True : PDFBool.False;
    case 'null': return PDFNull;
    case 'name': {
      const v = key === 'Filter' ? FILTER_ABBREVIATIONS[o.value] ?? o.value : o.value;
      return PDFName.of(v);
    }
    case 'string':
      return o.hex
        ? PDFHexString.of(Array.from(o.bytes, (b) => b.toString(16).padStart(2, '0')).join(''))
        : PDFString.of(Array.from(o.bytes, (b) => String.fromCharCode(b)).join(''));
    case 'array': {
      const arr = ctx.obj([]) as PDFArray;
      for (const it of o.items) arr.push(operandToPdf(ctx, it, key));
      return arr;
    }
    case 'dict': {
      const d = ctx.obj({}) as PDFDict;
      for (const [k, v] of o.entries) d.set(PDFName.of(INLINE_KEYS[k] ?? k), operandToPdf(ctx, v));
      return d;
    }
  }
}

/**
 * インライン画像（BI … ID … EI）を処理する。範囲にかかれば、塗った画像を XObject として資源に足し、
 * それを描く Do 命令を返す（圧縮したデータの中に EI と同じ並びが現れて読み違えられるのを避けるため）。
 */
export async function redactInlineImage(
  rc: RedactionContext,
  op: Operation,
  resources: ResourceEditor,
  ctm: Matrix,
): Promise<Operation | null> {
  const inline = op.inlineImage;
  if (!inline) return null;
  if (!rc.rects.some((r) => quadOverlapsRect(imageQuad(ctm), r))) return null;
  const dict = rc.ctx.obj({}) as PDFDict;
  for (const [k, v] of inline.dict) {
    const key = INLINE_KEYS[k] ?? k;
    dict.set(PDFName.of(key), operandToPdf(rc.ctx, v, key));
  }
  const { ref, painted } = await rebuildImage(rc, { dict, encoded: inline.data }, ctm, resources, 'image');
  if (painted === 0) return null;
  rc.stats.imagesRedacted++;
  const name = resources.add('XObject', ref, 'RedactedInline');
  return { op: 'Do', operands: [{ type: 'name', value: name }] };
}
