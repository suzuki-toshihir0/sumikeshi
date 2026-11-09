/**
 * 出力の PDF を pdf-lib で開き直し、すべての間接オブジェクトを調べて、
 * ストリームの中身（展開したもの）と、辞書・配列の中の文字列・名前に、探す値が無いかを返す。
 * pdf-lib は保存のときに辞書を圧縮したオブジェクトストリームに入れるので、ファイルのバイト列を探すだけでは足りない。
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRawStream, PDFStream, PDFString, decodePDFRawStream,
} from 'pdf-lib';

export async function findEverywhere(pdf: Uint8Array, needle: Uint8Array | string): Promise<string[]> {
  const n = Buffer.from(needle);
  const text = typeof needle === 'string' ? needle : null;
  const hits: string[] = [];
  if (Buffer.from(pdf).includes(n)) hits.push('ファイルのバイト列');
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const visit = (o: PDFObject | undefined, where: string, depth = 0) => {
    if (!o || depth > 64) return;
    if (o instanceof PDFString || o instanceof PDFHexString) {
      const bytes = Buffer.from(o.asBytes());
      if (bytes.includes(n) || (text !== null && o.decodeText().includes(text))) hits.push(`${where} の文字列`);
    } else if (o instanceof PDFName) {
      if (text !== null && o.decodeText().includes(text)) hits.push(`${where} の名前`);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) visit(o.get(i), where, depth + 1);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) visit(v, where, depth + 1);
    } else if (o instanceof PDFStream) {
      visit(o.dict, where, depth + 1);
      if (o instanceof PDFRawStream) {
        let data: Uint8Array | null = null;
        try {
          data = decodePDFRawStream(o).decode();
        } catch {
          data = o.getContents();
        }
        if (Buffer.from(data).includes(n)) hits.push(`${where} のストリーム`);
      }
    }
  };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) visit(obj, ref.toString());
  return hits;
}
