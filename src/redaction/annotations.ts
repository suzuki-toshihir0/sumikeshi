/**
 * 墨消しの範囲にかかる注釈（コメント、フォームの欄、リンクなど）を、データごと消す。
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFObject, PDFRef } from 'pdf-lib';
import type { PdfRect } from '../utils/coordinates';
import { getArray, getDict, getName, numbersOf, resolve } from './pdf-objects';
import { rectsOverlap } from './geometry';

function annotRect(ctx: PDFContext, annot: PDFDict): PdfRect | null {
  const r = numbersOf(ctx, getArray(ctx, annot, 'Rect'));
  if (r.length !== 4 || !r.every(Number.isFinite)) return null;
  const x0 = Math.min(r[0], r[2]);
  const y0 = Math.min(r[1], r[3]);
  return { x: x0, y: y0, width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) };
}

/**
 * 頁の注釈のうち、範囲にかかるものを消す。
 * 消した注釈の辞書を返す（フォームの欄の木からも外すため）。
 */
export function removeOverlappingAnnotations(ctx: PDFContext, page: PDFDict, rects: PdfRect[]): Set<PDFDict> {
  const removed = new Set<PDFDict>();
  const annots = getArray(ctx, page, 'Annots');
  if (!annots) return removed;
  const entries: { raw: PDFObject; dict: PDFDict | undefined }[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const d = resolve(ctx, raw);
    entries.push({ raw, dict: d instanceof PDFDict ? d : undefined });
  }
  for (const { dict } of entries) {
    if (!dict) continue;
    const r = annotRect(ctx, dict);
    // 位置の分からない注釈も、念のため消す
    if (!r || rects.some((rr) => rectsOverlap(r, rr))) removed.add(dict);
  }
  // 消した注釈に付いていたポップアップと、消した注釈を親に持つポップアップも消す
  for (const { dict } of entries) {
    if (!dict) continue;
    const parent = getDict(ctx, dict, 'Parent');
    if (getName(ctx, dict, 'Subtype') === 'Popup' && parent && removed.has(parent)) removed.add(dict);
  }
  for (const d of [...removed]) {
    const popup = getDict(ctx, d, 'Popup');
    if (popup) removed.add(popup);
  }
  if (removed.size === 0) return removed;
  const kept = entries.filter((e) => !(e.dict && removed.has(e.dict))).map((e) => e.raw);
  page.set(PDFName.of('Annots'), ctx.obj(kept));
  return removed;
}

/**
 * 文書全体で、消した注釈を /IRT（返信の宛先）で指す注釈を消す（返信の返信もたどる）。
 * 残すと、消した注釈がその参照からたどれて、本文（Contents）や外観ごと保存される。
 * 消した注釈を足した removed を返す。
 */
export function removeRepliesToRemoved(ctx: PDFContext, pages: PDFDict[], removed: Set<PDFDict>): Set<PDFDict> {
  let changed = removed.size > 0;
  while (changed) {
    changed = false;
    for (const page of pages) {
      const annots = getArray(ctx, page, 'Annots');
      if (!annots) continue;
      const kept: PDFObject[] = [];
      let drop = false;
      for (let i = 0; i < annots.size(); i++) {
        const raw = annots.get(i);
        const d = resolve(ctx, raw);
        if (d instanceof PDFDict && !removed.has(d)) {
          const irt = getDict(ctx, d, 'IRT');
          const parent = getDict(ctx, d, 'Parent');
          const orphanReply = irt !== undefined && removed.has(irt);
          const orphanPopup = getName(ctx, d, 'Subtype') === 'Popup' && parent !== undefined && removed.has(parent);
          if (orphanReply || orphanPopup) {
            removed.add(d);
            const popup = getDict(ctx, d, 'Popup');
            if (popup) removed.add(popup);
            changed = true;
          }
        }
        if (d instanceof PDFDict && removed.has(d)) drop = true;
        else kept.push(raw);
      }
      if (drop) page.set(PDFName.of('Annots'), ctx.obj(kept));
    }
  }
  return removed;
}

/** フォームの欄の木から、消したウィジェットを外す。ウィジェットが無くなった欄も外す */
export function pruneFormFields(ctx: PDFContext, catalog: PDFDict, removedWidgets: Set<PDFDict>): void {
  const acro = getDict(ctx, catalog, 'AcroForm');
  if (!acro) return;
  const fields = getArray(ctx, acro, 'Fields');
  if (!fields) return;

  /** 欄の配下にウィジェットが残っているか。残っていなければ false（親から外す） */
  const prune = (arr: PDFArray, depth: number): PDFObject[] => {
    const kept: PDFObject[] = [];
    for (let i = 0; i < arr.size(); i++) {
      const raw = arr.get(i);
      const d = resolve(ctx, raw);
      if (!(d instanceof PDFDict)) continue;
      if (removedWidgets.has(d)) continue;
      const kids = getArray(ctx, d, 'Kids');
      if (kids && depth < 32) {
        const keptKids = prune(kids, depth + 1);
        if (keptKids.length === 0) continue;
        if (keptKids.length !== kids.size()) d.set(PDFName.of('Kids'), ctx.obj(keptKids));
      }
      kept.push(raw);
    }
    return kept;
  };
  const keptFields = prune(fields, 0);
  acro.set(PDFName.of('Fields'), ctx.obj(keptFields));
  // 計算の順（/CO）からも外す（残すと、消した欄が値ごとたどれて保存される）
  const co = getArray(ctx, acro, 'CO');
  if (co) {
    const removedField = (d: PDFDict): boolean => {
      if (removedWidgets.has(d)) return true;
      const kids = getArray(ctx, d, 'Kids');
      if (!kids) return false;
      for (let i = 0; i < kids.size(); i++) {
        const k = resolve(ctx, kids.get(i));
        if (k instanceof PDFDict && !removedField(k)) return false;
      }
      return kids.size() > 0;
    };
    const keptCo: PDFObject[] = [];
    for (let i = 0; i < co.size(); i++) {
      const d = resolve(ctx, co.get(i));
      if (d instanceof PDFDict && removedField(d)) continue;
      keptCo.push(co.get(i));
    }
    if (keptCo.length > 0) acro.set(PDFName.of('CO'), ctx.obj(keptCo));
    else acro.delete(PDFName.of('CO'));
  }
}

export function isRef(o: PDFObject | undefined): o is PDFRef {
  return o instanceof PDFRef;
}
