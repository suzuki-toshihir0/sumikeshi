/**
 * 文書全体で、フォントのどの符号が使われているかを数える。
 * 墨消しで消した文字の符号が、ほかの場所でまだ使われているなら、フォントの字形は消してはいけない。
 *
 * 見る場所: 全頁の中身、そこから Do で描く Form XObject（入れ子も）、注釈の外観、
 * タイリングパターンの中身、ExtGState のソフトマスクの Form。
 */
import { PDFContext, PDFDict, PDFDocument, PDFName, PDFObject, PDFStream } from 'pdf-lib';
import { parseContentStream, type Operand } from '../content/lexer';
import { serializeOperations } from '../content/writer';
import { contentsBytes, get, getArray, getDict, getName, inheritedPageAttr, numbersOf, resolve, streamBytes } from '../pdf-objects';
import { createFontModel, type FontModel } from './font-model';
import type { CMapLoader } from './cmap';

/**
 * targets のフォントの使われ方を数える。'all' なら、文書の中で文字列を描くのに選ばれたフォントすべて。
 */
export async function collectFontUsage(
  doc: PDFDocument,
  targets: Set<PDFDict> | 'all',
  fontCache: Map<PDFDict, Promise<FontModel>>,
  cmapLoader?: CMapLoader,
  /** 同じ Form が、描く場所によって別のフォントで字を描くとき、そのフォントを入れる（符号を詰め直すと、どちらかで化けるため） */
  contextDependent?: Set<PDFDict>,
): Promise<Map<PDFDict, Set<number>>> {
  const ctx = doc.context;
  const used = new Map<PDFDict, Set<number>>();
  const all = targets === 'all';
  if (targets !== 'all') for (const t of targets) used.set(t, new Set());
  const track = (f: PDFDict | null) => {
    if (all && f && !used.has(f)) used.set(f, new Set());
  };
  const visited = new Set<string>();
  const type3Walked = new Set<PDFDict>();
  let visitCount = 0;
  const ids = new Map<object, number>();
  const idOf = (o: object | null | undefined) => {
    if (!o) return 0;
    let n = ids.get(o);
    if (n === undefined) ids.set(o, (n = ids.size + 1));
    return n;
  };
  /** Form ごとの、字を描く命令ごとのフォント（最初に読んだ場所のもの） */
  const formFonts = new Map<PDFStream, (PDFDict | null)[]>();

  const model = (f: PDFDict): Promise<FontModel | null> => {
    let p = fontCache.get(f);
    if (!p) {
      p = createFontModel(ctx, f, cmapLoader);
      fontCache.set(f, p);
    }
    return p.catch(() => null);
  };

  const lookup = (resources: PDFDict | undefined, category: string, name: string): PDFObject | undefined => {
    const cat = getDict(ctx, resources, category);
    return cat ? resolve(ctx, cat.get(PDFName.of(name))) : undefined;
  };

  const walk = async (
    stream: PDFStream | Uint8Array, resources: PDFDict | undefined, depth: number,
    inheritedFont: PDFDict | null = null, shown?: (PDFDict | null)[],
  ): Promise<void> => {
    if (depth > 32) return;
    let ops;
    try {
      ops = parseContentStream(stream instanceof Uint8Array ? stream : streamBytes(ctx, stream));
    } catch {
      return; // 読めない中身はビューアーも描けない
    }
    let font: PDFDict | null = inheritedFont;
    const fontStack: (PDFDict | null)[] = [];
    const addCodes = async (strings: Operand[]) => {
      shown?.push(font);
      if (!font || !used.has(font)) return;
      const m = await model(font);
      const set = used.get(font)!;
      for (const s of strings) {
        if (s.type !== 'string') continue;
        if (!m) {
          // 符号の切り方が分からない: 1 バイトと 2 バイトの両方で数えておく（消しすぎを避ける）
          for (const b of s.bytes) set.add(b);
          for (let i = 0; i + 1 < s.bytes.length; i += 2) set.add((s.bytes[i] << 8) | s.bytes[i + 1]);
          continue;
        }
        for (const c of m.split(s.bytes)) set.add(c.code);
      }
    };
    for (const o of ops) {
      const a = o.operands;
      switch (o.op) {
        case 'q': fontStack.push(font); break;
        case 'Q': font = fontStack.length > 0 ? fontStack.pop()! : font; break;
        case 'Tf': {
          const f = a[0]?.type === 'name' ? lookup(resources, 'Font', a[0].value) : undefined;
          font = f instanceof PDFDict ? f : null;
          track(font);
          // Type3 の字形の手続きの中で使うフォントも数える（手続きは字ごとに描かれる）
          if (font && getName(ctx, font, 'Subtype') === 'Type3' && !type3Walked.has(font)) {
            type3Walked.add(font);
            const procs = get(ctx, font, 'CharProcs');
            const own = getDict(ctx, font, 'Resources');
            if (procs instanceof PDFDict) {
              for (const [, pv] of procs.entries()) {
                const ps = resolve(ctx, pv);
                if (ps instanceof PDFStream) await walk(ps, own ?? resources, depth + 1);
              }
            }
          }
          break;
        }
        case 'gs': {
          const eg = a[0]?.type === 'name' ? lookup(resources, 'ExtGState', a[0].value) : undefined;
          if (eg instanceof PDFDict) {
            const fa = getArray(ctx, eg, 'Font');
            const f = fa ? resolve(ctx, fa.get(0)) : undefined;
            if (f instanceof PDFDict) {
              font = f;
              track(font);
            }
            const smask = get(ctx, eg, 'SMask');
            if (smask instanceof PDFDict) {
              const g = get(ctx, smask, 'G');
              if (g instanceof PDFStream) await walkForm(g, resources, depth);
            }
          }
          break;
        }
        case 'Tj': case "'": await addCodes(a.slice(0, 1)); break;
        case '"': await addCodes(a.slice(2, 3)); break;
        case 'TJ': if (a[0]?.type === 'array') await addCodes(a[0].items); break;
        case 'Do': {
          const x = a[0]?.type === 'name' ? lookup(resources, 'XObject', a[0].value) : undefined;
          if (x instanceof PDFStream && getName(ctx, x.dict, 'Subtype') === 'Form') await walkForm(x, resources, depth, font);
          break;
        }
        case 'scn': case 'SCN': {
          const last = a[a.length - 1];
          const pat = last?.type === 'name' ? lookup(resources, 'Pattern', last.value) : undefined;
          if (pat instanceof PDFStream) await walkForm(pat, resources, depth);
          break;
        }
      }
    }
  };

  const walkForm = async (form: PDFStream, parentResources: PDFDict | undefined, depth: number, inheritedFont: PDFDict | null = null) => {
    const own = getDict(ctx, form.dict, 'Resources');
    const res = own ?? parentResources;
    // 同じ Form でも、資源（直接書かれた辞書も含めてオブジェクトで区別）と受け継ぐフォントが違えば読み直す
    const key = `${idOf(form)}|${idOf(res)}|${idOf(inheritedFont)}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (++visitCount > 100000) return;
    const shown: (PDFDict | null)[] = [];
    await walk(form, res, depth + 1, inheritedFont, shown);
    const first = formFonts.get(form);
    if (!first) {
      formFonts.set(form, shown);
    } else if (first.length !== shown.length || first.some((f, i) => f !== shown[i])) {
      for (const f of [...first, ...shown]) if (f) contextDependent?.add(f);
    }
  };

  for (const page of doc.getPages()) {
    const node = page.node;
    const res = inheritedPageAttr(ctx, node, 'Resources');
    await walk(contentsBytes(ctx, node.get(PDFName.of('Contents'))), res instanceof PDFDict ? res : undefined, 0);
    const annots = getArray(ctx, node, 'Annots');
    for (let i = 0; annots && i < annots.size(); i++) {
      const an = resolve(ctx, annots.get(i));
      if (!(an instanceof PDFDict)) continue;
      const ap = getDict(ctx, an, 'AP');
      for (const k of ['N', 'R', 'D']) {
        const v = get(ctx, ap, k);
        if (v instanceof PDFStream) await walkForm(v, undefined, 0);
        else if (v instanceof PDFDict) {
          for (const [, sv] of v.entries()) {
            const st = resolve(ctx, sv);
            if (st instanceof PDFStream) await walkForm(st, undefined, 0);
          }
        }
      }
    }
  }
  void numbersOf;
  return used;
}

/**
 * 文書全体で、指定したフォントで描く文字列の符号を書き換える（符号を詰め直したとき）。
 * collectFontUsage が数える場所（頁の中身、Do で描く Form、注釈の外観、Type3 の字形の手続き、
 * タイリングパターン、ソフトマスクの Form）を、書き換えたストリームに差し替える。
 */
export async function rewriteFontCodes(doc: PDFDocument, maps: Map<PDFDict, { map: Map<number, number>; bytes: number }>): Promise<void> {
  const ctx = doc.context;
  const done = new Set<PDFStream>();
  const lookup = (resources: PDFDict | undefined, category: string, name: string): PDFObject | undefined => {
    const cat = getDict(ctx, resources, category);
    return cat ? resolve(ctx, cat.get(PDFName.of(name))) : undefined;
  };

  /** 中身を書き換え、変わったら新しいバイト列を返す */
  const rewrite = async (bytes: Uint8Array, resources: PDFDict | undefined, depth: number, inheritedFont: PDFDict | null = null): Promise<Uint8Array | null> => {
    if (depth > 32) return null;
    let ops;
    try {
      ops = parseContentStream(bytes);
    } catch {
      return null;
    }
    let font: PDFDict | null = inheritedFont;
    const fontStack: (PDFDict | null)[] = [];
    let changed = false;
    const recodeString = (o: Operand): Operand => {
      if (o.type !== 'string' || !font) return o;
      const m = maps.get(font);
      if (!m) return o;
      changed = true;
      if (m.bytes === 1) return { type: 'string', hex: true, bytes: Uint8Array.from(o.bytes, (b) => m.map.get(b) ?? b) };
      // 2 バイトの符号（Identity-H / V）
      const outBytes: number[] = [];
      for (let i = 0; i + 1 < o.bytes.length; i += 2) {
        const c = (o.bytes[i] << 8) | o.bytes[i + 1];
        const nc = m.map.get(c) ?? c;
        outBytes.push((nc >> 8) & 0xff, nc & 0xff);
      }
      return { type: 'string', hex: true, bytes: Uint8Array.from(outBytes) };
    };
    for (const o of ops) {
      const a = o.operands;
      switch (o.op) {
        case 'q': fontStack.push(font); break;
        case 'Q': font = fontStack.length > 0 ? fontStack.pop()! : font; break;
        case 'Tf': {
          const f = a[0]?.type === 'name' ? lookup(resources, 'Font', a[0].value) : undefined;
          font = f instanceof PDFDict ? f : null;
          if (font && getName(ctx, font, 'Subtype') === 'Type3') await rewriteType3Procs(font, resources, depth);
          break;
        }
        case 'gs': {
          const eg = a[0]?.type === 'name' ? lookup(resources, 'ExtGState', a[0].value) : undefined;
          if (eg instanceof PDFDict) {
            const fa = getArray(ctx, eg, 'Font');
            const f = fa ? resolve(ctx, fa.get(0)) : undefined;
            if (f instanceof PDFDict) font = f;
            const smask = get(ctx, eg, 'SMask');
            const g = smask instanceof PDFDict ? get(ctx, smask, 'G') : undefined;
            if (g instanceof PDFStream) await rewriteStream(g, resources, depth);
          }
          break;
        }
        case 'scn': case 'SCN': {
          const last = a[a.length - 1];
          const pat = last?.type === 'name' ? lookup(resources, 'Pattern', last.value) : undefined;
          if (pat instanceof PDFStream) await rewriteStream(pat, resources, depth);
          break;
        }
        case 'Tj': case "'": if (a[0]) a[0] = recodeString(a[0]); break;
        case '"': if (a[2]) a[2] = recodeString(a[2]); break;
        case 'TJ': if (a[0]?.type === 'array') a[0] = { type: 'array', items: a[0].items.map(recodeString) }; break;
        case 'Do': {
          const x = a[0]?.type === 'name' ? lookup(resources, 'XObject', a[0].value) : undefined;
          if (x instanceof PDFStream && getName(ctx, x.dict, 'Subtype') === 'Form') await rewriteStream(x, resources, depth, font);
          break;
        }
      }
    }
    return changed ? serializeOperations(ops) : null;
  };

  /** 間接オブジェクトのストリームを、書き換えた中身の新しいストリームに差し替える */
  // 同じ Form を描く場所ごとにフォントが違うものは、そのフォントの符号を詰め直さない（collectFontUsage の contextDependent）ので、
  // 最初に読んだ場所の資源とフォントで書き換えればよい
  const rewriteStream = async (stream: PDFStream, parentResources: PDFDict | undefined, depth: number, inheritedFont: PDFDict | null = null) => {
    if (done.has(stream)) return;
    done.add(stream);
    const res = getDict(ctx, stream.dict, 'Resources') ?? parentResources;
    const out = await rewrite(streamBytes(ctx, stream), res, depth + 1, inheritedFont);
    if (!out) return;
    const ref = ctx.getObjectRef(stream);
    if (!ref) return;
    const ns = ctx.flateStream(out);
    for (const [k, v] of stream.dict.entries()) {
      if (['Filter', 'DecodeParms', 'Length'].includes(k.decodeText())) continue;
      ns.dict.set(k, v);
    }
    ctx.assign(ref, ns);
  };

  const type3Done = new Set<PDFDict>();
  const rewriteType3Procs = async (font: PDFDict, resources: PDFDict | undefined, depth: number) => {
    if (type3Done.has(font)) return;
    type3Done.add(font);
    const procs = get(ctx, font, 'CharProcs');
    const own = getDict(ctx, font, 'Resources');
    if (!(procs instanceof PDFDict)) return;
    for (const [, pv] of procs.entries()) {
      const ps = resolve(ctx, pv);
      if (ps instanceof PDFStream) await rewriteStream(ps, own ?? resources, depth);
    }
  };

  for (const page of doc.getPages()) {
    const node = page.node;
    const res = inheritedPageAttr(ctx, node, 'Resources');
    const out = await rewrite(contentsBytes(ctx, node.get(PDFName.of('Contents'))), res instanceof PDFDict ? res : undefined, 0);
    if (out) node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(out)));
    const annots = getArray(ctx, node, 'Annots');
    for (let i = 0; annots && i < annots.size(); i++) {
      const an = resolve(ctx, annots.get(i));
      if (!(an instanceof PDFDict)) continue;
      const ap = getDict(ctx, an, 'AP');
      for (const k of ['N', 'R', 'D']) {
        const v = get(ctx, ap, k);
        if (v instanceof PDFStream) await rewriteStream(v, undefined, 0);
        else if (v instanceof PDFDict) {
          for (const [, sv] of v.entries()) {
            const st = resolve(ctx, sv);
            if (st instanceof PDFStream) await rewriteStream(st, undefined, 0);
          }
        }
      }
    }
  }
}

export type { PDFContext };
