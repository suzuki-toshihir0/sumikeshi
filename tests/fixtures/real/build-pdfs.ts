/**
 * generate.sh で作った画像から、スキャンの PDF の形の試験用素材を作る。
 * 実行: npx tsx tests/fixtures/real/build-pdfs.ts
 *
 * 画像は 800x300 画素。頁 (A4) の (50, 500) から 400x150pt に置く（144dpi 相当）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib';

const dir = dirname(fileURLToPath(import.meta.url));
const PLACE = { x: 50, y: 500, width: 400, height: 150 };

async function jbig2(): Promise<void> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const globals = doc.context.register(doc.context.stream(readFileSync(join(dir, 'jb2.sym'))));
  const image = doc.context.register(doc.context.stream(readFileSync(join(dir, 'jb2.0000')), {
    Type: 'XObject', Subtype: 'Image', Width: 800, Height: 300,
    ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'JBIG2Decode',
    DecodeParms: { JBIG2Globals: globals },
  }));
  page.node.setXObject(PDFName.of('Im0'), image);
  const content = `q ${PLACE.width} 0 0 ${PLACE.height} ${PLACE.x} ${PLACE.y} cm /Im0 Do Q`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  writeFileSync(join(dir, 'jbig2.pdf'), await doc.save({ useObjectStreams: false }));
}

async function jpeg(): Promise<void> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const img = await doc.embedJpg(new Uint8Array(readFileSync(join(dir, 'scan.jpg'))));
  page.drawImage(img, PLACE);
  writeFileSync(join(dir, 'jpeg.pdf'), await doc.save({ useObjectStreams: false }));
}

async function jpx(): Promise<void> {
  // JPEG 2000。色空間は画像の中にだけあり、辞書には書かない形
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const image = doc.context.register(doc.context.stream(readFileSync(join(dir, 'scan.jp2')), {
    Type: 'XObject', Subtype: 'Image', Width: 800, Height: 300, Filter: 'JPXDecode',
  }));
  page.node.setXObject(PDFName.of('Im0'), image);
  const content = `q ${PLACE.width} 0 0 ${PLACE.height} ${PLACE.x} ${PLACE.y} cm /Im0 Do Q`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  writeFileSync(join(dir, 'jpx.pdf'), await doc.save({ useObjectStreams: false }));
}

async function cmyk(): Promise<void> {
  // CMYK の JPEG。pdf-lib は Adobe の反転した CMYK に Decode [1 0 1 0 1 0 1 0] を付ける
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const img = await doc.embedJpg(new Uint8Array(readFileSync(join(dir, 'scan-cmyk.jpg'))));
  page.drawImage(img, PLACE);
  writeFileSync(join(dir, 'cmyk.pdf'), await doc.save({ useObjectStreams: false }));
}

async function predefinedCMap(): Promise<void> {
  // 埋め込まない日本語のフォントと、定義済みの CMap（UniJIS-UCS2-H）。古い PDF で見かける形
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const font = doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: 'Type0', BaseFont: 'KozMinPr6N-Regular', Encoding: 'UniJIS-UCS2-H',
    DescendantFonts: [doc.context.obj({
      Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'KozMinPr6N-Regular',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 6 },
      FontDescriptor: doc.context.obj({
        Type: 'FontDescriptor', FontName: 'KozMinPr6N-Regular', Flags: 4, Ascent: 880, Descent: -120,
        FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, CapHeight: 700, StemV: 80,
      }),
      DW: 1000,
    })],
  }));
  page.node.setFontDictionary(PDFName.of('F1'), font);
  // 「氏名：見本花子」と「住所：架空県」の 2 行（UTF-16BE）
  const hex = (t: string) => Array.from(t, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const content = `BT /F1 20 Tf 50 700 Td <${hex('氏名：見本花子')}> Tj 0 -40 Td <${hex('住所：架空県')}> Tj ET`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  writeFileSync(join(dir, 'cmap.pdf'), await doc.save({ useObjectStreams: false }));
}

async function rotated(): Promise<void> {
  // /Rotate 90 の頁（横向きの書類をスキャンして回したような形）。2 頁目は回転なし
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.setRotation(degrees(90));
  page.drawText('Rotated page code: ROTSECRET end', { x: 60, y: 600, size: 20, font });
  const page2 = doc.addPage([595, 842]);
  page2.drawText('Second page', { x: 60, y: 700, size: 20, font });
  writeFileSync(join(dir, 'rotated.pdf'), await doc.save({ useObjectStreams: false }));
}

await jbig2();
await predefinedCMap();
await rotated();
await jpeg();
await jpx();
await cmyk();
console.log('done');
