/**
 * 文字選択で作った範囲の黒い四角を、文字の進む向きに、次の字・線・画像の手前（無ければ本文の端）まで広げる。
 * 黒い四角の幅が消した文字列の幅と一致すると、候補の名前の幅と比べて絞られる（Bland ら "Story Beyond the Eye"）。
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { redactPdf } from '../../src/redaction/pdf-redactor';
import { parseContentStream } from '../../src/redaction/content/lexer';
import { contentsBytes } from '../../src/redaction/pdf-objects';
import { allText, extractPathSegments } from './helpers/pdf-oracle';
import type { PdfRect } from '../../src/utils/coordinates';

async function page(content: string, extra?: (doc: PDFDocument, p: ReturnType<PDFDocument['addPage']>) => void) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  await font.embed();
  p.node.setFontDictionary(PDFName.of('F1'), font.ref);
  p.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  extra?.(doc, p);
  return doc.save();
}

async function redact(bytes: Uint8Array, rects: PdfRect[]) {
  return redactPdf(bytes.slice().buffer as ArrayBuffer, new Map([[1, rects]]));
}

/** 出力の頁の最後に描いた黒い四角 */
async function boxesOf(pdf: Uint8Array): Promise<PdfRect[]> {
  const doc = await PDFDocument.load(pdf);
  const ops = parseContentStream(contentsBytes(doc.context, doc.getPages()[0].node.get(PDFName.of('Contents'))));
  let k = ops.length - 1;
  while (k >= 0 && ops[k].op !== 'f') k--;
  const out: PdfRect[] = [];
  for (let j = k - 1; j >= 0 && ops[j].op === 're'; j--) {
    const [x, y, width, height] = ops[j].operands.map((o) => (o.type === 'number' ? o.value : NaN));
    out.unshift({ x, y, width, height });
  }
  return out;
}

// Helvetica 12pt: "Name: " = 38.676、"Secret" = 34.68
const NAME_X = 50 + 38.676;
const SECRET_W = 34.68;
const secretBox = (x = NAME_X, y = 697): PdfRect & { source: 'text' } => ({ x, y, width: SECRET_W, height: 13, source: 'text' });

