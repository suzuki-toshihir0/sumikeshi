import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  toPixelBox,
  displayCanvasSize,
  lossyCheckBox,
  countNotBlack,
  meanAbsDiff,
  checkImageSize,
  MAX_IMAGE_SIDE,
  MAX_IMAGE_AREA,
} from '../../src/image/image-paint';
import { detectFileKind } from '../../src/image/image-format';
import { imageViewport, cssToPdfRect, pdfToCssRect } from '../../src/utils/coordinates';
import { RedactionError } from '../../src/redaction/errors';

// 性質の試験（property-based testing）。入力を fast-check でランダムに作り、どの入力でも成り立つことを確かめる

/** 画像の大きさ（小さくして、画素を総当たりで比べられるようにする） */
const size = fc.integer({ min: 1, max: 40 });
/** 範囲の座標（画像の外や、画素の途中の値も含める） */
const coord = fc.double({ min: -20, max: 60, noNaN: true });
const extent = fc.double({ min: 0, max: 60, noNaN: true });
const rect = fc.record({ x: coord, y: coord, width: extent, height: extent });

/** 画素 (px, py)（py は上から）が、範囲（左下を原点）と正の面積で重なるか */
function overlaps(r: { x: number; y: number; width: number; height: number }, h: number, px: number, py: number): boolean {
  const bottom = h - py - 1;
  return px < r.x + r.width && px + 1 > r.x && bottom < r.y + r.height && bottom + 1 > r.y && r.width > 0 && r.height > 0;
}

describe('toPixelBox の性質', () => {
  it('箱に入る画素は、範囲と正の面積で重なる画素とちょうど一致する（墨消しの漏れも塗りすぎも無い）', () => {
    fc.assert(
      fc.property(size, size, rect, (w, h, r) => {
        const box = toPixelBox(r, w, h);
        for (let py = 0; py < h; py++) {
          for (let px = 0; px < w; px++) {
            const inBox = !!box && px >= box.x0 && px < box.x1 && py >= box.y0 && py < box.y1;
            if (inBox !== overlaps(r, h, px, py)) return false;
          }
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('箱は画像の中に収まり、空にならない', () => {
    fc.assert(
      fc.property(size, size, rect, (w, h, r) => {
        const box = toPixelBox(r, w, h);
        if (!box) return true;
        return box.x0 >= 0 && box.y0 >= 0 && box.x1 <= w && box.y1 <= h && box.x0 < box.x1 && box.y0 < box.y1;
      }),
    );
  });
});

describe('画像の表示の座標の性質', () => {
  const scale = fc.double({ min: 0.05, max: 4, noNaN: true });

  it('画素の範囲 → 画面 → 画素の範囲で、元に戻る', () => {
    fc.assert(
      fc.property(size, size, scale, rect, (w, h, s, r) => {
        const vp = imageViewport(w, h, s);
        const back = cssToPdfRect(pdfToCssRect(r, vp), vp);
        const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
        return close(back.x, r.x) && close(back.y, r.y) && close(back.width, r.width) && close(back.height, r.height);
      }),
    );
  });

  it('画像の四隅は、画面の四隅に写る', () => {
    fc.assert(
      fc.property(size, size, scale, (w, h, s) => {
        const vp = imageViewport(w, h, s);
        const [lx, ty] = vp.convertToViewportPoint(0, h);
        const [rx, by] = vp.convertToViewportPoint(w, 0);
        return lx === 0 && ty === 0 && Math.abs(rx - vp.width) < 1e-9 && Math.abs(by - vp.height) < 1e-9;
      }),
    );
  });
});

describe('displayCanvasSize の性質', () => {
  const css = fc.double({ min: 0.01, max: 100000, noNaN: true });
  const dpr = fc.double({ min: 0.5, max: 4, noNaN: true });

  it('canvas の上限を超えず、1 画素より小さくならず、表示の大きさ×DPR を超えない', () => {
    fc.assert(
      fc.property(css, css, dpr, (w, h, d) => {
        const s = displayCanvasSize(w, h, d);
        return (
          Number.isInteger(s.width) &&
          Number.isInteger(s.height) &&
          s.width >= 1 &&
          s.height >= 1 &&
          s.width <= MAX_IMAGE_SIDE &&
          s.height <= MAX_IMAGE_SIDE &&
          s.width * s.height <= MAX_IMAGE_AREA &&
          s.width <= Math.max(1, Math.floor(w * d)) &&
          s.height <= Math.max(1, Math.floor(h * d))
        );
      }),
    );
  });

  it('上限に収まるときは縮めない', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4000 }), fc.integer({ min: 1, max: 4000 }), (w, h) => {
        const s = displayCanvasSize(w, h, 1);
        return s.width === w && s.height === h;
      }),
    );
  });
});

describe('lossyCheckBox の性質', () => {
  const box = fc
    .record({ x0: fc.integer({ min: 0, max: 500 }), y0: fc.integer({ min: 0, max: 500 }), w: fc.integer({ min: 1, max: 300 }), h: fc.integer({ min: 1, max: 300 }) })
    .map(({ x0, y0, w, h }) => ({ x0, y0, x1: x0 + w, y1: y0 + h }));

  it('一辺 16 画素以上なら、元の箱の内側の空でない箱、それより小さければ null', () => {
    fc.assert(
      fc.property(box, (b) => {
        const side = Math.min(b.x1 - b.x0, b.y1 - b.y0);
        const c = lossyCheckBox(b);
        if (side < 16) return c === null;
        return !!c && c.x0 > b.x0 && c.y0 > b.y0 && c.x1 < b.x1 && c.y1 < b.y1 && c.x0 < c.x1 && c.y0 < c.y1;
      }),
    );
  });

  it('除く幅は端から 16 画素を超えない（大きな範囲の大部分を確かめる）', () => {
    fc.assert(
      fc.property(box, (b) => {
        const c = lossyCheckBox(b);
        if (!c) return true;
        return c.x0 - b.x0 <= 16 && c.y0 - b.y0 <= 16 && b.x1 - c.x1 <= 16 && b.y1 - c.y1 <= 16;
      }),
    );
  });
});

describe('画素の比べの性質', () => {
  const pixels = fc.array(fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)), { maxLength: 50 });
  const toData = (p: [number, number, number, number][]) => new Uint8ClampedArray(p.flat());
  const tolerance = fc.nat(255);

  it('countNotBlack は、1 画素ずつの定義と一致する', () => {
    fc.assert(
      fc.property(pixels, tolerance, (p, t) => {
        const expected = p.filter(([r, g, b, a]) => r > t || g > t || b > t || a !== 255).length;
        return countNotBlack(toData(p), t) === expected;
      }),
    );
  });

  it('meanAbsDiff は対称で、0 以上 255 以下、自分自身とは 0', () => {
    fc.assert(
      fc.property(pixels, pixels, (p, q) => {
        const n = Math.min(p.length, q.length);
        const a = toData(p.slice(0, n));
        const b = toData(q.slice(0, n));
        const d = meanAbsDiff(a, b);
        return d === meanAbsDiff(b, a) && d >= 0 && d <= 255 && meanAbsDiff(a, a) === 0;
      }),
    );
  });
});

