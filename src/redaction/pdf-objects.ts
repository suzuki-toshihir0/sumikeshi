/** pdf-lib のオブジェクトを、参照を解決しつつ型ごとに取り出す小さな道具 */
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, PDFRawStream, PDFStream, PDFBool,
  PDFString, PDFHexString, PDFContext, decodePDFRawStream,
} from 'pdf-lib';
import { decodeStreamData } from './images/filters';

export function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  let cur = o;
  for (let i = 0; i < 32 && cur instanceof PDFRef; i++) cur = ctx.lookup(cur);
  return cur instanceof PDFRef ? undefined : cur;
}

export function get(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!d) return undefined;
  return resolve(ctx, d.get(PDFName.of(key)));
}

export function getNum(ctx: PDFContext, d: PDFDict | undefined, key: string): number | undefined {
  const o = get(ctx, d, key);
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

export function getName(ctx: PDFContext, d: PDFDict | undefined, key: string): string | undefined {
  const o = get(ctx, d, key);
  return o instanceof PDFName ? o.decodeText() : undefined;
}

export function getBool(ctx: PDFContext, d: PDFDict | undefined, key: string): boolean | undefined {
  const o = get(ctx, d, key);
  return o instanceof PDFBool ? o.asBoolean() : undefined;
}

export function getArray(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFArray | undefined {
  const o = get(ctx, d, key);
  return o instanceof PDFArray ? o : undefined;
}

/** 辞書（ストリームなら、その辞書）を返す */
export function getDict(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFDict | undefined {
  const o = get(ctx, d, key);
  if (o instanceof PDFDict) return o;
  if (o instanceof PDFStream) return o.dict;
  return undefined;
}

export function getStream(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFStream | undefined {
  const o = get(ctx, d, key);
  return o instanceof PDFStream ? o : undefined;
}

export function numbersOf(ctx: PDFContext, a: PDFArray | undefined): number[] {
  if (!a) return [];
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = resolve(ctx, a.get(i));
    out.push(v instanceof PDFNumber ? v.asNumber() : NaN);
  }
  return out;
}

export function nameOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

export function stringBytes(o: PDFObject | undefined): Uint8Array | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes();
  return undefined;
}

/** ストリームの中身を、フィルターをすべて外して返す */
export function streamBytes(ctx: PDFContext, s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) {
    return decodeStreamData(ctx, s.dict, s.getContents());
  }
  // pdf-lib が作ったストリーム（PDFContentStream など）
  const raw = s as unknown as { getContents?: () => Uint8Array; getUnencodedContents?: () => Uint8Array };
  if (typeof raw.getUnencodedContents === 'function') return raw.getUnencodedContents();
  if (typeof raw.getContents === 'function') {
    return decodeStreamData(ctx, s.dict, raw.getContents());
  }
  throw new Error('ストリームの中身を読めない');
}

export { decodePDFRawStream };
