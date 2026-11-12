import { describe, it, expect } from 'vitest';
import {
  multiply, apply, invert, quadOverlapsRect, transformBox, clipSegmentToRect, subtractRect, type Matrix,
} from '../../src/redaction/geometry';

describe('行列', () => {
  it('m1 を先にかける', () => {
    const scale: Matrix = [2, 0, 0, 2, 0, 0];
    const move: Matrix = [1, 0, 0, 1, 10, 0];
    expect(apply(multiply(scale, move), 1, 1)).toEqual([12, 2]);
    expect(apply(multiply(move, scale), 1, 1)).toEqual([22, 2]);
  });

  it('逆行列', () => {
    const m: Matrix = [0.24, 0, 0, -0.24, 0, 792];
    const inv = invert(m)!;
    const [x, y] = apply(m, 100, 200);
    const [bx, by] = apply(inv, x, y);
    expect(bx).toBeCloseTo(100);
    expect(by).toBeCloseTo(200);
    expect(invert([0, 0, 0, 0, 1, 1])).toBeNull();
  });
});

describe('四角形と矩形の重なり', () => {
  const r = { x: 10, y: 10, width: 10, height: 10 };
  it('軸にそろった四角形', () => {
    expect(quadOverlapsRect(transformBox([1, 0, 0, 1, 0, 0], 0, 0, 11, 11), r)).toBe(true);
    expect(quadOverlapsRect(transformBox([1, 0, 0, 1, 0, 0], 0, 0, 10, 10), r)).toBe(false); // 角が接するだけ
  });
  it('45 度回した四角形: 外接矩形は重なっても、実際は重ならない', () => {
    const c = Math.SQRT1_2;
    // 原点まわりに 45 度回した 1 辺 10 の正方形を (0, 0) に置く。外接矩形は (-7.07..7.07, 0..14.1)
    const quad = transformBox([c, c, -c, c, 3, 3], 0, 0, 10, 10);
    expect(quadOverlapsRect(quad, { x: 9, y: 0, width: 5, height: 5 })).toBe(false);
    expect(quadOverlapsRect(quad, { x: 0, y: 8, width: 2, height: 2 })).toBe(true);
  });
  it('幅 0 の四角形は、矩形の中にあれば重なる', () => {
    expect(quadOverlapsRect(transformBox([1, 0, 0, 1, 0, 0], 15, 12, 15, 18), r)).toBe(true);
    expect(quadOverlapsRect(transformBox([1, 0, 0, 1, 0, 0], 25, 12, 25, 18), r)).toBe(false);
  });
});

describe('線分の切り取り', () => {
  it('矩形を横切る線分', () => {
    const t = clipSegmentToRect([0, 15], [30, 15], { x: 10, y: 10, width: 10, height: 10 })!;
    expect(t[0]).toBeCloseTo(1 / 3);
    expect(t[1]).toBeCloseTo(2 / 3);
  });
  it('外れる線分', () => {
    expect(clipSegmentToRect([0, 0], [30, 0], { x: 10, y: 10, width: 10, height: 10 })).toBeNull();
  });
});

describe('矩形の引き算', () => {
  it('真ん中を抜くと 4 つ', () => {
    const out = subtractRect({ x: 0, y: 0, width: 30, height: 30 }, { x: 10, y: 10, width: 10, height: 10 });
    expect(out).toHaveLength(4);
    expect(out.reduce((s, r) => s + r.width * r.height, 0)).toBe(800);
  });
  it('重ならなければそのまま', () => {
    const a = { x: 0, y: 0, width: 5, height: 5 };
    expect(subtractRect(a, { x: 10, y: 10, width: 1, height: 1 })).toEqual([a]);
  });
});
