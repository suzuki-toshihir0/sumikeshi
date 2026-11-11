import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractImages, pixelCenterOnPage, inside, allText } from '../unit/helpers/pdf-oracle';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(__dirname, '../fixtures/real', name);

// 頁がまるごと画面に収まるよう、縦長にする
test.use({ viewport: { width: 900, height: 1400 } });

/** PDF の座標の矩形を、画面の上でドラッグして選ぶ（表示の倍率は canvas の幅から求める） */
async function dragPdfRect(page: Page, pageWidth: number, pageHeight: number, r: { x: number; y: number; width: number; height: number }) {
  const box = await page.locator('#pdf-canvas').boundingBox();
  if (!box) throw new Error('pdf-canvas が無い');
  const scale = box.width / pageWidth;
  const left = box.x + r.x * scale;
  const top = box.y + (pageHeight - (r.y + r.height)) * scale;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(left + r.width * scale, top + r.height * scale, { steps: 5 });
  await page.mouse.up();
}

/** 墨消しを実行して、ダウンロードした PDF を返す */
async function redactAndDownload(page: Page): Promise<Uint8Array> {
  await page.locator('#btn-redact').click();
  await expect(page.locator('#btn-download')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-download').click()]);
  const path = await download.path();
  return new Uint8Array(readFileSync(path!));
}

/** 頁の描画が終わるまで待つ（canvas が既定の 300x150 から変わる） */
async function waitForRender(page: Page) {
  await page.waitForFunction(() => {
    const c = document.querySelector('#pdf-canvas') as HTMLCanvasElement | null;
    return !!c && c.getBoundingClientRect().width > 300;
  });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // ブラウザが自動で取りに行く favicon.ico の 404 は除く（取得の失敗は response で見る）
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`response ${r.status()}: ${r.url()}`);
  });
  page.on('dialog', async (d) => {
    errors.push(`dialog: ${d.message()}`);
    await d.dismiss();
  });
  return errors;
}

async function expectRegionPainted(before: Uint8Array, after: Uint8Array, rect: { x: number; y: number; width: number; height: number }) {
  const [B] = await extractImages(before);
  const [A] = await extractImages(after);
  const values = new Set<number>();
  for (let y = 0; y < B.height; y++) {
    for (let x = 0; x < B.width; x++) {
      if (inside(pixelCenterOnPage(B, x, y), rect)) values.add(A.gray(x, y));
    }
  }
  expect(values.size).toBe(1);
}

