import type { PdfRect } from '../utils/coordinates';

/** PDF の変換行列 [a b c d e f]。点 (x, y) は (a x + c y + e, b x + d y + f) に移る */
export type Matrix = [number, number, number, number, number, number];
export type Point = [number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 を先に、m2 を後にかける（PDF の「m1 × m2」） */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** 変換で長さが最大で何倍になるか（線幅の見積もりに使う） */
export function maxScale(m: Matrix): number {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return Math.max(sx, sy);
}

/** 点の集まりの外接矩形 */
export function boundsOf(points: Point[]): PdfRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 矩形 (x0,y0)-(x1,y1) を m で移した四隅 */
export function transformBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): Point[] {
  return [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
}

/** 2 つの矩形が、面積を持って重なるか */
export function rectsOverlap(a: PdfRect, b: PdfRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * 凸四角形（頂点の並び順は問わない平行四辺形など）と、軸にそろった矩形が重なるかを、
 * 分離軸の定理で判定する。辺が接するだけのときは重ならないとみなす。
 * 幅や高さが 0 の四角形（大きさ 0 の文字など）は、矩形の内側（境界を含む）にある点があれば重なるとみなす。
 */
export function quadOverlapsRect(quad: Point[], r: PdfRect): boolean {
  const b = boundsOf(quad);
  if (b.width === 0 || b.height === 0) {
    // 退化した四角形: 線分か点。矩形の閉包と交わるかで見る
    return b.x <= r.x + r.width && b.x + b.width >= r.x && b.y <= r.y + r.height && b.y + b.height >= r.y
      && segmentOrPointTouchesRect(quad, r);
  }
  if (!rectsOverlap(b, r)) return false;
  const rectPts: Point[] = [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]];
  // 四角形の各辺の法線を軸として調べる（矩形の軸は外接矩形の判定で済んでいる）
  for (let i = 0; i < quad.length; i++) {
    const [x1, y1] = quad[i];
    const [x2, y2] = quad[(i + 1) % quad.length];
    const nx = -(y2 - y1);
    const ny = x2 - x1;
    if (nx === 0 && ny === 0) continue;
    let qmin = Infinity, qmax = -Infinity, rmin = Infinity, rmax = -Infinity;
    for (const [x, y] of quad) {
      const p = x * nx + y * ny;
      qmin = Math.min(qmin, p);
      qmax = Math.max(qmax, p);
    }
    for (const [x, y] of rectPts) {
      const p = x * nx + y * ny;
      rmin = Math.min(rmin, p);
      rmax = Math.max(rmax, p);
    }
    if (qmax <= rmin || rmax <= qmin) return false;
  }
  return true;
}

function segmentOrPointTouchesRect(quad: Point[], r: PdfRect): boolean {
  // 退化した四角形の両端（外接矩形の対角）で作る線分を、矩形で切り取れるかで見る
  const b = boundsOf(quad);
  const seg = clipSegmentToRect([b.x, b.y], [b.x + b.width, b.y + b.height], r, true);
  return seg !== null;
}

/**
 * 線分 p0-p1 のうち、矩形 r の中にある部分を返す（Liang–Barsky）。
 * 無ければ null。closed=true なら境界に触れるだけでも返す。
 */
export function clipSegmentToRect(p0: Point, p1: Point, r: PdfRect, closed = false): [number, number] | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, p0[0] - r.x],
    [dx, r.x + r.width - p0[0]],
    [-dy, p0[1] - r.y],
    [dy, r.y + r.height - p0[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (closed ? q < 0 : q <= 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  if (closed ? t0 > t1 : t0 >= t1) return null;
  return [t0, t1];
}

/** 矩形 a から矩形 b を引いた残りを、重ならない矩形（最大 4 つ）で返す */
export function subtractRect(a: PdfRect, b: PdfRect): PdfRect[] {
  if (!rectsOverlap(a, b)) return [a];
  const out: PdfRect[] = [];
  const ax1 = a.x + a.width;
  const ay1 = a.y + a.height;
  const bx1 = b.x + b.width;
  const by1 = b.y + b.height;
  // 下
  if (b.y > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: b.y - a.y });
  // 上
  if (by1 < ay1) out.push({ x: a.x, y: by1, width: a.width, height: ay1 - by1 });
  const midY0 = Math.max(a.y, b.y);
  const midY1 = Math.min(ay1, by1);
  // 左
  if (b.x > a.x) out.push({ x: a.x, y: midY0, width: b.x - a.x, height: midY1 - midY0 });
  // 右
  if (bx1 < ax1) out.push({ x: bx1, y: midY0, width: ax1 - bx1, height: midY1 - midY0 });
  return out.filter((r) => r.width > 0 && r.height > 0);
}

/** 矩形を四方に広げる */
export function inflate(r: PdfRect, d: number): PdfRect {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d };
}
