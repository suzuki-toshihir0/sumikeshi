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
  // フォームの欄（ウィジェットの親を含む）の動作から、JavaScript などの動く中身を消す
  const fieldsSeen = new Set<PDFDict>();
  const sanitizeFields = (arr: PDFArray | undefined, depth: number) => {
    for (let i = 0; arr && depth < 32 && i < arr.size(); i++) {
      const f = resolve(ctx, arr.get(i));
      if (!(f instanceof PDFDict) || fieldsSeen.has(f)) continue;
      fieldsSeen.add(f);
      sanitizeActions(ctx, f);
      sanitizeFields(getArray(ctx, f, 'Kids'), depth + 1);
    }
  };
  sanitizeFields(getArray(ctx, acro, 'Fields'), 0);

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
        if (a instanceof PDFDict) {
          a.delete(PDFName.of('StructParent'));
          sanitizeActions(ctx, a);
        }
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
  renumberObjects(ctx);
}

/** 動く中身の動作（スクリプト、外部のプログラムの起動、外部のデータの読み込み） */
const ACTIVE_ACTIONS = new Set(['JavaScript', 'Launch', 'ImportData', 'RichMediaExecute']);

/**
 * 注釈やフォームの欄の動作から、動く中身を消す。/AA（ページを開いた、値を変えた、などで動く動作）は丸ごと外し、
 * /A は /Next でつながる先までたどって、動く中身の動作だけを外す（URI や頁への移動は残す）
 */
function sanitizeActions(ctx: PDFContext, d: PDFDict): void {
  d.delete(PDFName.of('AA'));
  const clean = (action: PDFObject | undefined, depth: number): PDFObject | undefined => {
    const a = resolve(ctx, action);
    if (!(a instanceof PDFDict) || depth > 32) return action;
    const s = getName(ctx, a, 'S');
    a.delete(PDFName.of('JS'));
    const next = a.get(PDFName.of('Next'));
    if (next !== undefined) {
      const n = resolve(ctx, next);
      if (n instanceof PDFArray) {
        const kept: PDFObject[] = [];
        for (let i = 0; i < n.size(); i++) {
          const c = clean(n.get(i), depth + 1);
          if (c) kept.push(c);
        }
        if (kept.length > 0) a.set(PDFName.of('Next'), ctx.obj(kept));
        else a.delete(PDFName.of('Next'));
      } else {
        const c = clean(next, depth + 1);
        if (c) a.set(PDFName.of('Next'), c);
        else a.delete(PDFName.of('Next'));
      }
    }
    if (s && ACTIVE_ACTIONS.has(s)) {
      // この動作は外し、つながる先を代わりに置く
      return a.get(PDFName.of('Next'));
    }
    return action;
  };
  const a = d.get(PDFName.of('A'));
  if (a !== undefined) {
    const c = clean(a, 0);
    const r = resolve(ctx, c);
    if (r instanceof PDFDict) d.set(PDFName.of('A'), c!);
    else if (r instanceof PDFArray && r.size() > 0) d.set(PDFName.of('A'), r.get(0));
    else d.delete(PDFName.of('A'));
  }
}

/**
 * オブジェクトの番号を 1 から詰め直す。消したオブジェクトの欠番から、消したもの（フォントなど）の数や順番が分かるのを防ぐ。
 * 元の番号の順は保つ。
 */
export function renumberObjects(ctx: PDFContext): void {
  const entries = ctx.enumerateIndirectObjects().sort((a, b) => a[0].objectNumber - b[0].objectNumber || a[0].generationNumber - b[0].generationNumber);
  const map = new Map<PDFRef, PDFRef>();
  entries.forEach(([ref], i) => map.set(ref, PDFRef.of(i + 1, 0)));
  // 同じ辞書・配列が 2 か所から参照されていても、付け替えは 1 回だけ（新しい番号を古い番号と取り違えないため）
  const done = new Set<PDFObject>();
  const fix = (o: PDFObject | undefined, depth = 0): PDFObject | undefined => {
    if (o === undefined || depth > 256) return o;
    if (o instanceof PDFRef) return map.get(o) ?? o;
    if (done.has(o)) return o;
    if (o instanceof PDFDict || o instanceof PDFArray || o instanceof PDFStream) done.add(o);
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        const nv = fix(v, depth + 1);
        if (nv !== v && nv !== undefined) o.set(k, nv);
      }
      return o;
    }
    if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        const nv = fix(v, depth + 1);
        if (nv !== v && nv !== undefined) o.set(i, nv);
      }
      return o;
    }
    if (o instanceof PDFStream) {
      fix(o.dict, depth + 1);
      return o;
    }
    return o;
  };
  for (const [, obj] of entries) fix(obj);
  for (const [ref] of entries) ctx.delete(ref);
  for (const [ref, obj] of entries) ctx.assign(map.get(ref)!, obj);
  const trailer = ctx.trailerInfo as Record<string, PDFObject | undefined>;
  for (const k of Object.keys(trailer)) trailer[k] = fix(trailer[k]);
  ctx.largestObjectNumber = entries.length;
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
