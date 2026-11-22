import type { PdfRect } from '../utils/coordinates';
import { RedactionError } from '../redaction/errors';

/**
 * 扱える画像の大きさ。iOS の Safari は canvas を 1 辺 8192 画素、面積 67,108,864 画素までしか持てず、
 * 超えると何も描かれない（iOS 17 までは 4096×4096）。黙って白い画像を書き出さないよう、ここで止める
 */
export const MAX_IMAGE_SIDE = 8192;
export const MAX_IMAGE_AREA = 8192 * 8192;

/** 画素の箱（x0・y0 を含み、x1・y1 を含まない。y は上から数える） */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 範囲（左下を原点、1 画素を 1 単位）を、画素の箱にする。
 * 一部でもかかる画素は入れ（外向きに丸める）、画像の外は切る。かからなければ null
 */
export function toPixelBox(rect: PdfRect, width: number, height: number): PixelBox | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y0 = Math.max(0, Math.floor(height - (rect.y + rect.height)));
  const y1 = Math.min(height, Math.ceil(height - rect.y));
  if (x0 >= x1 || y0 >= y1) return null;
  return { x0, y0, x1, y1 };
}

/** w×h 画素の不透明の黒（範囲の箱に putImageData で書き込む。putImageData は下の画素と混ぜずに置き換える） */
export function blackPixels(width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}

/** RGBA の画素の列のうち、黒（どの色も tolerance 以下で不透明）でない画素の数 */
export function countNotBlack(data: Uint8ClampedArray, tolerance: number): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > tolerance || data[i + 1] > tolerance || data[i + 2] > tolerance || data[i + 3] !== 255) n++;
  }
  return n;
}

/** 箱を四方から margin 画素だけ狭める。潰れたら null */
export function shrinkBox(box: PixelBox, margin: number): PixelBox | null {
  const b = { x0: box.x0 + margin, y0: box.y0 + margin, x1: box.x1 - margin, y1: box.y1 - margin };
  return b.x0 < b.x1 && b.y0 < b.y1 ? b : null;
}

/** canvas に載らない大きさの画像は止める */
export function checkImageSize(width: number, height: number): void {
  if (!(width > 0 && height > 0)) {
    throw new RedactionError('画像の大きさを読み取れませんでした。');
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_AREA) {
    throw new RedactionError(
      `画像が大きすぎます（${width}×${height} 画素）。ブラウザで扱えるのは 1 辺 ${MAX_IMAGE_SIDE} 画素まで、` +
        `面積 ${MAX_IMAGE_AREA.toLocaleString('ja-JP')} 画素までです。縮小してから開いてください。`,
    );
  }
}

/**
 * 表示用の canvas の画素数。表示の大きさ×DPR が canvas の上限を超えるとき（小さく細長い画像の拡大表示など）は、
 * 縦横比を保って上限まで縮める（表示の大きさは CSS で保つ）
 */
export function displayCanvasSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  const w = cssWidth * dpr;
  const h = cssHeight * dpr;
  const k = Math.min(1, MAX_IMAGE_SIDE / w, MAX_IMAGE_SIDE / h, Math.sqrt(MAX_IMAGE_AREA / (w * h)));
  return { width: Math.max(1, Math.floor(w * k)), height: Math.max(1, Math.floor(h * k)) };
}
