/**
 * 画面の性質の試験（Bombadil）の素材を作る。`tests/pbt/.fixtures/` に書き出す（git には入れない）。
 * 頁・画像ごとに背景の色を変え、性質の側で canvas の左上の色から「いま何が表示されているか」を見分けられるようにする
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE } from './palette';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '.fixtures');
mkdirSync(dir, { recursive: true });

async function makePdf(doc: 'A' | 'B', pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= pages; k++) {
    const [r, g, b] = PALETTE[`DOC-${doc} PAGE-${k}/${pages}`];
    const page = pdf.addPage([500, 400]);
    page.drawRectangle({ x: 0, y: 0, width: 500, height: 400, color: rgb(r / 255, g / 255, b / 255) });
    page.drawText(`DOC-${doc} PAGE-${k}/${pages}`, { x: 120, y: 190, size: 24, font, color: rgb(0, 0, 0) });
    page.drawText('SECRET-TEXT-FOR-REDACTION', { x: 80, y: 120, size: 20, font, color: rgb(1, 1, 1) });
  }
  return pdf.save();
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
/** 一色の PNG（RGB）。中央に白い帯を入れる（墨消しで黒くなったかを見分けられるように） */
function makePng(w: number, h: number, [r, g, b]: number[]): Buffer {
  const row = Buffer.alloc(1 + w * 3);
  const band = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row.set([r, g, b], 1 + x * 3);
    band.set([255, 255, 255], 1 + x * 3);
  }
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) rows.push(y > h * 0.4 && y < h * 0.6 ? band : row);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', new Uint8Array()),
  ]);
}

writeFileSync(resolve(dir, 'doc-a.pdf'), await makePdf('A', 3));
writeFileSync(resolve(dir, 'doc-b.pdf'), await makePdf('B', 2));
writeFileSync(resolve(dir, 'small.png'), makePng(320, 240, PALETTE['IMAGE-SMALL']));
writeFileSync(resolve(dir, 'big.png'), makePng(4000, 3000, PALETTE['IMAGE-BIG']));
writeFileSync(resolve(dir, 'broken.pdf'), Buffer.from('%PDF-1.7\nこれは PDF ではない\n'));
writeFileSync(resolve(dir, 'not-image.gif'), Buffer.from('GIF89a\x01\x00\x01\x00'));

// 仕様から読むファイルの場所（Bombadil の SetFileInputFiles には、手元の絶対パスを渡す）
const files = ['doc-a.pdf', 'doc-b.pdf', 'small.png', 'big.png', 'broken.pdf', 'not-image.gif'];
writeFileSync(
  resolve(dir, 'paths.ts'),
  `// make-fixtures.ts が書き出す。手で直さない\nexport const FIXTURES: Record<string, string> = ${JSON.stringify(Object.fromEntries(files.map((f) => [f, resolve(dir, f)])), null, 2)};\n`,
);
console.log(`素材を ${dir} に作った`);
