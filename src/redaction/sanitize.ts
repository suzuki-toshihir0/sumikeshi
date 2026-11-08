/**
 * 文書全体から、墨消しした情報が残りうる場所を消す。
 *
 * - 文書の情報（Info）、XMP メタデータ、ファイルの ID
 * - 構造の木（ActualText / Alt に本文の写しを持つ）、しおり、添付ファイル、JavaScript
 * - 頁の縮小画像（Thumb）など、頁の写しを持つもの
 * - どこからも参照されていないオブジェクト（編集前の版の名残など）
 */
import {
  PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFObject, PDFRef, PDFStream,
} from 'pdf-lib';
import { get, getDict, getName, resolve, getArray } from './pdf-objects';

const CATALOG_KEYS_TO_REMOVE = [
  'Metadata', 'StructTreeRoot', 'MarkInfo', 'Outlines', 'PieceInfo', 'SpiderInfo', 'Threads',
  'Perms', 'Legal', 'Collection', 'AA', 'Requirements', 'AF', 'DSS',
];

const PAGE_KEYS_TO_REMOVE = ['Thumb', 'PieceInfo', 'Metadata', 'B', 'StructParents', 'AA', 'AF', 'SeparationInfo', 'PZ'];

export function sanitizeDocument(doc: PDFDocument): void {
  const ctx = doc.context;
  const catalog = doc.catalog;

  for (const k of CATALOG_KEYS_TO_REMOVE) catalog.delete(PDFName.of(k));
  if (getName(ctx, catalog, 'PageMode') === 'UseOutlines' || getName(ctx, catalog, 'PageMode') === 'UseThumbs') {
    catalog.set(PDFName.of('PageMode'), PDFName.of('UseNone'));
  }

  // 開いたときに動く JavaScript
  const openAction = get(ctx, catalog, 'OpenAction');
  if (openAction instanceof PDFDict) catalog.delete(PDFName.of('OpenAction'));

  // 名前の木: JavaScript と添付ファイルを消す（移動先の名前 Dests は残す）
  const names = getDict(ctx, catalog, 'Names');
  if (names) {
    for (const k of ['JavaScript', 'EmbeddedFiles', 'AlternatePresentations', 'Renditions', 'Templates', 'Pages', 'URLS', 'IDS']) {
      names.delete(PDFName.of(k));
    }
  }

  // XFA のフォームは、欄の値の写しを別に持つ
  const acro = getDict(ctx, catalog, 'AcroForm');
  if (acro) acro.delete(PDFName.of('XFA'));

  for (const page of doc.getPages()) {
    const node = page.node;
    for (const k of PAGE_KEYS_TO_REMOVE) node.delete(PDFName.of(k));
    // 添付ファイルの注釈は、元の文書そのものを持っていることがある
    const annots = getArray(ctx, node, 'Annots');
    if (annots) {
      const kept: PDFObject[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const a = resolve(ctx, annots.get(i));
        if (a instanceof PDFDict && getName(ctx, a, 'Subtype') === 'FileAttachment') continue;
        if (a instanceof PDFDict) a.delete(PDFName.of('StructParent'));
        kept.push(annots.get(i));
      }
      if (kept.length !== annots.size()) node.set(PDFName.of('Annots'), ctx.obj(kept));
    }
  }

  // 文書の情報と ID（元のファイルとの結び付きが分かる）
  const trailer = ctx.trailerInfo as { Info?: PDFObject; ID?: PDFObject; Encrypt?: PDFObject };
  delete trailer.Info;
  delete trailer.ID;

  collectGarbage(ctx);
}

/** どこからもたどれないオブジェクトを消す */
export function collectGarbage(ctx: PDFContext): void {
  const reachable = new Set<PDFRef>();
  const visit = (o: PDFObject | undefined) => {
    const stack: (PDFObject | undefined)[] = [o];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) continue;
      if (cur instanceof PDFRef) {
        if (reachable.has(cur)) continue;
        reachable.add(cur);
        stack.push(ctx.lookup(cur));
      } else if (cur instanceof PDFDict) {
        for (const [, v] of cur.entries()) stack.push(v);
      } else if (cur instanceof PDFArray) {
        for (let i = 0; i < cur.size(); i++) stack.push(cur.get(i));
      } else if (cur instanceof PDFStream) {
        for (const [, v] of cur.dict.entries()) stack.push(v);
      }
    }
  };
  const trailer = ctx.trailerInfo as Record<string, PDFObject | undefined>;
  for (const v of Object.values(trailer)) visit(v);
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) ctx.delete(ref);
  }
}