describe('checkImageSize の性質', () => {
  it('上限の中なら通し、外なら RedactionError（ほかの例外は出さない）', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 20000 }), fc.integer({ min: -10, max: 20000 }), (w, h) => {
        const ok = w > 0 && h > 0 && w <= MAX_IMAGE_SIDE && h <= MAX_IMAGE_SIDE && w * h <= MAX_IMAGE_AREA;
        try {
          checkImageSize(w, h);
          return ok;
        } catch (e) {
          return !ok && e instanceof RedactionError;
        }
      }),
    );
  });
});

describe('detectFileKind の性質', () => {
  const tail = fc.uint8Array({ maxLength: 2000 });
  const sigs: [string, number[]][] = [
    ['jpeg', [0xff, 0xd8, 0xff]],
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ];

  it('どんなバイト列でも例外を出さない', () => {
    fc.assert(fc.property(tail, (b) => (detectFileKind(b), true)));
  });

  it('画像の印で始まれば、後ろに何があっても（%PDF- を含めても）その画像として読む', () => {
    for (const [format, sig] of sigs) {
      fc.assert(
        fc.property(tail, fc.boolean(), (t, withPdf) => {
          const pdf = withPdf ? new TextEncoder().encode('%PDF-1.7') : new Uint8Array();
          const bytes = new Uint8Array([...sig, ...pdf, ...t]);
          const kind = detectFileKind(bytes);
          return kind?.kind === 'image' && kind.format === format;
        }),
      );
    }
  });

  it('画像の印で始まらず、先頭の 1024 バイトの中に %PDF- があれば PDF', () => {
    const notImage = fc.uint8Array({ minLength: 12, maxLength: 1000 }).filter((b) => {
      const k = detectFileKind(b);
      return k === null;
    });
    fc.assert(
      fc.property(notImage, fc.nat(1019), (prefix, at) => {
        const pos = Math.min(at, prefix.length);
        const bytes = new Uint8Array([...prefix.slice(0, pos), ...new TextEncoder().encode('%PDF-'), ...prefix.slice(pos)]);
        // 前に置いたバイト列が、たまたま画像の印になる場合は除く
        const head = detectFileKind(bytes.slice(0, Math.max(12, pos)));
        if (head?.kind === 'image') return true;
        return detectFileKind(bytes)?.kind === 'pdf';
      }),
    );
  });
});