describe('文字選択の黒い四角を、空いているところまで広げる', () => {
  it('同じ行の次の字の手前まで広げ、次の字は残す', async () => {
    const before = await page('BT /F1 12 Tf 50 700 Td (Name: Secret) Tj ET BT /F1 12 Tf 200 700 Td (end) Tj ET BT /F1 12 Tf 50 600 Td (another line that is long) Tj ET');
    const after = await redact(before, [secretBox()]);
    const [b] = await boxesOf(after);
    expect(b.x).toBeCloseTo(NAME_X, 3);
    expect(b.x + b.width).toBeGreaterThan(190);
    expect(b.x + b.width).toBeLessThan(200);
    const text = (await allText(after)).replace(/\s/g, '');
    expect(text).toContain('Name:');
    expect(text).toContain('end');
    expect(text).not.toContain('Secret');
  });

  it('行の後ろに何も無ければ、本文の右端まで広げる', async () => {
    const before = await page('BT /F1 12 Tf 50 700 Td (Name: Secret) Tj ET BT /F1 12 Tf 50 600 Td (a much longer line of ordinary text here) Tj ET');
    const after = await redact(before, [secretBox()]);
    const [b] = await boxesOf(after);
    // 2 行目の右端（50 + 208.09pt）まで。頁の端までは行かない
    expect(b.x + b.width).toBeCloseTo(258.09, 1);
  });

  it('表の縦の罫線の手前で止め、罫線は切らない', async () => {
    const before = await page('BT /F1 12 Tf 50 700 Td (Name: Secret) Tj ET 0.5 w 150 690 m 150 720 l S BT /F1 12 Tf 160 700 Td (Next cell) Tj ET');
    const after = await redact(before, [secretBox()]);
    const [b] = await boxesOf(after);
    expect(b.x + b.width).toBeGreaterThan(140);
    expect(b.x + b.width).toBeLessThan(150);
    const segs = await extractPathSegments(after);
    const vertical = segs.filter(([a, b2]) => Math.abs(a[0] - 150) < 0.01 && Math.abs(b2[0] - 150) < 0.01);
    const len = vertical.reduce((n, [a, b2]) => n + Math.abs(b2[1] - a[1]), 0);
    expect(len).toBeCloseTo(30, 3);
  });

  it('矩形で選んだ範囲は広げない', async () => {
    const before = await page('BT /F1 12 Tf 50 700 Td (Name: Secret) Tj ET BT /F1 12 Tf 200 700 Td (end) Tj ET');
    const after = await redact(before, [{ x: NAME_X, y: 697, width: SECRET_W, height: 13 }]);
    const [b] = await boxesOf(after);
    expect(b.width).toBeCloseTo(SECRET_W, 3);
  });

  it('文字が上向きに進む行（回転した頁など）では、上へ広げる', async () => {
    // Tm 0 1 -1 0: 文字は +y の向きに進む。"Name: " の後の "Secret" は y = 300 + 38.676 から 34.68pt
    const before = await page('BT /F1 12 Tf 0 1 -1 0 100 300 Tm (Name: Secret) Tj ET BT /F1 12 Tf 0 1 -1 0 100 450 Tm (end) Tj ET');
    const after = await redact(before, [{ x: 88, y: 300 + 38.676, width: 13, height: SECRET_W, source: 'text' }]);
    const [b] = await boxesOf(after);
    expect(b.x).toBeCloseTo(88, 3);
    expect(b.width).toBeCloseTo(13, 3);
    expect(b.y).toBeCloseTo(300 + 38.676, 3);
    expect(b.y + b.height).toBeGreaterThan(440);
    expect(b.y + b.height).toBeLessThan(450);
    expect((await allText(after)).replace(/\s/g, '')).toContain('end');
  });

  it('同じ行の後ろに幅の分からないフォントの字があれば、その手前で止める（広げたせいで墨消しを止めない）', async () => {
    const before = await page('BT /F1 12 Tf 50 700 Td (Name: Secret) Tj ET BT /F2 12 Tf 200 700 Td (mystery) Tj ET', (doc, p) => {
      p.node.setFontDictionary(PDFName.of('F2'), doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'MysteryFont' })));
    });
    const after = await redact(before, [secretBox()]);
    const [b] = await boxesOf(after);
    expect(b.x + b.width).toBeGreaterThan(190);
    expect(b.x + b.width).toBeLessThan(200);
  });

  it('空白の字（半角の空白、中身の無い字形）では止まらず、その先の字の手前まで広げる', async () => {
    const before = await page('BT /F1 12 Tf 50 700 Td (Name: Secret   more) Tj ET');
    const after = await redact(before, [secretBox()]);
    const [b] = await boxesOf(after);
    // "Secret" の右端 123.36 の後に空白 3 つ（各 3.336pt）、"more" は 133.37 から
    expect(b.x + b.width).toBeGreaterThan(128);
    expect(b.x + b.width).toBeLessThan(133.37);
    expect((await allText(after)).replace(/\s/g, '')).toContain('more');
  });

  it('Type3 の中身の無い字（Chrome の全角の空白など、d1 の外接矩形が空）でも止まらない', async () => {
    const before = await page('BT /T3 12 Tf 50 700 Td (ab) Tj (sss) Tj (c) Tj ET', (doc, p) => {
      const glyph = (box: string) => doc.context.register(doc.context.stream(`1000 0 ${box} d1 ${box === '0 0 0 0' ? '' : '0 0 800 700 re f'}`));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 800, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { ga: glyph('0 0 800 700'), gb: glyph('0 0 800 700'), gc: glyph('0 0 800 700'), gs: glyph('0 0 0 0') },
        Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('ga'), PDFName.of('gb'), PDFName.of('gc'), 115, PDFName.of('gs')] },
        FirstChar: 97, LastChar: 115, Widths: Array.from({ length: 19 }, () => 1000), Resources: {},
      }));
      p.node.setFontDictionary(PDFName.of('T3'), font);
    });
    // b（62〜74）を選ぶ。後ろに中身の無い字が 3 つ（74〜110）、c は 110 から
    const after = await redact(before, [{ x: 62, y: 698, width: 12, height: 12, source: 'text' }]);
    const [b] = await boxesOf(after);
    expect(b.x + b.width).toBeGreaterThan(105);
    expect(b.x + b.width).toBeLessThan(110);
  });

  it('上下の行の字が範囲の縁に少しかかるだけでも、その字は消さない（そこで止める）', async () => {
    // 上の行（y=712）の字の箱（709.5〜）は、下の行の範囲（697〜710）の上の縁に 0.5pt だけかかる
    const before = await page('BT /F1 12 Tf 50 700 Td (Name: Secret) Tj ET BT /F1 12 Tf 130 712 Td (tailword) Tj ET');
    const after = await redact(before, [secretBox()]);
    expect((await allText(after)).replace(/\s/g, '')).toContain('tailword');
  });
});
