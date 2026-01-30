import type { PageViewport } from 'pdfjs-dist';
import type { RedactionStore } from '../redaction/redaction-store';
import { pdfToCssRect } from '../utils/coordinates';

export class Overlay {
  private container: HTMLElement;
  private store: RedactionStore;

  /** 墨消し領域クリック時コールバック(削除用) */
  onRectClick: ((pageNum: number, index: number) => void) | null = null;

  constructor(container: HTMLElement, store: RedactionStore) {
    this.container = container;
    this.store = store;
  }

  /** 現在のページのオーバーレイを再描画する */
  render(pageNum: number, viewport: PageViewport): void {
    // 墨消し矩形以外の要素(ドラッグ中の矩形等)は保持する
    this.container.querySelectorAll('.redaction-rect').forEach((el) => el.remove());

    const rects = this.store.getRectsForPage(pageNum);
    rects.forEach((pdfRect, index) => {
      const cssRect = pdfToCssRect(pdfRect, viewport);
      const el = document.createElement('div');
      el.className = 'redaction-rect';
      el.style.left = `${cssRect.left}px`;
      el.style.top = `${cssRect.top}px`;
      el.style.width = `${cssRect.width}px`;
      el.style.height = `${cssRect.height}px`;
      el.title = 'クリックで選択を解除';
      el.addEventListener('click', () => {
        this.onRectClick?.(pageNum, index);
      });
      this.container.appendChild(el);
    });
  }

  /** オーバーレイをクリアする */
  clear(): void {
    this.container.querySelectorAll('.redaction-rect').forEach((el) => el.remove());
  }
}
