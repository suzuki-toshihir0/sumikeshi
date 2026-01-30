import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  decodePDFRawStream,
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
 * 小さな矩形群をマージして、重なり合う矩形をまとめる。
 * テキスト選択では文字単位の小さな矩形が大量に生成されるため、
 * これらを行単位の大きな矩形にまとめることで、
 * ContentStream内のテキスト位置との照合精度を向上させる。
 */
function mergeRects(rects: PdfRect[]): PdfRect[] {
  if (rects.length === 0) return [];

  // y座標（行）が近い矩形をグループ化してマージする
  const sorted = [...rects].sort((a, b) => a.y - b.y);
  const merged: PdfRect[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    // y座標が近く(同じ行)、x方向で重なりまたは隣接している場合マージ
    const yOverlap =
      current.y < r.y + r.height &&
      current.y + current.height > r.y;
    const xClose =
      current.x < r.x + r.width + 5 &&
      current.x + current.width + 5 > r.x;

    if (yOverlap && xClose) {
      const minX = Math.min(current.x, r.x);
      const minY = Math.min(current.y, r.y);
      const maxX = Math.max(current.x + current.width, r.x + r.width);
      const maxY = Math.max(current.y + current.height, r.y + r.height);
      current = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    } else {
      merged.push(current);
      current = { ...r };
    }
  }
  merged.push(current);
  return merged;
}

/**
 * ContentStreamバイナリからテキスト描画オペレーターを削除する。
 *
 * BT...ETブロック内のTmオペレーターでテキスト位置を追跡し、
 * 墨消し領域と重なるテキストオペレーターを空に置換する。
 */
function removeTextOperatorsFromStream(
  streamBytes: Uint8Array,
  redactRects: PdfRect[],
  _pageHeight: number,
): Uint8Array {
  const content = new TextDecoder('latin1').decode(streamBytes);

  // BT...ETブロックを探して処理する
  const result: string[] = [];
  let lastIndex = 0;

  // BT...ETブロックをネストなしで検出
  const btEtRegex = /\bBT\b([\s\S]*?)\bET\b/g;
  let match: RegExpExecArray | null;
  while ((match = btEtRegex.exec(content)) !== null) {
    // BT前のコンテンツをそのまま追加
    result.push(content.slice(lastIndex, match.index));

    // BTブロック内を処理
    const blockContent = match[1];
    const processedBlock = processTextBlock(blockContent, redactRects);
    result.push('BT');
    result.push(processedBlock);
    result.push('ET');

    lastIndex = match.index + match[0].length;
  }

  result.push(content.slice(lastIndex));
  return new TextEncoder().encode(result.join(''));
}

/**
 * BT...ETブロック内のテキストオペレーターを処理する。
 *
 * テキスト行列(Tm)とテキスト位置(Td, TD)を追跡し、
 * フォントサイズ(Tf)を考慮して、テキストの位置を推定する。
 * 墨消し領域と重なるテキスト描画オペレーターのみを空に置換する。
 */
