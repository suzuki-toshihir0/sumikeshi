import { test, expect } from '@playwright/test';
import { resolve } from 'path';

const samplePdf = resolve(__dirname, '../fixtures/sample.pdf');

test.describe('PDF墨消しツール', () => {
  test('初期画面が表示される', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#drop-zone')).toBeVisible();
    await expect(page.locator('.file-select-btn')).toBeVisible();
  });

  test('PDFファイルをアップロードすると表示される', async ({ page }) => {
    await page.goto('/');

    // ファイル選択
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles(samplePdf);

    // ページが表示される
    await expect(page.locator('#page-wrapper')).toBeVisible();
    await expect(page.locator('#pdf-canvas')).toBeVisible();
    await expect(page.locator('#page-nav')).toBeVisible();
    await expect(page.locator('#page-info')).toContainText('1 / 2');
  });

  test('ページナビゲーションが動作する', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#page-info')).toContainText('1 / 2');

    // 次のページへ
    await page.locator('#btn-next').click();
    await expect(page.locator('#page-info')).toContainText('2 / 2');

    // 前のページへ
    await page.locator('#btn-prev').click();
    await expect(page.locator('#page-info')).toContainText('1 / 2');
  });

  test('選択モードを切り替えられる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);

    // 初期はテキスト選択モード
    await expect(page.locator('#btn-text-mode')).toHaveClass(/active/);

    // 矩形選択モードに切り替え
    await page.locator('#btn-rect-mode').click();
    await expect(page.locator('#btn-rect-mode')).toHaveClass(/active/);
    await expect(page.locator('#btn-text-mode')).not.toHaveClass(/active/);
  });

  test('矩形選択で墨消し領域を追加できる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);

    // 矩形選択モードに切り替え
    await page.locator('#btn-rect-mode').click();

    // ページコンテナ上でドラッグ
    const container = page.locator('#page-container');
    const box = await container.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 50, box.y + 80);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + 110);
      await page.mouse.up();
    }

    // オーバーレイに墨消し矩形が追加される
    await expect(page.locator('.redaction-rect')).toBeVisible();
  });

  test('ネットワークリクエストが発生しない', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      // localhostへのリクエスト(ページ読み込み自体)は除外
      if (!url.startsWith('http://localhost') && !url.startsWith('data:') && !url.startsWith('blob:')) {
        requests.push(url);
      }
    });

    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);

    // 外部リクエストがないこと
    expect(requests).toHaveLength(0);
  });
});
