import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { redactPdf } from '../../src/redaction/pdf-redactor';

async function createTestPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.setFont(font);

  page.drawText('Public text', {
    x: 50,
    y: 750,
    size: 16,
    color: rgb(0, 0, 0),
  });

  page.drawText('SECRET data', {
    x: 50,
    y: 700,
    size: 16,
    color: rgb(0, 0, 0),
  });

  page.drawText('Another public line', {
    x: 50,
    y: 650,
    size: 16,
    color: rgb(0, 0, 0),
  });

  doc.setTitle('Test Title');
  doc.setAuthor('Test Author');

  const bytes = await doc.save();
  return bytes.buffer as ArrayBuffer;
}

describe('redactPdf', () => {
  it('墨消しPDFを生成できる', async () => {
    const originalBytes = await createTestPdf();
    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    // SECRET dataの領域を墨消し (y=700, 高さ20程度)
    redactionMap.set(1, [{ x: 40, y: 695, width: 300, height: 25 }]);

    const result = await redactPdf(originalBytes, redactionMap);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);

    // 生成されたPDFが有効か確認
    const redactedDoc = await PDFDocument.load(result);
    expect(redactedDoc.getPageCount()).toBe(1);
  });

  it('メタデータがクリアされる', async () => {
    const originalBytes = await createTestPdf();
    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    redactionMap.set(1, [{ x: 40, y: 695, width: 300, height: 25 }]);

    const result = await redactPdf(originalBytes, redactionMap);
    const redactedDoc = await PDFDocument.load(result);

    expect(redactedDoc.getTitle()).toBeFalsy();
    expect(redactedDoc.getAuthor()).toBeFalsy();
  });

  it('空の墨消しマップでもエラーにならない', async () => {
    const originalBytes = await createTestPdf();
    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();

    const result = await redactPdf(originalBytes, redactionMap);
    expect(result).toBeInstanceOf(Uint8Array);
  });
});
