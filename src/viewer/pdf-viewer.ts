import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
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
  /** 読み込みの世代。読み込みの途中で次の文書が開かれたら（画像を含む）、古い読み込みは文書を差し替えない */
  private generation = 0;
  /** 描画の番号。最後に頼んだ描画だけが、canvas とコールバックを触る */
  private renderSeq = 0;
  private renderTask: RenderTask | null = null;

  private canvas: HTMLCanvasElement;
  private textLayerEl: HTMLElement;
  private containerEl: HTMLElement;

  /** ページ変更時コールバック */
  onPageChange: ((pageNum: number, total: number) => void) | null = null;
  /** 頁の描画を始めたときのコールバック（描き終えるまで、前の頁の座標を使わせない） */
  onRenderStart: (() => void) | null = null;
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
    const generation = ++this.generation;
    const doc = await pdfjsLib.getDocument({
      data,
      cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
      cMapPacked: true,
    }).promise;
    if (generation !== this.generation) {
      doc.destroy();
      return;
    }
    this.doc = doc;
    this._totalPages = this.doc.numPages;
    const page = Math.min(initialPage ?? 1, this._totalPages);
    this._currentPageNumber = page;
    await this.renderPage(page);
    if (generation !== this.generation) return;
    // 新しい文書を開いたときは先頭から見せる（墨消しの後の描き直しでは位置を保つ）
    if (initialPage === undefined) this.containerEl.scrollTop = 0;
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

  /**
   * 指定ページを描画する。最後に頼んだ描画だけを生かす（頁送りを続けて押したときや、墨消しの後の描き直しの最中に
   * 頁を送ったとき、先に始めた描画が後から終わって、画面と座標を古い頁や古い文書に戻さないように）。
   * 前の描画は取り消す（同じ canvas に 2 つの描画が混ざらないように）
   */
  async renderPage(pageNum: number): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    if (pageNum < 1 || pageNum > this._totalPages) return;

    const seq = ++this.renderSeq;
    const superseded = () => seq !== this.renderSeq;
    this.onRenderStart?.();
    const pageChanged = pageNum !== this._currentPageNumber;
    this._currentPageNumber = pageNum;
    const page = await doc.getPage(pageNum);
    if (superseded()) return;
    this.currentPage = page;
    this.scale = this.calcFitWidthScale(page);
    const viewport = page.getViewport({ scale: this.scale });
    this._viewport = viewport;

    // Canvas描画（高DPIデバイス対応）
    this.renderTask?.cancel();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = viewport.width * dpr;
    this.canvas.height = viewport.height * dpr;
    this.canvas.style.width = `${viewport.width}px`;
    this.canvas.style.height = `${viewport.height}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const task = page.render({ canvasContext: ctx, viewport });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      // 次の描画に取り消されたものは、何もしない
      if (superseded()) return;
      throw err;
    }
    if (superseded()) return;

    // テキストレイヤー描画
    const textContent = await page.getTextContent();
    if (superseded()) return;
    try {
      await renderTextLayer(this.textLayerEl, textContent, viewport);
    } catch (err) {
      if (superseded()) return;
      throw err;
    }
    if (superseded()) return;

    // 頁を移ったときは、その頁の先頭から見せる
    if (pageChanged) this.containerEl.scrollTop = 0;
    this.onPageChange?.(this._currentPageNumber, this._totalPages);
    this.onPageRendered?.(this._currentPageNumber, viewport);
  }

  async nextPage(): Promise<void> {
    await this.renderPage(this._currentPageNumber + 1);
  }

  async prevPage(): Promise<void> {
    await this.renderPage(this._currentPageNumber - 1);
  }

  /** 文書を閉じる。読み込み・描画の途中のものも、この後は画面に触らない */
  destroy(): void {
    this.generation++;
    this.renderSeq++;
    this.renderTask?.cancel();
    this.renderTask = null;
    this.doc?.destroy();
    this.doc = null;
    this.currentPage = null;
  }
}
