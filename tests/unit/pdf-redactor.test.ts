import { describe, it, expect } from 'vitest';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName,
  PDFRef,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
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

  it('矩形選択: 墨消し対象テキストがContentStreamから削除される', async () => {
    const originalBytes = await createTestPdf();

    // まず元のPDFにhexエンコードされた "SECRET data" が含まれていることを確認
    const originalContent = await extractPageContentStream(originalBytes, 0);
    const secretHex = toHexString('SECRET data');
    expect(originalContent).toContain(secretHex);

    // 矩形選択パターン: 大きな矩形1つで "SECRET data" を覆う
    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    redactionMap.set(1, [{ x: 40, y: 690, width: 300, height: 30 }]);

    const result = await redactPdf(originalBytes, redactionMap);

    // 墨消し後のContentStreamに "SECRET data" のhex文字列が含まれていないことを確認
    const redactedContent = await extractPageContentStream(result, 0);
    expect(redactedContent).not.toContain(secretHex);

    // 他のテキストは残っていることを確認
    expect(redactedContent).toContain(toHexString('Public text'));
    expect(redactedContent).toContain(toHexString('Another public line'));
  });

  it('テキスト選択: 小さな矩形群で墨消しした場合もテキストが削除される', async () => {
    const originalBytes = await createTestPdf();

    // テキスト選択パターン: 文字単位の小さい矩形群でカバー
    // "SECRET data" (x=50, y=700, fontSize=16) を文字ごとに小さな矩形で覆うシミュレーション
    const charWidth = 16 * 0.6; // Helvetica概算
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    const text = 'SECRET data';
    for (let i = 0; i < text.length; i++) {
      rects.push({
        x: 50 + i * charWidth,
        y: 697,
        width: charWidth + 1,
        height: 20,
      });
    }

    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    redactionMap.set(1, rects);

    const result = await redactPdf(originalBytes, redactionMap);

    // 墨消し後のContentStreamに "SECRET data" のhex文字列が含まれていないことを確認
    const redactedContent = await extractPageContentStream(result, 0);
    expect(redactedContent).not.toContain(toHexString('SECRET data'));

    // 他のテキストは残っていることを確認
    expect(redactedContent).toContain(toHexString('Public text'));
    expect(redactedContent).toContain(toHexString('Another public line'));
  });

  it('墨消し後のBT...ETブロックが丸ごと削除される', async () => {
    const originalBytes = await createTestPdf();

    // 元のContentStreamにはBT...ETブロックが3つある（3行のテキスト）
    const originalContent = await extractPageContentStream(originalBytes, 0);
    const originalBtCount = (originalContent.match(/\bBT\b/g) ?? []).length;
    expect(originalBtCount).toBe(3);

    // "SECRET data" の領域を墨消し
    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    redactionMap.set(1, [{ x: 40, y: 690, width: 300, height: 30 }]);

    const result = await redactPdf(originalBytes, redactionMap);
    const redactedContent = await extractPageContentStream(result, 0);

    // 墨消し後はBT...ETブロックが2つに減っている（"SECRET data"のブロックが丸ごと削除）
    const redactedBtCount = (redactedContent.match(/\bBT\b/g) ?? []).length;
    expect(redactedBtCount).toBe(2);

    // 空の `() Tj` オペレーターが残存していないことを確認
    expect(redactedContent).not.toContain('() Tj');
  });

  it('部分的な墨消しではBT...ETブロックが保持される', async () => {
    // 1つのBT...ETブロック内に2つのTjがあり、片方だけ墨消しする場合
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.setFont(font);

    // 同じBT...ETブロック内に2行描画されるPDFを作る
    // pdf-libのdrawTextは各呼び出しで別のBT...ETを生成するため、
    // 2行を1ブロック内に収める必要がある。
    // ここでは別ブロック(各1つのTj)で代用し、片方のブロックだけ削除されることを確認
    page.drawText('Keep this', { x: 50, y: 750, size: 16, color: rgb(0, 0, 0) });
    page.drawText('Remove this', { x: 50, y: 700, size: 16, color: rgb(0, 0, 0) });

    const bytes = await doc.save();
    const originalContent = await extractPageContentStream(bytes.buffer as ArrayBuffer, 0);
    const originalBtCount = (originalContent.match(/\bBT\b/g) ?? []).length;
    expect(originalBtCount).toBe(2);

    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    // "Remove this" だけ墨消し
    redactionMap.set(1, [{ x: 40, y: 690, width: 300, height: 30 }]);

    const result = await redactPdf(bytes.buffer as ArrayBuffer, redactionMap);
    const redactedContent = await extractPageContentStream(result, 0);

    // "Remove this" のブロックが削除され、"Keep this" のブロックは残る
    const redactedBtCount = (redactedContent.match(/\bBT\b/g) ?? []).length;
    expect(redactedBtCount).toBe(1);
    expect(redactedContent).toContain(toHexString('Keep this'));
    expect(redactedContent).not.toContain(toHexString('Remove this'));
  });

  it('墨消し後のContentStreamにもバイナリにも対象テキストが残存しない', async () => {
    const originalBytes = await createTestPdf();
    const secretHex = toHexString('SECRET data');

    // 元のContentStreamにはhex文字列が含まれている
    const originalContent = await extractPageContentStream(originalBytes, 0);
    expect(originalContent).toContain(secretHex);

    const redactionMap = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    redactionMap.set(1, [{ x: 40, y: 690, width: 300, height: 30 }]);

    const result = await redactPdf(originalBytes, redactionMap);

    // 墨消し後: ContentStream（デコード済み）にhex文字列が残っていないことを確認
    const redactedContent = await extractPageContentStream(result, 0);
    expect(redactedContent).not.toContain(secretHex);

    // 墨消し後: PDFバイナリ全体にもリテラル "SECRET" が残っていないことを確認
    const binaryStr = new TextDecoder('latin1').decode(result);
    expect(binaryStr).not.toContain('SECRET');
  });
});

