import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addJpegMetadata, addPngMetadata, containsAscii } from './helpers/photo-meta';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplePdf = resolve(__dirname, '../fixtures/sample.pdf');

test.use({ viewport: { width: 900, height: 1400 } });

interface Decoded {
  width: number;
  height: number;
  data: number[];
}
type Rect = { x: number; y: number; width: number; height: number };

/**
 * ブラウザの canvas で素材の画像を作る。左半分が赤、右半分が青で、全体に細かい模様と "PHOTOSECRET" の字を描く。
 * transparentCorner を付けると、右下の角を透明にする（PNG のとき）
 */
async function makeImage(page: Page, width: number, height: number, mime: string, transparentCorner = false): Promise<Uint8Array> {
  const bytes = await page.evaluate(
    async ({ width, height, mime, transparentCorner }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = 'rgb(220, 40, 40)';
      ctx.fillRect(0, 0, width / 2, height);
      ctx.fillStyle = 'rgb(40, 60, 220)';
      ctx.fillRect(width / 2, 0, width / 2, height);
      ctx.fillStyle = 'rgb(250, 250, 250)';
      for (let y = 0; y < height; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < width; x += 16) ctx.fillRect(x, y, 4, 4);
      ctx.font = '24px sans-serif';
      ctx.fillText('PHOTOSECRET', 20, 60);
      if (transparentCorner) ctx.clearRect(width - 40, height - 40, 40, 40);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), mime, 0.95));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { width, height, mime, transparentCorner },
  );
  return new Uint8Array(bytes);
}

/** ブラウザで画像を読み、向きを当てた後の画素を返す */
async function decode(page: Page, bytes: Uint8Array): Promise<Decoded> {
  return page.evaluate(async (arr) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(arr)]), { imageOrientation: 'from-image' });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    return { width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  }, Array.from(bytes));
}

const px = (d: Decoded, x: number, y: number) => d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 4);

async function openFile(page: Page, name: string, bytes: Uint8Array, mimeType: string) {
  await page.locator('#file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) });
}

async function waitForRender(page: Page) {
  await page.waitForFunction(() => {
    const c = document.querySelector('#pdf-canvas') as HTMLCanvasElement | null;
    return !!c && c.getBoundingClientRect().width > 0 && c.width !== 300;
  });
}

/**
 * 画像の範囲（左上を原点とする画素の座標）を、画面でドラッグして選ぶ。
 * 表示の倍率は canvas の幅から求める
 */
async function dragImageRect(page: Page, imageWidth: number, r: Rect) {
  const box = await page.locator('#pdf-canvas').boundingBox();
  if (!box) throw new Error('pdf-canvas が無い');
  const scale = box.width / imageWidth;
  const left = box.x + r.x * scale;
  const top = box.y + r.y * scale;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(left + r.width * scale, top + r.height * scale, { steps: 5 });
  await page.mouse.up();
}

async function redactAndDownload(page: Page): Promise<{ bytes: Uint8Array; filename: string }> {
  await page.locator('#btn-redact').click();
  await expect(page.locator('#btn-download')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-download').click()]);
  return { bytes: new Uint8Array(readFileSync((await download.path())!)), filename: download.suggestedFilename() };
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', async (d) => {
    errors.push(`dialog: ${d.message()}`);
    await d.dismiss();
  });
  return errors;
}

/** 範囲の内側（端を margin だけ除く）がどれも黒（各色 tolerance 以下、不透明）か */
function expectBlack(d: Decoded, r: Rect, margin: number, tolerance: number) {
  let bad = 0;
  for (let y = r.y + margin; y < r.y + r.height - margin; y++) {
    for (let x = r.x + margin; x < r.x + r.width - margin; x++) {
      const [R, G, B, A] = px(d, x, y);
      if (R > tolerance || G > tolerance || B > tolerance || A !== 255) bad++;
    }
  }
  expect(bad).toBe(0);
}

/** 範囲から margin 以上離れた画素の、元との差の平均（各色） */
function meanDiffOutside(a: Decoded, b: Decoded, rects: Rect[], margin: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const near = rects.some((r) => x >= r.x - margin && x < r.x + r.width + margin && y >= r.y - margin && y < r.y + r.height + margin);
      if (near) continue;
      const p = px(a, x, y);
      const q = px(b, x, y);
      for (let k = 0; k < 3; k++) sum += Math.abs(p[k] - q[k]);
      n += 3;
    }
  }
  return sum / n;
}

