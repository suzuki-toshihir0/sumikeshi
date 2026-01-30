import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { cleanMetadata } from '../../src/redaction/metadata-cleaner';

describe('cleanMetadata', () => {
  it('メタデータをクリアする', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Secret Title');
    doc.setAuthor('Secret Author');
    doc.setSubject('Secret Subject');
    doc.setCreator('Secret Creator');
    doc.setProducer('Secret Producer');
    doc.setKeywords(['secret', 'keyword']);
    doc.addPage();

    cleanMetadata(doc);

    expect(doc.getTitle()).toBeFalsy();
    expect(doc.getAuthor()).toBeFalsy();
    expect(doc.getSubject()).toBeFalsy();
    expect(doc.getCreator()).toBeFalsy();
    expect(doc.getProducer()).toBeFalsy();
    expect(doc.getKeywords()).toBeFalsy();
  });
});
