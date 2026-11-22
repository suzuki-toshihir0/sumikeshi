/**
 * sumikeshi の画面の性質の試験（Bombadil）。
 *
 * ファイルを開く・範囲を選ぶ・墨消し・頁送り・ダウンロード・画面の大きさの変更を、ランダムな順番と間合いで行い、
 * どの状態でも次の性質が成り立つかを確かめる。読み込み・描画・墨消しの非同期の処理の順番がずれる隙間を広げるため、
 * pdf.js の Worker へのやり取り、画像の読み込み、書き出し、ファイルの読み取りに、ランダムな遅れを差し込む。
 *
 * 素材は `npx tsx tests/pbt/make-fixtures.ts` で作る（頁・画像ごとに背景の色を変えてある。palette.ts）
 */
import { always, eventually, now } from '@antithesishq/bombadil';
import { extract, actions, weighted, registerCustomAction, type ActionTemplate } from '@antithesishq/bombadil/browser';
import { clicks } from '@antithesishq/bombadil/browser/defaults/actions';
import { isAction } from '@antithesishq/bombadil/actions';
import { FIXTURES } from './.fixtures/paths.ts';
import { identify } from './palette.ts';
export { noUncaughtExceptions, noUnhandledPromiseRejections, noConsoleErrors } from '@antithesishq/bombadil/browser/defaults/properties';

/** 範囲の中心（canvas の幅・高さに対する割合） */
type Centers = [number, number][];
/**
 * 頁ごとの範囲の中心。キーは頁（画像）の色の名前（palette.ts）、rev は開いた文書の番号（#page-container の data-doc-revision）。
 * 墨消しを押したときに、その文書の全頁の分を記録する（枠が見えている頁だけでなく、ほかの頁に付けた範囲も確かめる）
 */
type PageRects = { rev: string; pages: Record<string, Centers> };
/** 最後に選んだファイルの名前、選んだ順の番号、処理中だったため断られたか */
type LastFile = { name: string; seq: number; refused: boolean };
type Pbt = {
  alerts: string[];
  /** 墨消しを押したときの記録 */
  redact: PageRects | null;
  /** まだ墨消ししていない範囲（枠が描き直されるたびに、そのときの頁の分を更新する） */
  pending: PageRects;
  lastFile: LastFile | null;
  /** 範囲を選べる状態で表示されたことのある、最後に選んだファイルの番号 */
  shownSeq: number;
};

/** 知らせてよい（想定どおりの）知らせの書き出し */
const EXPECTED_ALERTS = [
  '墨消し対象の領域を選択してください',
  '開けるのは PDF と画像',
  'この PDF を開けませんでした',
  '墨消しの処理中は、ほかのファイルを開けません',
  '先に墨消しを実行してください',
];

/** 開けるファイルの名前と、表示されたときの色の名前の頭 */
const SHOWN_AS: Record<string, string> = {
  'doc-a.pdf': 'DOC-A ',
  'doc-b.pdf': 'DOC-B ',
  'small.png': 'IMAGE-SMALL',
  'big.png': 'IMAGE-BIG',
};

