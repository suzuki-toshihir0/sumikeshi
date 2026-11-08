/**
 * 墨消しの範囲の情報が、墨消し後の PDF に残らないことを確かめる。
 * 判定は sumikeshi の実装とは独立に、pdf.js で PDF を読み直して行う（helpers/pdf-oracle.ts）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts, rgb,
} from 'pdf-lib';
import { redactPdf } from '../../src/redaction/pdf-redactor';
import {
  allText, extractText, extractImages, extractPathBoxes, extractPathSegments, segmentCrossesInterior,
  extractAnnotations, extractDocumentInfo,
  pixelCenterOnPage, inside, overlaps, documentText, type Box,
} from './helpers/pdf-oracle';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/real/${name}`, import.meta.url))));

async function redact(bytes: Uint8Array, rects: Box[], pageNo = 1): Promise<Uint8Array> {
  return redactPdf(bytes.slice().buffer as ArrayBuffer, new Map([[pageNo, rects]]));
}

/** 生の ContentStream で 1 頁の PDF を作る（/F1 = Helvetica） */
async function rawPage(
  content: string,
  extra?: (doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  extra?.(doc, page);
  return doc.save();
}

const textBoxes = async (bytes: Uint8Array) => (await extractText(bytes)).map((t) => ({ str: t.str, box: t.box }));

/** 墨消しの範囲にかからない文字が、同じ位置に残っていることを確かめる */
async function expectOutsideTextKept(before: Uint8Array, after: Uint8Array, rects: Box[]) {
  const b = (await textBoxes(before)).filter((t) => !rects.some((r) => overlaps(t.box, r)));
  const a = await allText(after);
  for (const t of b) expect(a).toContain(t.str.trim());
}

/** 範囲の中の画素に情報が残らず（一色）、範囲から離れた画素は元のままであることを確かめる */
async function expectImageRedacted(before: Uint8Array, after: Uint8Array, rect: Box) {
  const ib = await extractImages(before);
  const ia = await extractImages(after);
  expect(ia.length).toBe(ib.length);
  for (let k = 0; k < ib.length; k++) {
    const B = ib[k];
    const A = ia[k];
    expect([A.width, A.height]).toEqual([B.width, B.height]);
    const insideValues = new Set<number>();
    let insideCount = 0;
    let changedOutside = 0;
    const margin = { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 };
    for (let y = 0; y < B.height; y++) {
      for (let x = 0; x < B.width; x++) {
        const p = pixelCenterOnPage(B, x, y);
        if (inside(p, rect)) {
          insideValues.add(A.gray(x, y));
          insideCount++;
        } else if (!inside(p, margin)) {
          if (Math.abs(A.gray(x, y) - B.gray(x, y)) > 8) changedOutside++;
        }
      }
    }
    if (insideCount > 0) expect([...insideValues]).toHaveLength(1);
    expect(changedOutside).toBe(0);
  }
}

describe('スキャン（画像）の PDF', () => {
  it('8bit 灰色の画像: 範囲の画素が塗られ、範囲の外は元のまま', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const w = 200, h = 100;
    const px = new Uint8Array(w * h);
    for (let i = 0; i < px.length; i++) px[i] = 64 + ((i * 37) % 192);
    const img = doc.context.register(doc.context.flateStream(px, {
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }));
    page.node.setXObject(PDFName.of('Im0'), img);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 400 0 0 200 100 500 cm /Im0 Do Q')));
    const before = await doc.save();
    const rect = { x: 150, y: 550, width: 100, height: 50 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
    // 元の画像の生データが残っていない
    expect(Buffer.from(after).includes(Buffer.from(px.subarray(0, 64)))).toBe(false);
  });

  it('JBIG2 のスキャン', async () => {
    const before = fixture('jbig2.pdf');
    const rect = { x: 148, y: 578, width: 70, height: 24 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });

  it('CCITT G4 のスキャン', async () => {
    const before = fixture('ccitt.pdf');
    const rect = { x: 148, y: 118, width: 102, height: 34 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });

  it('JPEG のスキャン', async () => {
    const before = fixture('jpeg.pdf');
    const rect = { x: 148, y: 578, width: 70, height: 24 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });
});

describe('文字の PDF', () => {
  it('cm で縮めた座標の文字', async () => {
    const before = await rawPage('q 0.5 0 0 0.5 0 0 cm BT /F1 24 Tf 100 1400 Td (SECRET-CM) Tj ET Q BT /F1 12 Tf 50 750 Td (Public) Tj ET');
    const rects = [{ x: 45, y: 695, width: 120, height: 18 }];
    const after = await redact(before, rects);
    expect(await allText(after)).not.toContain('SECRET');
    await expectOutsideTextKept(before, after, rects);
  });

  it('Tm で拡大した文字（範囲にかかる文字だけが消える）', async () => {
    const before = await rawPage('BT /F1 1 Tf 24 0 0 24 50 700 Tm (Taro SECRET-TM) Tj ET');
    const rects = [{ x: 104, y: 693, width: 146, height: 26 }];
    const after = await redact(before, rects);
    const text = await allText(after);
    expect(text).not.toMatch(/SECRET|TM/);
    expect(text).toContain('Taro');
  });

  it('Tj が続くとき、選んだ側だけが消え、前の文字は同じ位置に残る', async () => {
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (Name of the tenant in this contract: ) Tj (SECRET-ADV) Tj ET');
    const rects = [{ x: 237, y: 695, width: 83, height: 16 }];
    const after = await redact(before, rects);
    const text = await allText(after);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('Name of the tenant in this contract:');
    const b = (await extractText(before)).find((t) => t.str.startsWith('Name'))!;
    const a = (await extractText(after)).find((t) => t.str.startsWith('Name'))!;
    expect(a.box.x).toBeCloseTo(b.box.x, 3);
    expect(a.box.y).toBeCloseTo(b.box.y, 3);
  });

  it('TJ の中の一部だけを消しても、後ろの文字の位置が変わらない', async () => {
    const before = await rawPage('BT /F1 12 Tf 50 700 Td [(AB) -500 (SECRET) 200 (CD)] TJ ET');
    const pos = await extractText(before);
    const rects = [{ x: 76, y: 695, width: 30, height: 16 }];
    const after = await redact(before, rects);
    const text = await allText(after);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('AB');
    expect(text).toContain('CD');
    const cdBefore = pos.find((t) => t.str.includes('CD'))!;
    const cdAfter = (await extractText(after)).find((t) => t.str.includes('CD'))!;
    // pdf.js は文字列の塊ごとに位置を返すので、CD の右端で比べる
    expect(cdAfter.box.x + cdAfter.box.width).toBeCloseTo(cdBefore.box.x + cdBefore.box.width, 2);
  });

  it('T* で次の行へ', async () => {
    const before = await rawPage('BT /F1 12 Tf 30 TL 50 700 Td (Public line) Tj T* (SECRET-TSTAR) Tj ET');
    const rects = [{ x: 45, y: 666, width: 120, height: 18 }];
    const after = await redact(before, rects);
    const text = await allText(after);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('Public line');
  });

  it("' と \" で次の行へ", async () => {
    const before = await rawPage('BT /F1 12 Tf 20 TL 50 700 Td (Line one) Tj (SECRET-QUOTE) \' 2 1 (SECRET-DQ) " ET');
    const rects = [{ x: 45, y: 655, width: 200, height: 30 }];
    const after = await redact(before, rects);
    const text = await allText(after);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('Line one');
  });

  it('Form XObject の中の文字', async () => {
    const before = await rawPage('q 1 0 0 1 50 700 cm /Fx1 Do Q BT /F1 12 Tf 50 750 Td (Public) Tj ET', (doc, page) => {
      const font = page.node.Resources()!.lookup(PDFName.of('Font'));
      const form = doc.context.flateStream('BT /F1 12 Tf 0 0 Td (SECRET-XOBJ) Tj ET', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 50], Resources: { Font: font },
      });
      page.node.setXObject(PDFName.of('Fx1'), doc.context.register(form));
    });
    const rects = [{ x: 45, y: 695, width: 120, height: 18 }];
    const after = await redact(before, rects);
    expect(await documentText(after)).not.toContain('SECRET');
    expect(await allText(after)).toContain('Public');
    expect(Buffer.from(after).includes(Buffer.from('SECRET'))).toBe(false);
  });

  it('ActualText で文字を持たせた範囲', async () => {
    const before = await rawPage('/Span <</ActualText (SECRET-ACTUAL)>> BDC BT /F1 12 Tf 50 700 Td (xxxx) Tj ET EMC');
    const rects = [{ x: 45, y: 695, width: 60, height: 18 }];
    const after = await redact(before, rects);
    expect(await allText(after)).not.toContain('SECRET');
  });

  it('文字をパスにしたもの（範囲にかかる線と塗りが無くなる）', async () => {
    const before = await rawPage('0 0 0 rg 50 700 m 60 712 l 70 700 l h f 200 700 m 210 712 l 220 700 l h f');
    const rect = { x: 45, y: 695, width: 30, height: 22 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    // 黒い四角の辺は範囲の境界の上なので、内側を通る線分は無いはず
    expect(segs.some((s) => segmentCrossesInterior(s, rect))).toBe(false);
    // 範囲の外の三角形は残る
    expect(segs.some((s) => s[0][0] >= 199 && s[0][0] <= 221 && s[0][1] >= 699)).toBe(true);
  });

  it('範囲を横切る表の罫線は、範囲の外の部分が残る', async () => {
    const before = await rawPage('1 w 0 0 0 RG 50 700 m 500 700 l S');
    const rect = { x: 200, y: 690, width: 50, height: 20 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    expect(segs.some((s) => segmentCrossesInterior(s, rect))).toBe(false);
    const horizontal = segs.filter((s) => s[0][1] === 700 && s[1][1] === 700);
    expect(horizontal.some((s) => Math.min(s[0][0], s[1][0]) === 50 && Math.max(s[0][0], s[1][0]) >= 195)).toBe(true);
    expect(horizontal.some((s) => Math.max(s[0][0], s[1][0]) === 500 && Math.min(s[0][0], s[1][0]) <= 255)).toBe(true);
  });

  it('範囲にかかる背景の矩形の塗りは、範囲を抜いた形で残る', async () => {
    const before = await rawPage('0.9 g 40 680 300 60 re f');
    const rect = { x: 100, y: 690, width: 50, height: 20 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    expect(segs.some((s) => segmentCrossesInterior(s, rect))).toBe(false);
    // 元の矩形の四隅は残る
    const xs = segs.flatMap((s) => [s[0][0], s[1][0]]);
    expect(xs).toContain(40);
    expect(xs).toContain(340);
  });
});

describe('注釈・フォーム・文書の情報', () => {
  it('範囲にかかる注釈とフォームの欄の値が無くなる', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('Public', { x: 50, y: 750, size: 12, font });
    const annot = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'FreeText', Rect: [50, 690, 250, 715],
      Contents: PDFString.of('SECRET-ANNOT'), DA: PDFString.of('/Helv 12 Tf 0 g'),
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    const form = doc.getForm();
    const tf = form.createTextField('tenant');
    tf.setText('SECRET-FIELD');
    tf.addToPage(page, { x: 50, y: 640, width: 200, height: 20 });
    const before = await doc.save();
    const rects = [{ x: 45, y: 685, width: 210, height: 35 }, { x: 45, y: 635, width: 210, height: 30 }];
    const after = await redact(before, rects);
    const annots = await extractAnnotations(after);
    expect(JSON.stringify(annots)).not.toContain('SECRET');
    expect(await documentText(after)).not.toContain('SECRET');
    expect(Buffer.from(after).includes(Buffer.from('SECRET'))).toBe(false);
  });

  it('XMP メタデータ、しおり、Info が無くなる', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('SECRET-BODY', { x: 50, y: 700, size: 12, font });
    doc.setTitle('SECRET-TITLE');
    doc.setAuthor('SECRET-AUTHOR');
    const xmp = doc.context.stream('<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>SECRET-XMP</dc:creator></x:xmpmeta>', {
      Type: 'Metadata', Subtype: 'XML',
    });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp));
    const outlinesRef = doc.context.nextRef();
    const item = doc.context.register(doc.context.obj({
      Title: PDFHexString.fromText('SECRET-BOOKMARK'), Parent: outlinesRef, Dest: [page.ref, PDFName.of('Fit')],
    }));
    doc.context.assign(outlinesRef, doc.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
    const before = await doc.save();
    const after = await redact(before, [{ x: 45, y: 695, width: 120, height: 18 }]);
    const info = await extractDocumentInfo(after);
    expect(JSON.stringify(info)).not.toContain('SECRET');
    expect(Buffer.from(after).includes(Buffer.from('SECRET'))).toBe(false);
  });

  it('どこからも参照されていないオブジェクトが残らない', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('Public', { x: 50, y: 750, size: 12, font });
    doc.context.register(doc.context.stream('BT /F1 12 Tf 50 700 Td (SECRET-ORPHAN) Tj ET'));
    const before = await doc.save();
    const after = await redact(before, [{ x: 45, y: 745, width: 60, height: 18 }]);
    expect(Buffer.from(after).includes(Buffer.from('SECRET-ORPHAN'))).toBe(false);
  });

  it('頁の縮小画像（Thumb）が残らない', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const thumb = doc.context.register(doc.context.stream('SECRET-THUMB', {
      Width: 4, Height: 3, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }));
    page.node.set(PDFName.of('Thumb'), thumb);
    const before = await doc.save();
    const after = await redact(before, [{ x: 45, y: 745, width: 60, height: 18 }]);
    expect(Buffer.from(after).includes(Buffer.from('SECRET-THUMB'))).toBe(false);
  });
});

