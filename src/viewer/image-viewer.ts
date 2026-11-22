import type { ImageDocument } from '../image/image-document';
import { imageViewport, type PageView } from '../utils/coordinates';
import { displayCanvasSize } from '../image/image-paint';

/** 画像を 1 枚、画面の幅に合わせて表示する（PDF の頁と同じ形の座標で、範囲を選べるようにする） */
export class ImageViewer {
  private image: ImageDocument | null = null;
  private _viewport: PageView | null = null;
  private canvas: HTMLCanvasElement;
  private textLayerEl: HTMLElement;
  private containerEl: HTMLElement;

  onPageRendered: ((pageNum: number, viewport: PageView) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, textLayerEl: HTMLElement, containerEl: HTMLElement) {
    this.canvas = canvas;
    this.textLayerEl = textLayerEl;
    this.containerEl = containerEl;
  }

  get viewport(): PageView | null {
    return this._viewport;
  }

  load(image: ImageDocument): void {
    this.image = image;
    this.render();
    this.containerEl.scrollTop = 0;
  }

  /** 墨消しの後や、画面の大きさが変わったときに描き直す */
  render(): void {
    const image = this.image;
    if (!image) return;
    const style = getComputedStyle(this.containerEl);
    const available = this.containerEl.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    // 大きな写真は画面の幅まで縮める。小さな画像は 2.5 倍まで拡げる
    const scale = Math.min(Math.max(available, 1) / image.width, 2.5);
    this._viewport = imageViewport(image.width, image.height, scale);

    const size = displayCanvasSize(this._viewport.width, this._viewport.height, window.devicePixelRatio || 1);
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.canvas.style.width = `${this._viewport.width}px`;
    this.canvas.style.height = `${this._viewport.height}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.canvas, 0, 0, this.canvas.width, this.canvas.height);

    // 画像には文字が無い。前に開いた PDF の文字を残さない
    this.textLayerEl.replaceChildren();
    this.onPageRendered?.(1, this._viewport);
  }

  unload(): void {
    this.image = null;
    this._viewport = null;
  }
}
