export type SelectionMode = 'text' | 'rect';

export class Toolbar {
  private fileInput: HTMLInputElement;
  private modeGroups: NodeListOf<HTMLElement>;
  private actionGroup: HTMLElement;
  private textModeBtn: HTMLButtonElement;
  private rectModeBtn: HTMLButtonElement;
  private modeSlider: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private redactBtn: HTMLButtonElement;
  private downloadBtn: HTMLButtonElement;

  private _mode: SelectionMode = 'text';

  onFileSelect: ((file: File) => void) | null = null;
  onModeChange: ((mode: SelectionMode) => void) | null = null;
  onClear: (() => void) | null = null;
  onRedact: (() => void) | null = null;
  onDownload: (() => void) | null = null;

  constructor() {
    this.fileInput = document.getElementById('file-input') as HTMLInputElement;
    this.modeGroups = document.querySelectorAll('.mode-group') as NodeListOf<HTMLElement>;
    this.actionGroup = document.querySelector('.action-group') as HTMLElement;
    this.textModeBtn = document.getElementById('btn-text-mode') as HTMLButtonElement;
    this.rectModeBtn = document.getElementById('btn-rect-mode') as HTMLButtonElement;
    this.modeSlider = document.querySelector('.mode-slider') as HTMLElement;
    this.clearBtn = document.getElementById('btn-clear') as HTMLButtonElement;
    this.redactBtn = document.getElementById('btn-redact') as HTMLButtonElement;
    this.downloadBtn = document.getElementById('btn-download') as HTMLButtonElement;

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) {
        this.onFileSelect?.(file);
        // 同じファイルを再選択可能にする
        this.fileInput.value = '';
      }
    });

    this.textModeBtn.addEventListener('click', () => this.setMode('text'));
    this.rectModeBtn.addEventListener('click', () => this.setMode('rect'));
    this.clearBtn.addEventListener('click', () => this.onClear?.());
    this.redactBtn.addEventListener('click', () => this.onRedact?.());
    this.downloadBtn.addEventListener('click', () => this.onDownload?.());
  }

  get mode(): SelectionMode {
    return this._mode;
  }

  setMode(mode: SelectionMode): void {
    this._mode = mode;
    this.textModeBtn.classList.toggle('active', mode === 'text');
    this.rectModeBtn.classList.toggle('active', mode === 'rect');
    this.updateSlider();
    this.onModeChange?.(mode);
  }

  /** アクティブボタンの実際の位置・幅に合わせてスライダーを配置する */
  private updateSlider(): void {
    const activeBtn = this._mode === 'text' ? this.textModeBtn : this.rectModeBtn;
    const toggle = this.modeSlider.parentElement;
    if (!toggle) return;
    const toggleRect = toggle.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    this.modeSlider.style.left = `${btnRect.left - toggleRect.left}px`;
    this.modeSlider.style.width = `${btnRect.width}px`;
  }

  /** PDF読み込み後にUIを表示する */
  showControls(): void {
    this.modeGroups.forEach((el) => { el.hidden = false; });
    this.actionGroup.hidden = false;
    // 表示後にスライダー位置を初期化（hidden状態ではサイズ計算不可のため）
    requestAnimationFrame(() => this.updateSlider());
  }

  /** ダウンロードボタンを表示する */
  showDownload(): void {
    this.downloadBtn.hidden = false;
  }
}
