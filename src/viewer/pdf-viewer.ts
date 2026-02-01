import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { renderTextLayer } from './text-layer';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

export class PdfViewer {
  private doc: PDFDocumentProxy | null = null;
  private currentPage: PDFPageProxy | null = null;
  private _currentPageNumber = 1;
  private _totalPages = 0;
  private _viewport: PageViewport | null = null;
  private scale = 1.5;

  private canvas: HTMLCanvasElement;
  private textLayerEl: HTMLElement;
  private containerEl: HTMLElement;

  /** ページ変更時コールバック */
  onPageChange: ((pageNum: number, total: number) => void) | null = null;
  /** ページ描画完了コールバック */
  onPageRendered: ((pageNum: number, viewport: PageViewport) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, textLayerEl: HTMLElement, containerEl: HTMLElement) {
    this.canvas = canvas;
    this.textLayerEl = textLayerEl;
    this.containerEl = containerEl;
  }

  get currentPageNumber(): number {
    return this._currentPageNumber;
  }

  get totalPages(): number {
    return this._totalPages;
  }

  get viewport(): PageViewport | null {
    return this._viewport;
  }

  /** PDFをArrayBufferから読み込む */
  async load(data: ArrayBuffer, initialPage?: number): Promise<void> {
    this.doc = await pdfjsLib.getDocument({
      data,
      cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
      cMapPacked: true,
    }).promise;
    this._totalPages = this.doc.numPages;
    const page = Math.min(initialPage ?? 1, this._totalPages);
    this._currentPageNumber = page;
    await this.renderPage(page);
  }

  /** コンテナ幅に収まるスケールを計算する */
  private calcFitWidthScale(page: PDFPageProxy): number {
    const style = getComputedStyle(this.containerEl);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const availableWidth = this.containerEl.clientWidth - paddingLeft - paddingRight;
    const pageWidth = page.getViewport({ scale: 1 }).width;
    const fitScale = availableWidth / pageWidth;
    return Math.min(Math.max(fitScale, 0.5), 2.5);
  }

  /** 現在のページをリサイズに合わせて再描画する */
  async resize(): Promise<void> {
    if (!this.doc || !this.currentPage) return;
    await this.renderPage(this._currentPageNumber);
  }

  /** 指定ページを描画する */
  async renderPage(pageNum: number): Promise<void> {
    if (!this.doc) return;
    if (pageNum < 1 || pageNum > this._totalPages) return;

    this._currentPageNumber = pageNum;
    this.currentPage = await this.doc.getPage(pageNum);
    this.scale = this.calcFitWidthScale(this.currentPage);
    this._viewport = this.currentPage.getViewport({ scale: this.scale });

    // Canvas描画（高DPIデバイス対応）
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this._viewport.width * dpr;
    this.canvas.height = this._viewport.height * dpr;
    this.canvas.style.width = `${this._viewport.width}px`;
    this.canvas.style.height = `${this._viewport.height}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    await this.currentPage.render({
      canvasContext: ctx,
      viewport: this._viewport,
    }).promise;

    // テキストレイヤー描画
    const textContent = await this.currentPage.getTextContent();
    await renderTextLayer(this.textLayerEl, textContent, this._viewport);

    this.onPageChange?.(this._currentPageNumber, this._totalPages);
    this.onPageRendered?.(this._currentPageNumber, this._viewport);
  }

  async nextPage(): Promise<void> {
    await this.renderPage(this._currentPageNumber + 1);
  }

  async prevPage(): Promise<void> {
    await this.renderPage(this._currentPageNumber - 1);
  }

  destroy(): void {
    this.doc?.destroy();
    this.doc = null;
    this.currentPage = null;
  }
}
