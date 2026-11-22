import type { PdfRect } from '../utils/coordinates';
import { RedactionError } from '../redaction/errors';
import type { ImageFormat, ImageOutput } from './image-format';
import { outputFor } from './image-format';
import { blackPixels, checkImageSize, countNotBlack, lossyCheckBox, meanAbsDiff, toPixelBox, type PixelBox } from './image-paint';

/** JPEG で書き出した範囲の内側で、黒とみなす各色の上限（一辺 16 画素以上の範囲の内側で、測った最大は 11） */
const JPEG_TOLERANCE = 24;
/** 書き出した画像の全体を、この大きさ以下に縮めて canvas と比べる */
const OVERALL_SIDE = 256;
/** 全体の比べで許す、色ごとの差の平均（JPEG の画質 0.95 で書き出したもの） */
const OVERALL_TOLERANCE = 6;

/**
 * 写真などの画像を 1 枚、手元の canvas に持つ。
 * 画素は canvas に描き直したものだけを持ち、元のファイルのバイト列（Exif の位置情報・縮小画像・XMP など）は持たない。
 * 書き出すときは canvas から圧縮し直すので、メタデータは入らない
 */
export class ImageDocument {
  readonly format: ImageFormat;
  readonly output: ImageOutput;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private constructor(format: ImageFormat, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.format = format;
    this.output = outputFor(format);
    this.canvas = canvas;
    this.ctx = ctx;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** 画像を読み、Exif の向きを当てて canvas に描く */
  static async decode(bytes: Uint8Array, format: ImageFormat): Promise<ImageDocument> {
    const source = await decodeToDrawable(bytes, format);
    try {
      checkImageSize(source.width, source.height);
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new RedactionError('画像を描く canvas を用意できませんでした。');
      ctx.drawImage(source.drawable, 0, 0);
      return new ImageDocument(format, canvas, ctx);
    } finally {
      source.close();
    }
  }

  /**
   * 範囲の画素を不透明の黒に置き換える（putImageData は下の画素と混ぜずに置き換える）。
   * 置き換えた後に読み直して、範囲がすべて黒になったことを確かめる
   */
  redact(rects: PdfRect[]): void {
    const boxes = this.boxesFor(rects);
    for (const b of boxes) {
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      this.ctx.putImageData(new ImageData(blackPixels(w, h), w, h), b.x0, b.y0);
    }
    for (const b of boxes) {
      const back = this.ctx.getImageData(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0).data;
      if (countNotBlack(back, 0) > 0) {
        throw new RedactionError('範囲を黒く塗れませんでした。画像を書き出していません。');
      }
    }
  }

  /**
   * 書き出す。書き出したものを読み直し、大きさと、範囲が黒いことと、全体が canvas と合っていることを確かめる
   * （ブラウザが canvas を黙って描けなかったときや、指紋の対策で書き出しを乱すときに、塗れていない画像を渡さないように）
   */
  async encode(redactedRects: PdfRect[]): Promise<Uint8Array> {
    const { mime, quality } = this.output;
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, mime, quality));
    if (!blob || blob.type !== mime) {
      throw new RedactionError('画像を書き出せませんでした。');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.verify(blob, this.boxesFor(redactedRects));
    return bytes;
  }

  /** 全体を OVERALL_SIDE 以下に縮めた画素（canvas と書き出した画像を同じやり方で縮める） */
  private thumbnail(source: CanvasImageSource): Uint8ClampedArray {
    const k = Math.min(1, OVERALL_SIDE / Math.max(this.width, this.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(this.width * k));
    c.height = Math.max(1, Math.round(this.height * k));
    const ctx = c.getContext('2d')!;
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  }

  private boxesFor(rects: PdfRect[]): PixelBox[] {
    return rects.map((r) => toPixelBox(r, this.width, this.height)).filter((b): b is PixelBox => b !== null);
  }

  private async verify(blob: Blob, boxes: PixelBox[]): Promise<void> {
    // 書き出した画像には向きの欄が無い。念のため向きを当てずに読む
    const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
    try {
      if (bmp.width !== this.width || bmp.height !== this.height) {
        throw new RedactionError('書き出した画像の大きさが元と合いません。画像を書き出していません。');
      }
      const lossy = this.output.mime === 'image/jpeg';
      // 1. 範囲ごと。PNG はすべての画素が黒。JPEG は一辺 16 画素以上の範囲の内側（小さな範囲は 2 で確かめる）
      for (const box of boxes) {
        const b = lossy ? lossyCheckBox(box) : box;
        if (!b) continue;
        const w = b.x1 - b.x0;
        const h = b.y1 - b.y0;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bmp, b.x0, b.y0, w, h, 0, 0, w, h);
        if (countNotBlack(ctx.getImageData(0, 0, w, h).data, lossy ? JPEG_TOLERANCE : 0) > 0) {
          throw new RedactionError('書き出した画像で、範囲が黒くなっていませんでした。画像を書き出していません。');
        }
      }
      // 2. 全体。縮めて canvas と比べ、書き出しそのものが乱れていないことを確かめる（範囲の大きさによらない）
      if (meanAbsDiff(this.thumbnail(this.canvas), this.thumbnail(bmp)) > OVERALL_TOLERANCE) {
        throw new RedactionError('書き出した画像が、墨消しした画像と合いませんでした。画像を書き出していません。');
      }
    } finally {
      bmp.close();
    }
  }
}

interface Drawable {
  drawable: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** 画像を読む。createImageBitmap で読めなければ img 要素で読む（HEIC は Safari の img でしか読めないことがある） */
async function decodeToDrawable(bytes: Uint8Array, format: ImageFormat): Promise<Drawable> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: `image/${format}` });
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { drawable: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    // 下で img 要素を試す
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // img 要素は、CSS の image-orientation の既定（from-image）で Exif の向きを当てた大きさになる
    return { drawable: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    const hint = format === 'heic' ? '（HEIC は Safari でだけ開けます。ほかのブラウザでは JPEG にしてから開いてください）' : '';
    throw new RedactionError(`この画像をブラウザで読めませんでした${hint}。`);
  }
}
