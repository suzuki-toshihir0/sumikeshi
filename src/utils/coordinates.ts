import type { PageViewport } from 'pdfjs-dist';

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
}

/** CSS座標 → PDF座標に変換 */
export function cssToPdfRect(cssRect: CssRect, viewport: PageViewport): PdfRect {
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
export function pdfToCssRect(pdfRect: PdfRect, viewport: PageViewport): CssRect {
  const [cssX1, cssY1] = viewport.convertToViewportPoint(pdfRect.x, pdfRect.y + pdfRect.height);
  const [cssX2, cssY2] = viewport.convertToViewportPoint(pdfRect.x + pdfRect.width, pdfRect.y);
  return {
    left: Math.min(cssX1, cssX2),
    top: Math.min(cssY1, cssY2),
    width: Math.abs(cssX2 - cssX1),
    height: Math.abs(cssY2 - cssY1),
  };
}
