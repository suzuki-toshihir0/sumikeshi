import { PDFDocument } from 'pdf-lib';

/** PDFのメタデータを全てクリアする */
export function cleanMetadata(doc: PDFDocument): void {
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setProducer('');
  doc.setCreator('');

  // Info辞書の追加エントリもクリア
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef) {
    const infoDict = doc.context.lookup(infoRef) as unknown as
      { delete?(key: unknown): void; entries?(): [unknown, unknown][] } | undefined;
    if (infoDict && typeof infoDict.delete === 'function' && typeof infoDict.entries === 'function') {
      for (const [key] of infoDict.entries()) {
        infoDict.delete(key);
      }
    }
  }
}
