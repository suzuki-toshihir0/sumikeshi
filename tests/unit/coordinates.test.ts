import { describe, it, expect } from 'vitest';
import { cssToPdfRect, pdfToCssRect } from '../../src/utils/coordinates';
import type { PageViewport } from 'pdfjs-dist';

/** テスト用の簡易viewport(スケール1、ページサイズ595x842) */
function createMockViewport(): PageViewport {
  // PDF座標: 左下原点、CSS座標: 左上原点
  const pageWidth = 595;
  const pageHeight = 842;
  const scale = 1;

  return {
    width: pageWidth * scale,
    height: pageHeight * scale,
    scale,
    convertToPdfPoint(cssX: number, cssY: number): [number, number] {
      return [cssX / scale, pageHeight - cssY / scale];
    },
    convertToViewportPoint(pdfX: number, pdfY: number): [number, number] {
      return [pdfX * scale, (pageHeight - pdfY) * scale];
    },
  } as unknown as PageViewport;
}

describe('coordinates', () => {
  const viewport = createMockViewport();

  describe('cssToPdfRect', () => {
    it('CSS座標をPDF座標に変換する', () => {
      const cssRect = { left: 50, top: 92, width: 200, height: 30 };
      const pdfRect = cssToPdfRect(cssRect, viewport);

      expect(pdfRect.x).toBeCloseTo(50);
      expect(pdfRect.y).toBeCloseTo(720); // 842 - 92 - 30 = 720
      expect(pdfRect.width).toBeCloseTo(200);
      expect(pdfRect.height).toBeCloseTo(30);
    });
  });

  describe('pdfToCssRect', () => {
    it('PDF座標をCSS座標に変換する', () => {
      const pdfRect = { x: 50, y: 720, width: 200, height: 30 };
      const cssRect = pdfToCssRect(pdfRect, viewport);

      expect(cssRect.left).toBeCloseTo(50);
      expect(cssRect.top).toBeCloseTo(92); // 842 - 720 - 30 = 92
      expect(cssRect.width).toBeCloseTo(200);
      expect(cssRect.height).toBeCloseTo(30);
    });
  });

  it('CSS→PDF→CSSのラウンドトリップで値が保存される', () => {
    const original = { left: 100, top: 200, width: 150, height: 40 };
    const pdfRect = cssToPdfRect(original, viewport);
    const roundTripped = pdfToCssRect(pdfRect, viewport);

    expect(roundTripped.left).toBeCloseTo(original.left);
    expect(roundTripped.top).toBeCloseTo(original.top);
    expect(roundTripped.width).toBeCloseTo(original.width);
    expect(roundTripped.height).toBeCloseTo(original.height);
  });
});
