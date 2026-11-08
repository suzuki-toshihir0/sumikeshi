/**
 * 墨消しの全体の流れ。
 *
 * 1. 頁ごとに、ContentStream を 1 命令ずつ追い、範囲にかかる文字・パス・画像の画素を消す
 *    （Form XObject の中も同じ。content-redactor.ts）
 * 2. 範囲にかかる注釈（フォームの欄を含む）を消す
 * 3. 範囲に黒い四角を描く
 * 4. 文書全体から、情報が残りうるもの（メタデータ、構造の木、しおり、縮小画像、参照されないオブジェクト）を消す
 *
 * 安全に消せないもの（幅の分からないフォントで範囲にかかり得る文字、読めない形式の画像など）があれば、
 * 出力せずに RedactionError を投げる。
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, EncryptedPDFError } from 'pdf-lib';
import type { PdfRect } from '../utils/coordinates';
import { parseContentStream, type Operation } from './content/lexer';
import { serializeOperations } from './content/writer';
import { redactOperations, type RedactionContext, type RedactionStats } from './content-redactor';
import { IDENTITY } from './geometry';
import { ResourceEditor } from './resources';
import { removeOverlappingAnnotations, pruneFormFields } from './annotations';
import { sanitizeDocument } from './sanitize';
import { resolve, streamBytes } from './pdf-objects';
import { RedactionError } from './errors';
import type { CMapLoader } from './fonts/cmap';
import type { FontModel } from './fonts/font-model';

export { RedactionError };
export type { RedactionStats };

export interface RedactOptions {
  /** 定義済みの CMap（.bcmap）を読む関数。省略時はブラウザで cmaps/ から読む */
  cmapLoader?: CMapLoader;
  /** 処理の結果の数を受け取る */
  onStats?: (stats: RedactionStats) => void;
}

function defaultCMapLoader(): CMapLoader | undefined {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return undefined;
  const base = `${import.meta.env.BASE_URL}cmaps/`;
  return async (name: string) => {
    const res = await fetch(`${base}${name}.bcmap`);
    if (!res.ok) throw new Error(`CMap ${name} を読めない（${res.status}）`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** 幅や高さが負の矩形を直し、面積の無いものを除く */
function normalizeRects(rects: PdfRect[]): PdfRect[] {
  return rects
    .map((r) => ({
      x: Math.min(r.x, r.x + r.width),
      y: Math.min(r.y, r.y + r.height),
      width: Math.abs(r.width),
      height: Math.abs(r.height),
    }))
    .filter((r) => r.width > 0 && r.height > 0 && [r.x, r.y, r.width, r.height].every(Number.isFinite));
}

/** 頁の属性を、親（Pages）から受け継いだものも含めて引く */
function inheritedAttr(page: PDFDict, key: string, doc: PDFDocument): unknown {
  let node: PDFDict | undefined = page;
  for (let i = 0; node && i < 64; i++) {
    const v = node.get(PDFName.of(key));
    if (v !== undefined) return resolve(doc.context, v);
    const parent = resolve(doc.context, node.get(PDFName.of('Parent')));
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/** 頁の ContentStream（配列なら連結）を読む */
function pageContentBytes(doc: PDFDocument, page: PDFDict): Uint8Array {
  const contents = resolve(doc.context, page.get(PDFName.of('Contents')));
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = resolve(doc.context, contents.get(i));
      if (s instanceof PDFStream) streams.push(s);
    }
  }
  const parts = streams.map((s) => streamBytes(doc.context, s));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
    out[pos++] = 0x0a; // ストリームの境目で字句が続かないように
  }
  return out;
}

/** q / Q の釣り合いを取りつつ、元の中身を q ... Q で囲む */
function wrapBalanced(ops: Operation[]): Operation[] {
  let depth = 0;
  let minDepth = 0;
  for (const o of ops) {
    if (o.op === 'q') depth++;
    else if (o.op === 'Q') {
      depth--;
      minDepth = Math.min(minDepth, depth);
    }
  }
  const pre = 1 - minDepth;
  const post = depth + pre;
  return [
    ...Array.from({ length: pre }, () => ({ op: 'q', operands: [] })),
    ...ops,
    ...Array.from({ length: Math.max(post, 0) }, () => ({ op: 'Q', operands: [] })),
  ];
}

function blackBoxes(rects: PdfRect[]): Operation[] {
  const n = (value: number) => ({ type: 'number' as const, value });
  return [
    { op: 'q', operands: [] },
    { op: 'g', operands: [n(0)] },
    ...rects.map((r) => ({ op: 're', operands: [n(r.x), n(r.y), n(r.width), n(r.height)] })),
    { op: 'f', operands: [] },
    { op: 'Q', operands: [] },
  ];
}

/** 墨消し処理を実行する */
export async function redactPdf(
  originalBytes: ArrayBuffer,
  redactionMap: Map<number, PdfRect[]>,
  options: RedactOptions = {},
): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(originalBytes, { updateMetadata: false });
  } catch (e) {
    // pdf-lib の読み込み方によってはクラスが別物になるので、名前と文言でも見る
    if (e instanceof EncryptedPDFError || (e as Error).name === 'EncryptedPDFError' || /is encrypted/.test((e as Error).message)) {
      throw new RedactionError('暗号化された PDF は墨消しできません。パスワードを外してから読み込んでください。');
    }
    throw new RedactionError(`PDF を読めません（${(e as Error).message}）。`);
  }
  if (doc.isEncrypted) {
    throw new RedactionError('暗号化された PDF は墨消しできません。パスワードを外してから読み込んでください。');
  }

  const ctx = doc.context;
  let pages;
  try {
    pages = doc.getPages();
  } catch (e) {
    // 頁の木が循環しているなど、壊れた PDF
    throw new RedactionError(`PDF の頁の作りが壊れていて読めません（${(e as Error).message}）。`);
  }
  const stats: RedactionStats = { glyphsRemoved: 0, imagesRedacted: 0, pathsRemoved: 0, pathsTrimmed: 0, formsRewritten: 0 };
  const fontCache = new Map<PDFDict, Promise<FontModel>>();
  const cmapLoader = options.cmapLoader ?? defaultCMapLoader();
  const removedWidgets = new Set<PDFDict>();

  for (const [pageNumber, rawRects] of redactionMap) {
    const rects = normalizeRects(rawRects);
    if (rects.length === 0) continue;
    const pageIndex = pageNumber - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;
    const page = pages[pageIndex].node;

    let ops: Operation[];
    try {
      ops = parseContentStream(pageContentBytes(doc, page));
    } catch (e) {
      throw new RedactionError(`${pageNumber} 頁の中身を読めません（${(e as Error).message}）。`);
    }

    const resDict = inheritedAttr(page, 'Resources', doc);
    const resources = new ResourceEditor(ctx, resDict instanceof PDFDict ? resDict : undefined);
    const rc: RedactionContext = {
      ctx, rects, cmapLoader, fontCache, stats, formStack: new Set(), pageNumber,
    };
    const result = await redactOperations(rc, ops, resources, IDENTITY);

    const newOps = [...wrapBalanced(result.ops), ...blackBoxes(rects)];
    page.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(serializeOperations(newOps))));
    if (resources.dict) page.set(PDFName.of('Resources'), resources.dict);

    for (const a of removeOverlappingAnnotations(ctx, page, rects)) removedWidgets.add(a);
  }

  if (removedWidgets.size > 0) pruneFormFields(ctx, doc.catalog, removedWidgets);
  sanitizeDocument(doc);
  options.onStats?.(stats);
  return doc.save({ updateFieldAppearances: false, addDefaultPage: false });
}
