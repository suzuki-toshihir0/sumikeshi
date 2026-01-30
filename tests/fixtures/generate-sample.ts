/**
 * テスト用PDFを生成するスクリプト
 * 実行: npx tsx tests/fixtures/generate-sample.ts
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function generateSamplePdf(): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // ページ1: テキストを含むページ
  const page1 = doc.addPage([595, 842]); // A4
  page1.setFont(font);

  page1.drawText('This is public information.', {
    x: 50,
    y: 750,
    size: 16,
    color: rgb(0, 0, 0),
  });

  page1.drawText('SECRET: confidential data here', {
    x: 50,
    y: 700,
    size: 16,
    color: rgb(0, 0, 0),
  });

  page1.drawText('More public text below.', {
    x: 50,
    y: 650,
    size: 16,
    color: rgb(0, 0, 0),
  });

  // ページ2
  const page2 = doc.addPage([595, 842]);
  page2.setFont(font);

  page2.drawText('Page 2 content.', {
    x: 50,
    y: 750,
    size: 16,
    color: rgb(0, 0, 0),
  });

  // メタデータ設定
  doc.setTitle('Sample PDF');
  doc.setAuthor('Test Author');
  doc.setSubject('Test Subject');

  const bytes = await doc.save();
  writeFileSync(`${__dirname}/sample.pdf`, bytes);
  console.log('sample.pdf generated');
}

generateSamplePdf().catch(console.error);
