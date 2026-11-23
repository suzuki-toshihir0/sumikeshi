import type { RedactionStore } from '../redaction/redaction-store';
import { pdfToCssRect, type PageView } from '../utils/coordinates';

/** タップとみなす指の動きの上限（ピクセル） */
const TAP_SLOP_PX = 10;

export class Overlay {
  private container: HTMLElement;
  private store: RedactionStore;

  /** 墨消し領域クリック時コールバック(削除用) */
  onRectClick: ((pageNum: number, index: number) => void) | null = null;

  /**
   * 枠の「タップで消す」の候補。1 本指で枠に触れたときに覚え、2 本目の指が触れたり、指が動いたりしたら取り消す
   * （ピンチの指が枠の上で離れたのを、タップと取り違えて範囲を消さないように）
   */
  private tap: { el: HTMLElement; id: number; x: number; y: number } | null = null;

  constructor(container: HTMLElement, store: RedactionStore) {
    this.container = container;
    this.store = store;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) this.tap = null;
    });
    document.addEventListener('touchmove', (e) => {
      const t = this.tap && Array.from(e.touches).find((x) => x.identifier === this.tap!.id);
      if (t && Math.hypot(t.clientX - this.tap!.x, t.clientY - this.tap!.y) > TAP_SLOP_PX) this.tap = null;
    });
    document.addEventListener('touchcancel', () => (this.tap = null));
  }

  /** 現在のページのオーバーレイを再描画する */
  render(pageNum: number, viewport: PageView): void {
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
      el.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        this.tap = e.touches.length === 1 ? { el, id: t.identifier, x: t.clientX, y: t.clientY } : null;
      });
      el.addEventListener('touchend', (e) => {
        // 1 本指で触れて、2 本目が来ず、ほとんど動かさずに離したときだけ消す
        const tap = this.tap;
        this.tap = null;
        if (!tap || tap.el !== el || e.touches.length > 0) return;
        if (!Array.from(e.changedTouches).some((t) => t.identifier === tap.id)) return;
        // iOS がこのあと作るクリックで、二重に消さないように止める
        e.preventDefault();
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
