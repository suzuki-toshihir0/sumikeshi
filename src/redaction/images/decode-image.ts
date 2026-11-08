/**
 * 画像のデータを、フィルターを外して「画素の値の並び」（PDF の画像の標本の形）にする。
 *
 * - 汎用のフィルター（Flate など）と予測子: images/filters.ts
 * - JBIG2, JPEG, JPEG 2000: pdf.js の画像デコーダ（pdfjs-dist/image_decoders）
 * - CCITT（FAX 形式）: pdf.js から移植したデコーダ（vendor/pdfjs-ccitt.ts）
 *
 * 出力は 1 行ごとにバイト境界にそろえた標本の並び（ISO 32000-1 8.9.3）。
 */
import { PDFContext, PDFDict, PDFStream } from 'pdf-lib';
import { applyGenericFilter, filterSteps, IMAGE_FILTERS, UnsupportedFilterError, type FilterStep } from './filters';
import { getBool, getNum, get, streamBytes } from '../pdf-objects';
import { CCITTFaxDecoder } from '../vendor/pdfjs-ccitt';

export interface DecodedImage {
  /** 1 行ごとにバイト境界にそろえた標本 */
  data: Uint8Array;
  bpc: number;
  ncomp: number;
  /** JPEG 2000 で色空間が画像の中にしか無い場合の成分の数 */
  ncompFromData?: number;
}

type Decoders = typeof import('pdfjs-dist/image_decoders/pdf.image_decoders.mjs');
let decodersPromise: Promise<Decoders> | null = null;
function imageDecoders(): Promise<Decoders> {
  // 大きいので、使うときだけ読み込む
  decodersPromise ??= import('pdfjs-dist/image_decoders/pdf.image_decoders.mjs');
  return decodersPromise;
}

export interface ImageParams {
  width: number;
  height: number;
  bpc: number;
  /** 色空間の成分の数（画像マスクなら 1） */
  ncomp: number | undefined;
  isMask: boolean;
}

