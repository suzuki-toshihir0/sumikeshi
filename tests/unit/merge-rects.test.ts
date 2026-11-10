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

  it('斜めにずれて重なる範囲はまとめない（外接する矩形の角は、どちらの範囲でもない）', () => {
    const rects = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ];
    expect(mergeRects(rects)).toHaveLength(2);
  });

  it('別の行で長さの違う値（表の欄、ラベルの後ろの値）はまとめない（短い行の横にある字まで消してしまう）', () => {
    // 表の 3 行の値（隙間 4〜6pt）
    const table = [
      { x: 227.3, y: 728.1, width: 68.3, height: 20.8 },
      { x: 227.3, y: 699.3, width: 140.4, height: 22.9 },
      { x: 227.3, y: 674.2, width: 79.0, height: 21.3 },
    ];
    expect(mergeRects(table)).toHaveLength(3);
    // 「Name of employee: 〜」「Contact telephone: 〜」のように、ラベルの長さで値の始まりがずれる行
    const letter = [
      { x: 196.2, y: 480.5, width: 67.7, height: 13.2 },
      { x: 191.9, y: 460.3, width: 74.0, height: 13.2 },
    ];
    expect(mergeRects(letter)).toHaveLength(2);
  });

  it('L 字に重なる範囲はまとめない（外接する矩形にすると、どちらにも入っていない角まで消す）', () => {
    const rects = [
      { x: 0, y: 0, width: 100, height: 10 },
      { x: 0, y: 0, width: 10, height: 100 },
    ];
    expect(mergeRects(rects)).toHaveLength(2);
  });

  it('一方が他方を含むなら、外側の 1 つにする', () => {
    const rects = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 10, y: 10, width: 20, height: 20 },
    ];
    expect(mergeRects(rects)).toEqual([{ x: 0, y: 0, width: 100, height: 100 }]);
  });

  it('同じ字の矩形が高さ違いで二重にあるもの（テキストレイヤーの重なり）は 1 つにまとめる', () => {
    const rects = [376.7, 387.3, 397.7].flatMap((x) => [
      { x, y: 634.83, width: 11.07, height: 10.5 },
      { x, y: 634.54, width: 11.07, height: 11.77 },
    ]);
    const out = mergeRects(rects);
    expect(out).toHaveLength(1);
    expect(out[0].y).toBeCloseTo(634.54);
    expect(out[0].y + out[0].height).toBeCloseTo(646.31);
  });

  it('大きな範囲の端から小さな範囲がはみ出すときは、含むとみなさない（はみ出した分だけ前の行まで消してしまう）', () => {
    const rects = [
      { x: 365.2, y: 600.8, width: 22.6, height: 29.0 },
      { x: 387.3, y: 600.8, width: 5.5, height: 11.8 },
    ];
    expect(mergeRects(rects)).toHaveLength(2);
  });
});
