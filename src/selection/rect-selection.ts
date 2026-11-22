import type { RedactionStore } from '../redaction/redaction-store';
import { cssToPdfRect, type PageView } from '../utils/coordinates';

export class RectSelection {
  private enabled = false;
  private pageNum = 1;
  private viewport: PageView | null = null;
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
    this.pageContainerEl.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    document.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    document.addEventListener('touchend', this.handleTouchEnd);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    // 止めたら、ドラッグの途中のものは捨てる（文書の切り替えをまたいだドラッグを、次の文書の範囲にしない）
    if (!enabled) this.cancelDrag();
    this.overlayEl.style.pointerEvents = enabled ? 'auto' : 'none';
    this.pageContainerEl.style.cursor = enabled ? 'crosshair' : '';
    this.pageContainerEl.style.touchAction = enabled ? 'none' : '';
  }

  setPageContext(pageNum: number, viewport: PageView): void {
    // 頁の座標が替わったら、前の座標で押し始めたドラッグは捨てる
    this.cancelDrag();
    this.pageNum = pageNum;
    this.viewport = viewport;
  }

  /** 頁の座標を外す（頁を描き直している間は、範囲を選ばない。途中のドラッグも捨てる） */
  clearPageContext(): void {
    this.viewport = null;
    this.cancelDrag();
  }

  private handleMouseDown = (e: MouseEvent): void => {
    // 頁を描き直している間（座標が無い間）は、ドラッグを始めない
    if (!this.enabled || !this.viewport || e.button !== 0) return;
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

  private handleTouchStart = (e: TouchEvent): void => {
    if (!this.enabled || !this.viewport) return;
    if ((e.target as HTMLElement).classList.contains('redaction-rect')) return;

    const touch = e.touches[0];
    const containerRect = this.pageContainerEl.getBoundingClientRect();
    this.startX = touch.clientX - containerRect.left;
    this.startY = touch.clientY - containerRect.top;
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

  private handleTouchMove = (e: TouchEvent): void => {
    if (!this.isDragging || !this.drawingEl) return;

    const touch = e.touches[0];
    const containerRect = this.pageContainerEl.getBoundingClientRect();
    const currentX = touch.clientX - containerRect.left;
    const currentY = touch.clientY - containerRect.top;

    const left = Math.min(this.startX, currentX);
    const top = Math.min(this.startY, currentY);
    const width = Math.abs(currentX - this.startX);
    const height = Math.abs(currentY - this.startY);

    this.drawingEl.style.left = `${left}px`;
    this.drawingEl.style.top = `${top}px`;
    this.drawingEl.style.width = `${width}px`;
    this.drawingEl.style.height = `${height}px`;

    e.preventDefault();
  };

  private handleTouchEnd = (e: TouchEvent): void => {
    if (!this.isDragging || !this.drawingEl || !this.viewport) return;
    this.isDragging = false;

    const touch = e.changedTouches[0];
    const containerRect = this.pageContainerEl.getBoundingClientRect();
    const endX = touch.clientX - containerRect.left;
    const endY = touch.clientY - containerRect.top;

    const left = Math.min(this.startX, endX);
    const top = Math.min(this.startY, endY);
    const width = Math.abs(endX - this.startX);
    const height = Math.abs(endY - this.startY);

    if (width > 5 && height > 5) {
      const pdfRect = cssToPdfRect({ left, top, width, height }, this.viewport);
      this.store.add(this.pageNum, pdfRect);
      this.onSelectionAdded?.();
    }

    this.drawingEl.remove();
    this.drawingEl = null;
  };

  private cancelDrag(): void {
    this.isDragging = false;
    this.drawingEl?.remove();
    this.drawingEl = null;
  }

  destroy(): void {
    this.pageContainerEl.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    this.pageContainerEl.removeEventListener('touchstart', this.handleTouchStart);
    document.removeEventListener('touchmove', this.handleTouchMove);
    document.removeEventListener('touchend', this.handleTouchEnd);
  }
}
