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
import { ResourceEditor, shallowCopy } from './resources';
import { get, getArray, getName, numbersOf, resolve, streamBytes } from './pdf-objects';
import { RedactionError } from './errors';
import { redactImageXObject, redactInlineImage } from './images/redact-image';

export interface RedactionStats {
  glyphsRemoved: number;
  /** フォントから字形などを消したフォントの数 */
  fontsScrubbed?: number;
  glyphsScrubbed?: number;
  /** 字形を書き換えられず、フォントのデータごと外したフォントの数（見た目が変わりうる） */
  fontsUnembedded?: number;
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
  /** フォントごとの、消した文字の符号（後でフォントのデータから消すため） */
  removedCodes: Map<PDFDict, Set<number>>;
}

/** フォントを設定した命令（Tf の資源の名前か、gs の ExtGState の名前） */
interface FontRef {
  dict: PDFDict;
  name: string;
  via: 'Tf' | 'gs';
}

/** 出力の側（ビューアー）で今効いている文字の状態 */
interface EmitState {
  font: string | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

interface GState {
  ctm: Matrix;
  font: FontRef | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
  lineWidth: number;
  /**
   * 出力に書いた文字の状態。文字を消した BT…ET では、消した文字のためだけの状態の命令（Tz など）を
   * 書かずに飛ばすので、実際の状態とずれることがある。文字を描く前に合わせる
   */
  emit: EmitState;
}

const fontKey = (f: FontRef | null) => (f ? `${f.via}:${f.name}` : null);

function emitStateOf(g: Omit<GState, 'emit'>): EmitState {
  return {
    font: fontKey(g.font), fontSize: g.fontSize, charSpacing: g.charSpacing, wordSpacing: g.wordSpacing,
    hScale: g.hScale, leading: g.leading, rise: g.rise, renderMode: g.renderMode,
  };
}

function initialGState(ctm: Matrix): GState {
  const g = { ctm, font: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, renderMode: 0, lineWidth: 1 };
  return { ...g, emit: emitStateOf(g) };
}

const copyGState = (g: GState): GState => ({ ...g, emit: { ...g.emit } });

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

/** 中身が資源の中で使っている名前 */
export interface UsedNames {
  XObject: Set<string>;
  Properties: Set<string>;
  Font: Set<string>;
}

export interface ContentResult {
  ops: Operation[];
  changed: boolean;
  /** 書き換えた後の中身が使う名前（資源を持たない子の Form が親の資源から使う名前を含む） */
  used: UsedNames;
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
  gs.emit = inherited?.emit ? { ...inherited.emit } : emitStateOf(gs);
  /** 文字を消した BT…ET の中で、残る文字を絶対位置で置き直している */
  let rewriting = false;
  /** 出力の側の文字の位置が、実際とずれている（次に描く前に Tm を置く） */
  let needTm = false;
  /**
   * まだ出していない文字の状態・位置の命令。次の文字を残すと決まったら出し、消すと決まったら捨てる
   * （消す文字のためだけの Tz や Td を出力に残さないため）
   */
  let pendingText: (Operation & { leadingUsed?: number })[] = [];
  /** 文字の形で切り抜く描き方（Tr 4〜7）の字を、この BT の中で消した／残した */
  let clipGlyphRemoved = false;
  let clipGlyphKept = false;
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  /** 幅の分からない文字の後で、文字の位置が分からなくなっている */
  let positionUncertain = false;
  let subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let clipOp: Operation | null = null;
  const marked: MarkedContent[] = [];
  /** 資源を持たない子の Form が、この資源から使っている名前 */
  const inheritedUse: UsedNames = { XObject: new Set(), Properties: new Set(), Font: new Set() };

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
    gs.font = f instanceof PDFDict ? { dict: f, name, via: 'Tf' } : null;
    gs.fontSize = size;
  };

  const n = (value: number): Operand => numberOp(value);

