/**
 * 文字選択で作った範囲の黒い四角を、文字の進む向きに、空いているところまで広げる。
 *
 * 文字選択の範囲は文字列の幅そのものなので、黒い四角の幅から消した文字列の幅が分かり、
 * 候補の名前の幅と比べると絞られる（Bland ら "Story Beyond the Eye: Glyph Positions Break PDF Text Redaction"）。
 * そこで、同じ行の次の字・線・画像・注釈の手前（何も無ければ頁の本文の端）まで広げる。
 * 広げた先には何も描かれていないので、範囲の外のものは消えない。
 * 同じ行で後ろに残る字の位置からは、幅がなお分かる（残す字を動かさない限り塞げない）。
 */
import type { Observed } from './content-redactor';
import type { Point } from './geometry';
import type { PdfRect } from '../utils/coordinates';

type Dir = '+x' | '-x' | '+y' | '-y';
/** 文字の進む向きを a、それと直交する向きを b とした箱 */
interface Canon { a0: number; a1: number; b0: number; b1: number }

function bbox(quad: Point[]): [number, number, number, number] {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function toCanon(dir: Dir, [x0, y0, x1, y1]: [number, number, number, number]): Canon {
  switch (dir) {
    case '+x': return { a0: x0, a1: x1, b0: y0, b1: y1 };
    case '-x': return { a0: -x1, a1: -x0, b0: y0, b1: y1 };
    case '+y': return { a0: y0, a1: y1, b0: -x1, b1: -x0 };
    case '-y': return { a0: -y1, a1: -y0, b0: x0, b1: x1 };
  }
}

function fromCanon(dir: Dir, c: Canon): [number, number, number, number] {
  switch (dir) {
    case '+x': return [c.a0, c.b0, c.a1, c.b1];
    case '-x': return [-c.a1, c.b0, -c.a0, c.b1];
    case '+y': return [-c.b1, c.a0, -c.b0, c.a1];
    case '-y': return [c.b0, -c.a1, c.b1, -c.a0];
  }
}

/** 範囲にかかる字の進む向き（軸に沿うものだけ。多数決で 8 割以上がそろうとき） */
function textDirection(rect: PdfRect, glyphs: Observed[]): Dir | null {
  const votes = new Map<Dir, number>();
  let total = 0;
  for (const g of glyphs) {
    const [x0, y0, x1, y1] = bbox(g.quad);
    const ix = Math.min(x1, rect.x + rect.width) - Math.max(x0, rect.x);
    const iy = Math.min(y1, rect.y + rect.height) - Math.max(y0, rect.y);
    if (ix <= 0 || iy <= 0 || !g.dir) continue;
    total++;
    const [dx, dy] = g.dir;
    const d: Dir | null = dx > 0.95 ? '+x' : dx < -0.95 ? '-x' : dy > 0.95 ? '+y' : dy < -0.95 ? '-y' : null;
    if (d) votes.set(d, (votes.get(d) ?? 0) + 1);
  }
  for (const [d, n] of votes) if (n >= total * 0.8 && n > 0) return d;
  return null;
}

/**
 * 文字選択の範囲（source が 'text'）を広げる。
 * observed: 頁に描かれるもの（何も消さずに中身を読んで集めたもの）、obstacles: 注釈の矩形など、ほかに止まるべきもの、
 * pageBox: 頁の見える範囲 [x0, y0, x1, y1]
 */
export function extendTextRects(
  rects: PdfRect[],
  observed: Observed[],
  obstacles: [number, number, number, number][],
  pageBox: [number, number, number, number],
): PdfRect[] {
  const glyphs = observed.filter((o) => o.kind === 'glyph');
  // 何も描かない字（空白）では止まらない（広げた範囲で消えるが、見た目も文字も変わらない）
  const boxes = observed.filter((o) => !o.blank).map((o) => ({ kind: o.kind, box: bbox(o.quad) }));
  for (const b of obstacles) boxes.push({ kind: 'path', box: b });
  return rects.map((rect) => {
    if (rect.source !== 'text') return rect;
    const dir = textDirection(rect, glyphs);
    if (!dir) return rect;
    const R = toCanon(dir, [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]);
    const thick = R.b1 - R.b0;
    // 隣の行の字の端が少しかかるくらいでは止まらないよう、帯は上下を 1 割ずつ狭める
    const bandLo = R.b0 + thick * 0.1;
    const bandHi = R.b1 - thick * 0.1;
    let limit = Infinity;
    let textEnd = R.a1;
    for (const { kind, box } of boxes) {
      const B = toCanon(dir, box);
      if (kind === 'glyph') textEnd = Math.max(textEnd, B.a1);
      // 範囲にかかるもの（消える）と、帯の外のものは見ない
      const overlaps = B.a0 < R.a1 && B.a1 > R.a0 && B.b0 < R.b1 && B.b1 > R.b0;
      if (overlaps) continue;
      if (B.b1 <= bandLo || B.b0 >= bandHi) continue;
      if (B.a0 < R.a1) continue; // 後ろ側
      limit = Math.min(limit, B.a0);
    }
    const page = toCanon(dir, pageBox);
    const margin = thick * 0.15;
    let end = limit < Infinity ? limit - margin : textEnd;
    end = Math.min(end, page.a1 - margin);
    if (!(end > R.a1)) return rect;
    const [x0, y0, x1, y1] = fromCanon(dir, { ...R, a1: end });
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, source: 'text' };
  });
}
