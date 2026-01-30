import type { PageViewport } from 'pdfjs-dist';
import type { RedactionStore } from '../redaction/redaction-store';
import { cssToPdfRect } from '../utils/coordinates';

export class RectSelection {
  private enabled = false;
  private pageNum = 1;
  private viewport: PageViewport | null = null;
  private isDragging = false;
  private startX = 0;
  private startY = 0;
  private drawingEl: HTMLDivElement | null = null;

  /** 選択追加時コールバック */
  onSelectionAdded: (() => void) | null = null;

  constructor(
    private overlayEl: HTMLElement,
    private pageContainerEl: HTMLElement,
    private store: RedactionStore,
  ) {
    this.pageContainerEl.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mouseup', this.handleMouseUp);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.overlayEl.style.pointerEvents = enabled ? 'auto' : 'none';
    this.pageContainerEl.style.cursor = enabled ? 'crosshair' : '';
  }

  setPageContext(pageNum: number, viewport: PageViewport): void {
    this.pageNum = pageNum;
    this.viewport = viewport;
  }

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    // 既存の墨消し矩形をクリックした場合はドラッグ開始しない
    if ((e.target as HTMLElement).classList.contains('redaction-rect')) return;

    const containerRect = this.pageContainerEl.getBoundingClientRect();
    this.startX = e.clientX - containerRect.left;
    this.startY = e.clientY - containerRect.top;
    this.isDragging = true;

    this.drawingEl = document.createElement('div');
    this.drawingEl.className = 'rect-drawing';
    this.drawingEl.style.left = `${this.startX}px`;
    this.drawingEl.style.top = `${this.startY}px`;
    this.drawingEl.style.width = '0px';
    this.drawingEl.style.height = '0px';
    this.overlayEl.appendChild(this.drawingEl);

    e.preventDefault();
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.isDragging || !this.drawingEl) return;

    const containerRect = this.pageContainerEl.getBoundingClientRect();
    const currentX = e.clientX - containerRect.left;
    const currentY = e.clientY - containerRect.top;

    const left = Math.min(this.startX, currentX);
    const top = Math.min(this.startY, currentY);
    const width = Math.abs(currentX - this.startX);
    const height = Math.abs(currentY - this.startY);

    this.drawingEl.style.left = `${left}px`;
    this.drawingEl.style.top = `${top}px`;
    this.drawingEl.style.width = `${width}px`;
    this.drawingEl.style.height = `${height}px`;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (!this.isDragging || !this.drawingEl || !this.viewport) return;
    this.isDragging = false;

    const containerRect = this.pageContainerEl.getBoundingClientRect();
    const endX = e.clientX - containerRect.left;
    const endY = e.clientY - containerRect.top;

    const left = Math.min(this.startX, endX);
    const top = Math.min(this.startY, endY);
    const width = Math.abs(endX - this.startX);
    const height = Math.abs(endY - this.startY);

    // 小さすぎるドラッグは無視
    if (width > 5 && height > 5) {
      const pdfRect = cssToPdfRect({ left, top, width, height }, this.viewport);
      this.store.add(this.pageNum, pdfRect);
      this.onSelectionAdded?.();
    }

    this.drawingEl.remove();
    this.drawingEl = null;
  };

  destroy(): void {
    this.pageContainerEl.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
  }
}
