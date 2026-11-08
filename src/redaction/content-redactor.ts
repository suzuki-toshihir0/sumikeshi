/**
 * ContentStream を 1 命令ずつ追い、墨消しの範囲にかかる文字・パス・画像を、データごと消す。
 *
 * - 文字: 1 文字ずつ頁の上の箱を求め、範囲にかかる文字の符号を消す。
 *   消した文字の文字送りは TJ の数値で埋め、後ろの文字の位置を変えない。
 * - パス: 範囲にかかる部分を消す（直線の線は範囲の外の部分を残し、軸にそろった矩形の塗りは範囲を抜く）。
 * - 画像: 範囲にかかる画素を塗りつぶした新しい画像に差し替える（images/redact-image.ts）。
 * - Form XObject: 中身を同じように処理し、変わったら写しを作って差し替える。
 * - 範囲にかかった部分を囲む ActualText / Alt を消す。
 */
import { PDFContext, PDFDict, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import type { PdfRect } from '../utils/coordinates';
import type { Operand, Operation } from './content/lexer';
import { parseContentStream } from './content/lexer';
import { serializeOperations } from './content/writer';
import {
  type Matrix, type Point, IDENTITY, multiply, apply, invert, transformBox, quadOverlapsRect,
  boundsOf, rectsOverlap, inflate, clipSegmentToRect, subtractRect, maxScale, flattenCubic,
  subtractRectFromPolygon,
} from './geometry';
import { createFontModel, UnsupportedFontError, type FontModel } from './fonts/font-model';
import type { CMapLoader } from './fonts/cmap';
import { ResourceEditor } from './resources';
import { get, getArray, getName, numbersOf, resolve, streamBytes } from './pdf-objects';
import { RedactionError } from './errors';
import { redactImageXObject, redactInlineImage } from './images/redact-image';

export interface RedactionStats {
  glyphsRemoved: number;
  imagesRedacted: number;
  pathsRemoved: number;
  pathsTrimmed: number;
  formsRewritten: number;
}

export interface RedactionContext {
  ctx: PDFContext;
  rects: PdfRect[];
  cmapLoader?: CMapLoader;
  fontCache: Map<PDFDict, Promise<FontModel>>;
  stats: RedactionStats;
  /** 処理中の Form XObject（循環の検出） */
  formStack: Set<PDFStream>;
  /** エラーの文言に使う頁番号 */
  pageNumber: number;
}

interface GState {
  ctm: Matrix;
  font: { dict: PDFDict; name: string } | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  lineWidth: number;
}

function initialGState(ctm: Matrix): GState {
  return { ctm, font: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, lineWidth: 1 };
}

const num = (o: Operand | undefined): number => (o?.type === 'number' ? o.value : 0);
const numberOp = (value: number): Operand => ({ type: 'number', value });

interface Subpath {
  ops: Operation[];
  /** 頂点と制御点（ユーザー空間） */
  points: Point[];
  straight: boolean;
  closed: boolean;
  /** re で作った矩形（ユーザー空間） */
  rect?: [number, number, number, number];
}

const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);

interface MarkedContent {
  op: Operation;
  touched: boolean;
}

export interface ContentResult {
  ops: Operation[];
  changed: boolean;
}

/**
 * ContentStream の操作列を墨消しする。
 * resources は書き換えが必要なら写しが作られる（呼び出し側で editor.changed を見て差し替える）。
 */
