import type { RedactionStore } from '../redaction/redaction-store';
import { cssToPdfRect, type PageView } from '../utils/coordinates';

/** タッチで描きかけの枠を出すまでの待ち（ミリ秒）。iPhone の記録で、ピンチの 2 本目は 1 本目の 11〜132 ミリ秒後に触れていた */
const TOUCH_DRAW_DELAY_MS = 150;

/**
 * WebKit のタッチ（iOS の Safari と、iOS の Chrome などの WebKit を使うブラウザ）か。WebKit だけが GestureEvent を持つ。
 * 1 本指の touchmove を止めるかは、エンジンで逆になる:
 * - WebKit は、1 本目の指の touchmove を止めると、そのあと 2 本目の指が来てもピンチを受け付けない（iPhone の記録で、2 本目が
 *   来る前に 1 本目が 4 ピクセル以上動いた 14 回は 1 回も拡大されず、動かなかった 6 回は 6 回とも拡大された）
 * - Chromium は止めてもピンチを受け付ける。止めないと、1 本指のドラッグをブラウザが自分の操作として扱い、その直後（0.5 秒ほど）の
 *   タップをクリックにしない
 * 出来事のたびに見る（試験で GestureEvent を後から置いて WebKit を装えるように）
 */
function isWebKitTouch(): boolean {
  return typeof (window as unknown as { GestureEvent?: unknown }).GestureEvent !== 'undefined' && navigator.maxTouchPoints > 0;
}

export class RectSelection {
  private enabled = false;
  private pageNum = 1;
  private viewport: PageView | null = null;
  private isDragging = false;
  private startX = 0;
  private startY = 0;
  private drawingEl: HTMLDivElement | null = null;
  /** タッチで描いているときの、描き始めた指の識別子 */
  private dragTouchId: number | null = null;
  /** タッチで描いているときの、指の今の位置（ページの入れ物の中の座標） */
  private lastX = 0;
  private lastY = 0;
  /** 描きかけの枠を出すまでの待ち（ピンチの 1 本目で枠が一瞬出ないように） */
  private drawTimer: ReturnType<typeof setTimeout> | null = null;

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
    // 2 本目の指は、ページの外（ツールバーなど）に触れることもあるので、文書全体で見張る
    document.addEventListener('touchstart', this.handleAnyTouchStart);
    document.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    document.addEventListener('touchend', this.handleTouchEnd);
    // iOS がタッチを打ち切ったとき（ピンチやスクロールの操作に移ったときなど）は、描きかけの枠を捨てる
    document.addEventListener('touchcancel', this.handleTouchCancel);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    // 止めたら、ドラッグの途中のものは捨てる（文書の切り替えをまたいだドラッグを、次の文書の範囲にしない）
    if (!enabled) this.cancelDrag();
    this.overlayEl.style.pointerEvents = enabled ? 'auto' : 'none';
    this.pageContainerEl.style.cursor = enabled ? 'crosshair' : '';
    // 1 本指の移動（スクロール）は止めて範囲の選択に使い、2 本指の拡大・縮小（ピンチ）は止めない（細かい範囲を選ぶため）
    this.pageContainerEl.style.touchAction = enabled ? 'pinch-zoom' : '';
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
    // 頁を描き直している間（座標が無い間）は、ドラッグを始めない。描き直しをまたぐドラッグも捨てる（setPageContext）。
    // 描き直しの前の座標しか無いので、捨てないと別の頁や古い表示の位置に範囲が付く（意図した振る舞い）
    if (!this.enabled || !this.viewport || e.button !== 0) return;
    // 既存の墨消し矩形をクリックした場合はドラッグ開始しない
    if ((e.target as HTMLElement).classList.contains('redaction-rect')) return;

    // 前の描きかけの枠が残っていれば消してから始める（参照を失って画面に置き去りにしない）
    this.cancelDrag();
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
    // 2 本目の指が触れたら、ピンチとしてブラウザに任せる。描きかけの枠は捨て、preventDefault しない
    if (e.touches.length > 1) {
      this.cancelDrag();
      return;
    }
    if ((e.target as HTMLElement).classList.contains('redaction-rect')) return;

