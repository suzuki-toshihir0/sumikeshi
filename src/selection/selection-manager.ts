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
  /** 頁の座標があるか（頁を描き直している間は無い） */
  private hasPageContext = false;
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
    this.hasPageContext = true;
    this.publish();
  }

  /** 頁の座標を外す。頁を描き直している間は、前の頁の座標と頁番号で範囲を選ばない（描き終えたら setPageContext で戻す） */
  clearPageContext(): void {
    this.textSelection.clearPageContext();
    this.rectSelection.clearPageContext();
    this.hasPageContext = false;
    this.publish();
  }

  /**
   * 範囲を選べるか（選択が有効で、頁の座標がある）を、#page-container の data-selectable に出す。
   * E2E と画面の性質の試験（tests/pbt）は、これを見て範囲を選ぶ
   */
  private publish(): void {
    this.pageContainerEl.dataset.selectable = String(this.active && this.hasPageContext);
  }

  /** 選択を有効化する */
  enable(): void {
    this.active = true;
    this.publish();
    this.setMode(this._mode);
  }

  /** 選択を無効化する */
  disable(): void {
    this.active = false;
    this.publish();
    this.textSelection.setEnabled(false);
    this.rectSelection.setEnabled(false);
  }
}