export async function redactOperations(
  rc: RedactionContext,
  ops: Operation[],
  resources: ResourceEditor,
  initialCtm: Matrix,
  inherited?: Partial<GState>,
): Promise<ContentResult> {
  const out: Operation[] = [];
  let changed = false;
  let gs: GState = { ...initialGState(initialCtm), ...inherited, ctm: initialCtm };
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  /** 幅の分からない文字の後で、文字の位置が分からなくなっている */
  let positionUncertain = false;
  let subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let clipOp: Operation | null = null;
  const marked: MarkedContent[] = [];

  const markTouched = () => {
    for (const m of marked) m.touched = true;
  };

  const overlapsAny = (quad: Point[]) => rc.rects.some((r) => quadOverlapsRect(quad, r));

  const fontModel = async (): Promise<FontModel | null> => {
    if (!gs.font) return null;
    let p = rc.fontCache.get(gs.font.dict);
    if (!p) {
      p = createFontModel(rc.ctx, gs.font.dict, rc.cmapLoader);
      rc.fontCache.set(gs.font.dict, p);
    }
    try {
      return await p;
    } catch (e) {
      if (e instanceof UnsupportedFontError || (e as Error).name === 'UnsupportedCMapError' || e instanceof Error) {
        return null;
      }
      throw e;
    }
  };

  const setFont = (name: string, size: number) => {
    const f = resources.lookup('Font', name);
    gs.font = f instanceof PDFDict ? { dict: f, name } : null;
    gs.fontSize = size;
  };

  const lineMove = (tx: number, ty: number) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    positionUncertain = false;
  };

  /** 文字の位置が分からないとき、その先の文字が範囲にかかり得るかを、行の先まで伸ばした帯で調べる */
  const uncertainStripHits = (model: FontModel | null): boolean => {
    const trm = textRenderingMatrix();
    const L = 1e5;
    const quad = model?.vertical
      ? transformBox(trm, -0.5, -L, 0.5, 0.1)
      : transformBox(trm, -0.1, -0.3, L, 1.1);
    return overlapsAny(quad);
  };

  const textRenderingMatrix = (): Matrix =>
    multiply(multiply([gs.fontSize * gs.hScale, 0, 0, gs.fontSize, 0, gs.rise], tm), gs.ctm);

  const fontLabel = () => {
    const base = gs.font ? getName(rc.ctx, gs.font.dict, 'BaseFont') : undefined;
    return base ? `フォント ${base}` : 'フォント';
  };

  /** 文字を描く命令を処理し、範囲にかかる文字を消した命令を返す */
  const showText = async (elements: Operand[], original: Operation): Promise<Operation[]> => {
    const model = await fontModel();
    if (!model) {
      // フォントが読めない。位置が分からないので、範囲にかかり得るなら止める
      if (uncertainStripHits(null)) {
        throw new RedactionError(
          `${rc.pageNumber} 頁: ${fontLabel()} の文字の幅が読めないため、墨消しの範囲にかかる文字を正確に消せません。`,
        );
      }
      positionUncertain = true;
      return [original];
    }
    const tfs = gs.fontSize;
    const th = gs.hScale;
    const newArray: Operand[] = [];
    let removedAny = false;
    let pendingAdjust = 0;

    const pushAdjust = (n: number) => {
      if (n === 0) return;
      const last = newArray[newArray.length - 1];
      if (last?.type === 'number') last.value += n;
      else newArray.push(numberOp(n));
    };

    for (const el of elements) {
      if (el.type === 'number') {
        // TJ の数値: 1/1000 em 単位で、正なら左（縦書きなら上）へ戻る
        if (model.vertical) tm = multiply([1, 0, 0, 1, 0, (-el.value / 1000) * tfs], tm);
        else tm = multiply([1, 0, 0, 1, (-el.value / 1000) * tfs * th, 0], tm);
        pushAdjust(el.value);
        continue;
      }
      if (el.type !== 'string') continue;
      const codes = model.split(el.bytes);
      let keptStart = -1;
      let keptBytes: number[] = [];
      const flushKept = () => {
        if (keptBytes.length > 0) {
          if (pendingAdjust !== 0) {
            pushAdjust(pendingAdjust);
            pendingAdjust = 0;
          }
          newArray.push({ type: 'string', bytes: Uint8Array.from(keptBytes), hex: el.hex });
          keptBytes = [];
        }
        keptStart = -1;
      };
      for (const c of codes) {
        if (!model.widthKnown(c)) positionUncertain = true;
        let remove = false;
        if (positionUncertain) {
          if (uncertainStripHits(model)) {
            throw new RedactionError(
              `${rc.pageNumber} 頁: ${fontLabel()} の文字の幅が分からないため、墨消しの範囲にかかる文字を正確に消せません。`,
            );
          }
        } else {
          const [x0, y0, x1, y1] = model.box(c);
          const quad = transformBox(textRenderingMatrix(), x0, y0, x1, y1);
          remove = overlapsAny(quad);
        }
        const adv = model.advance(c);
        const spacing = gs.charSpacing + (model.isWordSpace(c) ? gs.wordSpacing : 0);
        if (model.vertical) {
          const ty = adv * tfs + spacing;
          tm = multiply([1, 0, 0, 1, 0, ty], tm);
          if (remove) {
            if (tfs === 0) throw new RedactionError(`${rc.pageNumber} 頁: 大きさ 0 の文字を消せません。`);
            flushKept();
            pendingAdjust += (-ty * 1000) / tfs;
          }
        } else {
          const tx = (adv * tfs + spacing) * th;
          tm = multiply([1, 0, 0, 1, tx, 0], tm);
          if (remove) {
            if (tfs * th === 0) throw new RedactionError(`${rc.pageNumber} 頁: 大きさ 0 の文字を消せません。`);
            flushKept();
            pendingAdjust += (-tx * 1000) / (tfs * th);
          }
        }
        if (remove) {
          removedAny = true;
          rc.stats.glyphsRemoved++;
        } else {
          if (keptStart < 0) keptStart = c.start;
          for (let i = 0; i < c.length; i++) keptBytes.push(el.bytes[c.start + i]);
        }
      }
      flushKept();
    }
    if (!removedAny) return [original];
    pushAdjust(pendingAdjust);
    markTouched();
    changed = true;
    return [{ op: 'TJ', operands: [{ type: 'array', items: newArray }] }];
  };

  const finishPath = (paint: Operation): Operation[] => {
    if (current) subpaths.push(current);
    const paths = subpaths;
    subpaths = [];
    current = null;
    const clip = clipOp;
    clipOp = null;

    const p = paint.op;
    const fill = ['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(p);
    const stroke = ['S', 's', 'B', 'B*', 'b', 'b*'].includes(p);
    const closesLast = ['s', 'b', 'b*'].includes(p);
    if (closesLast && paths.length > 0) paths[paths.length - 1].closed = true;

    const original = (): Operation[] => [...paths.flatMap((s) => s.ops), ...(clip ? [clip] : []), paint];
    if (p === 'n') return original(); // 切り抜きだけのパス（後述の制約: 形は変えない）

    const ctm = gs.ctm;
    const halfWidth = stroke ? (Math.max(gs.lineWidth, 0) * maxScale(ctm)) / 2 + 0.5 : 0;
    const inv = invert(ctm);
    const result: Operation[] = [];
    let modified = false;

    for (const sp of paths) {
      const devPts = sp.points.map(([x, y]) => apply(ctm, x, y));
      if (devPts.length === 0) {
        result.push(...sp.ops);
        continue;
      }
      const bounds = inflate(boundsOf(devPts), halfWidth);
      const hits = rc.rects.filter((r) => rectsOverlap(bounds, r));
      if (hits.length === 0) {
        result.push(...sp.ops);
        // s / b / b* は最後のサブパスを閉じる。塗りの命令を S / B / B* に変えるので、明示して閉じる
        if (closesLast && sp === paths[paths.length - 1] && sp.ops[sp.ops.length - 1]?.op !== 'h' && !sp.rect) {
          result.push({ op: 'h', operands: [] });
        }
        continue;
      }
      modified = true;
      if (!inv) {
        rc.stats.pathsRemoved++;
        continue;
      }
      const toUser = (q: Point): Operand[] => apply(inv, q[0], q[1]).map(numberOp);

      // 軸にそろった矩形の塗り: 範囲を抜いた残りの矩形にする
      const rectDev = axisAlignedRect(sp, ctm);
      if (fill && rectDev) {
        let pieces = [rectDev];
        for (const r of hits) pieces = pieces.flatMap((pc) => subtractRect(pc, r));
        for (const pc of pieces) {
          const corners: Point[] = [[pc.x, pc.y], [pc.x + pc.width, pc.y], [pc.x + pc.width, pc.y + pc.height], [pc.x, pc.y + pc.height]];
          result.push({ op: 'm', operands: toUser(corners[0]) });
          for (const q of corners.slice(1)) result.push({ op: 'l', operands: toUser(q) });
          result.push({ op: 'h', operands: [] });
        }
        rc.stats.pathsTrimmed++;
        continue;
      }

      // それ以外の形（曲線は折れ線にする）
      const poly = subpathPolyline(sp, ctm);
      if (fill) {
        // 塗り: 多角形から範囲を抜いた残りを、重ならない多角形で描く
        let pieces = [poly];
        for (const r of hits) pieces = pieces.flatMap((pc) => subtractRectFromPolygon(pc, r));
        for (const pc of pieces) {
          result.push({ op: 'm', operands: toUser(pc[0]) });
          for (const q of pc.slice(1)) result.push({ op: 'l', operands: toUser(q) });
          result.push({ op: 'h', operands: [] });
        }
      } else {
        // 線: 線分ごとに、範囲（線の太さの半分だけ広げる）の外の部分を残す
        const expanded = hits.map((r) => inflate(r, halfWidth));
        const segs: [Point, Point][] = [];
        for (let i = 0; i + 1 < poly.length; i++) segs.push([poly[i], poly[i + 1]]);
        if (sp.closed && poly.length > 2) segs.push([poly[poly.length - 1], poly[0]]);
        for (const [da, db] of segs) {
          for (const [t0, t1] of keptIntervals(da, db, expanded)) {
            const p0: Point = [da[0] + (db[0] - da[0]) * t0, da[1] + (db[1] - da[1]) * t0];
            const p1: Point = [da[0] + (db[0] - da[0]) * t1, da[1] + (db[1] - da[1]) * t1];
            result.push({ op: 'm', operands: toUser(p0) }, { op: 'l', operands: toUser(p1) });
          }
        }
      }
      rc.stats.pathsTrimmed++;
    }

    if (!modified) return original();
    changed = true;
    markTouched();
    const paintOp: Operation = closesLast ? { op: p === 's' ? 'S' : p === 'b' ? 'B' : 'B*', operands: [] } : paint;
    const ops: Operation[] = [];
    if (clip) {
      // 切り抜きは元の形のまま効かせ、塗りと線は書き換えた形で描く
      ops.push(...paths.flatMap((s) => s.ops), clip, { op: 'n', operands: [] });
    }
    if (result.length > 0) ops.push(...result, paintOp);
    return ops;
  };

  for (const o of ops) {
    const operands = o.operands;
    if (PATH_OPS.has(o.op)) {
      const pts = operands.map(num);
      if (o.op === 'm') {
        if (current) subpaths.push(current);
        current = { ops: [o], points: [[pts[0], pts[1]]], straight: true, closed: false };
      } else if (o.op === 're') {
        if (current) subpaths.push(current);
        const [x, y, w, h] = pts;
        subpaths.push({
          ops: [o], points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], straight: true, closed: true, rect: [x, y, w, h],
        });
        current = null;
      } else {
        if (!current) current = { ops: [], points: [], straight: true, closed: false };
        current.ops.push(o);
        if (o.op === 'h') current.closed = true;
        else {
          for (let i = 0; i + 1 < pts.length; i += 2) current.points.push([pts[i], pts[i + 1]]);
          if (o.op !== 'l') current.straight = false;
        }
      }
      continue;
    }
    if (o.op === 'W' || o.op === 'W*') {
      clipOp = o;
      continue;
    }
    if (PAINT_OPS.has(o.op)) {
      out.push(...finishPath(o));
      continue;
    }
    if (current || subpaths.length > 0) {
      // パスの途中に別の命令（不正だが実在する）。そのまま出す
      out.push(...subpaths.flatMap((s) => s.ops), ...(current ? current.ops : []), ...(clipOp ? [clipOp] : []));
      subpaths = [];
      current = null;
      clipOp = null;
    }

    switch (o.op) {
      case 'q':
        stack.push({ ...gs });
        out.push(o);
        break;
      case 'Q':
        if (stack.length > 0) gs = stack.pop()!;
        out.push(o);
        break;
      case 'cm':
        if (operands.length >= 6) gs.ctm = multiply(operands.slice(0, 6).map(num) as Matrix, gs.ctm);
        out.push(o);
        break;
      case 'w':
        gs.lineWidth = num(operands[0]);
        out.push(o);
        break;
      case 'gs': {
        const n = operands[0];
        if (n?.type === 'name') {
          const eg = resources.lookup('ExtGState', n.value);
          if (eg instanceof PDFDict) {
            const lw = get(rc.ctx, eg, 'LW');
            if (lw && 'asNumber' in lw) gs.lineWidth = (lw as unknown as { asNumber(): number }).asNumber();
            const fontArr = getArray(rc.ctx, eg, 'Font');
            if (fontArr && fontArr.size() >= 2) {
              const fd = resolve(rc.ctx, fontArr.get(0));
              const size = numbersOf(rc.ctx, fontArr)[1];
              if (fd instanceof PDFDict) {
                gs.font = { dict: fd, name: '(ExtGState)' };
                gs.fontSize = Number.isFinite(size) ? size : gs.fontSize;
              }
            }
          }
        }
        out.push(o);
        break;
      }
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        positionUncertain = false;
        out.push(o);
        break;
      case 'ET':
        out.push(o);
        break;
      case 'Tc': gs.charSpacing = num(operands[0]); out.push(o); break;
      case 'Tw': gs.wordSpacing = num(operands[0]); out.push(o); break;
      case 'Tz': gs.hScale = num(operands[0]) / 100; out.push(o); break;
      case 'TL': gs.leading = num(operands[0]); out.push(o); break;
      case 'Ts': gs.rise = num(operands[0]); out.push(o); break;
      case 'Tf':
        if (operands[0]?.type === 'name') setFont(operands[0].value, num(operands[1]));
        out.push(o);
        break;
      case 'Td':
        lineMove(num(operands[0]), num(operands[1]));
        out.push(o);
        break;
      case 'TD':
        gs.leading = -num(operands[1]);
        lineMove(num(operands[0]), num(operands[1]));
        out.push(o);
        break;
      case 'Tm':
        tlm = operands.slice(0, 6).map(num) as Matrix;
        tm = tlm;
        positionUncertain = false;
        out.push(o);
        break;
      case 'T*':
        lineMove(0, -gs.leading);
        out.push(o);
        break;
      case 'Tj':
        out.push(...(await showText(operands.slice(0, 1), o)));
        break;
      case 'TJ': {
        const arr = operands[0];
        out.push(...(await showText(arr?.type === 'array' ? arr.items : [], o)));
        break;
      }
      case "'": {
        lineMove(0, -gs.leading);
        const shown = await showText(operands.slice(0, 1), { op: 'Tj', operands: operands.slice(0, 1) });
        out.push({ op: 'T*', operands: [] }, ...shown);
        break;
      }
      case '"': {
        gs.wordSpacing = num(operands[0]);
        gs.charSpacing = num(operands[1]);
        lineMove(0, -gs.leading);
        const shown = await showText(operands.slice(2, 3), { op: 'Tj', operands: operands.slice(2, 3) });
        out.push(
          { op: 'Tw', operands: [operands[0]] },
          { op: 'Tc', operands: [operands[1]] },
          { op: 'T*', operands: [] },
          ...shown,
        );
        break;
      }
      case 'BDC':
      case 'BMC':
        marked.push({ op: o, touched: false });
        out.push(o);
        break;
      case 'EMC': {
        const m = marked.pop();
        if (m?.touched) stripMarkedContentText(rc, m.op, resources);
        out.push(o);
        break;
      }
      case 'Do': {
        const n = operands[0];
        if (n?.type !== 'name') {
          out.push(o);
          break;
        }
        const replaced = await handleXObject(rc, n.value, resources, gs);
        if (replaced) {
          changed = true;
          markTouched();
          if (replaced === 'remove') break;
          out.push({ op: 'Do', operands: [{ type: 'name', value: replaced }] });
        } else {
          out.push(o);
        }
        break;
      }
      case 'BI': {
        const replaced = await redactInlineImage(rc, o, resources, gs.ctm);
        if (replaced) {
          changed = true;
          markTouched();
          out.push(replaced);
        } else {
          out.push(o);
        }
        break;
      }
      default:
        out.push(o);
    }
  }
  // 閉じていない BDC が範囲にかかっていた場合も、文字の情報を消す
  for (const m of marked) if (m.touched) stripMarkedContentText(rc, m.op, resources);
  // 差し替えた元の画像・フォームは、資源に名前が残っていると保存されてしまうので外す
  const usedXObjects = new Set<string>();
  for (const o of out) {
    const n = o.operands[0];
    if (o.op === 'Do' && n?.type === 'name') usedXObjects.add(n.value);
  }
  resources.pruneUnused('XObject', usedXObjects);
  return { ops: out, changed };
}

