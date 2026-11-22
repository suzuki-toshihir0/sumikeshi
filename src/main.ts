import { PdfViewer } from './viewer/pdf-viewer';
import { Toolbar } from './ui/toolbar';
import { PageNavigator } from './ui/page-navigator';
import { Overlay } from './ui/overlay';
import { SelectionManager } from './selection/selection-manager';
import { RedactionStore } from './redaction/redaction-store';
import { RedactionError } from './redaction/errors';
import { runRedactionInWorker } from './redaction/redaction-runner';
import type { PdfRect } from './utils/coordinates';
import { readFileAsArrayBuffer, downloadBytes } from './utils/file-io';
import { ImageViewer } from './viewer/image-viewer';
import { ImageDocument } from './image/image-document';
import { detectFileKind } from './image/image-format';

class App {
  private viewer: PdfViewer;
  private imageViewer: ImageViewer;
  private toolbar: Toolbar;
  private pageNav: PageNavigator;
  private overlay: Overlay;
  private selection: SelectionManager;
  private store: RedactionStore;

  private originalBytes: ArrayBuffer | null = null;
  private redactedBytes: Uint8Array | null = null;
  /** 開いている画像（PDF のときは null）。墨消しは手元の画素に重ねていき、書き出すたびに 1 回だけ圧縮する */
  private image: ImageDocument | null = null;
  /** 画像でこれまでに墨消しした範囲（書き出した画像でも黒いことを確かめる） */
  private imageRedacted: PdfRect[] = [];
  /** 墨消しの処理中（範囲の追加・削除と、別の PDF を開くことを止める） */
  private busy = false;
  /** 開こうとしたファイルの番号。読み込みの途中で次のファイルが選ばれたら、前のものは開かない */
  private loadRequest = 0;
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
    this.imageViewer = new ImageViewer(canvas, textLayerEl, viewerContainerEl);
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
    this.imageViewer.onPageRendered = (pageNum, viewport) => {
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
        if (this.image) this.imageViewer.render();
        else this.viewer.resize();
      }, 200);
    });
  }

  private setupMobileDropZone(): void {
    if ('ontouchstart' in window) {
      this.dropZone.textContent = 'PDF・画像を選択';
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
      // 形式は中身で決める（loadFile）。開けない形式なら、そこで理由を伝える
      const file = e.dataTransfer?.files[0];
      if (file) {
        this.loadFile(file);
      }
    });
  }

  private async loadFile(file: File): Promise<void> {
    if (this.refuseWhileBusy()) return;
    const request = ++this.loadRequest;
    const fileBytes = await readFileAsArrayBuffer(file);
    // 読んでいる間に次のファイルが選ばれていたら開かない。墨消しが始まっていたら、理由を伝えて開かない
    if (request !== this.loadRequest || this.refuseWhileBusy()) return;
    const kind = detectFileKind(new Uint8Array(fileBytes));
    if (!kind) {
      alert('開けるのは PDF と画像（JPEG・PNG・WebP・AVIF、Safari では HEIC も）です。');
      return;
    }
    // 画像は開く前に読んでおく（読めない・大きすぎる画像では、今開いている文書をそのまま残す）
    let image: ImageDocument | null = null;
    if (kind.kind === 'image') {
      try {
        image = await ImageDocument.decode(new Uint8Array(fileBytes), kind.format);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        console.warn('画像の読み込みエラー:', e.message);
        alert(`この画像は開けません。\n${e.message}`);
        return;
      }
      if (request !== this.loadRequest || this.refuseWhileBusy()) return;
    }

    const revision = ++this.docRevision;
    this.store.clear();
    // 前の文書の墨消しの結果を落とせないようにする
    this.redactedBytes = null;
    this.toolbar.hideDownload();
    document.getSelection()?.removeAllRanges();

    // UI切り替え
    this.dropZone.hidden = true;
    this.pageWrapper.hidden = false;
    this.toolbar.showControls();
    this.toolbar.setDocumentKind(kind.kind);

    if (image) {
      this.image = image;
      this.imageRedacted = [];
      this.originalBytes = null;
      this.viewer.destroy();
      this.pageNav.hide();
      this.imageViewer.load(image);
    } else {
      this.image = null;
      this.imageRedacted = [];
      this.imageViewer.unload();
      // pdf-libで後から使うためにコピーを保持する
      // (pdfjs-distがWorkerにtransferするとdetachedになるため)
      this.originalBytes = fileBytes.slice(0);
      this.pageNav.show();
      await this.viewer.load(fileBytes);
      // 読んでいる間に次の文書を開いたか、墨消しが始まっていたら、範囲を選べるようにしない
      // （墨消しが終われば、そちらで選べるようにする）。開けなかったファイルは文書を替えないので、ここでは数えない
      if (revision !== this.docRevision || this.busy) return;
    }
    this.selection.enable();
  }

  /** 墨消しの処理中なら、ファイルを開かずに理由を伝えて true を返す */
  private refuseWhileBusy(): boolean {
    if (!this.busy) return false;
    alert('墨消しの処理中は、ほかのファイルを開けません。処理が終わってから開いてください。');
    return true;
  }

  private refreshOverlay(): void {
    const viewport = this.image ? this.imageViewer.viewport : this.viewer.viewport;
    if (viewport) {
      this.overlay.render(this.image ? 1 : this.viewer.currentPageNumber, viewport);
    }
  }

  private async executeRedaction(): Promise<void> {
    if (!this.originalBytes && !this.image) return;
    if (!this.store.hasRects) {
      alert('墨消し対象の領域を選択してください。');
      return;
    }
    if (this.image) {
      await this.executeImageRedaction(this.image);
      return;
    }

    // 処理中は範囲を足したり消したりさせない（処理に渡した範囲と、終わったときに消す範囲がずれないように）
    this.busy = true;
    this.selection.disable();
    this.toolbar.setBusy(true);
    const revision = this.docRevision;
    /** 画面が墨消しの結果と合っている（表示に失敗したら、範囲を選ばせない） */
    let previewMatches = true;
    try {
      // 墨消しは Web Worker で動かす（壊れた画像などで終わらなくなっても画面が固まらないように）。
      // Worker に渡すと元の ArrayBuffer は使えなくなるので、写しを渡す
      const result = await runRedactionInWorker(
        () => new Worker(new URL('./redaction/redaction-worker.ts', import.meta.url), { type: 'module' }),
        this.originalBytes!.slice(0),
        this.store.getAllRects(),
      );
      // 処理中に文書が替わっていたら、古い文書の結果は使わない
      if (revision !== this.docRevision) return;
      // 墨消し済みバイトを新しいoriginalBytesとして保持し、追加の墨消しに備える
      this.redactedBytes = result;
      this.originalBytes = result.buffer.slice(0) as ArrayBuffer;
      this.store.clear();
      // 墨消しした範囲の枠も消す（結果の表示に失敗すると描き直されず、枠だけが残る）
      this.overlay.clear();

      // 墨消し結果でプレビューを更新する。表示に失敗しても、墨消しは済んでいるので結果は落とせるようにする
      const viewerBytes = result.buffer.slice(0) as ArrayBuffer;
      const currentPage = this.viewer.currentPageNumber;
      try {
        await this.viewer.load(viewerBytes, currentPage);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error('墨消し結果の表示エラー:', e.message, e.stack);
        previewMatches = false;
        alert(`墨消しは済みましたが、結果の表示に失敗しました。ダウンロードして確かめてください。続けて墨消しするときは、PDF を開き直してください。\n${e.message}`);
      }
      // 描き直す前の文字に掛かっていたブラウザの選択を残さない
      document.getSelection()?.removeAllRanges();
      // 表示を試みた後に出す（ボタンが見えたら処理は終わっている。表示に失敗しても結果は落とせる）
      this.toolbar.showDownload();
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
      // 文書が替わっておらず、画面が手元のバイト列と合っていれば、また範囲を選べるようにする。
      // 結果の表示に失敗したときは、画面が古い文書のままで、選んだ範囲が次に送るバイト列と合わないので選ばせない
      if (revision === this.docRevision && previewMatches) this.selection.enable();
    }
  }

  /**
   * 画像の墨消し。手元の画素の範囲を黒に置き換えてから書き出す。
   * 書き出せなかったら、置き換えた画素は戻さないが（戻すと黒の下の画素を手元に持ち続ける）、結果は落とさせない
   */
  private async executeImageRedaction(image: ImageDocument): Promise<void> {
    this.busy = true;
    this.selection.disable();
    this.toolbar.setBusy(true);
    const revision = this.docRevision;
    // 前回の結果は先に落とせなくする（今回の墨消しに失敗したとき、今回の範囲が残った画像を渡さない）
    this.redactedBytes = null;
    this.toolbar.hideDownload();
    try {
      const rects = this.store.getRectsForPage(1).slice();
      image.redact(rects);
      this.imageRedacted.push(...rects);
      this.store.clear();
      this.overlay.clear();
      this.imageViewer.render();
      const result = await image.encode(this.imageRedacted);
      if (revision !== this.docRevision) return;
      this.redactedBytes = result;
      this.toolbar.showDownload();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error('画像の墨消しエラー:', e.message, e.stack);
      alert(`墨消しした画像を書き出せませんでした。\n${e.message}`);
    } finally {
      this.busy = false;
      this.toolbar.setBusy(false);
      if (revision === this.docRevision) this.selection.enable();
    }
  }

  private downloadRedacted(): void {
    if (!this.redactedBytes) {
      alert('先に墨消しを実行してください。');
      return;
    }
    if (this.image) {
      const { mime, extension } = this.image.output;
      downloadBytes(this.redactedBytes, `redacted.${extension}`, mime);
    } else {
      downloadBytes(this.redactedBytes, 'redacted.pdf', 'application/pdf');
    }
  }
}

// アプリケーション起動
new App();