const ui = extract((s) => {
  const d = s.document;
  const w = s.window as unknown as { __pbt?: Pbt };
  const q = <T extends Element>(sel: string) => d.querySelector(sel) as T | null;
  const canvas = q<HTMLCanvasElement>('#pdf-canvas');
  const wrapper = q<HTMLElement>('#page-wrapper');
  const container = q<HTMLElement>('#page-container');
  const visible = !!wrapper && !wrapper.hidden && !!canvas && canvas.width > 4;
  const box = canvas?.getBoundingClientRect();

  /** canvas の、割合 (fx, fy) の位置の色 */
  const pixel = (fx: number, fy: number): number[] | null => {
    if (!visible || !canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const x = Math.min(canvas.width - 1, Math.floor(canvas.width * fx));
    const y = Math.min(canvas.height - 1, Math.floor(canvas.height * fy));
    return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
  };

  const pbt = w.__pbt;
  const selectable = container?.dataset.selectable === 'true';
  const corner = pixel(0.03, 0.03);
  const docRevision = container?.dataset.docRevision ?? '';
  // 墨消しの記録のうち、いま表示している文書・頁の分
  const record = pbt?.redact && pbt.redact.rev === docRevision ? pbt.redact : null;
  const recorded = record ? (record.pages[identify(corner) ?? ''] ?? []) : [];
  // 最後に選んだファイルが、範囲を選べる状態で表示されたら、ページの側に印を付ける（後の状態の性質で使う）
  const lastFile = pbt?.lastFile ?? null;
  const prefix = lastFile ? SHOWN_AS[lastFile.name] : undefined;
  const shown = !!lastFile && !!prefix && selectable && visible && (identify(corner) ?? '').startsWith(prefix);
  if (pbt && lastFile && shown) pbt.shownSeq = lastFile.seq;
  return {
    shim: !!pbt,
    visible,
    selectable,
    busy: !!q<HTMLButtonElement>('#btn-redact')?.disabled,
    downloadVisible: !(q<HTMLElement>('#btn-download')?.hidden ?? true),
    pageInfo: q('#page-info')?.textContent ?? '',
    navHidden: q<HTMLElement>('#page-nav')?.hidden ?? true,
    textModeHidden: q<HTMLElement>('#btn-text-mode')?.hidden ?? false,
    text: q('#text-layer')?.textContent ?? '',
    corner,
    viewport: { w: s.window.innerWidth, h: s.window.innerHeight },
    canvasBox: visible && box ? { x: box.x, y: box.y, w: box.width, h: Math.min(box.height, s.window.innerHeight - box.y) } : null,
    spans: Array.from(d.querySelectorAll('#text-layer span'))
      .slice(0, 6)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })
      .filter((r) => r.w > 4 && r.h > 4 && r.y + r.h < s.window.innerHeight),
    overlayRects: Array.from(d.querySelectorAll('.redaction-rect')).map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
    unexpectedAlerts: (pbt?.alerts ?? []).filter((m) => !EXPECTED_ALERTS.some((p) => m.startsWith(p))),
    docRevision,
    /** 墨消しの記録が、いま表示している文書のものか */
    hasRecord: !!record,
    lastFile,
    /** 最後に選んだファイルが、いま表示されている */
    lastFileShown: shown,
    shownSeq: pbt?.shownSeq ?? 0,
    /** いま表示している頁で、墨消しを押したときに記録した範囲の中心の色 */
    redactedColors: recorded.map(([fx, fy]) => pixel(fx, fy)),
  };
});

/**
 * 試験のための仕込み（頁を読み込むたびに 1 回）:
 * - alert を記録する（Bombadil も閉じるが、内容を性質で見るため）
 * - 墨消しのボタンを押したときの範囲を記録する
 * - 非同期の処理にランダムな遅れを差し込む（Worker へのやり取りは順番を保つ）
 */
const installShim = registerCustomAction('installShim', async (document, window) => {
  const w = window as unknown as Window & typeof globalThis & { __pbt: Pbt };
  const pbt: Pbt = { alerts: [], redact: null, pending: { rev: '', pages: {} }, lastFile: null, shownSeq: 0 };
  let fileSeq = 0;
  w.__pbt = pbt;
  w.alert = (m?: unknown) => {
    pbt.alerts.push(String(m));
    // 処理中で断られたファイルは、表示されなくてよい
    if (String(m).startsWith('墨消しの処理中は') && pbt.lastFile) pbt.lastFile.refused = true;
  };
  // 最後に選んだファイルを記録する（アプリより先に聞く）
  document.getElementById('file-input')?.addEventListener(
    'change',
    (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) pbt.lastFile = { name: f.name, seq: ++fileSeq, refused: false };
    },
    true,
  );
  const rand = (max: number) => Math.floor(Math.random() * max);

  const container = document.getElementById('page-container') as HTMLElement;
  const overlay = document.getElementById('overlay-layer') as HTMLElement;
  const canvas = document.getElementById('pdf-canvas') as HTMLCanvasElement;
  /** いま表示している頁の色の名前（描き直しの途中なら null） */
  const pageId = (): string | null => {
    if (container.dataset.selectable !== 'true') return null;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width < 4) return null;
    return identify(Array.from(ctx.getImageData(Math.floor(canvas.width * 0.03), Math.floor(canvas.height * 0.03), 1, 1).data.slice(0, 3)));
  };
  const overlayCenters = (): Centers => {
    const cb = canvas.getBoundingClientRect();
    return Array.from(overlay.querySelectorAll('.redaction-rect')).map((e) => {
      const r = e.getBoundingClientRect();
      return [(r.x + r.width / 2 - cb.x) / cb.width, (r.y + r.height / 2 - cb.y) / cb.height] as [number, number];
    });
  };
  const rev = () => container.dataset.docRevision ?? '';

  // 枠が描き直されるたびに（範囲の追加・削除、頁の表示）、その頁の範囲を覚える。文書が替わったら前の分は捨てる
  new w.MutationObserver(() => {
    const id = pageId();
    if (!id) return;
    if (pbt.pending.rev !== rev()) pbt.pending = { rev: rev(), pages: {} };
    pbt.pending.pages[id] = overlayCenters();
  }).observe(overlay, { childList: true });

  // 「選択範囲をクリア」は全頁の範囲を消す
  document.getElementById('btn-clear')?.addEventListener('click', () => (pbt.pending = { rev: rev(), pages: {} }), true);

  document.getElementById('btn-redact')?.addEventListener(
    'click',
    () => {
      if (pbt.pending.rev !== rev()) return;
      // 範囲が無いときは、アプリは知らせを出すだけで前の結果を残すので、前の記録も残す（空で上書きすると、以後の確かめが空回りする）
      if (!Object.values(pbt.pending.pages).some((c) => c.length > 0)) return;
      pbt.redact = { rev: pbt.pending.rev, pages: { ...pbt.pending.pages } };
      // 墨消しが済めばアプリは範囲を消す
      pbt.pending = { rev: rev(), pages: {} };
    },
    true,
  );

  // pdf.js の Worker へのやり取り: 順番を保ったまま遅らせる
  const post = w.Worker.prototype.postMessage;
  let last = 0;
  w.Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
    const at = Math.max(last, Date.now() + rand(150));
    last = at;
    setTimeout(() => (post as (...a: unknown[]) => void).apply(this, args), at - Date.now());
  } as typeof Worker.prototype.postMessage;

  const bitmap = w.createImageBitmap.bind(w);
  w.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) =>
    new Promise((r) => setTimeout(r, rand(600))).then(() => bitmap(...args))) as typeof createImageBitmap;

  const toBlob = w.HTMLCanvasElement.prototype.toBlob;
  w.HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, ...rest: unknown[]) {
    toBlob.call(this, (b) => setTimeout(() => cb(b), rand(600)), ...(rest as [string?, number?]));
  };

  const read = w.FileReader.prototype.readAsArrayBuffer;
  w.FileReader.prototype.readAsArrayBuffer = function (this: FileReader, blob: Blob) {
    setTimeout(() => read.call(this, blob), rand(300));
  };
});

