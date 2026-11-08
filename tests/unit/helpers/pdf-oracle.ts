/**
 * 墨消しの結果を、sumikeshi の実装とは独立に確かめるための道具。
 * pdf.js（Node 用の legacy ビルド）で PDF を開き、取り出せる文字・画像・パスを調べる。
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export interface Box { x: number; y: number; width: number; height: number }

export interface TextGlyphRun {
  str: string;
  /** 文字列の外接矩形（PDF の既定のユーザー空間） */
  box: Box;
}

async function open(bytes: Uint8Array) {
  return pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: root + 'node_modules/pdfjs-dist/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: root + 'node_modules/pdfjs-dist/standard_fonts/',
    isOffscreenCanvasSupported: false,
    verbosity: 0,
  }).promise;
}

/** 頁から取り出せる文字列と、その位置 */
export async function extractText(bytes: Uint8Array, pageNo = 1): Promise<TextGlyphRun[]> {
  const doc = await open(bytes);
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent({ includeMarkedContent: false });
  const out: TextGlyphRun[] = [];
  for (const item of tc.items as { str: string; transform: number[]; width: number; height: number }[]) {
    if (!item.str) continue;
    const [a, b, , , e, f] = item.transform;
    const size = Math.hypot(a, b) || item.height;
    // Chrome の PDF などは、漢字を康熙部首の文字（⼈ など）に対応づけていることがあるので NFKC でそろえる
    out.push({ str: item.str.normalize('NFKC'), box: { x: e, y: f - size * 0.2, width: item.width, height: size } });
  }
  await doc.destroy();
  return out;
}

/** 頁から取り出せる文字をすべてつなげたもの */
export async function allText(bytes: Uint8Array, pageNo = 1): Promise<string> {
  return (await extractText(bytes, pageNo)).map((t) => t.str).join('');
}

/** 文書全体から取り出せる文字（全頁） */
export async function documentText(bytes: Uint8Array): Promise<string> {
  const doc = await open(bytes);
  let s = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    s += (tc.items as { str?: string }[]).map((t) => (t.str ?? '').normalize('NFKC')).join('');
  }
  await doc.destroy();
  return s;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** 画素ごとの灰色の明るさ（0〜255）。色付きは平均を取る */
  gray: (x: number, y: number) => number;
  /** 画像を頁に置いた変換行列（画像の単位正方形 → ユーザー空間） */
  ctm: number[];
}

function multiply(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** 頁に描かれる画像を、pdf.js で復号して取り出す */
export async function extractImages(bytes: Uint8Array, pageNo = 1): Promise<DecodedImage[]> {
  const doc = await open(bytes);
  const page = await doc.getPage(pageNo);
  const ops = await page.getOperatorList();
  const out: DecodedImage[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === pdfjs.OPS.save) stack.push(ctm);
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === pdfjs.OPS.transform) ctm = multiply(args as number[], ctm);
    else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = multiply(args[0] as number[], ctm);
    } else if (fn === pdfjs.OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) {
      let img: { width: number; height: number; kind?: number; data: Uint8Array | Uint8ClampedArray };
      if (fn === pdfjs.OPS.paintImageXObject) {
        const id = args[0] as string;
        img = await new Promise((r) => (id.startsWith('g_') ? page.commonObjs : page.objs).get(id, r));
      } else {
        img = args[0] as typeof img;
      }
      out.push(toDecoded(img, fn === pdfjs.OPS.paintImageMaskXObject, [...ctm]));
    }
  }
  await doc.destroy();
  return out;
}

function toDecoded(
  img: { width: number; height: number; kind?: number; data: Uint8Array | Uint8ClampedArray },
  isMask: boolean,
  ctm: number[],
): DecodedImage {
  const { width, height, data } = img;
  if (isMask) {
    // 1bit。1 の画素が「塗らない」側（pdf.js は Decode を反映済み）
    const rowBytes = Math.ceil(width / 8);
    return { width, height, ctm, gray: (x, y) => ((data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0) };
  }
  if (img.kind === 1) {
    const rowBytes = Math.ceil(width / 8);
    return { width, height, ctm, gray: (x, y) => ((data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0) };
  }
  const comps = img.kind === 2 ? 3 : 4;
  return {
    width, height, ctm,
    gray: (x, y) => {
      const p = (y * width + x) * comps;
      return Math.round((data[p] + data[p + 1] + data[p + 2]) / 3);
    },
  };
}

/** 画像の画素 (x, y) の中心が、頁のどこに来るか */
export function pixelCenterOnPage(img: DecodedImage, x: number, y: number): [number, number] {
  const u = (x + 0.5) / img.width;
  const v = 1 - (y + 0.5) / img.height;
  const m = img.ctm;
  return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
}

export function inside(p: [number, number], r: Box): boolean {
  return p[0] >= r.x && p[0] <= r.x + r.width && p[1] >= r.y && p[1] <= r.y + r.height;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 頁で描かれるパス（線・塗り）の外接矩形の一覧 */
export async function extractPathBoxes(bytes: Uint8Array, pageNo = 1): Promise<Box[]> {
  const doc = await open(bytes);
  const page = await doc.getPage(pageNo);
  const ops = await page.getOperatorList();
  const out: Box[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === pdfjs.OPS.save) stack.push(ctm);
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === pdfjs.OPS.transform) ctm = multiply(args as number[], ctm);
    else if (fn === pdfjs.OPS.constructPath) {
      const minMax = args[2] as number[] | Float32Array;
      if (!minMax) continue;
      const [x0, y0, x1, y1] = Array.from(minMax);
      const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [
        ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5],
      ]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      out.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    }
  }
  await doc.destroy();
  return out;
}

/** 頁の注釈の一覧（種類と中身） */
export async function extractAnnotations(bytes: Uint8Array, pageNo = 1) {
  const doc = await open(bytes);
  const page = await doc.getPage(pageNo);
  const annots = (await page.getAnnotations()) as { subtype: string; contentsObj?: { str: string }; fieldValue?: unknown; rect: number[] }[];
  await doc.destroy();
  return annots.map((a) => ({ subtype: a.subtype, contents: a.contentsObj?.str ?? '', fieldValue: a.fieldValue, rect: a.rect }));
}

/** しおり・メタデータ */
export async function extractDocumentInfo(bytes: Uint8Array) {
  const doc = await open(bytes);
  const outline = await doc.getOutline();
  const meta = await doc.getMetadata();
  await doc.destroy();
  return { outlineTitles: (outline ?? []).map((o: { title: string }) => o.title), info: meta.info, xmp: meta.metadata?.getRaw?.() ?? null };
}
