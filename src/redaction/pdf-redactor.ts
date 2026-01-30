import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFFlateStream,
  rgb,
} from 'pdf-lib';
import type { PdfRect } from '../utils/coordinates';
import { cleanMetadata } from './metadata-cleaner';

/** 2つの矩形が重なるかチェック */
function rectsOverlap(a: PdfRect, b: PdfRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * ContentStreamバイナリからテキスト描画オペレーターを削除する。
 *
 * PDF ContentStreamのオペレーターを簡易パースし、
 * BT...ETブロック内のテキスト位置(Td, Tm等)を追跡して、
 * 墨消し領域と重なるテキスト(Tj, TJ, ', ")オペレーターを空に置換する。
 */
function removeTextOperatorsFromStream(
  streamBytes: Uint8Array,
  redactRects: PdfRect[],
  pageHeight: number,
): Uint8Array {
  const content = new TextDecoder('latin1').decode(streamBytes);

  // BT...ETブロックを探して処理する
  const result: string[] = [];
  let lastIndex = 0;
  const btRegex = /\bBT\b/g;

  let btMatch: RegExpExecArray | null;
  while ((btMatch = btRegex.exec(content)) !== null) {
    const btStart = btMatch.index;
    // 対応するETを探す
    const etRegex = /\bET\b/g;
    etRegex.lastIndex = btStart + 2;
    const etMatch = etRegex.exec(content);
    if (!etMatch) break;
    const etEnd = etMatch.index + 2;

    // BT前のコンテンツをそのまま追加
    result.push(content.slice(lastIndex, btStart));

    // BTブロックを処理
    const btBlock = content.slice(btStart, etEnd);
    const processedBlock = processTextBlock(btBlock, redactRects, pageHeight);
    result.push(processedBlock);

    lastIndex = etEnd;
    btRegex.lastIndex = etEnd;
  }

  result.push(content.slice(lastIndex));
  return new TextEncoder().encode(result.join(''));
}

/**
 * BT...ETブロック内のテキストオペレーターを処理する。
 * テキスト位置を追跡し、墨消し対象領域と重なるテキストを削除する。
 */
function processTextBlock(
  block: string,
  redactRects: PdfRect[],
  pageHeight: number,
): string {
  // テキスト行列の状態を追跡
  let tx = 0, ty = 0;
  let tmA = 1, tmD = 1, tmE = 0, tmF = 0;
  let hasTm = false;

  const lines = block.split('\n');
  const outputLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // テキスト位置設定オペレーター
    const tdMatch = trimmed.match(/^([-\d.]+)\s+([-\d.]+)\s+Td$/);
    const tmMatch = trimmed.match(
      /^([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm$/,
    );

    if (tdMatch) {
      tx += parseFloat(tdMatch[1]);
      ty += parseFloat(tdMatch[2]);
      outputLines.push(line);
      continue;
    }

    if (tmMatch) {
      tmA = parseFloat(tmMatch[1]);
      tmD = parseFloat(tmMatch[4]);
      tmE = parseFloat(tmMatch[5]);
      tmF = parseFloat(tmMatch[6]);
      hasTm = true;
      tx = 0;
      ty = 0;
      outputLines.push(line);
      continue;
    }

    // テキスト描画オペレーター (Tj, TJ, ', ")
    const isTextOp =
      trimmed.endsWith(' Tj') ||
      trimmed.endsWith(' TJ') ||
      trimmed.endsWith(" '") ||
      trimmed.endsWith(' "');

    if (isTextOp) {
      // 現在のテキスト位置を計算
      let posX: number, posY: number;
      if (hasTm) {
        posX = tmA * tx + tmE;
        posY = tmD * ty + tmF;
      } else {
        posX = tx;
        posY = ty;
      }

      // おおよそのテキスト領域 (正確なサイズはフォントに依存するため、推定)
      const textRect: PdfRect = {
        x: posX,
        y: posY - 2,
        width: 500, // テキスト幅は推定
        height: 20, // 行の高さは推定
      };

      // ページ高さが指定されている場合、y座標はPDF座標系のまま
      void pageHeight;

      const shouldRedact = redactRects.some((r) => rectsOverlap(textRect, r));
      if (shouldRedact) {
        // テキストオペレーターを空文字列オペレーターに置換
        outputLines.push('() Tj');
      } else {
        outputLines.push(line);
      }
    } else {
      outputLines.push(line);
    }
  }

  return outputLines.join('\n');
}

/**
 * ContentStreamを取得しバイト列として返す
 */
function getStreamBytes(streamObj: unknown): Uint8Array | null {
  if (streamObj instanceof PDFRawStream) {
    return streamObj.getContents();
  }
  if (streamObj instanceof PDFFlateStream) {
    return streamObj.getContents();
  }
  // getContentsメソッドを持つオブジェクト
  if (streamObj && typeof (streamObj as Record<string, unknown>).getContents === 'function') {
    return (streamObj as { getContents(): Uint8Array }).getContents();
  }
  return null;
}

/** 墨消し処理を実行する */
export async function redactPdf(
  originalBytes: ArrayBuffer,
  redactionMap: Map<number, PdfRect[]>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(originalBytes);
  const pages = doc.getPages();

  for (const [pageNumOneBased, rects] of redactionMap) {
    if (rects.length === 0) continue;
    const pageIndex = pageNumOneBased - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;

    const page = pages[pageIndex];
    const { height: pageHeight } = page.getSize();

    // ContentStreamからテキストオペレーターを削除する
    const pageDict = page.node;
    const contentsRef = pageDict.get(PDFName.of('Contents'));

    if (contentsRef) {
      await processContents(doc, contentsRef, rects, pageHeight);
    }

    // 黒塗り矩形を描画
    for (const rect of rects) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        color: rgb(0, 0, 0),
      });
    }
  }

  // メタデータクリア
  cleanMetadata(doc);

  return doc.save();
}

/** Contents(単一またはArray)を処理する */
async function processContents(
  doc: PDFDocument,
  contentsRef: unknown,
  rects: PdfRect[],
  pageHeight: number,
): Promise<void> {
  if (contentsRef instanceof PDFRef) {
    const streamObj = doc.context.lookup(contentsRef);
    const bytes = getStreamBytes(streamObj);
    if (bytes) {
      const newBytes = removeTextOperatorsFromStream(bytes, rects, pageHeight);
      const newStream = doc.context.flateStream(newBytes);
      doc.context.assign(contentsRef, newStream);
    }
  } else if (contentsRef instanceof PDFArray) {
    for (let i = 0; i < contentsRef.size(); i++) {
      const ref = contentsRef.get(i);
      if (ref instanceof PDFRef) {
        const streamObj = doc.context.lookup(ref);
        const bytes = getStreamBytes(streamObj);
        if (bytes) {
          const newBytes = removeTextOperatorsFromStream(bytes, rects, pageHeight);
          const newStream = doc.context.flateStream(newBytes);
          doc.context.assign(ref, newStream);
        }
      }
    }
  }
}