/** パスが（CTM で移した後に）軸にそろった矩形なら、その矩形 */
function axisAlignedRect(sp: Subpath, ctm: Matrix): PdfRect | null {
  let pts: Point[];
  if (sp.rect) {
    const [x, y, w, h] = sp.rect;
    pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  } else {
    if (!sp.straight) return null;
    pts = sp.points.slice();
    if (pts.length === 5 && pts[0][0] === pts[4][0] && pts[0][1] === pts[4][1]) pts.pop();
    if (pts.length !== 4) return null;
  }
  const d = pts.map(([x, y]) => apply(ctm, x, y));
  const eps = 1e-6;
  for (let i = 0; i < 4; i++) {
    const a = d[i];
    const b = d[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > eps && Math.abs(a[1] - b[1]) > eps) return null;
  }
  const r = boundsOf(d);
  return r.width > 0 && r.height > 0 ? r : null;
}

/** サブパスを、頁の座標の折れ線にする（曲線は細かい直線に分ける） */
function subpathPolyline(sp: Subpath, ctm: Matrix): Point[] {
  if (sp.rect) {
    const [x, y, w, h] = sp.rect;
    return [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
  }
  const out: Point[] = [];
  let cur: Point = [0, 0];
  for (const o of sp.ops) {
    const n = o.operands.map((v) => (v.type === 'number' ? v.value : 0));
    const P = (i: number): Point => apply(ctm, n[i], n[i + 1]);
    switch (o.op) {
      case 'm':
      case 'l':
        cur = P(0);
        out.push(cur);
        break;
      case 'c': {
        const pts = flattenCubic(cur, P(0), P(2), P(4));
        out.push(...pts);
        cur = P(4);
        break;
      }
      case 'v': {
        const pts = flattenCubic(cur, cur, P(0), P(2));
        out.push(...pts);
        cur = P(2);
        break;
      }
      case 'y': {
        const pts = flattenCubic(cur, P(0), P(2), P(2));
        out.push(...pts);
        cur = P(2);
        break;
      }
    }
  }
  return out;
}

/** 線分のうち、どの矩形にも入らない部分を [t0, t1] の並びで返す */
function keptIntervals(a: Point, b: Point, rects: PdfRect[]): [number, number][] {
  let intervals: [number, number][] = [[0, 1]];
  for (const r of rects) {
    const cut = clipSegmentToRect(a, b, r, true);
    if (!cut) continue;
    const [c0, c1] = cut;
    const next: [number, number][] = [];
    for (const [s, e] of intervals) {
      if (c1 <= s || c0 >= e) {
        next.push([s, e]);
        continue;
      }
      if (c0 > s) next.push([s, c0]);
      if (c1 < e) next.push([c1, e]);
    }
    intervals = next;
  }
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return intervals.filter(([s, e]) => (e - s) * len > 1e-6);
}

/** BDC の属性から、文字の情報（ActualText, Alt, E）を消す */
function stripMarkedContentText(rc: RedactionContext, op: Operation, resources: ResourceEditor): void {
  if (op.op !== 'BDC') return;
  const props = op.operands[1];
  const keys = new Set(['ActualText', 'Alt', 'E']);
  if (props?.type === 'dict') {
    props.entries = props.entries.filter(([k]) => !keys.has(k));
    return;
  }
  if (props?.type === 'name') {
    const d = resources.lookup('Properties', props.value);
    if (!(d instanceof PDFDict)) return;
    if (![...keys].some((k) => d.has(PDFName.of(k)))) return;
    const copy = rc.ctx.obj({}) as PDFDict;
    for (const [k, v] of d.entries()) if (!keys.has(k.decodeText())) copy.set(k, v);
    const name = resources.add('Properties', rc.ctx.register(copy), 'RedactedMC');
    op.operands[1] = { type: 'name', value: name };
  }
}

/** Do の XObject を処理する。差し替えたら新しい名前、消すなら 'remove'、変えないなら null */
async function handleXObject(
  rc: RedactionContext,
  name: string,
  resources: ResourceEditor,
  gs: GState,
): Promise<string | 'remove' | null> {
  const raw = resources.lookupRaw('XObject', name);
  const xobj = resolve(rc.ctx, raw);
  if (!(xobj instanceof PDFStream)) return null;
  const subtype = getName(rc.ctx, xobj.dict, 'Subtype');

  if (subtype === 'Image') {
    const newRef = await redactImageXObject(rc, xobj, gs.ctm, resources);
    if (!newRef) return null;
    rc.stats.imagesRedacted++;
    return resources.add('XObject', newRef, 'RedactedIm');
  }

  if (subtype === 'Form') {
    if (rc.formStack.has(xobj)) return null; // 循環。ビューアーも描かない
    const matrix = numbersOf(rc.ctx, getArray(rc.ctx, xobj.dict, 'Matrix'));
    const fm: Matrix = matrix.length === 6 && matrix.every(Number.isFinite) ? (matrix as Matrix) : IDENTITY;
    const ctm = multiply(fm, gs.ctm);
    const formResDict = get(rc.ctx, xobj.dict, 'Resources');
    // Resources の無いフォームは、呼び出し元の資源を使う（古い PDF に多い）
    const formRes = new ResourceEditor(rc.ctx, formResDict instanceof PDFDict ? formResDict : resources.dict);
    let ops: Operation[];
    try {
      ops = parseContentStream(streamBytes(rc.ctx, xobj));
    } catch (e) {
      throw new RedactionError(`${rc.pageNumber} 頁: Form XObject /${name} の中身を読めません（${(e as Error).message}）。`);
    }
    rc.formStack.add(xobj);
    let result: ContentResult;
    try {
      result = await redactOperations(rc, ops, formRes, ctm, {
        font: gs.font, fontSize: gs.fontSize, charSpacing: gs.charSpacing, wordSpacing: gs.wordSpacing,
        hScale: gs.hScale, leading: gs.leading, rise: gs.rise, lineWidth: gs.lineWidth,
      });
    } finally {
      rc.formStack.delete(xobj);
    }
    if (!result.changed) return null;
    const dict = rc.ctx.obj({}) as PDFDict;
    for (const [k, v] of xobj.dict.entries()) {
      const key = k.decodeText();
      if (['Filter', 'DecodeParms', 'Length', 'Metadata', 'PieceInfo', 'LastModified', 'StructParent', 'StructParents'].includes(key)) continue;
      dict.set(k, v);
    }
    if (formRes.changed && formRes.dict) dict.set(PDFName.of('Resources'), formRes.dict);
    const stream = rc.ctx.flateStream(serializeOperations(result.ops));
    for (const [k, v] of dict.entries()) stream.dict.set(k, v);
    const ref: PDFRef = rc.ctx.register(stream);
    rc.stats.formsRewritten++;
    return resources.add('XObject', ref, 'RedactedFm');
  }

  if (subtype === 'PS') {
    // PostScript の XObject は PDF 1.4 以降で使われず、中身を解釈できない。描かれないので消す
    return 'remove';
  }
  return null;
}
