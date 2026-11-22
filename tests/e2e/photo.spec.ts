import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
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
  // 読み込みと描画が終わり、範囲を選べるようになるまで待つ
  await page.locator('#page-container[data-selectable="true"]').waitFor({ state: 'attached' });
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
    // setInputFiles は change を送った時点で戻る（読み込みの終わりは待たない）
    await openFile(page, 'big.png', big, 'image/png');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#page-info')).toContainText('1 / 2');
    // 画像の読み込みが終わるのを待っても、PDF のまま
    await page.waitForTimeout(3000);
    await expect(page.locator('#page-nav')).toBeVisible();
    await expect(page.locator('#btn-text-mode')).toBeVisible();
    await expect(page.locator('#text-layer span').first()).toBeAttached();
  });

  test('PDF を読んでいる間に画像を選んだら、後に選んだ画像が残る', async ({ page }) => {
    await page.goto('/');
    const png = await makeImage(page, 200, 100, 'image/png');
    // setInputFiles は change を送った時点で戻る（PDF の読み込みの終わりは待たない）
    await page.locator('#file-input').setInputFiles(samplePdf);
    await openFile(page, 'a.png', png, 'image/png');
    await waitForRender(page);
    // PDF の読み込みと描画が終わるのを待っても、画像のまま
    await page.waitForTimeout(3000);
    await expect(page.locator('#page-nav')).toBeHidden();
    await expect(page.locator('#btn-text-mode')).toBeHidden();
    await expect(page.locator('#text-layer span')).toHaveCount(0);
    const box = (await page.locator('#pdf-canvas').boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(2, 1);
  });

  test('2 回目の墨消しに失敗したら、前回の結果を落とせない（今回の範囲が残った画像を渡さない）', async ({ page }) => {
    await page.goto('/');
    await openFile(page, 'a.png', await makeImage(page, 320, 240, 'image/png'), 'image/png');
    await waitForRender(page);
    await dragImageRect(page, 320, { x: 10, y: 10, width: 60, height: 30 });
    await redactAndDownload(page);
    // 範囲の画素を置き換えられないブラウザを装う
    await page.evaluate(() => {
      CanvasRenderingContext2D.prototype.putImageData = function () {};
    });
    await dragImageRect(page, 320, { x: 150, y: 100, width: 60, height: 30 });
    const message = page.waitForEvent('dialog').then(async (d) => {
      const m = d.message();
      await d.dismiss();
      return m;
    });
    await page.locator('#btn-redact').click();
    expect(await message).toContain('黒く塗れませんでした');
    await expect(page.locator('#btn-download')).toBeHidden();
  });

  test('ファイルを読んでいる間に墨消しが始まったら、そのファイルは開かずに理由を伝える', async ({ page }) => {
    await page.goto('/');
    await openFile(page, 'a.png', await makeImage(page, 320, 240, 'image/png'), 'image/png');
    await waitForRender(page);
    await dragImageRect(page, 320, { x: 10, y: 10, width: 60, height: 30 });
    // ファイルの読み込みを 1.5 秒、墨消しの書き出しを 3 秒遅らせる（読み込みの途中で墨消しが始まり、その最中に読み終わる）
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsArrayBuffer;
      FileReader.prototype.readAsArrayBuffer = function (this: FileReader, blob: Blob) {
        setTimeout(() => read.call(this, blob), 1500);
      };
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, ...rest: unknown[]) {
        toBlob.call(this, (b) => setTimeout(() => cb(b), 3000), ...(rest as [string?, number?]));
      };
    });
    const message = page.waitForEvent('dialog').then(async (d) => {
      const m = d.message();
      await d.dismiss();
      return m;
    });
    await page.locator('#file-input').setInputFiles(samplePdf);
    await page.locator('#btn-redact').click();
    expect(await message).toContain('処理中');
    // 墨消しは最後まで進み、画像のまま
    await expect(page.locator('#btn-download')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#page-nav')).toBeHidden();
    await expect(page.locator('#btn-text-mode')).toBeHidden();
  });

  test('小さな範囲だけでも、書き出した画像が乱れていたら渡さない（指紋の対策で書き出しを乱すブラウザを装う）', async ({ page }) => {
    await page.goto('/');
    await openFile(page, 'a.jpg', await makeImage(page, 320, 240, 'image/jpeg'), 'image/jpeg');
    await waitForRender(page);
    await dragImageRect(page, 320, { x: 100, y: 100, width: 10, height: 10 });
    await page.evaluate(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, ...rest: unknown[]) {
        const c = document.createElement('canvas');
        c.width = this.width;
        c.height = this.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(this, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i++) if (i % 4 !== 3) d.data[i] = Math.random() * 256;
        ctx.putImageData(d, 0, 0);
        toBlob.call(c, cb, ...(rest as [string?, number?]));
      };
    });
    const message = page.waitForEvent('dialog').then(async (d) => {
      const m = d.message();
      await d.dismiss();
      return m;
    });
    await page.locator('#btn-redact').click();
    expect(await message).toContain('書き出せませんでした');
    await expect(page.locator('#btn-download')).toBeHidden();
  });

  test('古い PDF の読み込みが画像の墨消しの最中に終わっても、範囲を選べるようにならない', async ({ page }) => {
    // pdf.js の Worker の読み込みを遅らせ、PDF の読み込みを画像の墨消しの最中まで延ばす
    await page.route('**/pdf.worker*', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.goto('/');
    const png = await makeImage(page, 320, 240, 'image/png');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await openFile(page, 'a.png', png, 'image/png');
    await waitForRender(page);
    await dragImageRect(page, 320, { x: 10, y: 10, width: 60, height: 30 });
    // 墨消しの書き出しを 5 秒遅らせる
    await page.evaluate(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, ...rest: unknown[]) {
        toBlob.call(this, (b) => setTimeout(() => cb(b), 5000), ...(rest as [string?, number?]));
      };
    });
    await page.locator('#btn-redact').click();
    // PDF の読み込みが終わるのを待ってから、墨消しの最中に範囲を選ぼうとする
    await page.waitForTimeout(3000);
    await expect(page.locator('#btn-download')).toBeHidden();
    await dragImageRect(page, 320, { x: 150, y: 100, width: 60, height: 30 });
    await expect(page.locator('.redaction-rect')).toHaveCount(0);
  });

  test('PDF の読み込み中に開けないファイルを選んでも、PDF はそのまま範囲を選べる', async ({ page }) => {
    await page.route('**/pdf.worker*', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.goto('/');
    page.on('dialog', (d) => d.dismiss());
    await page.locator('#file-input').setInputFiles(samplePdf);
    await openFile(page, 'a.gif', new TextEncoder().encode('GIF89a\x01\x00\x01\x00'), 'image/gif');
    await expect(page.locator('#page-info')).toContainText('1 / 2', { timeout: 10000 });
    const span = page.locator('#text-layer span').first();
    await expect(span).toBeAttached();
    const box = (await span.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.redaction-rect').first()).toBeVisible();
  });

  test('次の文書を読み込んでいる間は、前の文書の上で範囲を選べない（前の文書の座標の範囲を次の文書に当てない）', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#page-info')).toContainText('1 / 2');
    await page.locator('#btn-rect-mode').click();
    // pdf.js の Worker へのやり取りを遅らせ、次の PDF の読み込みを延ばす
    await page.evaluate(() => {
      const post = Worker.prototype.postMessage;
      (window as unknown as { restorePost: () => void }).restorePost = () => {
        Worker.prototype.postMessage = post;
      };
      Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
        setTimeout(() => (post as (...a: unknown[]) => void).apply(this, args), 2000);
      } as typeof Worker.prototype.postMessage;
    });
    await page.locator('#file-input').setInputFiles(samplePdf);
    // 読み込み中（画面にはまだ前の PDF が出ている）に、範囲を選ぼうとする
    const box = (await page.locator('#pdf-canvas').boundingBox())!;
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 120, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.redaction-rect')).toHaveCount(0);
    // 遅らせるのを止め、読み込みが終われば選べる
    await page.evaluate(() => (window as unknown as { restorePost: () => void }).restorePost());
    await page.waitForTimeout(5000);
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 120, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.redaction-rect')).toHaveCount(1);
  });

  test('次の文書を読み込んでいる間に選び方を切り替えても、範囲を選べるようにならない', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await expect(page.locator('#page-info')).toContainText('1 / 2');
    await page.evaluate(() => {
      const post = Worker.prototype.postMessage;
      (window as unknown as { restorePost: () => void }).restorePost = () => {
        Worker.prototype.postMessage = post;
      };
      Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
        setTimeout(() => (post as (...a: unknown[]) => void).apply(this, args), 2000);
      } as typeof Worker.prototype.postMessage;
    });
    await page.locator('#file-input').setInputFiles(samplePdf);
    await page.locator('#btn-rect-mode').click();
    await expect(page.locator('#btn-rect-mode')).toHaveClass(/active/);
    const box = (await page.locator('#pdf-canvas').boundingBox())!;
    const drag = async () => {
      await page.mouse.move(box.x + 50, box.y + 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + 120, { steps: 5 });
      await page.mouse.up();
    };
    await drag();
    await expect(page.locator('.redaction-rect')).toHaveCount(0);
    // 読み込みが終われば、切り替えた選び方（矩形）で選べる
    await page.evaluate(() => (window as unknown as { restorePost: () => void }).restorePost());
    await page.waitForTimeout(5000);
    await drag();
    await expect(page.locator('.redaction-rect')).toHaveCount(1);
  });

  test('文書の切り替えをまたいだドラッグは、範囲にしない', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await waitForRender(page);
    await page.locator('#btn-rect-mode').click();
    const box = (await page.locator('#pdf-canvas').boundingBox())!;
    // 前の文書の上で押し始め、押したまま次の文書を開き、開き終えてから離す
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 3 });
    await openFile(page, 'a.png', await makeImage(page, 320, 240, 'image/png'), 'image/png');
    await waitForRender(page);
    await page.mouse.move(box.x + 200, box.y + 120, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator('.redaction-rect')).toHaveCount(0);
    await expect(page.locator('.rect-drawing')).toHaveCount(0);
  });

  test('PDF を読めなかったら、理由を伝えて最初の画面に戻す（前の文書の画面に、読めなかった PDF のバイト列を結び付けない）', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(samplePdf);
    await waitForRender(page);
    const message = page.waitForEvent('dialog').then(async (d) => {
      const m = d.message();
      await d.dismiss();
      return m;
    });
    await openFile(page, 'broken.pdf', new TextEncoder().encode('%PDF-1.7\nこれは PDF ではない'), 'application/pdf');
    expect(await message).toContain('PDF を開けません');
    await expect(page.locator('#drop-zone')).toBeVisible();
    await expect(page.locator('#page-wrapper')).toBeHidden();
    await expect(page.locator('#page-nav')).toBeHidden();
    // 開き直せる
    await page.locator('#file-input').setInputFiles(samplePdf);
    await waitForRender(page);
    await expect(page.locator('#page-info')).toContainText('1 / 2');
  });

  test('頁の描画が追い越されても、最後に頼んだ頁が残る', async ({ page }) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const label of ['PAGE-ONE', 'PAGE-TWO', 'PAGE-THREE']) doc.addPage([400, 300]).drawText(label, { x: 50, y: 150, size: 24, font });
    const pdf = await doc.save();
    await page.goto('/');
    await openFile(page, 'three.pdf', pdf, 'application/pdf');
    await waitForRender(page);
    await expect(page.locator('#text-layer')).toContainText('PAGE-ONE');
    // 次の Worker へのやり取り（2 頁目の取り寄せ）だけを 1.5 秒遅らせる
    await page.evaluate(() => {
      const post = Worker.prototype.postMessage;
      let first = true;
      Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
        const delay = first ? 1500 : 0;
        first = false;
        setTimeout(() => (post as (...a: unknown[]) => void).apply(this, args), delay);
      } as typeof Worker.prototype.postMessage;
    });
    // 2 頁目を頼み、その描画が終わる前に 3 頁目を頼む
    await page.locator('#btn-next').click();
    await page.locator('#btn-next').click();
    await page.waitForTimeout(3000);
    await expect(page.locator('#page-info')).toContainText('3 / 3');
    await expect(page.locator('#text-layer')).toContainText('PAGE-THREE');
    await expect(page.locator('#text-layer')).not.toContainText('PAGE-TWO');
  });

  test('頁の描画の途中は、前の頁の座標で範囲を選ばない', async ({ page }) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const label of ['PAGE-ONE', 'PAGE-TWO']) doc.addPage([400, 300]).drawText(label, { x: 50, y: 150, size: 24, font });
    await page.goto('/');
    await openFile(page, 'two.pdf', await doc.save(), 'application/pdf');
    await waitForRender(page);
    await page.locator('#btn-rect-mode').click();
    await page.evaluate(() => {
      const post = Worker.prototype.postMessage;
      let first = true;
      Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
        const delay = first ? 1500 : 0;
        first = false;
        setTimeout(() => (post as (...a: unknown[]) => void).apply(this, args), delay);
      } as typeof Worker.prototype.postMessage;
    });
    await page.locator('#btn-next').click();
    // 2 頁目の描画の途中（画面はまだ 1 頁目）にドラッグする
    const box = (await page.locator('#pdf-canvas').boundingBox())!;
    const drag = async () => {
      await page.mouse.move(box.x + 30, box.y + 30);
      await page.mouse.down();
      await page.mouse.move(box.x + 150, box.y + 90, { steps: 3 });
      await page.mouse.up();
    };
    await drag();
    await expect(page.locator('#page-info')).toContainText('2 / 2', { timeout: 5000 });
    await expect(page.locator('.redaction-rect')).toHaveCount(0);
    // 1 頁目にも付いていない
    await page.locator('#btn-prev').click();
    await expect(page.locator('#page-info')).toContainText('1 / 2');
    await expect(page.locator('#text-layer')).toContainText('PAGE-ONE');
    await expect(page.locator('.redaction-rect')).toHaveCount(0);
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
