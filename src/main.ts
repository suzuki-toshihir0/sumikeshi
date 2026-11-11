import { PdfViewer } from './viewer/pdf-viewer';
import { Toolbar } from './ui/toolbar';
import { PageNavigator } from './ui/page-navigator';
import { Overlay } from './ui/overlay';
import { SelectionManager } from './selection/selection-manager';
import { RedactionStore } from './redaction/redaction-store';
import { RedactionError } from './redaction/errors';
import { runRedactionInWorker } from './redaction/redaction-runner';
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
  /** 墨消しの処理中（範囲の追加・削除と、別の PDF を開くことを止める） */
  private busy = false;
  /** 開いた文書の番号。処理中に文書が替わったら、古い処理の結果を捨てる */
  private docRevision = 0;
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
    this.setupMobileDropZone();
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
      if (this.busy) return;
      this.store.clear();
      this.refreshOverlay();
    };

    // 墨消し実行
    this.toolbar.onRedact = () => this.executeRedaction();

    // ダウンロード
    this.toolbar.onDownload = () => this.downloadRedacted();

    // オーバーレイの墨消し矩形クリック(削除)
    this.overlay.onRectClick = (pageNum, index) => {
      if (this.busy) return;
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

  private setupMobileDropZone(): void {
    if ('ontouchstart' in window) {
      this.dropZone.textContent = 'PDFを選択';
      this.dropZone.style.cursor = 'pointer';
      this.dropZone.addEventListener('click', () => {
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        fileInput.click();
      });
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
    if (this.busy) {
      alert('墨消しの処理中は、ほかの PDF を開けません。処理が終わってから開いてください。');
      return;
    }
    this.docRevision++;
    const fileBytes = await readFileAsArrayBuffer(file);
    // pdf-libで後から使うためにコピーを保持する
    // (pdfjs-distがWorkerにtransferするとdetachedになるため)
    this.originalBytes = fileBytes.slice(0);
    this.store.clear();
    // 前の文書の墨消しの結果を落とせないようにする
    this.redactedBytes = null;
    this.toolbar.hideDownload();
    document.getSelection()?.removeAllRanges();

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

    // 処理中は範囲を足したり消したりさせない（処理に渡した範囲と、終わったときに消す範囲がずれないように）
    this.busy = true;
    this.selection.disable();
    this.toolbar.setBusy(true);
    const revision = this.docRevision;
    try {
      // 墨消しは Web Worker で動かす（壊れた画像などで終わらなくなっても画面が固まらないように）。
      // Worker に渡すと元の ArrayBuffer は使えなくなるので、写しを渡す
      const result = await runRedactionInWorker(
        () => new Worker(new URL('./redaction/redaction-worker.ts', import.meta.url), { type: 'module' }),
        this.originalBytes.slice(0),
        this.store.getAllRects(),
      );
      // 処理中に文書が替わっていたら、古い文書の結果は使わない
      if (revision !== this.docRevision) return;
      // 墨消し済みバイトを新しいoriginalBytesとして保持し、追加の墨消しに備える
      this.redactedBytes = result;
      this.originalBytes = result.buffer.slice(0) as ArrayBuffer;
      this.store.clear();
      this.toolbar.showDownload();

      // 墨消し結果でプレビューを更新する。表示に失敗しても、墨消しは済んでいるので結果は落とせるようにする
      const viewerBytes = result.buffer.slice(0) as ArrayBuffer;
      const currentPage = this.viewer.currentPageNumber;
      try {
        await this.viewer.load(viewerBytes, currentPage);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error('墨消し結果の表示エラー:', e.message, e.stack);
        alert(`墨消しは済みましたが、結果の表示に失敗しました。ダウンロードして確かめてください。\n${e.message}`);
      }
      // 描き直す前の文字に掛かっていたブラウザの選択を残さない
      document.getSelection()?.removeAllRanges();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error('墨消し処理エラー:', e.message, e.stack);
      if (err instanceof RedactionError) {
        // 情報が残るおそれのある PDF は作らない。理由をそのまま伝える
        alert(`この PDF は安全に墨消しできないため、今回選んだ範囲の墨消しは行っていません。\n\n${e.message}`);
      } else {
        alert(`墨消し処理中にエラーが発生しました。今回選んだ範囲の墨消しは行っていません。\n${e.message}`);
      }
    } finally {
      this.busy = false;
      this.toolbar.setBusy(false);
      // 文書が替わっていなければ、成功しても失敗しても、また範囲を選べるようにする
      if (revision === this.docRevision) this.selection.enable();
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