    // 前の描きかけの枠が残っていれば消してから始める（参照を失って画面に置き去りにしない）
    this.cancelDrag();
    const touch = e.touches[0];
    const containerRect = this.pageContainerEl.getBoundingClientRect();
    this.startX = touch.clientX - containerRect.left;
    this.startY = touch.clientY - containerRect.top;
    this.isDragging = true;
    this.dragTouchId = touch.identifier;
    this.lastX = this.startX;
    this.lastY = this.startY;
    // 描きかけの枠は、少し待ってから出す。ピンチでは 2 本目の指が 1 本目の少し後に触れる（iPhone の記録で 11〜132 ミリ秒後）。
    // その間に 2 本目が来れば、枠を出さずに捨てる（cancelDrag）。待つ間に離しても、範囲にはする（handleTouchEnd）
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      if (this.isDragging) this.showTouchDrawing();
    }, TOUCH_DRAW_DELAY_MS);
    // touchstart は、どのエンジンでも止めない。止めると、iOS の Safari（と Chromium）は、そのあと 2 本目の指が来てもピンチを
    // 受け付けない。1 本指のスクロールは touch-action: pinch-zoom で防ぐ（touchmove の扱いは isWebKitTouch の注を参照）
  };

  /** タッチで描きかけの枠を出す（始点から今の指の位置まで） */
  private showTouchDrawing(): void {
    this.drawingEl = document.createElement('div');
    this.drawingEl.className = 'rect-drawing';
    this.overlayEl.appendChild(this.drawingEl);
    this.updateTouchDrawing();
  }

  private updateTouchDrawing(): void {
    if (!this.drawingEl) return;
    this.drawingEl.style.left = `${Math.min(this.startX, this.lastX)}px`;
    this.drawingEl.style.top = `${Math.min(this.startY, this.lastY)}px`;
    this.drawingEl.style.width = `${Math.abs(this.lastX - this.startX)}px`;
    this.drawingEl.style.height = `${Math.abs(this.lastY - this.startY)}px`;
  }

  /** どこかで 2 本目の指が触れたら、描きかけの枠を捨てる（ピンチとしてブラウザに任せる） */
  private handleAnyTouchStart = (e: TouchEvent): void => {
    if (this.isDragging && e.touches.length > 1) this.cancelDrag();
  };

  /** 描き始めた指のタッチ（無ければ null） */
  private dragTouch(list: TouchList): Touch | null {
    return Array.from(list).find((t) => t.identifier === this.dragTouchId) ?? null;
  }

  private handleTouchMove = (e: TouchEvent): void => {
    if (!this.isDragging || this.dragTouchId === null) return;
    // 2 本指になったら、ピンチとしてブラウザに任せる
    if (e.touches.length > 1) {
      this.cancelDrag();
      return;
    }

    const touch = this.dragTouch(e.touches);
    if (!touch) return;
    const containerRect = this.pageContainerEl.getBoundingClientRect();
    this.lastX = touch.clientX - containerRect.left;
    this.lastY = touch.clientY - containerRect.top;
    this.updateTouchDrawing();
    // WebKit のタッチでは止めない（止めるとピンチを受け付けなくなる）。Chromium では止める（isWebKitTouch の注を参照）
    if (!isWebKitTouch()) e.preventDefault();
  };


  private handleTouchEnd = (e: TouchEvent): void => {
    if (!this.isDragging || this.dragTouchId === null || !this.viewport) return;
    // まだほかの指が触れていれば 2 本指の操作なので、範囲にしない
    if (e.touches.length > 0) {
      this.cancelDrag();
      return;
    }
    // 離れたのが描き始めた指でなければ、範囲にしない（終点を取り違えない）
    const touch = this.dragTouch(e.changedTouches);
    if (!touch) {
      this.cancelDrag();
      return;
    }
    this.isDragging = false;
    this.dragTouchId = null;

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

    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.drawTimer = null;
    this.drawingEl?.remove();
    this.drawingEl = null;
  };

  private handleTouchCancel = (): void => {
    this.cancelDrag();
  };

  /** 描きかけの枠を捨てる。参照を失った枠が残っていても、まとめて消す */
  cancelDrag(): void {
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.drawTimer = null;
    this.isDragging = false;
    this.dragTouchId = null;
    this.drawingEl = null;
    this.overlayEl.querySelectorAll('.rect-drawing').forEach((el) => el.remove());
  }

  destroy(): void {
    this.pageContainerEl.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    this.pageContainerEl.removeEventListener('touchstart', this.handleTouchStart);
    document.removeEventListener('touchstart', this.handleAnyTouchStart);
    document.removeEventListener('touchmove', this.handleTouchMove);
    document.removeEventListener('touchend', this.handleTouchEnd);
    document.removeEventListener('touchcancel', this.handleTouchCancel);
  }
}
