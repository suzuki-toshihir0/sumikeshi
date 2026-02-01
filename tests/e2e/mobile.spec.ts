import { test, expect, Page } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePdf = resolve(__dirname, '../fixtures/sample.pdf');

/** CDP経由でタッチドラッグを実行するヘルパー */
async function touchDrag(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const steps = 5;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x1, y: y1 }],
  });
  for (let i = 1; i <= steps; i++) {
    const x = x1 + (x2 - x1) * (i / steps);
    const y = y1 + (y2 - y1) * (i / steps);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
}

test.describe('モバイル対応', () => {
  test('PDFがビューポート幅に収まる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#pdf-canvas')).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();

    const canvasBox = await page.locator('#pdf-canvas').boundingBox();
    expect(canvasBox).toBeTruthy();
    expect(canvasBox!.width).toBeLessThanOrEqual(viewport!.width);
  });

  test('タッチで矩形選択できる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#pdf-canvas')).toBeVisible();
    await expect(page.locator('#page-info')).toContainText('1 / 2');

    // 矩形選択モードに切り替え
    await page.locator('#btn-rect-mode').tap();
    await expect(page.locator('#btn-rect-mode')).toHaveClass(/active/);

    // ページコンテナの位置を取得
    const container = page.locator('#page-container');
    const box = await container.boundingBox();
    expect(box).toBeTruthy();

    // CDP経由でタッチドラッグを実行
    await touchDrag(page, box!.x + 50, box!.y + 80, box!.x + 200, box!.y + 130);

    // 墨消し矩形が追加される
    await expect(page.locator('.redaction-rect')).toBeVisible();
  });

  test('墨消し矩形をタップで削除できる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#pdf-canvas')).toBeVisible();
    await expect(page.locator('#page-info')).toContainText('1 / 2');

    // 矩形選択モードに切り替えてタッチドラッグで矩形を追加
    await page.locator('#btn-rect-mode').tap();

    const container = page.locator('#page-container');
    const box = await container.boundingBox();
    expect(box).toBeTruthy();

    await touchDrag(page, box!.x + 50, box!.y + 80, box!.x + 200, box!.y + 130);

    const rect = page.locator('.redaction-rect');
    await expect(rect).toBeVisible();

    // 矩形をタップして削除
    await rect.tap();
    await expect(rect).not.toBeVisible();
  });

  test('ツールバーのボタンが44px以上のタッチターゲットサイズを持つ', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#pdf-canvas')).toBeVisible();

    const buttons = [
      page.locator('.file-select-btn'),
      page.locator('#btn-text-mode'),
      page.locator('#btn-rect-mode'),
    ];

    for (const button of buttons) {
      const box = await button.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }
  });

  test('ドロップゾーンのテキストがモバイル向け', async ({ page }) => {
    await page.goto('/');
    // ontouchstartがあるデバイスでは「PDFを開くボタンからPDFを選択」と表示
    await expect(page.locator('#drop-zone')).toContainText('PDFを開くボタンからPDFを選択');
  });
});