// ---- 操作 ----

/** 画面の中（負でなく、窓の大きさの内側）の点か */
const onScreen = (p: { x: number; y: number }) => {
  const v = ui.current.viewport;
  return p.x >= 0 && p.y >= 0 && p.x < v.w && p.y < v.h;
};
/** 両端が画面の中のドラッグだけを残す */
const drag = (from: { x: number; y: number }, to: { x: number; y: number }, steps: [number, number] | number, delay: [number, number] | number): ActionTemplate[] =>
  onScreen(from) && onScreen(to) ? [{ MouseDrag: { from, to, steps, delayMillis: delay } }] : [];

const ready = () => ui.current.shim;

/** 仕込みが済んでいなければ、まず仕込む */
export const setup = actions(() => (ui.current.shim ? [] : [installShim()]));

const openFiles = actions(() => Object.values(FIXTURES).map((f) => ({ SetFileInputFiles: { selector: '#file-input', files: [f] } }) as ActionTemplate)).when(ready);

/** canvas の上の矩形のドラッグ（見えている部分の 10〜90% の中。左上の 3% の色は塗らない） */
const FRACTIONS: [number, number, number, number][] = [
  [0.1, 0.1, 0.4, 0.3],
  [0.5, 0.2, 0.9, 0.45],
  [0.2, 0.5, 0.6, 0.8],
  [0.15, 0.4, 0.85, 0.6],
  [0.6, 0.6, 0.9, 0.9],
];
const rectDrags = actions(() => {
  const b = ui.current.canvasBox;
  if (!b || b.h < 20) return [];
  return FRACTIONS.flatMap(([x0, y0, x1, y1]) => drag({ x: b.x + b.w * x0, y: b.y + b.h * y0 }, { x: b.x + b.w * x1, y: b.y + b.h * y1 }, [2, 8], [0, 40]));
}).when(ready);

/** 文字のレイヤーの文字をなぞる（文字選択） */
const textDrags = actions(() =>
  ui.current.spans.flatMap((r) => drag({ x: r.x + 1, y: r.y + r.h / 2 }, { x: r.x + r.w - 1, y: r.y + r.h / 2 }, [2, 8], [0, 40])),
).when(ready);

/** 墨消しの範囲の枠を押して消す（同じ場所で押して離す） */
const removeRects = actions(() =>
  ui.current.overlayRects.flatMap((p) => drag(p, p, 1, 0)),
).when(ready);

