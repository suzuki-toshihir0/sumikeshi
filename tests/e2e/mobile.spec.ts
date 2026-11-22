import { test, expect, Page, type CDPSession } from '@playwright/test';
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

  test.describe('スマホでの範囲の選択（ピンチ、残る枠）', () => {
    type P = { x: number; y: number };
    /** 頁ごとの CDP のセッション（タッチの状態はセッションごとに持たれるので、1 つの試験の中では使い回す） */
    const sessions = new WeakMap<Page, CDPSession>();
    /** CDP でタッチの出来事を 1 つ送る（touchPoints は、そのとき触れている指すべて） */
    async function touch(page: Page, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: P[], firstId = 0) {
      let cdp = sessions.get(page);
      if (!cdp) {
        cdp = await page.context().newCDPSession(page);
        sessions.set(page, cdp);
      }
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ ...p, id: firstId + i })) });
    }

    /**
     * 触れている指のうち、finger だけを離す（ほかの指は触れたまま）。
     * この版の Chromium は touchEnd に渡した指を離すが、CDP の説明（touchEnd には指を渡さない）と食い違い、版によって変わりうる。
     * 意図した指が離れたことを、ページが受け取った touchend で確かめる（変わったら、黙って別の筋書きを試さずに落ちる）
     */
    async function releaseOnly(page: Page, finger: P, all: P[]) {
      await page.evaluate(() => ((window as unknown as { lastTouchEnd: string }).lastTouchEnd = ''));
      await touch(page, 'touchEnd', [finger].map((f) => ({ ...f })), all.indexOf(finger));
      const released = await page.evaluate(() => (window as unknown as { lastTouchEnd: string }).lastTouchEnd);
      expect(released).toBe(`${Math.round(finger.x)},${Math.round(finger.y)} remaining=${all.length - 1}`);
    }

    async function openInRectMode(page: Page) {
      await page.goto('/');
      await page.locator('#file-input').setInputFiles(samplePdf);
      await expect(page.locator('#page-info')).toContainText('1 / 2');
      await page.locator('#btn-rect-mode').tap();
      await page.locator('#page-container[data-selectable="true"]').waitFor({ state: 'attached' });
      // 最後に受け取った touchend（離れた指の位置と、残った指の数）を記録する
      await page.evaluate(() =>
        window.addEventListener('touchend', (e) => {
          const c = e.changedTouches[0];
          (window as unknown as { lastTouchEnd: string }).lastTouchEnd = `${Math.round(c.clientX)},${Math.round(c.clientY)} remaining=${e.touches.length}`;
        }),
      );
      return (await page.locator('#page-container').boundingBox())!;
    }

    // 本物のピンチ（ブラウザの拡大）は、画面を出さない Chromium ではタッチの操作で起こせない（何も開いていない画面でも倍率が変わらない）。
    // ここでは、アプリがピンチを止めていないことを確かめる。拡大そのものは iPhone で確かめる
    test('矩形選択でも、二本指の操作（ピンチ）を止めない。1 本指のドラッグは止めて範囲にする', async ({ page }) => {
      const box = await openInRectMode(page);
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('page-container')!).touchAction)).toBe('pinch-zoom');
      // アプリの聞き手の後に走る window の聞き手で、preventDefault されたかを記録する
      await page.evaluate(() => {
        const log: string[] = [];
        (window as unknown as { touchLog: string[] }).touchLog = log;
        for (const type of ['touchstart', 'touchmove']) {
          window.addEventListener(type, (e) => log.push(`${type}:${(e as TouchEvent).touches.length}:${e.defaultPrevented}`));
        }
      });
      const a = { x: box.x + 80, y: box.y + 120 };
      const b = { x: box.x + 180, y: box.y + 220 };
      // 2 本指
      await touch(page, 'touchStart', [a]);
      await touch(page, 'touchStart', [a, b]);
      await touch(page, 'touchMove', [{ x: a.x - 20, y: a.y - 20 }, { x: b.x + 20, y: b.y + 20 }]);
      await touch(page, 'touchEnd', []);
      // 1 本指
      await touch(page, 'touchStart', [a]);
      await touch(page, 'touchMove', [{ x: a.x + 60, y: a.y + 40 }]);
      await touch(page, 'touchEnd', []);
      const log = await page.evaluate(() => (window as unknown as { touchLog: string[] }).touchLog);
      expect(log.filter((l) => l.split(':')[1] === '2')).toEqual(['touchstart:2:false', 'touchmove:2:false']);
      expect(log.slice(-2)).toEqual(['touchstart:1:true', 'touchmove:1:true']);
      // 2 本指の操作は範囲にならず、1 本指のドラッグだけが範囲になる
      expect(await page.locator('.redaction-rect').count()).toBe(1);
      expect(await page.locator('.rect-drawing').count()).toBe(0);
    });

    test('1 本指で描きかけの途中に 2 本目の指が触れたら、描きかけの枠を捨て、何も残さない', async ({ page }) => {
      const box = await openInRectMode(page);
      const a = { x: box.x + 60, y: box.y + 80 };
      await touch(page, 'touchStart', [a]);
      await touch(page, 'touchMove', [{ x: a.x + 40, y: a.y + 30 }]);
      // 2 本目の指（ピンチを始めようとした）
      await touch(page, 'touchStart', [{ x: a.x + 40, y: a.y + 30 }, { x: a.x + 120, y: a.y + 90 }]);
      const moved = [{ x: a.x + 30, y: a.y + 20 }, { x: a.x + 140, y: a.y + 110 }];
      await touch(page, 'touchMove', moved);
      // 2 本目を先に離し、そのあと 1 本目を離す
      await releaseOnly(page, moved[1], moved);
      await touch(page, 'touchEnd', []);
      expect(await page.locator('.rect-drawing').count()).toBe(0);
      expect(await page.locator('.redaction-rect').count()).toBe(0);
    });

    test('2 本目の指がページの外に触れ、それを先に離しても、範囲を作らない', async ({ page }) => {
      const box = await openInRectMode(page);
      const a = { x: box.x + 60, y: box.y + 80 };
      const a2 = { x: a.x + 40, y: a.y + 30 };
      // 2 本目の指はツールバーの上（ページの入れ物の外）
      const toolbar = (await page.locator('#toolbar').boundingBox())!;
      const outside = { x: toolbar.x + toolbar.width - 10, y: toolbar.y + toolbar.height / 2 };
      await touch(page, 'touchStart', [a]);
      await touch(page, 'touchMove', [a2]);
      await touch(page, 'touchStart', [a2, outside]);
      // 2 本目（ページの外）を先に離し、そのあと 1 本目を離す
      await releaseOnly(page, outside, [a2, outside]);
      await touch(page, 'touchEnd', []);
      expect(await page.locator('.redaction-rect').count()).toBe(0);
      expect(await page.locator('.rect-drawing').count()).toBe(0);
    });

    test('描きかけの途中でタッチが打ち切られたら（touchcancel）、描きかけの枠を捨てる', async ({ page }) => {
      const box = await openInRectMode(page);
      const a = { x: box.x + 60, y: box.y + 80 };
      await touch(page, 'touchStart', [a]);
      await touch(page, 'touchMove', [{ x: a.x + 80, y: a.y + 50 }]);
      await touch(page, 'touchCancel', []);
      expect(await page.locator('.rect-drawing').count()).toBe(0);
      expect(await page.locator('.redaction-rect').count()).toBe(0);
      // 次の 1 本指のドラッグは、ふつうに範囲になる
      await touch(page, 'touchStart', [a]);
      await touch(page, 'touchMove', [{ x: a.x + 100, y: a.y + 60 }]);
      await touch(page, 'touchEnd', []);
      expect(await page.locator('.redaction-rect').count()).toBe(1);
      expect(await page.locator('.rect-drawing').count()).toBe(0);
    });

    test('タップしても、点（大きさ 0 の枠）を残さない', async ({ page }) => {
      const box = await openInRectMode(page);
      for (let i = 0; i < 4; i++) {
        const p = { x: box.x + 40 + i * 30, y: box.y + 60 };
        await touch(page, 'touchStart', [p]);
        await touch(page, 'touchEnd', []);
      }
      expect(await page.locator('.rect-drawing').count()).toBe(0);
      expect(await page.locator('.redaction-rect').count()).toBe(0);
    });

    test('範囲をたくさん作ってから「×」で消すと、枠は 1 つも残らない', async ({ page }) => {
      const box = await openInRectMode(page);
      for (let i = 0; i < 5; i++) {
        const a = { x: box.x + 30 + i * 20, y: box.y + 60 + i * 40 };
        await touch(page, 'touchStart', [a]);
        await touch(page, 'touchMove', [{ x: a.x + 60, y: a.y + 30 }]);
        // 途中で 2 本目の指が触れる操作も混ぜる
        if (i % 2 === 0) await touch(page, 'touchStart', [{ x: a.x + 60, y: a.y + 30 }, { x: a.x + 100, y: a.y + 70 }]);
        await touch(page, 'touchEnd', []);
      }
      await page.locator('#btn-clear').tap();
      expect(await page.locator('.rect-drawing').count()).toBe(0);
      expect(await page.locator('.redaction-rect').count()).toBe(0);
    });
  });
});
