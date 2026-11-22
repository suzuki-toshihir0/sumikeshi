import type { PageViewport } from 'pdfjs-dist';

/**
 * 表示の座標の変換に使う、PageViewport の一部。
 * 画像は pdf.js の頁ではないので、同じ形のものを `imageViewport` で作る（pdf.js は PageViewport を外に出していない）
 */
export type PageView = Pick<PageViewport, 'width' | 'height' | 'scale' | 'convertToPdfPoint' | 'convertToViewportPoint'>;

/** CSS座標系の矩形 */
export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** PDF座標系の矩形 (左下原点) */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 文字選択で作った範囲（黒い四角を、文字の進む向きに空いているところまで広げる） */
  source?: 'text';
}

/** CSS座標 → PDF座標に変換 */
export function cssToPdfRect(cssRect: CssRect, viewport: PageView): PdfRect {
  const [x1, y1] = viewport.convertToPdfPoint(cssRect.left, cssRect.top);
  const [x2, y2] = viewport.convertToPdfPoint(
    cssRect.left + cssRect.width,
    cssRect.top + cssRect.height,
  );
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** PDF座標 → CSS座標に変換 */
export function pdfToCssRect(pdfRect: PdfRect, viewport: PageView): CssRect {
  const [cssX1, cssY1] = viewport.convertToViewportPoint(pdfRect.x, pdfRect.y + pdfRect.height);
  const [cssX2, cssY2] = viewport.convertToViewportPoint(pdfRect.x + pdfRect.width, pdfRect.y);
  return {
    left: Math.min(cssX1, cssX2),
    top: Math.min(cssY1, cssY2),
    width: Math.abs(cssX2 - cssX1),
    height: Math.abs(cssY2 - cssY1),
  };
}

/**
 * 画像の表示の座標。PDF の頁と同じく左下を原点とし、1 画素を 1 単位とする
 * （範囲の選択・枠の表示・墨消しを、PDF と同じ形の矩形で扱えるように）
 */
export function imageViewport(imageWidth: number, imageHeight: number, scale: number): PageView {
  return {
    width: imageWidth * scale,
    height: imageHeight * scale,
    scale,
    convertToPdfPoint: (x: number, y: number) => [x / scale, imageHeight - y / scale],
    convertToViewportPoint: (x: number, y: number) => [x * scale, (imageHeight - y) * scale],
  };
}
