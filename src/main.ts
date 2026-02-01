import { PdfViewer } from './viewer/pdf-viewer';
import { Toolbar } from './ui/toolbar';
import { PageNavigator } from './ui/page-navigator';
import { Overlay } from './ui/overlay';
import { SelectionManager } from './selection/selection-manager';
import { RedactionStore } from './redaction/redaction-store';
import { redactPdf } from './redaction/pdf-redactor';
import { readFileAsArrayBuffer, downloadPdf } from './utils/file-io';

class App {
  private viewer: PdfViewer;
  private toolbar: Toolbar;
  private pageNav: PageNavigator;
  private overlay: Overlay;
  private selection: SelectionManager;
  private store: RedactionStore;

  private originalBytes: ArrayBuffer | null = null;
  private redactedBytes: Uint8Array | null = null;
  private dropZone: HTMLElement;
  private pageWrapper: HTMLElement;

  constructor() {
    const canvas = document.getElementById('pdf-canvas') as HTMLCanvasElement;
    const textLayerEl = document.getElementById('text-layer') as HTMLElement;
    const overlayEl = document.getElementById('overlay-layer') as HTMLElement;
    const pageContainerEl = document.getElementById('page-container') as HTMLElement;
    this.dropZone = document.getElementById('drop-zone') as HTMLElement;
    this.pageWrapper = document.getElementById('page-wrapper') as HTMLElement;

    const viewerContainerEl = document.getElementById('viewer-container') as HTMLElement;

    this.store = new RedactionStore();
    this.viewer = new PdfViewer(canvas, textLayerEl, viewerContainerEl);
    this.toolbar = new Toolbar();
    this.pageNav = new PageNavigator();
    this.overlay = new Overlay(overlayEl, this.store);
    this.selection = new SelectionManager(textLayerEl, overlayEl, pageContainerEl, this.store);

    this.setupEventHandlers();
    this.setupDragAndDrop();
    this.setupResizeHandler();
    this.setupMobileDropZoneText();
  }

  private setupEventHandlers(): void {
    // ファイル選択
    this.toolbar.onFileSelect = (file) => this.loadFile(file);

    // ページナビゲーション
    this.pageNav.onPrev = () => this.viewer.prevPage();
    this.pageNav.onNext = () => this.viewer.nextPage();

    // ページ変更時
    this.viewer.onPageChange = (pageNum, total) => {
      this.pageNav.update(pageNum, total);
    };

    // ページ描画完了時
    this.viewer.onPageRendered = (pageNum, viewport) => {
      this.selection.setPageContext(pageNum, viewport);
      this.overlay.render(pageNum, viewport);
    };

    // モード切替
    this.toolbar.onModeChange = (mode) => {
      this.selection.setMode(mode);
    };

    // 選択クリア
    this.toolbar.onClear = () => {
      this.store.clear();
      this.refreshOverlay();
    };

    // 墨消し実行
    this.toolbar.onRedact = () => this.executeRedaction();

    // ダウンロード
    this.toolbar.onDownload = () => this.downloadRedacted();

    // オーバーレイの墨消し矩形クリック(削除)
    this.overlay.onRectClick = (pageNum, index) => {
      this.store.remove(pageNum, index);
      this.refreshOverlay();
    };

    // テキスト選択・矩形選択完了時にオーバーレイ更新
    this.setupSelectionCallbacks();
  }

  private setupSelectionCallbacks(): void {
    // SelectionManagerの内部コンポーネントにコールバックを設定
    // TextSelectionとRectSelectionのonSelectionAddedは
    // SelectionManager経由ではなく直接アクセスが必要なので、
    // MutationObserverでストアの変更を検知する代わりに
    // 定期的なリフレッシュを使わず、storeをProxyでラップすることも検討したが、
    // シンプルにstoreのaddメソッドをフックする
    const originalAdd = this.store.add.bind(this.store);
    this.store.add = (pageNum, rect) => {
      originalAdd(pageNum, rect);
      this.refreshOverlay();
    };
  }

  private setupResizeHandler(): void {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.viewer.resize();
      }, 200);
    });
  }

  private setupMobileDropZoneText(): void {
    if ('ontouchstart' in window) {
      this.dropZone.textContent = 'PDFを開くボタンからPDFを選択';
    }
  }

  private setupDragAndDrop(): void {
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.classList.add('dragover');
    });

    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.classList.remove('dragover');
    });

    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('dragover');
      const file = e.dataTransfer?.files[0];
      if (file && file.type === 'application/pdf') {
        this.loadFile(file);
      }
    });
  }

  private async loadFile(file: File): Promise<void> {
    const fileBytes = await readFileAsArrayBuffer(file);
    // pdf-libで後から使うためにコピーを保持する
    // (pdfjs-distがWorkerにtransferするとdetachedになるため)
    this.originalBytes = fileBytes.slice(0);
    this.store.clear();

    // UI切り替え
    this.dropZone.hidden = true;
    this.pageWrapper.hidden = false;
    this.toolbar.showControls();
    this.pageNav.show();

    await this.viewer.load(fileBytes);
    this.selection.enable();
  }

  private refreshOverlay(): void {
    const viewport = this.viewer.viewport;
    if (viewport) {
      this.overlay.render(this.viewer.currentPageNumber, viewport);
    }
  }

  private async executeRedaction(): Promise<void> {
    if (!this.originalBytes) return;
    if (!this.store.hasRects) {
      alert('墨消し対象の領域を選択してください。');
      return;
    }

    try {
      this.redactedBytes = await redactPdf(
        this.originalBytes,
        this.store.getAllRects(),
      );

      // 墨消し結果でプレビューを更新する
      // 墨消し済みバイトを新しいoriginalBytesとして保持し、追加の墨消しに備える
      this.originalBytes = this.redactedBytes.buffer.slice(0) as ArrayBuffer;
      this.store.clear();
      const viewerBytes = this.redactedBytes.buffer.slice(0) as ArrayBuffer;
      const currentPage = this.viewer.currentPageNumber;
      await this.viewer.load(viewerBytes, currentPage);
      this.selection.enable();
      this.toolbar.showDownload();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error('墨消し処理エラー:', e.message, e.stack);
      alert(`墨消し処理中にエラーが発生しました。\n${e.message}`);
    }
  }

  private downloadRedacted(): void {
    if (!this.redactedBytes) {
      alert('先に墨消しを実行してください。');
      return;
    }
    downloadPdf(this.redactedBytes, 'redacted.pdf');
  }
}

// アプリケーション起動
new App();