  /** 出力の側の文字の状態を、実際の状態に合わせる命令を書く */
  const syncState = (opts: { leadingOnly?: boolean } = {}) => {
    const e = gs.emit;
    if (!opts.leadingOnly) {
      const key = fontKey(gs.font);
      if (gs.font && (key !== e.font || gs.fontSize !== e.fontSize)) {
        if (gs.font.via === 'Tf') out.push({ op: 'Tf', operands: [{ type: 'name', value: gs.font.name }, n(gs.fontSize)] });
        else out.push({ op: 'gs', operands: [{ type: 'name', value: gs.font.name }] });
        e.font = key;
        e.fontSize = gs.fontSize;
      }
      if (gs.charSpacing !== e.charSpacing) out.push({ op: 'Tc', operands: [n(gs.charSpacing)] });
      if (gs.wordSpacing !== e.wordSpacing) out.push({ op: 'Tw', operands: [n(gs.wordSpacing)] });
      if (gs.hScale !== e.hScale) out.push({ op: 'Tz', operands: [n(gs.hScale * 100)] });
      if (gs.rise !== e.rise) out.push({ op: 'Ts', operands: [n(gs.rise)] });
      if (gs.renderMode !== e.renderMode) out.push({ op: 'Tr', operands: [n(gs.renderMode)] });
      Object.assign(e, { charSpacing: gs.charSpacing, wordSpacing: gs.wordSpacing, hScale: gs.hScale, rise: gs.rise, renderMode: gs.renderMode });
    }
    if (gs.leading !== e.leading) {
      out.push({ op: 'TL', operands: [n(gs.leading)] });
      e.leading = gs.leading;
    }
  };

  /** 文字の状態の命令: 実際の状態に反映し、出すのは後（flushPending）に回す */
  const stateOp = (o: Operation, apply: () => void) => {
    apply();
    if (!rewriting) pendingText.push(o);
  };

  /** 溜めた命令を出す。出力の側の状態も合わせて進める */
  const flushPending = () => {
    const e = gs.emit;
    for (const p of pendingText) {
      const a = p.operands;
      switch (p.op) {
        case 'Tc': e.charSpacing = num(a[0]); break;
        case 'Tw': e.wordSpacing = num(a[0]); break;
        case 'Tz': e.hScale = num(a[0]) / 100; break;
        case 'TL': e.leading = num(a[0]); break;
        case 'Ts': e.rise = num(a[0]); break;
        case 'Tr': e.renderMode = num(a[0]); break;
        case 'Tf':
          if (a[0]?.type === 'name') e.font = `Tf:${a[0].value}`;
          e.fontSize = num(a[1]);
          break;
        case 'TD': e.leading = -num(a[1]); break;
        case 'T*':
          // T* は出力の側の行送り（TL）で動くので、元の命令のときの値に合わせる
          if (p.leadingUsed !== undefined && p.leadingUsed !== e.leading) {
            out.push({ op: 'TL', operands: [n(p.leadingUsed)] });
            e.leading = p.leadingUsed;
          }
          break;
      }
      out.push({ op: p.op, operands: p.operands });
    }
    pendingText = [];
  };

  /** 溜めた命令を捨てる。位置の命令を捨てたら、次に描く前に絶対位置を置く */
  const discardPending = () => {
    if (pendingText.some((p) => ['Td', 'TD', 'Tm', 'T*'].includes(p.op))) needTm = true;
    pendingText = [];
  };