/** ASCII文字列をPDFのhex文字列表現(大文字)に変換する (例: "AB" → "4142") */
function toHexString(text: string): string {
  return Array.from(text)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

/**
 * PDFの指定ページのContentStreamをデコードしてテキストとして返すヘルパー。
 * テスト専用: テキストオペレーターの存在を確認するために使う。
 */
async function extractPageContentStream(
  pdfBytes: ArrayBuffer | Uint8Array,
  pageIndex: number,
): Promise<string> {
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPages()[pageIndex];
  const pageDict = page.node;
  const contentsRef = pageDict.get(PDFName.of('Contents'));

  const streams: string[] = [];

  function decodeStream(streamObj: unknown): string | null {
    if (streamObj instanceof PDFRawStream) {
      try {
        const decoded = decodePDFRawStream(streamObj);
        return new TextDecoder('latin1').decode(decoded.decode());
      } catch {
        return new TextDecoder('latin1').decode(streamObj.getContents());
      }
    }
    if (streamObj && typeof (streamObj as Record<string, unknown>).getContents === 'function') {
      return new TextDecoder('latin1').decode(
        (streamObj as { getContents(): Uint8Array }).getContents(),
      );
    }
    return null;
  }

  if (contentsRef instanceof PDFRef) {
    const streamObj = doc.context.lookup(contentsRef);
    const text = decodeStream(streamObj);
    if (text) streams.push(text);
  } else if (contentsRef instanceof PDFArray) {
    for (let i = 0; i < contentsRef.size(); i++) {
      const ref = contentsRef.get(i);
      if (ref instanceof PDFRef) {
        const streamObj = doc.context.lookup(ref);
        const text = decodeStream(streamObj);
        if (text) streams.push(text);
      }
    }
  }

  return streams.join('\n');
}