/** ツールバーと頁送りのボタンだけを押す（ファイルを開くボタンは、ファイルの選択の画面が開くので押さない） */
const BUTTONS = new Set(['btn-text-mode', 'btn-rect-mode', 'btn-clear', 'btn-redact', 'btn-download', 'btn-prev', 'btn-next']);
const buttons = clicks.filter((a) => isAction(a, 'Click') && BUTTONS.has(a.Click.fingerprint.id ?? '')).when(ready);

const resize = actions(() =>
  [
    [700, 768],
    [1024, 768],
    [1280, 900],
  ].map(([width, height]) => ({ SetViewport: { width, height } }) as ActionTemplate),
).when(ready);

const waits = actions(() => ['Wait' as const]);

/** 操作はまとめて 1 つだけ export する（export したものは全部登録されるので、個々も export すると二重に数えられる） */
export const all = weighted([
  [3, openFiles],
  [5, rectDrags],
  [2, textDrags],
  [1, removeRects],
  [6, buttons],
  [1, resize],
  [3, waits],
]);

// ---- 性質 ----

/**
 * 範囲を選べるときは、canvas・文字のレイヤー・頁番号・ボタンの出し分けが、同じ文書の同じ頁を指している。
 * 文字のレイヤーの頁の目印（「DOC-A PAGE-1/3」）は墨消しで消えうるので、「残っている目印がどれも表示中の頁のもの」を見る
 */
export const displayIsConsistent = always(() => {
  const u = ui.current;
  if (!u.selectable || !u.visible) return true;
  const id = identify(u.corner);
  if (!id) return false;
  const labels = u.text.match(/DOC-[AB] PAGE-\d\/\d/g) ?? [];
  const m = id.match(/^DOC-[AB] PAGE-(\d)\/(\d)$/);
  if (m) return u.pageInfo === `${m[1]} / ${m[2]}` && labels.every((l) => l === id) && !u.navHidden && !u.textModeHidden;
  return u.text === '' && u.navHidden && u.textModeHidden;
});

/** 処理中でなく文書を表示しているなら、20 秒以内に範囲を選べるようになる（選べないまま固まらない） */
export const becomesSelectable = always(
  now(() => ui.current.visible && !ui.current.busy && !ui.current.selectable).implies(
    eventually(() => ui.current.selectable || !ui.current.visible || ui.current.busy).within(20, 'seconds'),
  ),
);

/** 墨消しの処理中は、範囲を選べない */
export const notSelectableWhileBusy = always(() => !(ui.current.selectable && ui.current.busy));

/** 墨消しの処理は 30 秒以内に終わる */
export const busyEnds = always(now(() => ui.current.busy).implies(eventually(() => !ui.current.busy).within(30, 'seconds')));

/**
 * 墨消しの結果を落とせるなら、その文書で墨消しした範囲は、どの頁でも画面で黒い
 * （墨消しを押したときに全頁の範囲の中心を記録しておき、いま表示している頁の分の色を見る）
 */
export const redactedAreasAreBlack = always(() => {
  const u = ui.current;
  if (!u.hasRecord || u.busy || !u.selectable || !u.downloadVisible) return true;
  return u.redactedColors.every((c) => !!c && Math.max(...c) <= 40);
});

/**
 * 最後に選んだファイル（開けるもので、処理中で断られていないもの）は、次のファイルを選ばない限り、20 秒以内に表示される。
 * 読み込みの間は前の文書を表示していてよい（読み込みに失敗することもある）
 */
export const chosenFileIsEventuallyShown = always(() => {
  const f = ui.current.lastFile;
  if (!f || f.refused || !SHOWN_AS[f.name] || ui.current.lastFileShown) return true;
  const seq = f.seq;
  return eventually(() => {
    const u = ui.current;
    return !u.lastFile || u.lastFile.seq !== seq || u.lastFile.refused || u.lastFileShown;
  }).within(20, 'seconds');
});

/**
 * 最後に選んだファイルが一度表示されたら、次のファイルを選ぶまで、範囲を選べる状態では必ずそれを表示している
 * （遅れて終わった、前に選んだファイルの読み込みが、画面を上書きしない）
 */
export const shownFileStaysShown = always(() => {
  const u = ui.current;
  if (!u.selectable || !u.visible || u.busy || !u.lastFile || u.lastFile.refused) return true;
  if (u.shownSeq !== u.lastFile.seq) return true;
  return u.lastFileShown;
});

/** 想定していない失敗の知らせが出ない */
export const noUnexpectedAlerts = always(() => ui.current.unexpectedAlerts.length === 0);