function processTextBlock(
  blockContent: string,
  redactRects: PdfRect[],
): string {
  // テキスト状態
  let fontSize = 12;
  // テキスト行列: [a, b, c, d, e, f] — 位置は (e, f)
  let tmE = 0, tmF = 0;
  let lineX = 0, lineY = 0;

  // オペレーターを1つずつ処理するためにトークン化
  // PDFのContentStreamはスタックベース: オペランド... オペレーター
  const tokens = tokenize(blockContent);
  const outputTokens: string[] = [];
  const operandStack: string[] = [];

  for (const token of tokens) {
    if (isOperator(token)) {
      const operands = operandStack.splice(0);

      switch (token) {
        case 'Tf': {
          // フォント名 サイズ Tf
          if (operands.length >= 2) {
            fontSize = Math.abs(parseFloat(operands[operands.length - 1]));
          }
          outputTokens.push([...operands, token].join(' '));
          break;
        }
        case 'Tm': {
          // a b c d e f Tm
          if (operands.length >= 6) {
            tmE = parseFloat(operands[4]);
            tmF = parseFloat(operands[5]);
            lineX = tmE;
            lineY = tmF;
          }
          outputTokens.push([...operands, token].join(' '));
          break;
        }
        case 'Td':
        case 'TD': {
          // tx ty Td
          if (operands.length >= 2) {
            const tx = parseFloat(operands[0]);
            const ty = parseFloat(operands[1]);
            lineX += tx;
            lineY += ty;
            tmE = lineX;
            tmF = lineY;
          }
          outputTokens.push([...operands, token].join(' '));
          break;
        }
        case 'T*': {
          // 次の行に移動 (TL分だけ下に移動)
          outputTokens.push(token);
          break;
        }
        case 'Tj':
        case 'TJ':
        case "'":
        case '"': {
          // テキスト描画オペレーター
          // オペランドからテキスト幅を推定
          const estWidth = estimateTextWidth(operands, fontSize);
          const textRect: PdfRect = {
            x: tmE,
            y: tmF - fontSize * 0.2,
            width: estWidth,
            height: fontSize * 1.2,
          };

          const shouldRedact = redactRects.some((r) => rectsOverlap(textRect, r));
          if (shouldRedact) {
            // テキストオペレーターを空文字列に置換
            outputTokens.push('() Tj');
          } else {
            outputTokens.push([...operands, token].join(' '));
          }
          break;
        }
        default:
          outputTokens.push([...operands, token].join(' '));
          break;
      }
    } else {
      operandStack.push(token);
    }
  }

  // 残ったオペランドをそのまま出力
  if (operandStack.length > 0) {
    outputTokens.push(operandStack.join(' '));
  }

  return '\n' + outputTokens.join('\n') + '\n';
}

/**
 * テキストオペランドから描画幅を推定する。
 * hex文字列 <...> の場合はバイト数÷2が文字数。
 * 文字列リテラル (...) の場合は文字数をカウント。
 * TJ配列 [...] の場合は配列内の文字列の合計。
 * 平均文字幅はフォントサイズの約0.6倍と仮定。
 */
function estimateTextWidth(operands: string[], fontSize: number): number {
  const avgCharWidth = fontSize * 0.6;
  let charCount = 0;

  for (const op of operands) {
    if (op.startsWith('<') && op.endsWith('>') && !op.startsWith('<<')) {
      // hex文字列: 2桁で1バイト = 1文字
      charCount += (op.length - 2) / 2;
    } else if (op.startsWith('(') && op.endsWith(')')) {
      // 文字列リテラル: エスケープを考慮しつつ文字数を数える
      let count = 0;
      for (let i = 1; i < op.length - 1; i++) {
        if (op[i] === '\\') { i++; }
        count++;
      }
      charCount += count;
    } else if (op.startsWith('[') && op.endsWith(']')) {
      // TJ配列: 文字列要素の合計
      const inner = op.slice(1, -1);
      const strMatches = inner.match(/<[0-9A-Fa-f]*>|\([^)]*\)/g);
      if (strMatches) {
        for (const m of strMatches) {
          if (m.startsWith('<')) {
            charCount += (m.length - 2) / 2;
          } else if (m.startsWith('(')) {
            charCount += m.length - 2;
          }
        }
      }
    }
  }

  return Math.max(charCount * avgCharWidth, fontSize);
}

/** PDFのContentStreamトークンかオペレーターかを判定 */
function isOperator(token: string): boolean {
  // PDFオペレーターは英字のみで構成される（ただし ' と " もオペレーター）
  if (token === "'" || token === '"') return true;
  if (token === 'T*') return true;
  return /^[A-Za-z*]+$/.test(token) && !/^[0-9]/.test(token);
}