test.describe('ブラウザでの墨消し', () => {
  for (const name of ['jbig2.pdf', 'ccitt.pdf', 'jpeg.pdf', 'jpx.pdf']) {
    test(`スキャンの PDF（${name}）: 範囲の画素が塗られた PDF をダウンロードできる`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto('/');
      await page.locator('#file-input').setInputFiles(fixture(name));
      await waitForRender(page);
      await page.locator('#btn-rect-mode').click();
      const before = new Uint8Array(readFileSync(fixture(name)));
      // ccitt.pdf は頁が 600x225pt で、画像が頁いっぱい
      const isCcitt = name === 'ccitt.pdf';
      const [pageWidth, pageHeight] = isCcitt ? [600, 225] : [595, 842];
      const rect = isCcitt ? { x: 148, y: 118, width: 102, height: 34 } : { x: 148, y: 578, width: 70, height: 24 };
      await dragPdfRect(page, pageWidth, pageHeight, rect);
      await expect(page.locator('.redaction-rect')).toBeVisible();
      const after = await redactAndDownload(page);
      expect(errors).toEqual([]);
      // ドラッグの位置は画面の丸めで少しずれるので、内側を少し狭めて確かめる
      await expectRegionPainted(before, after, { x: rect.x + 2, y: rect.y + 2, width: rect.width - 4, height: rect.height - 4 });
    });
  }

  test('Chrome で印刷した日本語の PDF: 氏名が消える', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('chrome.pdf'));
    await waitForRender(page);
    await page.locator('#btn-rect-mode').click();
    await dragPdfRect(page, 612, 792, { x: 140, y: 655, width: 63, height: 25 });
    const after = await redactAndDownload(page);
    expect(errors).toEqual([]);
    const text = await allText(after);
    expect(text).not.toContain('花子');
    expect(text).toContain('生年月日');
  });

  test('定義済みの CMap の日本語の PDF: Worker の中から cmaps/ を読み、氏名が消える', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('cmap.pdf'));
    await waitForRender(page);
    await page.locator('#btn-rect-mode').click();
    // 「見本花子」は x=110〜190（1 文字 20pt）、y=700 の行
    await dragPdfRect(page, 595, 842, { x: 111, y: 693, width: 78, height: 25 });
    const after = await redactAndDownload(page);
    expect(errors).toEqual([]);
    const text = await allText(after);
    expect(text).not.toContain('花子');
    expect(text).toContain('氏名');
    expect(text).toContain('架空県');
  });

  test('/Rotate 90 の頁でも、文字選択で選んだ文字が消える', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('rotated.pdf'));
    await waitForRender(page);
    // 人と同じく、画面に見えている文字の上をドラッグする（テキストレイヤーの span の位置を使う）
    const span = page.locator('#text-layer span', { hasText: 'ROTSECRET' }).first();
    const box = await span.boundingBox();
    expect(box).toBeTruthy();
    const canvas = await page.locator('#pdf-canvas').boundingBox();
    // 回した頁の文字は縦に並ぶ。span が canvas の中にあること
    expect(box!.x).toBeGreaterThanOrEqual(canvas!.x - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height + 1);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.redaction-rect').first()).toBeVisible();
    const after = await redactAndDownload(page);
    expect(errors).toEqual([]);
    const text = await allText(after);
    expect(text).not.toContain('ROTSECRET');
  });

  test('墨消しの後、ブラウザの選択範囲が残らず、次の文字選択がすぐできる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('cmap.pdf'));
    await waitForRender(page);
    const span = page.locator('#text-layer span', { hasText: '氏名' }).first();
    const box = (await span.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    // 選んだ範囲は墨消しの範囲として登録され、ブラウザの選択は解除される
    await expect(page.locator('.redaction-rect').first()).toBeVisible();
    expect(await page.evaluate(() => document.getSelection()?.isCollapsed ?? true)).toBe(true);
  });

  test('新しい PDF を開くと、前の文書のダウンロードボタンは隠れ、スクロールは先頭に戻る', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('chrome.pdf'));
    await waitForRender(page);
    await page.locator('#btn-rect-mode').click();
    await dragPdfRect(page, 612, 792, { x: 140, y: 655, width: 63, height: 25 });
    await page.locator('#btn-redact').click();
    await expect(page.locator('#btn-download')).toBeVisible();
    await page.locator('#viewer-container').evaluate((el) => { el.scrollTop = 400; });
    await page.locator('#file-input').setInputFiles(fixture('jbig2.pdf'));
    await expect(page.locator('#btn-download')).toBeHidden();
    await waitForRender(page);
    expect(await page.locator('#viewer-container').evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('テキストレイヤーの文字の位置が、PDF の文字の位置と合っている（文字選択の範囲がずれない）', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('cmap.pdf'));
    await waitForRender(page);
    const canvas = (await page.locator('#pdf-canvas').boundingBox())!;
    const scale = canvas.width / 595;
    // 「氏名：見本花子」は x=50 から 20pt の字が 7 つ（幅 140pt）
    const span = page.locator('#text-layer span', { hasText: '氏名' }).first();
    const box = (await span.boundingBox())!;
    const left = (box.x - canvas.x) / scale;
    const width = box.width / scale;
    expect(Math.abs(left - 50)).toBeLessThan(1);
    expect(Math.abs(width - 140)).toBeLessThan(2);
  });

  test('文字選択で消すと、黒い四角は選んだ文字より先の空いているところまで広がる（四角の幅から文字列の幅が分からない）', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('chrome.pdf'));
    await waitForRender(page);
    const canvas = (await page.locator('#pdf-canvas').boundingBox())!;
    const scale = canvas.width / 612;
    // 「賃借人氏名：見本 花子　生年月日：…」の「見本 花子」を、人と同じく字の上をドラッグして選ぶ。
    // Chrome の Noto は「見」「子」などを康熙部首の文字（U+2F92 ⾒、U+2F26 ⼦）に写すので、その字で探す
    const first = (await page.locator('#text-layer span', { hasText: '\u2F92' }).first().boundingBox())!;
    const last = (await page.locator('#text-layer span', { hasText: '\u2F26' }).first().boundingBox())!;
    const y = first.y + first.height / 2;
    await page.mouse.move(first.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width - 1, y, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.redaction-rect').first()).toBeVisible();
    const after = await redactAndDownload(page);
    expect(errors).toEqual([]);
    const text = await allText(after);
    expect(text).not.toContain('花子');
    expect(text).toContain('1990');
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const { parseContentStream } = await import('../../src/redaction/content/lexer');
    const { contentsBytes } = await import('../../src/redaction/pdf-objects');
    const doc = await PDFDocument.load(after);
    const ops = parseContentStream(contentsBytes(doc.context, doc.getPages()[0].node.get(PDFName.of('Contents'))));
    const res = ops.filter((o) => o.op === 're').map((o) => o.operands.map((x) => (x.type === 'number' ? x.value : NaN)));
    const box = res[res.length - 1];
    // 選んだ「子」の右端より先（全角の空白の分）まで広がり、次の字（「生年月日」の「生」）の手前で止まる
    const selectedRight = (last.x + last.width - canvas.x) / scale;
    const spans = page.locator('#text-layer span');
    const n = await spans.count();
    let nextLeft = Infinity;
    for (let i = 0; i < n; i++) {
      const b = await spans.nth(i).boundingBox();
      if (!b || Math.abs(b.y - first.y) > first.height / 2) continue;
      const t = (await spans.nth(i).textContent()) ?? '';
      if (!t.trim()) continue;
      const left = (b.x - canvas.x) / scale;
      if (left > selectedRight + 1) nextLeft = Math.min(nextLeft, left);
    }
    expect(nextLeft).toBeLessThan(Infinity);
    expect(box[0] + box[2]).toBeGreaterThan(selectedRight + 3);
    expect(box[0] + box[2]).toBeLessThan(nextLeft);
  });

  test('墨消しの処理中は、範囲を足したり別の PDF を開いたりできない（処理中に足した範囲が消されないまま選択から消えない）', async ({ page }) => {
    // Worker の返事を 3 秒遅らせて、処理中の状態を作る
    await page.addInitScript(() => {
      const W = window.Worker;
      window.Worker = class extends W {
        set onmessage(fn: ((e: MessageEvent) => void) | null) {
          super.onmessage = fn ? (e: MessageEvent) => setTimeout(() => fn(e), 3000) : null;
        }
      } as typeof Worker;
    });
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('cmap.pdf'));
    await waitForRender(page);
    await page.locator('#btn-rect-mode').click();
    await dragPdfRect(page, 595, 842, { x: 111, y: 693, width: 78, height: 25 });
    await expect(page.locator('.redaction-rect')).toHaveCount(1);
    await page.locator('#btn-redact').click();
    // 処理中に範囲を足そうとしても足されない
    await dragPdfRect(page, 595, 842, { x: 50, y: 600, width: 100, height: 25 });
    await expect(page.locator('.redaction-rect')).toHaveCount(1);
    // 処理中に別の PDF を開こうとしても開かない
    await page.locator('#file-input').setInputFiles(fixture('chrome.pdf'), { noWaitAfter: true }).catch(() => {});
    await expect(page.locator('#btn-download')).toBeVisible({ timeout: 10000 });
    const after = await (async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-download').click()]);
      return new Uint8Array(readFileSync((await download.path())!));
    })();
    const text = await allText(after);
    // 墨消ししたのは cmap.pdf で、処理中に足そうとした範囲の字（住所の行）は残る
    expect(text).not.toContain('花子');
    expect(text).toContain('架空県');
  });

  test('墨消しの結果を表示できなくても、結果はダウンロードでき、範囲もまた選べる', async ({ page }) => {
    // Worker が表示できない PDF を返したことにする
    await page.addInitScript(() => {
      const W = window.Worker;
      window.Worker = class extends W {
        set onmessage(fn: ((e: MessageEvent) => void) | null) {
          super.onmessage = fn ? () => fn({ data: { ok: true, bytes: new Uint8Array([1, 2, 3]) } } as MessageEvent) : null;
        }
      } as typeof Worker;
    });
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture('cmap.pdf'));
    await waitForRender(page);
    await page.locator('#btn-rect-mode').click();
    await dragPdfRect(page, 595, 842, { x: 111, y: 693, width: 78, height: 25 });
    await page.locator('#btn-redact').click();
    await expect(page.locator('#btn-download')).toBeVisible();
    await expect.poll(() => dialogs.join('\n')).toContain('表示に失敗');
    expect(dialogs.join('\n')).not.toContain('行っていません');
    // 範囲をまた選べる
    await dragPdfRect(page, 595, 842, { x: 50, y: 600, width: 100, height: 25 });
    await expect(page.locator('.redaction-rect')).toHaveCount(1);
  });
});
