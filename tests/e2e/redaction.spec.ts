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
});