describe('実在の作り方の PDF', () => {
  it('Chrome で印刷した日本語の PDF: 氏名だけが消え、ほかは残る', async () => {
    const before = fixture('chrome.pdf');
    // 「見本 花子」の行の、氏名の部分（pdftotext -bbox で x=141〜202、y=650〜686）
    const rects = [{ x: 140, y: 655, width: 63, height: 25 }];
    const after = await redact(before, rects);
    const text = await allText(after);
    expect(text).not.toContain('花子');
    // 「見本」は住所（架空県見本市）にもあるので、氏名の直後に無いことを見る
    expect(text).not.toMatch(/氏名[:：]?\s*見本/);
    expect(text).toContain('賃借人氏名');
    expect(text).toContain('生年月日');
    expect(text).toContain('架空県見本市');
  });

  it('既存の黒い四角: 墨消しの範囲に黒い四角が描かれる', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('SECRET', { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });
    const before = await doc.save();
    const rect = { x: 45, y: 695, width: 60, height: 18 };
    const after = await redact(before, [rect]);
    const boxes = await extractPathBoxes(after);
    expect(boxes.some((b) => Math.abs(b.x - rect.x) < 0.01 && Math.abs(b.y - rect.y) < 0.01
      && Math.abs(b.width - rect.width) < 0.01 && Math.abs(b.height - rect.height) < 0.01)).toBe(true);
  });
});
