import type { PageView } from '../utils/coordinates';
import type { SelectionMode } from '../ui/toolbar';
import type { RedactionStore } from '../redaction/redaction-store';
import { TextSelection } from './text-selection';
import { RectSelection } from './rect-selection';

export class SelectionManager {
  private textSelection: TextSelection;
  private rectSelection: RectSelection;
  private _mode: SelectionMode = 'text';
  /** 範囲を選ばせてよいか。止めている間（墨消しの処理中、次の文書の読み込み中）は、選び方を切り替えても有効にしない */
  private active = false;
  private textLayerEl: HTMLElement;
  private pageContainerEl: HTMLElement;

  constructor(
    textLayerEl: HTMLElement,
    overlayEl: HTMLElement,
    pageContainerEl: HTMLElement,
    store: RedactionStore,
  ) {
    this.textLayerEl = textLayerEl;
    this.pageContainerEl = pageContainerEl;
    this.textSelection = new TextSelection(textLayerEl, store);
    this.rectSelection = new RectSelection(overlayEl, pageContainerEl, store);
  }

  get mode(): SelectionMode {
    return this._mode;
  }

  setMode(mode: SelectionMode): void {
    this._mode = mode;
    this.textSelection.setEnabled(this.active && mode === 'text');
    this.rectSelection.setEnabled(this.active && mode === 'rect');
    this.textLayerEl.classList.toggle('selecting-text', mode === 'text');
  }

  /** ページ情報を更新する */
  setPageContext(pageNum: number, viewport: PageView): void {
    this.textSelection.setPageContext(pageNum, viewport);
    this.rectSelection.setPageContext(pageNum, viewport);
  }

  /** 頁の座標を外す。頁を描き直している間は、前の頁の座標と頁番号で範囲を選ばない（描き終えたら setPageContext で戻す） */
  clearPageContext(): void {
    this.textSelection.clearPageContext();
    this.rectSelection.clearPageContext();
  }

  /** 選択を有効化する */
  enable(): void {
    this.active = true;
    // 範囲を選べるかを外から見えるようにする（E2E は、これを待ってから範囲を選ぶ）
    this.pageContainerEl.dataset.selectable = 'true';
    this.setMode(this._mode);
  }

  /** 選択を無効化する */
  disable(): void {
    this.active = false;
    this.pageContainerEl.dataset.selectable = 'false';
    this.textSelection.setEnabled(false);
    this.rectSelection.setEnabled(false);
  }
}