const SECRETS = ['SECRET', 'Exif\0\0', 'http://ns.adobe.com/xap'];

test.describe('写真の墨消し', () => {
  test('JPEG: 範囲が黒くなり、Exif の位置情報・縮小画像・XMP・コメントが消えた JPEG を落とせる', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    const thumb = await makeImage(page, 80, 60, 'image/jpeg');
    const photo = addJpegMetadata(await makeImage(page, 400, 300, 'image/jpeg'), { orientation: 1, thumbnail: thumb });
    // 仕込めていること
    expect(containsAscii(photo, 'GPSSECRET')).toBe(true);
    expect(containsAscii(photo, 'THUMBSECRET')).toBe(true);
    const original = await decode(page, photo);

    await openFile(page, 'IMG_0001.JPG', photo, 'image/jpeg');
    await waitForRender(page);
    // 写真には文字が無いので、矩形選択だけにする
    await expect(page.locator('#btn-text-mode')).toBeHidden();
    await expect(page.locator('#btn-rect-mode')).toHaveClass(/active/);
    await expect(page.locator('#page-nav')).toBeHidden();

    const rect = { x: 16, y: 32, width: 180, height: 40 };
    await dragImageRect(page, 400, rect);
    await expect(page.locator('.redaction-rect')).toBeVisible();
    const { bytes, filename } = await redactAndDownload(page);
    expect(errors).toEqual([]);

    expect(filename).toBe('redacted.jpg');
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    for (const s of SECRETS) expect(containsAscii(bytes, s), s).toBe(false);

    const out = await decode(page, bytes);
    expect([out.width, out.height]).toEqual([400, 300]);
    // ドラッグは画面の丸めで少しずれ、JPEG は端がにじむので、内側を見る
    expectBlack(out, rect, 4, 24);
    expect(meanDiffOutside(original, out, [rect], 12)).toBeLessThan(4);
  });

  test('Exif の向き（90° 回す）: 画面に見えている向きで選んだ所が黒くなり、向きを当てた画像で書き出す', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    const thumb = await makeImage(page, 80, 60, 'image/jpeg');
    // 保存は 400×300 で左が赤。向き 6（時計回りに 90° 回して見る）なので、見た目は 300×400 で上が赤
    const photo = addJpegMetadata(await makeImage(page, 400, 300, 'image/jpeg'), { orientation: 6, thumbnail: thumb });
    await openFile(page, 'IMG_0002.JPG', photo, 'image/jpeg');
    await waitForRender(page);
    const box = await page.locator('#pdf-canvas').boundingBox();
    expect(box!.height / box!.width).toBeCloseTo(400 / 300, 1);

    const rect = { x: 40, y: 280, width: 200, height: 60 };
    await dragImageRect(page, 300, rect);
    const { bytes } = await redactAndDownload(page);
    expect(errors).toEqual([]);

    const out = await decode(page, bytes);
    expect([out.width, out.height]).toEqual([300, 400]);
    // 向きの欄は書き出さない（書き出した画素が、もう見た目の向きになっている）
    expect(containsAscii(bytes, 'Exif')).toBe(false);
    const [r, , b] = px(out, 150, 20);
    expect(r).toBeGreaterThan(150);
    expect(b).toBeLessThan(100);
    expectBlack(out, rect, 4, 24);
  });

  test('PNG: 範囲がちょうど黒になり、範囲の外は 1 画素も変わらず、文字の欄と Exif が消える', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    const png = addPngMetadata(await makeImage(page, 320, 240, 'image/png', true));
    expect(containsAscii(png, 'PNGSECRET')).toBe(true);
    const original = await decode(page, png);
    await openFile(page, 'screenshot.png', png, 'image/png');
    await waitForRender(page);

    // 透明な右下の角にもかかるように選ぶ
    const rect = { x: 250, y: 180, width: 70, height: 60 };
    await dragImageRect(page, 320, rect);
    const { bytes, filename } = await redactAndDownload(page);
    expect(errors).toEqual([]);
    expect(filename).toBe('redacted.png');
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    for (const s of SECRETS) expect(containsAscii(bytes, s), s).toBe(false);

    const out = await decode(page, bytes);
    expectBlack(out, rect, 3, 0);
    // 範囲から離れた所は、元とまったく同じ（透明な角は範囲の中）
    expect(meanDiffOutside(original, out, [rect], 6)).toBe(0);
  });

  test('2 回続けて墨消ししても、前の範囲は黒のままで、JPEG を圧縮し直して劣化させない', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    const photo = await makeImage(page, 400, 300, 'image/jpeg');
    const original = await decode(page, photo);
    await openFile(page, 'a.jpg', photo, 'image/jpeg');
    await waitForRender(page);

    const first = { x: 16, y: 32, width: 150, height: 40 };
    await dragImageRect(page, 400, first);
    const once = await redactAndDownload(page);
    const second = { x: 220, y: 200, width: 120, height: 50 };
    await dragImageRect(page, 400, second);
    const twice = await redactAndDownload(page);
    expect(errors).toEqual([]);

    const a = await decode(page, once.bytes);
    const b = await decode(page, twice.bytes);
    expectBlack(b, first, 4, 24);
    expectBlack(b, second, 4, 24);
    // 2 回目の書き出しは、手元の画素から 1 回だけ圧縮したもの（1 回目の JPEG を読み直して圧縮し直してはいない）
    expect(meanDiffOutside(original, b, [first, second], 12)).toBeLessThanOrEqual(meanDiffOutside(original, a, [first, second], 12) + 0.5);
  });

  test('画像の後に PDF を開くと、文字選択と頁送りが戻る', async ({ page }) => {
    await page.goto('/');
    await openFile(page, 'a.png', await makeImage(page, 200, 100, 'image/png'), 'image/png');
    await waitForRender(page);
    await expect(page.locator('#btn-text-mode')).toBeHidden();
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#page-info')).toContainText('1 / 2');
    await expect(page.locator('#btn-text-mode')).toBeVisible();
    await expect(page.locator('#page-nav')).toBeVisible();
    await expect(page.locator('#text-layer span').first()).toBeAttached();
  });

  test('PDF の後に画像を開くと、前の頁の文字のレイヤーが残らない', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#text-layer span').first()).toBeAttached();
    await openFile(page, 'a.png', await makeImage(page, 200, 100, 'image/png'), 'image/png');
    await waitForRender(page);
    await expect(page.locator('#text-layer span')).toHaveCount(0);
  });

  test('大きな画像を読んでいる間に PDF を選んだら、後に選んだ PDF が残る', async ({ page }) => {
    await page.goto('/');
    const big = await makeImage(page, 6000, 4000, 'image/png');
    // 画像を選んだ直後（読み込みの途中）に PDF を選ぶ
    await Promise.all([
      openFile(page, 'big.png', big, 'image/png'),
      page.locator('#file-input').setInputFiles(samplePdf),
    ]);
    await expect(page.locator('#page-info')).toContainText('1 / 2');
    // 画像の読み込みが終わるのを待っても、PDF のまま
    await page.waitForTimeout(3000);
    await expect(page.locator('#page-nav')).toBeVisible();
    await expect(page.locator('#btn-text-mode')).toBeVisible();
    await expect(page.locator('#text-layer span').first()).toBeAttached();
  });

  test('大きすぎる画像は開かずに理由を伝える', async ({ page }) => {
    await page.goto('/');
    const big = await makeImage(page, 8200, 4, 'image/png');
    const message = page.waitForEvent('dialog').then(async (d) => {
      const m = d.message();
      await d.dismiss();
      return m;
    });
    await openFile(page, 'big.png', big, 'image/png');
    expect(await message).toContain('大きすぎます');
    await expect(page.locator('#drop-zone')).toBeVisible();
  });

  test('知らない形式（GIF）は開かずに、開ける形式を伝える', async ({ page }) => {
    await page.goto('/');
    const message = page.waitForEvent('dialog').then(async (d) => {
      const m = d.message();
      await d.dismiss();
      return m;
    });
    await openFile(page, 'a.gif', new TextEncoder().encode('GIF89a\x01\x00\x01\x00'), 'image/gif');
    expect(await message).toContain('JPEG');
    await expect(page.locator('#drop-zone')).toBeVisible();
  });
});
