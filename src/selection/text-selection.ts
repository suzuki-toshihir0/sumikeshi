import type { PageViewport } from 'pdfjs-dist';
import type { RedactionStore } from '../redaction/redaction-store';
import { cssToPdfRect } from '../utils/coordinates';

export class TextSelection {
  private enabled = false;
  private pageNum = 1;
  private viewport: PageViewport | null = null;
  private selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;

  /** 選択追加時コールバック */
  onSelectionAdded: (() => void) | null = null;

  constructor(
    private textLayerEl: HTMLElement,
    private store: RedactionStore,
  ) {
    this.textLayerEl.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('selectionchange', this.handleSelectionChange);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setPageContext(pageNum: number, viewport: PageViewport): void {
    this.pageNum = pageNum;
    this.viewport = viewport;
  }

  private handleMouseUp = (): void => {
    // mouseup発火時はselectionchangeのデバウンスをキャンセルして即確定
    if (this.selectionChangeTimer) {
      clearTimeout(this.selectionChangeTimer);
      this.selectionChangeTimer = null;
    }
    this.commitSelection();
  };

  private handleSelectionChange = (): void => {
    if (!this.enabled) return;
    // デバウンスで選択が安定したら確定（モバイルのlong-press対応）
    if (this.selectionChangeTimer) {
      clearTimeout(this.selectionChangeTimer);
    }
    this.selectionChangeTimer = setTimeout(() => {
      this.selectionChangeTimer = null;
      this.commitSelection();
    }, 500);
  };

  private commitSelection(): void {
    if (!this.enabled || !this.viewport) return;

    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    // テキストレイヤー内の選択のみ処理
    if (!this.textLayerEl.contains(range.commonAncestorContainer)) return;

    const clientRects = range.getClientRects();
    if (clientRects.length === 0) return;

    const containerRect = this.textLayerEl.getBoundingClientRect();

    for (const clientRect of clientRects) {
      if (clientRect.width < 1 || clientRect.height < 1) continue;
      const cssRect = {
        left: clientRect.left - containerRect.left,
        top: clientRect.top - containerRect.top,
        width: clientRect.width,
        height: clientRect.height,
      };
      const pdfRect = cssToPdfRect(cssRect, this.viewport);
      this.store.add(this.pageNum, pdfRect);
    }

    selection.removeAllRanges();
    this.onSelectionAdded?.();
  }

  destroy(): void {
    this.textLayerEl.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('selectionchange', this.handleSelectionChange);
    if (this.selectionChangeTimer) {
      clearTimeout(this.selectionChangeTimer);
    }
  }
}
