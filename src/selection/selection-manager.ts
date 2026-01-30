import type { PageViewport } from 'pdfjs-dist';
import type { SelectionMode } from '../ui/toolbar';
import type { RedactionStore } from '../redaction/redaction-store';
import { TextSelection } from './text-selection';
import { RectSelection } from './rect-selection';

export class SelectionManager {
  private textSelection: TextSelection;
  private rectSelection: RectSelection;
  private _mode: SelectionMode = 'text';
  private textLayerEl: HTMLElement;

  constructor(
    textLayerEl: HTMLElement,
    overlayEl: HTMLElement,
    pageContainerEl: HTMLElement,
    store: RedactionStore,
  ) {
    this.textLayerEl = textLayerEl;
    this.textSelection = new TextSelection(textLayerEl, store);
    this.rectSelection = new RectSelection(overlayEl, pageContainerEl, store);
  }

  get mode(): SelectionMode {
    return this._mode;
  }

  setMode(mode: SelectionMode): void {
    this._mode = mode;
    this.textSelection.setEnabled(mode === 'text');
    this.rectSelection.setEnabled(mode === 'rect');
    this.textLayerEl.classList.toggle('selecting-text', mode === 'text');
  }

  /** ページ情報を更新する */
  setPageContext(pageNum: number, viewport: PageViewport): void {
    this.textSelection.setPageContext(pageNum, viewport);
    this.rectSelection.setPageContext(pageNum, viewport);
  }

  /** 選択を有効化する */
  enable(): void {
    this.setMode(this._mode);
  }

  /** 選択を無効化する */
  disable(): void {
    this.textSelection.setEnabled(false);
    this.rectSelection.setEnabled(false);
  }
}