  /** 書き直しの途中で、残る文字のかたまりの前に絶対位置を置く */
  const placeIfNeeded = () => {
    if (!needTm) return;
    out.push({ op: 'Tm', operands: tm.map(n) });
    needTm = false;
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

  /**
   * 文字を描く命令を処理し、範囲にかかる文字を消して out に書く。
   * 最初に文字を消したところから、その BT…ET の終わりまでは「書き直し」に入り、
   * 残る文字のかたまりごとに絶対位置（Tm）を置く。消した文字の送りの幅や字数、
   * 消した文字のためだけの状態（Tz など）は出力に残らない。
   */
  const showText = async (elements: Operand[], original: Operation): Promise<void> => {
    const model = await fontModel();
    if (!model) {
      // フォントが読めない。位置が分からないので、範囲にかかり得るなら止める
      if (uncertainStripHits(null)) {
        throw new RedactionError(
          `${rc.pageNumber} 頁: ${fontLabel()} の文字の幅が読めないため、墨消しの範囲にかかる文字を正確に消せません。`,
        );
      }
      flushPending();
      syncState();
      if (rewriting) placeIfNeeded();
      out.push(original);
      positionUncertain = true;
      return;
    }
    const tfs = gs.fontSize;
    const th = gs.hScale;
    /** 書き直しに入る前の、元の位置のまま出す部分 */
    let prefix: Operand[] = [];
    /** 書き直しの途中の、残る文字のかたまり */
    let run: Operand[] = [];
    let runStarted = false;

    const pushInto = (arr: Operand[], o: Operand) => {
      const last = arr[arr.length - 1];
      if (o.type === 'number' && last?.type === 'number') last.value += o.value;
      else arr.push(o);
    };
    const flushRun = () => {
      // かたまりの末尾の数値（次の文字までの移動）は、次の Tm が置き直すので出さない
      while (run.length > 0 && run[run.length - 1].type === 'number') run.pop();
      if (run.some((x) => x.type === 'string')) out.push({ op: 'TJ', operands: [{ type: 'array', items: run }] });
      run = [];
      runStarted = false;
    };
    const flushPrefix = () => {
      while (prefix.length > 0 && prefix[prefix.length - 1].type === 'number') prefix.pop();
      if (prefix.some((x) => x.type === 'string')) out.push({ op: 'TJ', operands: [{ type: 'array', items: prefix }] });
      prefix = [];
    };
    const startRewriting = () => {
      // この命令でまだ何も残していなければ、溜めた状態・位置の命令は消す文字のためのものなので捨てる
      if (!prefix.some((x) => x.type === 'string')) discardPending();
      flushPrefix();
      rewriting = true;
      needTm = true;
    };
    const keep = (bytes: number[], hex: boolean) => {
      if (rewriting) {
        if (!runStarted) {
          syncState();
          placeIfNeeded();
          runStarted = true;
        }
        const last = run[run.length - 1];
        if (last?.type === 'string' && last.hex === hex) last.bytes = Uint8Array.from([...last.bytes, ...bytes]);
        else run.push({ type: 'string', bytes: Uint8Array.from(bytes), hex });
      } else {
        if (!prefix.some((x) => x.type === 'string')) {
          // 残す文字が出る: 溜めた命令を出してから、元の位置のまま描く（TJ の先頭の数値は、その後ろに置く）
          const leading = prefix;
          prefix = [];
          flushPending();
          syncState();
          prefix = leading;
        }
        const last = prefix[prefix.length - 1];
        if (last?.type === 'string' && last.hex === hex) last.bytes = Uint8Array.from([...last.bytes, ...bytes]);
        else prefix.push({ type: 'string', bytes: Uint8Array.from(bytes), hex });
      }
    };

    let removedAny = false;
    for (const el of elements) {
      if (el.type === 'number') {
        // TJ の数値: 1/1000 em 単位で、正なら左（縦書きなら上）へ戻る
        if (model.vertical) tm = multiply([1, 0, 0, 1, 0, (-el.value / 1000) * tfs], tm);
        else tm = multiply([1, 0, 0, 1, (-el.value / 1000) * tfs * th, 0], tm);
        if (rewriting) {
          if (runStarted) pushInto(run, numberOp(el.value));
          else needTm = true;
        } else {
          pushInto(prefix, numberOp(el.value));
        }
        continue;
      }
      if (el.type !== 'string') continue;
      for (const c of model.split(el.bytes)) {
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
          remove = overlapsAny(transformBox(textRenderingMatrix(), x0, y0, x1, y1));
        }
        if (remove) {
          if (!rewriting) startRewriting();
          else flushRun();
          needTm = true;
          removedAny = true;
          rc.stats.glyphsRemoved++;
          if (gs.renderMode >= 4) clipGlyphRemoved = true;
          if (gs.font) {
            let set = rc.removedCodes.get(gs.font.dict);
            if (!set) rc.removedCodes.set(gs.font.dict, (set = new Set()));
            set.add(c.code);
          }
        } else {
          keep(Array.from(el.bytes.subarray(c.start, c.start + c.length)), el.hex);
          if (gs.renderMode >= 4) clipGlyphKept = true;
        }
        const adv = model.advance(c);
        const spacing = gs.charSpacing + (model.isWordSpace(c) ? gs.wordSpacing : 0);
        if (model.vertical) tm = multiply([1, 0, 0, 1, 0, adv * tfs + spacing], tm);
        else tm = multiply([1, 0, 0, 1, (adv * tfs + spacing) * th, 0], tm);
      }
    }
    if (!removedAny && !rewriting) {
      // 何も消さなかった: 元の命令をそのまま出す
      flushPending();
      syncState();
      out.push(original);
      return;
    }
    if (rewriting) flushRun();
    flushPrefix();
    if (removedAny) {
      markTouched();
      changed = true;
    }
  };

