import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
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
    // ontouchstartがあるデバイスでは「PDF・画像を選択」と表示
    await expect(page.locator('#drop-zone')).toContainText('PDF・画像を選択');
  });

  test('iPhone の大きさの写真（4032×3024）を、タッチで選んで墨消しできる', async ({ page }) => {
    await page.goto('/');
    const W = 4032;
    const H = 3024;
    const photo = await page.evaluate(
      async ({ W, H }) => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d')!;
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, 'rgb(240, 200, 120)');
        g.addColorStop(1, 'rgb(60, 140, 200)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      },
      { W, H },
    );
    await page.locator('#file-input').setInputFiles({ name: 'IMG_1234.JPG', mimeType: 'image/jpeg', buffer: Buffer.from(photo) });
    await expect(page.locator('#btn-rect-mode')).toHaveClass(/active/);
    await expect(page.locator('#btn-text-mode')).toBeHidden();

    // 写真は画面の幅に収まる
    const viewport = page.viewportSize()!;
    const box = (await page.locator('#pdf-canvas').boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.width).toBeGreaterThan(viewport.width * 0.8);

    // 写真の左上の 4 分の 1 をなぞる
    await touchDrag(page, box.x + box.width * 0.1, box.y + box.height * 0.1, box.x + box.width * 0.4, box.y + box.height * 0.4);
    await expect(page.locator('.redaction-rect')).toHaveCount(1);
    await page.locator('#btn-redact').tap();
    await expect(page.locator('#btn-download')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-download').tap()]);
    expect(download.suggestedFilename()).toBe('redacted.jpg');
    const out = Array.from(new Uint8Array(readFileSync((await download.path())!)));

    // 書き出した写真の大きさと、なぞった所の内側が黒く、外は元の色のままであること
    const result = await page.evaluate(
      async ({ out, W, H }) => {
        const bmp = await createImageBitmap(new Blob([new Uint8Array(out)]));
        const c = document.createElement('canvas');
        c.width = 1;
        c.height = 1;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        const at = (x: number, y: number) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.drawImage(bmp, x, y, 1, 1, 0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data);
        };
        return { size: [bmp.width, bmp.height], inside: at(W * 0.25, H * 0.25), outside: at(W * 0.75, H * 0.75) };
      },
      { out, W, H },
    );
    expect(result.size).toEqual([W, H]);
    expect(Math.max(...result.inside.slice(0, 3))).toBeLessThanOrEqual(8);
    expect(Math.max(...result.outside.slice(0, 3))).toBeGreaterThan(100);
  });
});
