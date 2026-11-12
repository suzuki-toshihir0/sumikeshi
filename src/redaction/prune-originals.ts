/**
 * 墨消しで差し替えた元の画像・Form が、ほかの頁や親（Pages）の資源の辞書から指されたまま残らないようにする。
 *
 * 資源の辞書は、複数の頁で共有したり、親の Pages から受け継いだりできる。墨消しした頁は自分の資源の写しを持つが、
 * 元の辞書は元の画像を指したままなので、どの頁もその画像を描かなくても、保存すると元の画像がファイルに残る。
 * どこでも描かれていない項目のうち、差し替えた元のものを指す項目だけを外す。ほかの頁が描くものは残す。
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFStream } from 'pdf-lib';
import { parseContentStream } from './content/lexer';
import { contentsBytes, get, getArray, getDict, getName, resolve, streamBytes } from './pdf-objects';

export function pruneReplacedOriginals(doc: PDFDocument, originals: Set<PDFObject>): void {
  if (originals.size === 0) return;
  const ctx = doc.context;
  const originalObjects = new Set<PDFObject>();
  for (const o of originals) {
    const r = resolve(ctx, o);
    if (r) originalObjects.add(r);
  }

  /** XObject の辞書ごとの、描かれる名前。中身を読めなかった辞書は外さない */
  const used = new Map<PDFDict, Set<string>>();
  const unreadable = new Set<PDFDict>();
  const seen = new Set<string>();
  let streamIds = 0;
  const ids = new Map<object, number>();
  const idOf = (o: object) => {
    let n = ids.get(o);
    if (n === undefined) ids.set(o, (n = ++streamIds));
    return n;
  };

  const visit = (bytes: Uint8Array | PDFStream, resources: PDFDict | undefined, depth: number): void => {
    if (depth > 32) return;
    const xobjects = getDict(ctx, resources, 'XObject');
    if (xobjects && !used.has(xobjects)) used.set(xobjects, new Set());
    let ops;
    try {
      ops = parseContentStream(bytes instanceof Uint8Array ? bytes : streamBytes(ctx, bytes));
    } catch {
      if (xobjects) unreadable.add(xobjects);
      return;
    }
    const child = (s: PDFStream) => {
      const own = getDict(ctx, s.dict, 'Resources');
      const res = own ?? resources;
      const key = `${idOf(s)}|${res ? idOf(res) : 0}`;
      if (seen.has(key)) return;
      seen.add(key);
      visit(s, res, depth + 1);
    };
    for (const o of ops) {
      const a = o.operands;
      if (o.op === 'Do' && a[0]?.type === 'name') {
        if (xobjects) used.get(xobjects)!.add(a[0].value);
        const x = resolve(ctx, xobjects?.get(PDFName.of(a[0].value)));
        if (x instanceof PDFStream && getName(ctx, x.dict, 'Subtype') === 'Form') child(x);
      } else if ((o.op === 'scn' || o.op === 'SCN') && a[a.length - 1]?.type === 'name') {
        const last = a[a.length - 1] as { value: string };
        const pat = resolve(ctx, getDict(ctx, resources, 'Pattern')?.get(PDFName.of(last.value)));
        if (pat instanceof PDFStream) child(pat);
      } else if (o.op === 'Tf' && a[0]?.type === 'name') {
        // Type3 の字形の手続きは、資源を持たなければ呼び出し元の資源で画像などを描く
        const f = resolve(ctx, getDict(ctx, resources, 'Font')?.get(PDFName.of(a[0].value)));
        const procs = f instanceof PDFDict && getName(ctx, f, 'Subtype') === 'Type3' ? get(ctx, f, 'CharProcs') : undefined;
        if (procs instanceof PDFDict) {
          const own = getDict(ctx, f as PDFDict, 'Resources');
          for (const [, pv] of procs.entries()) {
            const ps = resolve(ctx, pv);
            if (!(ps instanceof PDFStream)) continue;
            const res = own ?? resources;
            const key = `${idOf(ps)}|${res ? idOf(res) : 0}`;
            if (seen.has(key)) continue;
            seen.add(key);
            visit(ps, res, depth + 1);
          }
        }
      } else if (o.op === 'gs' && a[0]?.type === 'name') {
        const eg = resolve(ctx, getDict(ctx, resources, 'ExtGState')?.get(PDFName.of(a[0].value)));
        const smask = eg instanceof PDFDict ? get(ctx, eg, 'SMask') : undefined;
        const g = smask instanceof PDFDict ? get(ctx, smask, 'G') : undefined;
        if (g instanceof PDFStream) child(g);
      }
    }
  };

  // 頁の資源がどこにあるか（頁そのものか、親の Pages か）
  const resourceOwners = new Set<PDFDict>();
  for (const page of doc.getPages()) {
    const node = page.node;
    let owner: PDFDict | undefined = node;
    for (let i = 0; owner && i < 64; i++) {
      if (owner.has(PDFName.of('Resources'))) break;
      const parent = resolve(ctx, owner.get(PDFName.of('Parent')));
      owner = parent instanceof PDFDict ? parent : undefined;
    }
    if (owner) resourceOwners.add(owner);
    const res = owner ? getDict(ctx, owner, 'Resources') : undefined;
    visit(contentsBytes(ctx, node.get(PDFName.of('Contents'))), res, 0);
    // 注釈の外観
    const annots = getArray(ctx, node, 'Annots');
    for (let i = 0; annots && i < annots.size(); i++) {
      const an = resolve(ctx, annots.get(i));
      const ap = an instanceof PDFDict ? getDict(ctx, an, 'AP') : undefined;
      for (const k of ['N', 'R', 'D']) {
        const v = get(ctx, ap, k);
        const streams = v instanceof PDFStream ? [v] : v instanceof PDFDict ? [...v.entries()].map(([, sv]) => resolve(ctx, sv)) : [];
        for (const st of streams) if (st instanceof PDFStream) visit(st, getDict(ctx, st.dict, 'Resources'), 1);
      }
    }
  }

  // どの頁も受け継がない親（Pages）の資源は、丸ごと外す
  const removeUnusedPagesResources = (node: PDFDict, depth: number) => {
    if (depth > 64) return;
    const kids = resolve(ctx, node.get(PDFName.of('Kids')));
    if (!(kids instanceof PDFArray)) return;
    if (node.has(PDFName.of('Resources')) && !resourceOwners.has(node)) node.delete(PDFName.of('Resources'));
    for (let i = 0; i < kids.size(); i++) {
      const k = resolve(ctx, kids.get(i));
      if (k instanceof PDFDict) removeUnusedPagesResources(k, depth + 1);
    }
  };
  removeUnusedPagesResources(doc.catalog.Pages(), 0);

  // 描かれない項目のうち、差し替えた元のものを指す項目を外す
  for (const [xobjects, names] of used) {
    if (unreadable.has(xobjects)) continue;
    for (const [k, v] of xobjects.entries()) {
      if (names.has(k.decodeText())) continue;
      if (originalObjects.has(v) || originalObjects.has(resolve(ctx, v) as PDFObject)) xobjects.delete(k);
    }
  }
}
