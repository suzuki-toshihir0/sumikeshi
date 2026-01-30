export class PageNavigator {
  private nav: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private pageInfo: HTMLElement;

  onPrev: (() => void) | null = null;
  onNext: (() => void) | null = null;

  constructor() {
    this.nav = document.getElementById('page-nav') as HTMLElement;
    this.prevBtn = document.getElementById('btn-prev') as HTMLButtonElement;
    this.nextBtn = document.getElementById('btn-next') as HTMLButtonElement;
    this.pageInfo = document.getElementById('page-info') as HTMLElement;

    this.prevBtn.addEventListener('click', () => this.onPrev?.());
    this.nextBtn.addEventListener('click', () => this.onNext?.());
  }

  update(current: number, total: number): void {
    this.pageInfo.textContent = `${current} / ${total}`;
    this.prevBtn.disabled = current <= 1;
    this.nextBtn.disabled = current >= total;
  }

  show(): void {
    this.nav.hidden = false;
  }
}
