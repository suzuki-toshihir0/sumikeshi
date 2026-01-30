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

  /** ページ変更時コールバック */
  onPageChange: ((pageNum: number, total: number) => void) | null = null;
  /** ページ描画完了コールバック */
  onPageRendered: ((pageNum: number, viewport: PageViewport) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, textLayerEl: HTMLElement) {
    this.canvas = canvas;
    this.textLayerEl = textLayerEl;
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
  async load(data: ArrayBuffer): Promise<void> {
    this.doc = await pdfjsLib.getDocument({ data }).promise;
    this._totalPages = this.doc.numPages;
    this._currentPageNumber = 1;
    await this.renderPage(1);
  }

  /** 指定ページを描画する */
  async renderPage(pageNum: number): Promise<void> {
    if (!this.doc) return;
    if (pageNum < 1 || pageNum > this._totalPages) return;

    this._currentPageNumber = pageNum;
    this.currentPage = await this.doc.getPage(pageNum);
    this._viewport = this.currentPage.getViewport({ scale: this.scale });

    // Canvas描画
    this.canvas.width = this._viewport.width;
    this.canvas.height = this._viewport.height;
    const ctx = this.canvas.getContext('2d')!;
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