/** デコーダが返す Uint8ClampedArray なども、pdf-lib が受け取れる Uint8Array にそろえる */
function asUint8(a: ArrayBufferView): Uint8Array {
  return a instanceof Uint8Array && a.constructor === Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

function rowBytes(width: number, bpc: number, ncomp: number): number {
  return Math.ceil((width * bpc * ncomp) / 8);
}

function ensureLength(data: Uint8Array, expected: number): Uint8Array {
  if (data.length === expected) return data;
  if (data.length > expected) return data.subarray(0, expected);
  // 足りない分は 0 で埋める（ビューアーも同じように描く）
  const out = new Uint8Array(expected);
  out.set(data);
  return out;
}

function ccittDecode(ctx: PDFContext, params: PDFDict | undefined, data: Uint8Array, width: number, height: number): Uint8Array {
  let pos = 0;
  const source = { next: () => (pos < data.length ? data[pos++] : -1) };
  const decoder = new CCITTFaxDecoder(source, {
    K: getNum(ctx, params, 'K') ?? 0,
    EndOfLine: getBool(ctx, params, 'EndOfLine') ?? false,
    EncodedByteAlign: getBool(ctx, params, 'EncodedByteAlign') ?? false,
    Columns: getNum(ctx, params, 'Columns') ?? 1728,
    Rows: getNum(ctx, params, 'Rows') ?? 0,
    EndOfBlock: getBool(ctx, params, 'EndOfBlock') ?? true,
    BlackIs1: getBool(ctx, params, 'BlackIs1') ?? false,
  });
  const columns = getNum(ctx, params, 'Columns') ?? 1728;
  const expected = rowBytes(columns, 1, 1) * height;
  const out = new Uint8Array(expected);
  let n = 0;
  while (n < expected) {
    const c = decoder.readNextChar();
    if (c < 0) break;
    out[n++] = c;
  }
  if (columns === width) return out;
  // Columns と Width が違う（不正）: Width に合わせて詰め直す
  const src = rowBytes(columns, 1, 1);
  const dst = rowBytes(width, 1, 1);
  const fixed = new Uint8Array(dst * height);
  for (let y = 0; y < height; y++) fixed.set(out.subarray(y * src, y * src + Math.min(src, dst)), y * dst);
  return fixed;
}

async function applyImageFilter(
  ctx: PDFContext,
  step: FilterStep,
  data: Uint8Array,
  p: ImageParams,
  dict: PDFDict,
): Promise<DecodedImage> {
  switch (step.name) {
    case 'CCITTFaxDecode':
      return { data: ccittDecode(ctx, step.params, data, p.width, p.height), bpc: 1, ncomp: 1 };
    case 'JBIG2Decode': {
      const { Jbig2Image } = await imageDecoders();
      const chunks: { data: Uint8Array; start: number; end: number }[] = [];
      const globals = get(ctx, step.params, 'JBIG2Globals');
      if (globals instanceof PDFStream) {
        const g = streamBytes(ctx, globals);
        chunks.push({ data: g, start: 0, end: g.length });
      }
      chunks.push({ data, start: 0, end: data.length });
      const out = asUint8(new Jbig2Image().parseChunks(chunks));
      // JBIG2 は 1 が黒。PDF の画像の標本（DeviceGray で 0 が黒）に合わせて反転する（pdf.js と同じ）
      for (let i = 0; i < out.length; i++) out[i] ^= 0xff;
      return { data: out, bpc: 1, ncomp: 1 };
    }
    case 'DCTDecode': {
      const { JpegImage } = await imageDecoders();
      const colorTransform = getNum(ctx, step.params, 'ColorTransform');
      const jpeg = new JpegImage({ colorTransform: Number.isInteger(colorTransform) ? colorTransform : -1 });
      // 先頭にゴミがあるものは、最初の SOI（FF D8）まで読み飛ばす（pdf.js と同じ）
      let start = 0;
      while (start + 1 < data.length && !(data[start] === 0xff && data[start + 1] === 0xd8)) start++;
      jpeg.parse(start > 0 && start + 1 < data.length ? data.subarray(start) : data);
      const out = jpeg.getData({ width: p.width, height: p.height, forceRGB: false, isSourcePDF: true });
      return { data: asUint8(out), bpc: 8, ncomp: jpeg.numComponents };
    }
    case 'JPXDecode': {
      if (get(ctx, dict, 'SMaskInData') !== undefined && (getNum(ctx, dict, 'SMaskInData') ?? 0) !== 0) {
        throw new UnsupportedFilterError('透明度を中に持つ JPEG 2000 の画像（SMaskInData）は扱えない');
      }
      const { JpxImage } = await imageDecoders();
      // 成分の数を 0 にすると RGBA で返るので、色空間が無いときは画像の中の成分の数を渡す
      const ncompWanted = p.ncomp ?? JpxImage.parseImageProperties(data).componentsCount;
      const decoded = JpxImage.decode(data, { numComponents: ncompWanted, isIndexedColormap: false, smaskInData: false });
      if (!decoded) throw new UnsupportedFilterError(`成分が ${ncompWanted} の JPEG 2000 の画像は読めない`);
      const out = asUint8(decoded);
      // 成分ごとに間引いた画像などで、復号した大きさが辞書の幅・高さと合わないことがある。合わなければ塗る位置が狂うので止める
      if (out.length !== p.width * p.height * ncompWanted) {
        throw new UnsupportedFilterError(`JPEG 2000 の画像の大きさが辞書（${p.width}x${p.height}）と合わない`);
      }
      const ncomp = ncompWanted;
      return { data: out, bpc: 8, ncomp, ncompFromData: p.ncomp === undefined ? ncomp : undefined };
    }
  }
  throw new UnsupportedFilterError(`対応していない画像のフィルター ${step.name}`);
}

/**
 * 画像のデータを復号する。
 * 色空間の成分の数 p.ncomp は、JPEG 2000 で色空間が無い場合は undefined でよい。
 */
export async function decodeImageSamples(
  ctx: PDFContext,
  dict: PDFDict,
  encoded: Uint8Array,
  p: ImageParams,
): Promise<DecodedImage> {
  const steps = filterSteps(ctx, dict);
  let data = encoded;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (IMAGE_FILTERS.has(step.name)) {
      if (i !== steps.length - 1) throw new UnsupportedFilterError('画像のフィルターの後ろに別のフィルターがある');
      const decoded = await applyImageFilter(ctx, step, data, p, dict);
      const ncomp = p.isMask ? 1 : decoded.ncomp;
      return { ...decoded, ncomp, data: ensureLength(decoded.data, rowBytes(p.width, decoded.bpc, ncomp) * p.height) };
    }
    data = applyGenericFilter(ctx, step, data);
  }
  if (p.ncomp === undefined) throw new UnsupportedFilterError('画像の色空間が無い');
  return { data: ensureLength(data, rowBytes(p.width, p.bpc, p.ncomp) * p.height), bpc: p.bpc, ncomp: p.ncomp };
}
