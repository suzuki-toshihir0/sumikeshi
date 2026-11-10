import { describe, it, expect } from 'vitest';
import { mergeRects } from '../../src/redaction/pdf-redactor';

describe('mergeRects', () => {
  it('同じ行で 1 文字ずつ並んだ範囲（語の間の空白を含む）は 1 つにまとめる', () => {
    const rects = [50, 58, 66, 74.7, 87, 95].map((x) => ({ x, y: 697, width: 7.5, height: 14 }));
    expect(mergeRects(rects)).toEqual([{ x: 50, y: 697, width: 52.5, height: 14 }]);
  });

  it('縦書きで 1 文字ずつ並んだ範囲は 1 つにまとめる', () => {
    const rects = [700, 686, 672].map((y) => ({ x: 100, y, width: 14, height: 14 }));
    expect(mergeRects(rects)).toEqual([{ x: 100, y: 672, width: 14, height: 42 }]);
  });

  it('別の行の範囲（横に長い矩形が縦に並ぶ）はまとめない', () => {
    const rects = [
      { x: 139, y: 622, width: 76, height: 19 },
      { x: 123, y: 579, width: 68, height: 19 },
    ];
    expect(mergeRects(rects)).toHaveLength(2);
  });

  it('重なる範囲はまとめる', () => {
    const rects = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ];
    expect(mergeRects(rects)).toEqual([{ x: 0, y: 0, width: 15, height: 15 }]);
  });
});