/**
 * ContentStreamをトークンに分割する。
 * 文字列リテラル(...)やhex文字列<...>、配列[...]を1つのトークンとして扱う。
 */
function tokenize(content: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = content.length;

  while (i < len) {
    // 空白スキップ
    if (/\s/.test(content[i])) {
      i++;
      continue;
    }

    // コメント
    if (content[i] === '%') {
      while (i < len && content[i] !== '\n' && content[i] !== '\r') i++;
      continue;
    }

    // 文字列リテラル (...)
    if (content[i] === '(') {
      let depth = 1;
      let str = '(';
      i++;
      while (i < len && depth > 0) {
        if (content[i] === '\\') {
          str += content[i] + (content[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (content[i] === '(') depth++;
        if (content[i] === ')') depth--;
        str += content[i];
        i++;
      }
      tokens.push(str);
      continue;
    }

    // hex文字列 <...>
    if (content[i] === '<' && content[i + 1] !== '<') {
      let str = '<';
      i++;
      while (i < len && content[i] !== '>') {
        str += content[i];
        i++;
      }
      str += '>';
      i++;
      tokens.push(str);
      continue;
    }

    // 辞書 << ... >>
    if (content[i] === '<' && content[i + 1] === '<') {
      let str = '<<';
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (content[i] === '<' && content[i + 1] === '<') {
          depth++;
          str += '<<';
          i += 2;
          continue;
        }
        if (content[i] === '>' && content[i + 1] === '>') {
          depth--;
          str += '>>';
          i += 2;
          continue;
        }
        str += content[i];
        i++;
      }
      tokens.push(str);
      continue;
    }

    // 配列 [...]
    if (content[i] === '[') {
      let depth = 1;
      let str = '[';
      i++;
      while (i < len && depth > 0) {
        if (content[i] === '(') {
          // 配列内の文字列リテラル
          let subDepth = 1;
          str += '(';
          i++;
          while (i < len && subDepth > 0) {
            if (content[i] === '\\') {
              str += content[i] + (content[i + 1] ?? '');
              i += 2;
              continue;
            }
            if (content[i] === '(') subDepth++;
            if (content[i] === ')') subDepth--;
            str += content[i];
            i++;
          }
          continue;
        }
        if (content[i] === '[') depth++;
        if (content[i] === ']') depth--;
        str += content[i];
        i++;
      }
      tokens.push(str);
      continue;
    }

    // 名前 /Name
    if (content[i] === '/') {
      let str = '/';
      i++;
      while (i < len && !/[\s/<>\[\]()%]/.test(content[i])) {
        str += content[i];
        i++;
      }
      tokens.push(str);
      continue;
    }

    // 数値またはオペレーター
    {
      let str = '';
      while (i < len && !/[\s/<>\[\]()%]/.test(content[i])) {
        str += content[i];
        i++;
      }
      if (str.length > 0) {
        tokens.push(str);
      }
    }
  }

  return tokens;
}

/**
 * ContentStreamをデコードしてバイト列として返す。
 * Flate圧縮されたストリームはdecodePDFRawStreamでデコードする。
 */
function getStreamBytes(streamObj: unknown): Uint8Array | null {
  if (streamObj instanceof PDFRawStream) {
    try {
      const decoded = decodePDFRawStream(streamObj);
      return decoded.decode();
    } catch {
      return streamObj.getContents();
    }
  }
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

    // 小さな矩形をマージ
    const mergedRects = mergeRects(rects);

    // ContentStreamからテキストオペレーターを削除する
    const pageDict = page.node;
    const contentsRef = pageDict.get(PDFName.of('Contents'));

    if (contentsRef) {
      processContents(doc, contentsRef, mergedRects, pageHeight);
    }

    // 黒塗り矩形を描画（マージ済み矩形を使用）
    for (const rect of mergedRects) {
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
function processContents(
  doc: PDFDocument,
  contentsRef: unknown,
  rects: PdfRect[],
  pageHeight: number,
): void {
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

