/**
 * ストリームのフィルター（圧縮）を外す。
 * 汎用のフィルター（Flate, LZW, ASCIIHex, ASCII85, RunLength）は pdf-lib の復号器を使い、
 * pdf-lib が扱わない予測子（Predictor）はここで戻す。
 * 画像専用のフィルター（DCT, JPX, JBIG2, CCITTFax）は images/decode-image.ts で扱う。
 */
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFContext, decodePDFRawStream, PDFRef,
} from 'pdf-lib';

export const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);

/** インライン画像の略記を正式名に */
export const FILTER_ABBREVIATIONS: Record<string, string> = {
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode',
  RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
};

export class UnsupportedFilterError extends Error {}

function deref(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

export interface FilterStep {
  name: string;
  params: PDFDict | undefined;
}

/** 辞書の Filter / DecodeParms を、順に並べる */
export function filterSteps(ctx: PDFContext, dict: PDFDict): FilterStep[] {
  const f = deref(ctx, dict.get(PDFName.of('Filter')) ?? dict.get(PDFName.of('F')));
  const p = deref(ctx, dict.get(PDFName.of('DecodeParms')) ?? dict.get(PDFName.of('DP')));
  const names: string[] = [];
  if (f instanceof PDFName) names.push(f.decodeText());
  else if (f instanceof PDFArray) {
    for (let i = 0; i < f.size(); i++) {
      const n = deref(ctx, f.get(i));
      if (n instanceof PDFName) names.push(n.decodeText());
    }
  }
  return names.map((name, i) => {
    let params: PDFObject | undefined;
    if (p instanceof PDFArray) params = deref(ctx, p.get(i));
    else if (i === 0 || names.length === 1) params = p;
    return { name: FILTER_ABBREVIATIONS[name] ?? name, params: params instanceof PDFDict ? params : undefined };
  });
}

/** 汎用フィルターを 1 段外す */
export function applyGenericFilter(ctx: PDFContext, step: FilterStep, data: Uint8Array): Uint8Array {
  if (IMAGE_FILTERS.has(step.name)) {
    throw new UnsupportedFilterError(`画像用のフィルター ${step.name} は、ここでは外せない`);
  }
  const known = ['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode'];
  if (!known.includes(step.name)) {
    throw new UnsupportedFilterError(`対応していないフィルター ${step.name}`);
  }
  const d = ctx.obj({}) as PDFDict;
  d.set(PDFName.of('Filter'), PDFName.of(step.name));
  if (step.params) d.set(PDFName.of('DecodeParms'), step.params);
  let out = decodePDFRawStream(PDFRawStream.of(d, data)).decode();
  if ((step.name === 'FlateDecode' || step.name === 'LZWDecode') && step.params) {
    out = undoPredictor(ctx, step.params, out);
  }
  return out;
}

/** フィルターをすべて外す（画像用のフィルターがあれば例外） */
export function decodeStreamData(ctx: PDFContext, dict: PDFDict, data: Uint8Array): Uint8Array {
  let out = data;
  for (const step of filterSteps(ctx, dict)) out = applyGenericFilter(ctx, step, out);
  return out;
}

function numParam(ctx: PDFContext, params: PDFDict, key: string, def: number): number {
  const v = deref(ctx, params.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : def;
}

/** PNG / TIFF の予測子を戻す（ISO 32000-1 7.4.4.4） */
export function undoPredictor(ctx: PDFContext, params: PDFDict, data: Uint8Array): Uint8Array {
  const predictor = numParam(ctx, params, 'Predictor', 1);
  if (predictor <= 1) return data;
  const colors = numParam(ctx, params, 'Colors', 1);
  const bpc = numParam(ctx, params, 'BitsPerComponent', 8);
  const columns = numParam(ctx, params, 'Columns', 1);
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    // TIFF の予測子 2
    const out = data.slice();
    const rows = Math.floor(out.length / rowBytes);
    if (bpc === 8) {
      for (let r = 0; r < rows; r++) {
        const base = r * rowBytes;
        for (let i = bytesPerPixel; i < rowBytes; i++) out[base + i] = (out[base + i] + out[base + i - bytesPerPixel]) & 0xff;
      }
      return out;
    }
    if (bpc === 16) {
      for (let r = 0; r < rows; r++) {
        const base = r * rowBytes;
        for (let i = 2 * colors; i + 1 < rowBytes; i += 2) {
          const prev = (out[base + i - 2 * colors] << 8) | out[base + i - 2 * colors + 1];
          const cur = ((out[base + i] << 8) | out[base + i + 1]) + prev;
          out[base + i] = (cur >> 8) & 0xff;
          out[base + i + 1] = cur & 0xff;
        }
      }
      return out;
    }
    // 1, 2, 4 bit
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes;
      const vals: number[] = [];
      const mask = (1 << bpc) - 1;
      for (let k = 0; k < columns * colors; k++) {
        const bit = k * bpc;
        vals.push((out[base + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask);
      }
      for (let k = colors; k < vals.length; k++) vals[k] = (vals[k] + vals[k - colors]) & mask;
      out.fill(0, base, base + rowBytes);
      for (let k = 0; k < vals.length; k++) {
        const bit = k * bpc;
        out[base + (bit >> 3)] |= vals[k] << (8 - bpc - (bit & 7));
      }
    }
    return out;
  }

  // PNG の予測子（10〜15）。各行の先頭 1 バイトがその行の方式
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  const prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const src = r * (rowBytes + 1);
    const type = data[src];
    const cur = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[src + 1 + i];
      const left = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0;
      const up = prev[i];
      const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
      let v: number;
      switch (type) {
        case 0: v = raw; break;
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: v = raw;
      }
      cur[i] = v & 0xff;
    }
    prev.set(cur);
  }
  return out;
}
