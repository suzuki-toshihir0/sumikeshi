/**
 * 文書全体で、フォントのどの符号が使われているかを数える。
 * 墨消しで消した文字の符号が、ほかの場所でまだ使われているなら、フォントの字形は消してはいけない。
 *
 * 見る場所: 全頁の中身、そこから Do で描く Form XObject（入れ子も）、注釈の外観、
 * タイリングパターンの中身、ExtGState のソフトマスクの Form。
 */
import { PDFContext, PDFDict, PDFDocument, PDFName, PDFObject, PDFStream } from 'pdf-lib';
import { parseContentStream, type Operand } from '../content/lexer';
import { contentsBytes, get, getArray, getDict, getName, inheritedPageAttr, numbersOf, resolve, streamBytes } from '../pdf-objects';
import { createFontModel, type FontModel } from './font-model';
import type { CMapLoader } from './cmap';

export async function collectFontUsage(
  doc: PDFDocument,
  targets: Set<PDFDict>,
  fontCache: Map<PDFDict, Promise<FontModel>>,
  cmapLoader?: CMapLoader,
): Promise<Map<PDFDict, Set<number>>> {
  const ctx = doc.context;
  const used = new Map<PDFDict, Set<number>>();
  for (const t of targets) used.set(t, new Set());
  const visited = new Set<string>();
  let visitCount = 0;

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

  const walk = async (stream: PDFStream | Uint8Array, resources: PDFDict | undefined, depth: number): Promise<void> => {
    if (depth > 32) return;
    let ops;
    try {
      ops = parseContentStream(stream instanceof Uint8Array ? stream : streamBytes(ctx, stream));
    } catch {
      return; // 読めない中身はビューアーも描けない
    }
    let font: PDFDict | null = null;
    const fontStack: (PDFDict | null)[] = [];
    const addCodes = async (strings: Operand[]) => {
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
          break;
        }
        case 'gs': {
          const eg = a[0]?.type === 'name' ? lookup(resources, 'ExtGState', a[0].value) : undefined;
          if (eg instanceof PDFDict) {
            const fa = getArray(ctx, eg, 'Font');
            const f = fa ? resolve(ctx, fa.get(0)) : undefined;
            if (f instanceof PDFDict) font = f;
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
          if (x instanceof PDFStream && getName(ctx, x.dict, 'Subtype') === 'Form') await walkForm(x, resources, depth);
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

  const walkForm = async (form: PDFStream, parentResources: PDFDict | undefined, depth: number) => {
    const own = getDict(ctx, form.dict, 'Resources');
    const res = own ?? parentResources;
    const key = `${ctx.getObjectRef(form)?.toString() ?? 'direct'}|${res ? ctx.getObjectRef(res)?.toString() ?? 'r' : '-'}`;
    if (visited.has(key) && key.indexOf('direct') < 0) return;
    visited.add(key);
    if (++visitCount > 100000) return;
    await walk(form, res, depth + 1);
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

export type { PDFContext };