  const finishPath = (paint: Operation): Operation[] => {
    if (current) subpaths.push(current);
    const paths = subpaths;
    subpaths = [];
    current = null;
    const clip = clipOp;
    clipOp = null;

    const p = paint.op;
    // n（塗らない）は、切り抜き（W n）の形を作るときに使う。形は塗りと同じく範囲を抜く
    const clipOnly = p === 'n';
    const fill = clipOnly || ['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(p);
    const stroke = ['S', 's', 'B', 'B*', 'b', 'b*'].includes(p);
    const closesLast = ['s', 'b', 'b*'].includes(p);
    if (closesLast && paths.length > 0) paths[paths.length - 1].closed = true;

    const original = (): Operation[] => [...paths.flatMap((s) => s.ops), ...(clip ? [clip] : []), paint];

    const ctm = gs.ctm;
    const halfWidth = stroke ? (Math.max(gs.lineWidth, 0) * maxScale(ctm)) / 2 + 0.5 : 0;
    const inv = invert(ctm);
    const result: Operation[] = [];
    /** 塗りと線の両方を描く（B など）とき、線の側。切り口に線を引かないよう、塗りと分けて描く */
    const fillAndStroke = fill && stroke && !clipOnly;
    const strokeResult: Operation[] = [];
    let modified = false;

    /** 線: 線分ごとに、範囲（線の太さの半分だけ広げる）の外の部分を残す */
    const trimStroke = (sp: Subpath, hits: PdfRect[], into: Operation[], toUser: (q: Point) => Operand[]) => {
      const poly = subpathPolyline(sp, ctm);
      const expanded = hits.map((r) => inflate(r, halfWidth));
      const segs: [Point, Point][] = [];
      for (let i = 0; i + 1 < poly.length; i++) segs.push([poly[i], poly[i + 1]]);
      if (sp.closed && poly.length > 2) segs.push([poly[poly.length - 1], poly[0]]);
      for (const [da, db] of segs) {
        for (const [t0, t1] of keptIntervals(da, db, expanded)) {
          const p0: Point = [da[0] + (db[0] - da[0]) * t0, da[1] + (db[1] - da[1]) * t0];
          const p1: Point = [da[0] + (db[0] - da[0]) * t1, da[1] + (db[1] - da[1]) * t1];
          into.push({ op: 'm', operands: toUser(p0) }, { op: 'l', operands: toUser(p1) });
        }
      }
    };

    for (const sp of paths) {
      const devPts = sp.points.map(([x, y]) => apply(ctm, x, y));
      const keepAsIs = () => {
        const ops = [...sp.ops];
        // s / b / b* は最後のサブパスを閉じる。塗りの命令を S / B / B* に変えるので、明示して閉じる
        if (closesLast && sp === paths[paths.length - 1] && sp.ops[sp.ops.length - 1]?.op !== 'h' && !sp.rect) {
          ops.push({ op: 'h', operands: [] });
        }
        result.push(...ops);
        if (fillAndStroke) strokeResult.push(...ops);
      };
      if (devPts.length === 0) {
        keepAsIs();
        continue;
      }
      const bounds = inflate(boundsOf(devPts), halfWidth);
      const hits = rc.rects.filter((r) => rectsOverlap(bounds, r));
      if (hits.length === 0) {
        keepAsIs();
        continue;
      }
      modified = true;
      if (!inv) {
        rc.stats.pathsRemoved++;
        continue;
      }
      const toUser = (q: Point): Operand[] => apply(inv, q[0], q[1]).map(numberOp);
      if (fillAndStroke) trimStroke(sp, hits, strokeResult, toUser);

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
        trimStroke(sp, hits, result, toUser);
      }
      rc.stats.pathsTrimmed++;
    }

    if (!modified) return original();
    changed = true;
    markTouched();
    if (clipOnly) {
      // 切り抜きの形から範囲を抜く。範囲の中は黒い四角で隠れるので、そこが切り抜きの外になっても見た目は変わらない。
      // 形が全部無くなったら、大きさ 0 の矩形で切り抜く（元の切り抜きは範囲の中だけだったので、外には何も見えていなかった）
      const shape = result.length > 0 ? result : [{ op: 're', operands: [0, 0, 0, 0].map(numberOp) }];
      return [...shape, ...(clip ? [clip] : []), paint];
    }
    const paintOp: Operation = closesLast ? { op: p === 's' ? 'S' : p === 'b' ? 'B' : 'B*', operands: [] } : paint;
    const ops: Operation[] = [];
    if (clip) {
      // 切り抜きは元の形のまま効かせ、塗りと線は書き換えた形で描く
      ops.push(...paths.flatMap((s) => s.ops), clip, { op: 'n', operands: [] });
    }
    if (fillAndStroke) {
      // 塗り（範囲を抜いた形）と、線（元の輪郭の範囲の外の部分）を分けて描く
      const fillOp = p === 'B*' || p === 'b*' ? 'f*' : 'f';
      if (result.length > 0) ops.push(...result, { op: fillOp, operands: [] });
      if (strokeResult.length > 0) ops.push(...strokeResult, { op: 'S', operands: [] });
      return ops;
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

    // 文字の状態を読み書きする命令の前では、溜めた命令を先に出す（順番を保つ）
    if (['q', 'Q', 'gs', 'Do', 'BI', 'EI', 'd0', 'd1'].includes(o.op)) flushPending();

    switch (o.op) {
      case 'q':
        stack.push(copyGState(gs));
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
                gs.font = { dict: fd, name: n.value, via: 'gs' };
                gs.fontSize = Number.isFinite(size) ? size : gs.fontSize;
                // gs は書き直しの途中でも出すので、出力の側のフォントも変わる
                gs.emit.font = fontKey(gs.font);
                gs.emit.fontSize = gs.fontSize;
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
        rewriting = false;
        needTm = false;
        clipGlyphRemoved = false;
        clipGlyphKept = false;
        out.push(o);
        break;
      case 'ET':
        // 最後の文字の後の状態・位置の命令は、描く文字が無いので出さない（後で要れば syncState で合わせる）
        pendingText = [];
        rewriting = false;
        needTm = false;
        out.push(o);
        if (clipGlyphRemoved && !clipGlyphKept) {
          // 切り抜きに使う字を全部消した。ビューアーは字が無ければ切り抜きを変えないので、
          // 元のとおり「字の形の中だけ」に近づけるため、大きさ 0 の切り抜きを置く（字はすべて範囲にかかっていた）
          out.push({ op: 're', operands: [0, 0, 0, 0].map(numberOp) }, { op: 'W', operands: [] }, { op: 'n', operands: [] });
        }
        break;
      case 'Tc': stateOp(o, () => { gs.charSpacing = num(operands[0]); }); break;
      case 'Tw': stateOp(o, () => { gs.wordSpacing = num(operands[0]); }); break;
      case 'Tz': stateOp(o, () => { gs.hScale = num(operands[0]) / 100; }); break;
      case 'TL': stateOp(o, () => { gs.leading = num(operands[0]); }); break;
      case 'Ts': stateOp(o, () => { gs.rise = num(operands[0]); }); break;
      case 'Tr': stateOp(o, () => { gs.renderMode = num(operands[0]); }); break;
      case 'Tf':
        stateOp(o, () => {
          if (operands[0]?.type === 'name') setFont(operands[0].value, num(operands[1]));
        });
        break;
      case 'Td':
      case 'TD':
      case 'Tm':
      case 'T*': {
        if (o.op === 'TD') gs.leading = -num(operands[1]);
        if (o.op === 'Td' || o.op === 'TD') lineMove(num(operands[0]), num(operands[1]));
        else if (o.op === 'T*') lineMove(0, -gs.leading);
        else {
          tlm = operands.slice(0, 6).map(num) as Matrix;
          tm = tlm;
          positionUncertain = false;
        }
        if (rewriting) {
          // 書き直しの途中: 相対の移動は出さず、次に描く前に絶対位置を置く
          needTm = true;
        } else {
          pendingText.push(o.op === 'T*' ? { ...o, leadingUsed: gs.leading } : o);
        }
        break;
      }
      case 'Tj':
        await showText(operands.slice(0, 1), o);
        break;
      case 'TJ': {
        const arr = operands[0];
        await showText(arr?.type === 'array' ? arr.items : [], o);
        break;
      }
      case "'":
      case '"': {
        if (o.op === '"') {
          gs.wordSpacing = num(operands[0]);
          gs.charSpacing = num(operands[1]);
        }
        lineMove(0, -gs.leading);
        const str = o.op === '"' ? operands.slice(2, 3) : operands.slice(0, 1);
        if (rewriting) {
          needTm = true;
        } else {
          // ' と " は、行送り（T*）と状態の設定に分けて溜める（中で書き直しに入ることがあるため）
          pendingText.push({ op: 'T*', operands: [], leadingUsed: gs.leading });
        }
        await showText(str, { op: 'Tj', operands: str });
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
        const replaced = await handleXObject(rc, n.value, resources, gs, inheritedUse);
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
  // 差し替えた元の画像・フォーム・属性は、資源に名前が残っていると保存されてしまうので外す
  const used: UsedNames = {
    XObject: new Set(inheritedUse.XObject), Properties: new Set(inheritedUse.Properties), Font: new Set(inheritedUse.Font),
  };
  for (const o of out) {
    const n0 = o.operands[0];
    const n1 = o.operands[1];
    if (o.op === 'Do' && n0?.type === 'name') used.XObject.add(n0.value);
    if (o.op === 'Tf' && n0?.type === 'name') used.Font.add(n0.value);
    if ((o.op === 'BDC' || o.op === 'DP') && n1?.type === 'name') used.Properties.add(n1.value);
  }
  const t3 = namesUsedByType3WithoutResources(rc, resources);
  for (const n of t3.XObject) used.XObject.add(n);
  for (const n of t3.Font) used.Font.add(n);
  resources.pruneUnused('XObject', used.XObject);
  resources.pruneUnused('Properties', used.Properties);
  // 消した文字だけが使っていたフォント（1 字ごとに別のフォントに分けた PDF など）は、資源から外して丸ごと消す
  resources.pruneUnused('Font', used.Font);
  return { ops: out, changed, used };
}

/**
 * Resources を持たない Type3 フォントの字形の手続きは、呼び出し元の資源を使う。
 * そこで Do している名前を集める（資源から外さないため）。
 */
function namesUsedByType3WithoutResources(rc: RedactionContext, resources: ResourceEditor): { XObject: Set<string>; Font: Set<string> } {
  const out = { XObject: new Set<string>(), Font: new Set<string>() };
  const fonts = resources.categoryDict('Font');
  if (!fonts) return out;
  for (const [, v] of fonts.entries()) {
    const f = resolve(rc.ctx, v);
    if (!(f instanceof PDFDict) || getName(rc.ctx, f, 'Subtype') !== 'Type3' || f.has(PDFName.of('Resources'))) continue;
    const procs = get(rc.ctx, f, 'CharProcs');
    if (!(procs instanceof PDFDict)) continue;
    for (const [, p] of procs.entries()) {
      const s = resolve(rc.ctx, p);
      if (!(s instanceof PDFStream)) continue;
      try {
        for (const o of parseContentStream(streamBytes(rc.ctx, s))) {
          const n = o.operands[0];
          if (o.op === 'Do' && n?.type === 'name') out.XObject.add(n.value);
          if (o.op === 'Tf' && n?.type === 'name') out.Font.add(n.value);
        }
      } catch {
        // 読めない字形の手続きは、ビューアーも描けないので数えない
      }
    }
  }
  return out;
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
    // 属性が空になったら、属性の無い BMC にする（「ここに ActualText があった」という殻も残さない）
    if (props.entries.length === 0) {
      op.op = 'BMC';
      op.operands = op.operands.slice(0, 1);
    }
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
  inheritedUse: UsedNames,
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
    const usesParentResources = !(formResDict instanceof PDFDict);
    if (!result.changed) {
      // 書き換えない Form は、資源を持たなければ呼び出し元の資源を使い続ける
      if (usesParentResources) {
        for (const n of result.used.XObject) inheritedUse.XObject.add(n);
        for (const n of result.used.Properties) inheritedUse.Properties.add(n);
        for (const n of result.used.Font) inheritedUse.Font.add(n);
      }
      return null;
    }
    const dict = rc.ctx.obj({}) as PDFDict;
    for (const [k, v] of xobj.dict.entries()) {
      const key = k.decodeText();
      if (['Filter', 'DecodeParms', 'Length', 'Metadata', 'PieceInfo', 'LastModified', 'StructParent', 'StructParents'].includes(key)) continue;
      dict.set(k, v);
    }
    if (usesParentResources && formRes.dict) {
      // 親の資源の辞書を共有したままにすると、後で親の側で使わない名前を外したときに、この Form の分まで消える。写しを持たせる
      const snapshot = shallowCopy(rc.ctx, formRes.dict);
      for (const [k, v] of snapshot.entries()) {
        const sub = resolve(rc.ctx, v);
        if (sub instanceof PDFDict) snapshot.set(k, shallowCopy(rc.ctx, sub));
      }
      dict.set(PDFName.of('Resources'), snapshot);
    } else if (formRes.changed && formRes.dict) {
      dict.set(PDFName.of('Resources'), formRes.dict);
    }
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
