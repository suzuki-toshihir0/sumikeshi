import type { PdfRect } from '../utils/coordinates';

/** ページごとの墨消し対象領域を管理する */
export class RedactionStore {
  private rects: Map<number, PdfRect[]> = new Map();

  /** 墨消し領域を追加する */
  add(pageNum: number, rect: PdfRect): void {
    if (!this.rects.has(pageNum)) {
      this.rects.set(pageNum, []);
    }
    this.rects.get(pageNum)!.push(rect);
  }

  /** 指定ページの墨消し領域を取得する */
  getRectsForPage(pageNum: number): PdfRect[] {
    return this.rects.get(pageNum) ?? [];
  }

  /** 全ページの墨消し領域を取得する */
  getAllRects(): Map<number, PdfRect[]> {
    return this.rects;
  }

  /** 指定ページの指定インデックスの領域を削除する */
  remove(pageNum: number, index: number): void {
    const pageRects = this.rects.get(pageNum);
    if (pageRects && index >= 0 && index < pageRects.length) {
      pageRects.splice(index, 1);
    }
  }

  /** 全領域をクリアする */
  clear(): void {
    this.rects.clear();
  }

  /** 墨消し領域があるかどうか */
  get hasRects(): boolean {
    for (const rects of this.rects.values()) {
      if (rects.length > 0) return true;
    }
    return false;
  }
}
