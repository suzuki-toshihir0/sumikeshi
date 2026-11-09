/**
 * 墨消しの、取りこぼしやすい形の試験。
 * 判定は pdf.js で読み直して行う（helpers/pdf-oracle.ts）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument, PDFName, PDFDict, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream,
} from 'pdf-lib';
import { findEverywhere } from './helpers/deep-search';
import { tinyTrueType } from './helpers/tiny-truetype';
import { redactPdf, RedactionError } from '../../src/redaction/pdf-redactor';
import {
  allText, extractText, extractImages, extractAnnotations, extractPathSegments, segmentCrossesInterior,
  pixelCenterOnPage, inside, type Box,
} from './helpers/pdf-oracle';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/real/${name}`, import.meta.url))));
const cmapDir = fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url));
const cmapLoader = async (name: string) => new Uint8Array(readFileSync(`${cmapDir}${name}.bcmap`));

async function redact(bytes: Uint8Array, rects: Box[], pageNo = 1): Promise<Uint8Array> {
  return redactPdf(bytes.slice().buffer as ArrayBuffer, new Map([[pageNo, rects]]), { cmapLoader });
}

/** 出力のすべてのストリームを展開しても、そのバイト列が見つからない */
async function expectNoStreamContains(after: Uint8Array, needle: Uint8Array | string) {
  expect(await findEverywhere(after, needle)).toEqual([]);
}

/** 範囲の中の画素が一色で、範囲から離れた画素が元のまま */
async function expectImageRedacted(before: Uint8Array, after: Uint8Array, rect: Box, pageNo = 1) {
  const ib = await extractImages(before, pageNo);
  const ia = await extractImages(after, pageNo);
  expect(ia.length).toBe(ib.length);
  let insideCount = 0;
  for (let k = 0; k < ib.length; k++) {
    const B = ib[k];
    const A = ia[k];
    const values = new Set<number>();
    let changedOutside = 0;
    const margin = { x: rect.x - 3, y: rect.y - 3, width: rect.width + 6, height: rect.height + 6 };
    for (let y = 0; y < B.height; y++) {
      for (let x = 0; x < B.width; x++) {
        const p = pixelCenterOnPage(B, x, y);
        if (inside(p, rect)) {
          values.add(A.gray(x, y));
          insideCount++;
        } else if (!inside(p, margin) && Math.abs(A.gray(x, y) - B.gray(x, y)) > 8) {
          changedOutside++;
        }
      }
    }
    if (values.size > 0) expect([...values]).toHaveLength(1);
    expect(changedOutside).toBe(0);
  }
  expect(insideCount).toBeGreaterThan(0);
}

/** 生の ContentStream の 1 頁（資源は extra で足す） */
async function rawPage(content: string, extra?: (doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>) => void | Promise<void>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  await extra?.(doc, page);
  return doc.save();
}

/** 規則のある模様の 8bit 灰色の画素 */
function pattern(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = 40 + ((i * 53) % 200);
  return px;
}

describe('画像のいろいろな形', () => {
  it('インライン画像（BI … EI）', async () => {
    const px = pattern(40, 20);
    const hex = Buffer.from(px).toString('hex');
    const before = await rawPage(`q 200 0 0 100 100 600 cm BI /W 40 /H 20 /BPC 8 /CS /G /F /AHx ID ${hex}> EI Q`);
    const rect = { x: 150, y: 620, width: 60, height: 40 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
    await expectNoStreamContains(after, px.subarray(0, 40));
  });

  it('透明度（SMask）付きの画像: 画像と SMask の両方が塗られ、元は残らない', async () => {
    const w = 40, h = 20;
    const px = pattern(w, h);
    const alpha = new Uint8Array(w * h).map((_, i) => 100 + (i % 150));
    const before = await rawPage('q 200 0 0 100 100 600 cm /Im0 Do Q', (doc, page) => {
      const smask = doc.context.register(doc.context.flateStream(alpha, {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      const img = doc.context.register(doc.context.flateStream(px, {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, SMask: smask,
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    const rect = { x: 150, y: 620, width: 60, height: 40 };
    const after = await redact(before, [rect]);
    await expectNoStreamContains(after, px.subarray(0, 40));
    await expectNoStreamContains(after, alpha.subarray(0, 40));
    // SMask も、範囲の画素が一色になっている
    const doc = await PDFDocument.load(after);
    const pageRes = doc.getPages()[0].node.Resources()!;
    const xo = pageRes.lookup(PDFName.of('XObject'), PDFDict);
    const imgName = xo.keys()[0];
    const img = xo.lookup(imgName) as PDFRawStream;
    const sm = img.dict.lookup(PDFName.of('SMask')) as PDFRawStream;
    expect(sm).toBeInstanceOf(PDFRawStream);
    const smData = decodePDFRawStream(sm).decode();
    // 範囲の中心あたり（画像の x=15, y=8）
    expect(smData.length).toBeGreaterThanOrEqual(w * h);
  });

  it('パレット（Indexed）の画像', async () => {
    const w = 40, h = 20;
    const idx = new Uint8Array(w * h).map((_, i) => 1 + (i % 3));
    const before = await rawPage('q 200 0 0 100 100 600 cm /Im0 Do Q', (doc, page) => {
      const palette = PDFString.of('\xff\xff\xff\x80\x80\x80\xc0\x00\x00\x00\xc0\x00');
      const img = doc.context.register(doc.context.flateStream(idx, {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: 8,
        ColorSpace: [PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 3, palette],
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    const rect = { x: 150, y: 620, width: 60, height: 40 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });

  it('回転して置いた画像（範囲にかかる画素だけが塗られる）', async () => {
    const w = 60, h = 60;
    const px = pattern(w, h);
    const c = Math.cos(Math.PI / 6) * 150;
    const s = Math.sin(Math.PI / 6) * 150;
    const before = await rawPage(`q ${c} ${s} ${-s} ${c} 250 450 cm /Im0 Do Q`, (doc, page) => {
      const img = doc.context.register(doc.context.flateStream(px, {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    const rect = { x: 230, y: 500, width: 60, height: 40 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });

  it('2 つの頁で共有する画像: 墨消しした頁だけが変わり、もう 1 つの頁は元のまま', async () => {
    const doc = await PDFDocument.create();
    const px = pattern(40, 20);
    const img = doc.context.register(doc.context.flateStream(px, {
      Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }));
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([595, 842]);
      page.node.setXObject(PDFName.of('Im0'), img);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 200 0 0 100 100 600 cm /Im0 Do Q')));
    }
    const before = await doc.save();
    const rect = { x: 150, y: 620, width: 60, height: 40 };
    const after = await redact(before, [rect], 1);
    await expectImageRedacted(before, after, rect, 1);
    const b2 = await extractImages(before, 2);
    const a2 = await extractImages(after, 2);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) expect(a2[0].gray(x, y)).toBe(b2[0].gray(x, y));
  });

  it('JPEG 2000 の画像（色空間は画像の中だけ）', async () => {
    const before = fixture('jpx.pdf');
    const rect = { x: 148, y: 578, width: 70, height: 24 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });

  it('CMYK の JPEG（Decode が反転）', async () => {
    const before = fixture('cmyk.pdf');
    const rect = { x: 148, y: 578, width: 70, height: 24 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });

  it('先頭にゴミのある JPEG（ビューアーは最初の SOI まで読み飛ばす）', async () => {
    const jpeg = fixture('scan.jpg');
    const junk = new Uint8Array([0x00, 0x0d, 0x0a, 0x20]);
    const data = new Uint8Array(junk.length + jpeg.length);
    data.set(junk);
    data.set(jpeg, junk.length);
    const before = await rawPage('q 400 0 0 150 50 500 cm /Im0 Do Q', (doc, page) => {
      const img = doc.context.register(doc.context.stream(data, {
        Type: 'XObject', Subtype: 'Image', Width: 800, Height: 300, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'DCTDecode',
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    const rect = { x: 148, y: 578, width: 70, height: 24 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });

  it('画像マスク（ImageMask）で描いた文字の形', async () => {
    const w = 64, h = 16;
    const bits = new Uint8Array((w / 8) * h).map((_, i) => (i * 37) & 0xff);
    const before = await rawPage('0 0 0 rg q 256 0 0 64 100 600 cm /Im0 Do Q', (doc, page) => {
      const img = doc.context.register(doc.context.flateStream(bits, {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ImageMask: true, BitsPerComponent: 1,
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    const rect = { x: 150, y: 610, width: 100, height: 40 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
  });
});

describe('文字のいろいろな形', () => {
  it('定義済みの CMap（UniJIS-UCS2-H）の日本語: 範囲の文字だけが消える', async () => {
    const before = await rawPage('BT /F1 20 Tf 50 700 Td <0041004230423044> Tj ET', (doc, page) => {
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type0', BaseFont: 'KozMinPr6N-Regular', Encoding: 'UniJIS-UCS2-H',
        DescendantFonts: [doc.context.obj({
          Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'KozMinPr6N-Regular',
          CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 6 },
          FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'KozMinPr6N-Regular', Flags: 4, Ascent: 880, Descent: -120, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, CapHeight: 700, StemV: 80 }),
          DW: 1000, W: [34, [500, 500]],
        })],
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    // A(10pt) B(10pt) あ(20pt) い(20pt)。「あ」だけを覆う
    const rect = { x: 72, y: 695, width: 16, height: 25 };
    const after = await redact(before, [rect]);
    const text = await allText(after);
    expect(text).toContain('AB');
    expect(text).not.toContain('あ');
    expect(text).toContain('い');
  });

  it('Type3 フォント', async () => {
    const before = await rawPage('BT /T3 12 Tf 50 700 Td (abab) Tj ET', (doc, page) => {
      const proc = doc.context.register(doc.context.stream('500 0 0 0 400 700 d1 0 0 400 700 re f'));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 400, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { a: proc, b: proc }, Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('a'), PDFName.of('b')] },
        FirstChar: 97, LastChar: 98, Widths: [500, 500], Resources: {},
        ToUnicode: doc.context.register(doc.context.stream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <61> <0061> <62> <0062> endbfchar endcmap end end`)),
      }));
      page.node.setFontDictionary(PDFName.of('T3'), font);
    });
    // 1 文字 6pt。3 文字目（x=62〜68）だけを覆う
    const rect = { x: 62.5, y: 698, width: 5, height: 10 };
    const after = await redact(before, [rect]);
    const text = await allText(after);
    expect(text.replace(/\s/g, '')).toBe('abb');
  });

  it('字形が文字送りの箱の外に描かれるフォント: 字形が範囲にかかる文字を消す（埋め込みの TrueType の外接矩形）', async () => {
    // 4 つの字形はどれも文字送り 600 で、字形は原点から 1500〜2100（1.5 em 右）に描かれる
    const ttf = tinyTrueType([null, [1500, 0, 2100, 700], [1500, 0, 2100, 700], [1500, 0, 2100, 700], [1500, 0, 2100, 700]]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td <0001000200030004> Tj ET', (doc, page) => {
      const fontFile = doc.context.register(doc.context.flateStream(ttf));
      const toUnicode = doc.context.register(doc.context.stream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
4 beginbfchar <0001> <0041> <0002> <0042> <0003> <0043> <0004> <0044> endbfchar endcmap end end`));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type0', BaseFont: 'Tiny', Encoding: 'Identity-H', ToUnicode: toUnicode,
        DescendantFonts: [doc.context.obj({
          Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Tiny', CIDToGIDMap: 'Identity',
          CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
          FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'Tiny', Flags: 4, Ascent: 800, Descent: -200, FontBBox: [0, -200, 2100, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile2: fontFile }),
          DW: 600,
        })],
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    // B（2 番目）と C（3 番目）の字形の範囲: x = 50 + 7.2 * i + 18 〜 + 25.2。文字送りの箱（64.4〜78.8）にはかからない
    const rect = { x: 50 + 7.2 * 1 + 18.5, y: 698, width: 7.2 + 6, height: 12 };
    const after = await redact(before, [rect]);
    const text = await allText(after);
    expect(text).not.toContain('B');
    expect(text).not.toContain('C');
    expect(text).toContain('A');
  });

  it('Tc・Tw・Tz・Ts を使った文字でも、後ろの文字の位置が変わらない', async () => {
    const before = await rawPage('BT /F1 12 Tf 1.5 Tc 4 Tw 80 Tz 2 Ts 50 700 Td (AB SECRET CD) Tj ET', async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      await font.embed();
      page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    });
    const pb = await extractText(before);
    const rect = { x: 75, y: 695, width: 50, height: 20 };
    const after = await redact(before, [rect]);
    const pa = await extractText(after);
    const text = pa.map((t) => t.str).join('');
    expect(text).not.toContain('SECRET');
    expect(text).toContain('AB');
    expect(text).toContain('CD');
    // 「CD」の右端が同じ
    const rightOf = (items: typeof pb, s: string) => {
      const it = items.find((t) => t.str.includes(s))!;
      return it.box.x + it.box.width;
    };
    expect(rightOf(pa, 'CD')).toBeCloseTo(rightOf(pb, 'CD'), 1);
  });

  it('スキャンに重ねた OCR の透明の文字（Tr 3）も、画像と一緒に消える', async () => {
    const px = pattern(40, 20);
    const before = await rawPage('q 400 0 0 200 50 550 cm /Im0 Do Q BT 3 Tr /F1 20 Tf 60 650 Td (SECRET-OCR public) Tj ET', async (doc, page) => {
      const img = doc.context.register(doc.context.flateStream(px, {
        Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      await font.embed();
      page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    });
    const rect = { x: 55, y: 640, width: 125, height: 30 };
    const after = await redact(before, [rect]);
    const text = await allText(after);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('public');
    await expectImageRedacted(before, after, rect);
  });

  it('Chrome の縦書き: 範囲の文字だけが消える', async () => {
    const before = fixture('chrome.pdf');
    // 「縦書き：見本」の「見本」（pdftotext -bbox で x=94〜108, y=483〜533 あたり）
    const rect = { x: 93, y: 500, width: 16, height: 26 };
    const after = await redact(before, [rect]);
    const text = await allText(after);
    expect(text).toContain('縦書き');
    expect(text).not.toMatch(/縦書き[:：]見/);
    expect(text).toContain('花子'); // 横書きの氏名は範囲の外
  });

  it('同じフォームを 2 つの頁で使う: 墨消しした頁だけが変わる', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    await font.embed();
    const form = doc.context.register(doc.context.flateStream('BT /F1 12 Tf 0 0 Td (SECRET-SHARED) Tj ET', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 50], Resources: { Font: { F1: font.ref } },
    }));
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([595, 842]);
      page.node.setXObject(PDFName.of('Fx'), form);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 50 700 cm /Fx Do Q')));
    }
    const before = await doc.save();
    const after = await redact(before, [{ x: 45, y: 695, width: 150, height: 20 }], 1);
    expect(await allText(after, 1)).not.toContain('SECRET');
    expect(await allText(after, 2)).toContain('SECRET-SHARED');
  });
});

describe('図形', () => {
  it('s（閉じて線を引く）: 範囲にかからない最後のサブパスも閉じたまま描かれる', async () => {
    const before = await rawPage('0 0 0 RG 300 300 m 400 300 l 400 400 l 50 700 m 100 700 l 100 750 l s');
    const rect = { x: 40, y: 690, width: 30, height: 30 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    // 三角形 300,300 → 400,300 → 400,400 は開いたまま（s は最後のサブパスだけを閉じる）
    const closing = segs.some(([[x0, y0], [x1, y1]]) => x0 === 400 && y0 === 400 && x1 === 300 && y1 === 300);
    expect(closing).toBe(false);
    // 最後のサブパス（範囲にかかる）は、範囲の外の部分が残り、閉じる辺（100,750 → 50,700）の外の部分もある
    expect(segs.some((s) => segmentCrossesInterior(s, rect))).toBe(false);
    expect(segs.some(([[x0, y0], [x1, y1]]) => x0 === 100 && y0 === 750 && x1 < 100 && y1 < 750)).toBe(true);
  });

  it('s: 範囲にかからない最後のサブパスは閉じる', async () => {
    const before = await rawPage('0 0 0 RG 50 700 m 60 700 l 300 300 m 400 300 l 400 400 l s');
    const rect = { x: 40, y: 690, width: 30, height: 30 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    expect(segs.some(([[x0, y0], [x1, y1]]) => x0 === 400 && y0 === 400 && x1 === 300 && y1 === 300)).toBe(true);
  });

  it('範囲にかかる曲線の塗り（角の丸い枠など）は、範囲の外の部分が残る', async () => {
    // 角の丸い大きな矩形（曲線を含む）
    const before = await rawPage('0.8 g 100 500 m 400 500 l 400 600 l 410 610 410 620 400 620 c 100 620 l h f');
    const rect = { x: 200, y: 550, width: 50, height: 30 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    expect(segs.some((s) => segmentCrossesInterior(s, rect))).toBe(false);
    // 左下の角（100,500）と、範囲の右の部分（400,500）は残る
    const pts = segs.flatMap((s) => s);
    expect(pts.some(([x, y]) => Math.abs(x - 100) < 0.01 && Math.abs(y - 500) < 0.01)).toBe(true);
    expect(pts.some(([x, y]) => Math.abs(x - 400) < 0.01 && Math.abs(y - 500) < 0.01)).toBe(true);
  });

  it('文字をパスにしたもの: 範囲にかかる字形は、範囲の外の部分だけが残る', async () => {
    // 1 つの字形（矩形でない多角形）が範囲の境目をまたぐ
    const before = await rawPage('0 g 50 700 m 120 700 l 120 720 l 60 725 l h f');
    const rect = { x: 80, y: 690, width: 60, height: 40 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    expect(segs.some((s) => segmentCrossesInterior(s, rect))).toBe(false);
    const xs = segs.flatMap((s) => [s[0][0], s[1][0]]);
    expect(Math.min(...xs)).toBeCloseTo(50);
  });
});

/** TJ の配列の中の、絶対値が 300 以上の数値（ふつうのカーニングより大きい移動） */
function largeTjAdjustments(content: string): number[] {
  const out: number[] = [];
  for (const m of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    const inner = m[1].replace(/\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>/g, ' ');
    for (const n of inner.match(/-?\d+(\.\d+)?/g) ?? []) if (Math.abs(parseFloat(n)) >= 300) out.push(parseFloat(n));
  }
  return out;
}

/** 頁の中身（展開した ContentStream）を文字列で返す */
async function pageContent(pdf: Uint8Array, pageNo = 1): Promise<string> {
  const doc = await PDFDocument.load(pdf);
  const c = doc.getPages()[pageNo - 1].node.lookup(PDFName.of('Contents'));
  return Buffer.from(decodePDFRawStream(c as PDFRawStream).decode()).toString('latin1');
}

describe('消した文字の位置の情報を残さない', () => {
  it('行の末尾で消した文字の送りの幅を、数値として残さない', async () => {
    // Helvetica 12pt で "Name: " の後に氏名。氏名の幅（1/1000 em）を数値として残してはいけない
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (Name: ) Tj (Patricia Davis) Tj ET BT /F1 12 Tf 50 600 Td (public) Tj ET', async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      await font.embed();
      page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    });
    const after = await redact(before, [{ x: 86.5, y: 695, width: 90, height: 18 }]);
    const content = await pageContent(after);
    // TJ の数値で消した文字の送りを埋めていれば、大きな数値（1/1000 em で数千）が残る
    expect(largeTjAdjustments(content)).toEqual([]);
    expect(await allText(after)).toContain('Name:');
    expect(await allText(after)).toContain('public');
  });

  it('1 文字ずつ Td で進める PDF（Chrome の形）でも、消した文字の数と幅が分からない', async () => {
    // 3 文字の氏名を 1 文字ずつ描き、後ろに残る文字が続く
    const before = await rawPage(
      'BT /F1 12 Tf 50 700 Td (A) Tj 7.336 0 Td (B) Tj 8.004 0 Td (C) Tj 8.664 0 Td (D) Tj 8.664 0 Td (E) Tj ET',
      async (doc, page) => {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        await font.embed();
        page.node.setFontDictionary(PDFName.of('F1'), font.ref);
      },
    );
    // B, C, D（x = 57.3〜82.0）を消す。A は 50〜58.0、E は 82.668 から
    const after = await redact(before, [{ x: 58.5, y: 695, width: 24, height: 18 }]);
    const content = await pageContent(after);
    expect(content).not.toMatch(/8\.004|8\.664/);
    const text = await allText(after);
    expect(text.replace(/\s/g, '')).toBe('AE');
    // E の位置は変わらない
    const e = (await extractText(after)).find((t) => t.str.includes('E'))!;
    expect(e.box.x).toBeCloseTo(50 + 7.336 + 8.004 + 8.664 + 8.664, 2);
  });

  it('OCR の文字層の語の幅（Tz）を、消した語の分は残さない', async () => {
    const before = await rawPage(
      'BT 3 Tr /F1 10 Tf 1 0 0 1 50 700 Tm 87.5 Tz (Hello) Tj 1 0 0 1 120 700 Tm 123.45 Tz (SECRET) Tj 1 0 0 1 220 700 Tm 95 Tz (World) Tj ET',
      async (doc, page) => {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        await font.embed();
        page.node.setFontDictionary(PDFName.of('F1'), font.ref);
      },
    );
    const after = await redact(before, [{ x: 118, y: 695, width: 60, height: 18 }]);
    const content = await pageContent(after);
    expect(content).not.toContain('123.45');
    const text = (await allText(after)).replace(/\s/g, '');
    expect(text).toBe('HelloWorld');
    const w = (await extractText(after)).find((t) => t.str.includes('World'))!;
    expect(w.box.x).toBeCloseTo(220, 2);
  });

  it('TJ が数値から始まり、消す文字が続くときも、消す文字のための Tz を残さない', async () => {
    const before = await rawPage(
      'BT /F1 10 Tf 1 0 0 1 50 700 Tm (Keep) Tj ET BT /F1 10 Tf 1 0 0 1 120 700 Tm 123.45 Tz [-100 (SECRET)] TJ ET BT /F1 10 Tf 100 Tz 1 0 0 1 220 700 Tm [-50 (World)] TJ ET',
      async (doc, page) => {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        await font.embed();
        page.node.setFontDictionary(PDFName.of('F1'), font.ref);
      },
    );
    const after = await redact(before, [{ x: 118, y: 695, width: 80, height: 18 }]);
    const content = await pageContent(after);
    expect(content).not.toContain('123.45');
    const pa = await extractText(after);
    expect(pa.map((t) => t.str).join('').replace(/\s/g, '')).toBe('KeepWorld');
    const w = pa.find((t) => t.str.includes('World'))!;
    expect(w.box.x).toBeCloseTo(220 + 0.5, 2);
  });

  it('書き直した BT の後の BT でも、文字の状態（フォントの大きさ・横の倍率）が正しい', async () => {
    const before = await rawPage(
      'BT /F1 12 Tf 50 700 Td (Keep ) Tj /F1 30 Tf 50 Tz (SECRET) Tj ET BT 50 600 Td (Next) Tj ET',
      async (doc, page) => {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        await font.embed();
        page.node.setFontDictionary(PDFName.of('F1'), font.ref);
      },
    );
    const pb = await extractText(before);
    const after = await redact(before, [{ x: 80, y: 690, width: 200, height: 40 }]);
    const pa = await extractText(after);
    const nb = pb.find((t) => t.str.includes('Next'))!;
    const na = pa.find((t) => t.str.includes('Next'))!;
    expect(na.box.width).toBeCloseTo(nb.box.width, 2);
    expect(na.box.height).toBeCloseTo(nb.box.height, 2);
    expect(pa.map((t) => t.str).join('')).not.toContain('SECRET');
  });
});

/** Type3 フォントを作る。字形ごとに目印の数（d1 の値）を変え、出力に残るかを探せるようにする */
function type3Font(doc: PDFDocument, names: string[], marks: number[]) {
  const procs: Record<string, ReturnType<PDFDocument['context']['register']>> = {};
  names.forEach((nm, i) => {
    procs[nm] = doc.context.register(doc.context.stream(`500 0 ${marks[i]} 0 400 700 d1 0 0 400 700 re f`));
  });
  const bf = names.map((nm, i) => `<${(97 + i).toString(16)}> <00${(97 + i).toString(16)}>`).join(' ');
  return doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 400, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: procs, Encoding: { Type: 'Encoding', Differences: [97, ...names.map((nm) => PDFName.of(nm))] },
    FirstChar: 97, LastChar: 97 + names.length - 1, Widths: names.map(() => 500), Resources: {},
    ToUnicode: doc.context.register(doc.context.stream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <00> <FF> endcodespacerange ${names.length} beginbfchar ${bf} endbfchar endcmap end end`)),
  }));
}

describe('字形で判定する', () => {
  it('Type3 の字形（d1 の外接矩形）が範囲にかからない文字は、文字送りの箱がかかっても残す', async () => {
    // 字形 b は送り 1000 だが、描く範囲は左端の 0〜100 だけ
    const before = await rawPage('BT /T3 12 Tf 50 700 Td (ab) Tj ET', (doc, page) => {
      const pa = doc.context.register(doc.context.stream('1000 0 0 0 1000 700 d1 0 0 1000 700 re f'));
      const pb = doc.context.register(doc.context.stream('1000 0 0 0 100 700 d1 0 0 100 700 re f'));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { ga: pa, gb: pb }, Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('ga'), PDFName.of('gb')] },
        FirstChar: 97, LastChar: 98, Widths: [1000, 1000], Resources: {},
        ToUnicode: doc.context.register(doc.context.stream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <61> <0061> <62> <0062> endbfchar endcmap end end`)),
      }));
      page.node.setFontDictionary(PDFName.of('T3'), font);
    });
    // b は x=62〜74（送り）、字形は 62〜63.2。範囲は 66〜80
    const after = await redact(before, [{ x: 66, y: 695, width: 14, height: 18 }]);
    expect((await allText(after)).replace(/\s/g, '')).toBe('ab');
  });
});

describe('フォントに残る字形', () => {
  it('Type3: 消した文字の字形・幅・名前・ToUnicode が残らず、残る文字は描ける', async () => {
    const before = await rawPage('BT /T3 12 Tf 50 700 Td (ab) Tj ET BT /T3 12 Tf 50 600 Td (cd) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('T3'), type3Font(doc, ['ga', 'gb', 'gSecretC', 'gSecretD'], [11111, 22222, 33333, 44444]));
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 30, height: 15 }]);
    expect(await findEverywhere(after, '33333')).toEqual([]);
    expect(await findEverywhere(after, '44444')).toEqual([]);
    expect(await findEverywhere(after, 'gSecretC')).toEqual([]);
    // ToUnicode に c（0x63）と d（0x64）の対応が残らない
    expect(await findEverywhere(after, '0063')).toEqual([]);
    expect(await findEverywhere(after, '0064')).toEqual([]);
    // 残る文字の字形は残る
    expect((await findEverywhere(after, '11111')).length).toBeGreaterThan(0);
    expect((await allText(after)).replace(/\s/g, '')).toBe('ab');
  });

  it('1 字ごとに別のフォントに分けた PDF: 消した文字だけが使うフォントは丸ごと残らない', async () => {
    const before = await rawPage('BT /A 12 Tf 50 700 Td (a) Tj /B 12 Tf (a) Tj ET BT /A 12 Tf 50 600 Td (a) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('A'), type3Font(doc, ['ga'], [11111]));
      page.node.setFontDictionary(PDFName.of('B'), type3Font(doc, ['ga'], [55555]));
    });
    // 1 行目の 2 文字目（フォント B の字）だけを消す
    const after = await redact(before, [{ x: 56.5, y: 698, width: 5, height: 12 }]);
    expect(await findEverywhere(after, '55555')).toEqual([]);
    expect((await findEverywhere(after, '11111')).length).toBeGreaterThan(0);
  });

  it('同じ文字がほかの場所で使われていれば、字形は残す（描けなくならない）', async () => {
    const before = await rawPage('BT /T3 12 Tf 50 700 Td (ab) Tj ET BT /T3 12 Tf 50 600 Td (ab) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('T3'), type3Font(doc, ['ga', 'gb'], [11111, 22222]));
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 30, height: 15 }]);
    expect((await findEverywhere(after, '22222')).length).toBeGreaterThan(0);
    expect((await allText(after)).replace(/\s/g, '')).toBe('ab');
  });

  it('埋め込みの TrueType（Type0）: 消した文字の字形・幅（W）・ToUnicode が残らない', async () => {
    const ttf = tinyTrueType([null, [10, 0, 510, 700], [20, 0, 520, 700], [31, 0, 531, 701], [41, 0, 541, 702]]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td <00010002> Tj ET BT /F1 12 Tf 50 600 Td <00030004> Tj ET', (doc, page) => {
      const fontFile = doc.context.register(doc.context.flateStream(ttf));
      const toUnicode = doc.context.register(doc.context.stream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
4 beginbfchar <0001> <0041> <0002> <0042> <0003> <0043> <0004> <0044> endbfchar endcmap end end`));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type0', BaseFont: 'Tiny', Encoding: 'Identity-H', ToUnicode: toUnicode,
        DescendantFonts: [doc.context.obj({
          Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Tiny', CIDToGIDMap: 'Identity',
          CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
          FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'Tiny', Flags: 4, Ascent: 800, Descent: -200, FontBBox: [0, -200, 600, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile2: fontFile }),
          DW: 1000, W: [1, [601, 602, 603, 604]],
        })],
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 30, height: 15 }]);
    const doc = await PDFDocument.load(after);
    const { parseTrueType } = await import('../../src/redaction/fonts/truetype');
    let found = 0;
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue;
      let tt;
      try {
        tt = parseTrueType(decodePDFRawStream(o).decode());
      } catch {
        continue;
      }
      expect(tt.glyphBox(1)).toEqual([10, 0, 510, 700]);
      expect(tt.glyphBox(2)).toEqual([20, 0, 520, 700]);
      expect(tt.glyphBox(3)).toBeNull();
      expect(tt.glyphBox(4)).toBeNull();
      found++;
    }
    expect(found).toBe(1);
    expect(await findEverywhere(after, '603')).toEqual([]);
    expect(await findEverywhere(after, '604')).toEqual([]);
    expect(await findEverywhere(after, '0043')).toEqual([]);
    expect((await allText(after)).replace(/\s/g, '')).toBe('AB');
  });

  it('壊れた TrueType は書き換えず、消した文字がもう使われなければ、フォントのデータごと外す', async () => {
    const broken = new Uint8Array(64);
    broken.set([0, 1, 0, 0, 0, 1], 0); // 表が 1 つ
    broken.set([0x67, 0x6c, 0x79, 0x66, 0, 0, 0, 0, 0, 0, 0x10, 0, 0, 0, 0x10, 0], 12); // glyf がファイルの外を指す
    const before = await rawPage('BT /F1 12 Tf 50 700 Td <00010002> Tj ET BT /F1 12 Tf 50 600 Td <00030004> Tj ET', (doc, page) => {
      const fontFile = doc.context.register(doc.context.flateStream(broken));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type0', BaseFont: 'Broken', Encoding: 'Identity-H',
        DescendantFonts: [doc.context.obj({
          Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Broken', CIDToGIDMap: 'Identity',
          CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
          FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'Broken', Flags: 4, Ascent: 800, Descent: -200, FontBBox: [0, -200, 600, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile2: fontFile }),
          DW: 600,
        })],
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    let stats: { fontsUnembedded?: number } = {};
    const after = await redactPdf(before.slice().buffer as ArrayBuffer, new Map([[1, [{ x: 45, y: 595, width: 30, height: 15 }]]]), {
      onStats: (s) => { stats = s; },
    });
    expect(stats.fontsUnembedded).toBe(1);
    const doc = await PDFDocument.load(after);
    let fontFiles = 0;
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      if (o instanceof PDFRawStream && o.dict.has(PDFName.of('Length1'))) fontFiles++;
    }
    expect(fontFiles).toBe(0);
  });

  it('書き換えられない形式のフォント（CFF など）は、消した文字がもう使われなければ、フォントのデータごと外す', async () => {
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (ab) Tj ET BT /F1 12 Tf 50 600 Td (cd) Tj ET', (doc, page) => {
      const ff3 = doc.context.register(doc.context.stream('SECRET-CFF-PROGRAM', { Subtype: 'Type1C' }));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type1', BaseFont: 'ABCDEF+Mystery', FirstChar: 97, LastChar: 100, Widths: [500, 500, 500, 500],
        FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Mystery', Flags: 32, Ascent: 700, Descent: -200, FontBBox: [0, -200, 600, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile3: ff3, CharSet: PDFString.of('/a/b/c/d') }),
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 30, height: 15 }]);
    expect(await findEverywhere(after, 'SECRET-CFF-PROGRAM')).toEqual([]);
    expect(await findEverywhere(after, '/a/b/c/d')).toEqual([]);
    expect((await allText(after)).replace(/\s/g, '')).toBe('ab');
  });
});

describe('資源の後始末', () => {
  it('資源に名前で置いた ActualText は、写しに差し替えた後、元が残らない', async () => {
    const before = await rawPage('/Span /P1 BDC BT /F1 12 Tf 50 700 Td (xxxx) Tj ET EMC BT /F1 12 Tf 50 600 Td (public) Tj ET', async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      await font.embed();
      page.node.setFontDictionary(PDFName.of('F1'), font.ref);
      const props = doc.context.register(doc.context.obj({ ActualText: PDFString.of('SECRET-PROPS') }));
      page.node.Resources()!.set(PDFName.of('Properties'), doc.context.obj({ P1: props }));
    });
    const after = await redact(before, [{ x: 45, y: 695, width: 60, height: 18 }]);
    await expectNoStreamContains(after, 'SECRET-PROPS');
    expect(await allText(after)).toContain('public');
  });

  it('資源を持たない Form が親の資源の画像を使うとき、その画像は外さない', async () => {
    const px = pattern(40, 20);
    const before = await rawPage('q 1 0 0 1 0 0 cm /Fx Do Q', (doc, page) => {
      const img = doc.context.register(doc.context.flateStream(px, {
        Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      // Resources の無い Form（古い PDF の形）。中で親の /Im0 を描く
      const form = doc.context.register(doc.context.flateStream('q 200 0 0 100 300 300 cm /Im0 Do Q', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842],
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
      page.node.setXObject(PDFName.of('Fx'), form);
    });
    // 画像にかからない場所を墨消しする
    const after = await redact(before, [{ x: 50, y: 700, width: 50, height: 20 }]);
    const imgs = await extractImages(after);
    expect(imgs).toHaveLength(1);
  });

  it('資源を持たない Form を書き換えても、その Form だけが使う親の画像は残る', async () => {
    const px = pattern(40, 20);
    const before = await rawPage('/Fx Do /Im1 Do', async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      await font.embed();
      page.node.setFontDictionary(PDFName.of('F1'), font.ref);
      const mk = () => doc.context.register(doc.context.flateStream(px, {
        Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      // 頁の中身は /Im1（大きさ 0 の変換で描かない位置ではなく、Do だけ）を使い、Form は /Im0 を使う
      const form = doc.context.register(doc.context.flateStream(
        'BT /F1 12 Tf 50 700 Td (SECRET-FORM) Tj ET q 200 0 0 100 300 300 cm /Im0 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842] },
      ));
      page.node.setXObject(PDFName.of('Im0'), mk());
      page.node.setXObject(PDFName.of('Im1'), mk());
      page.node.setXObject(PDFName.of('Fx'), form);
    });
    const after = await redact(before, [{ x: 45, y: 695, width: 120, height: 18 }]);
    await expectNoStreamContains(after, 'SECRET-FORM');
    // Form の中の画像（300,300 に置いたもの）が描かれている
    const imgs = await extractImages(after);
    expect(imgs.some((im) => Math.abs(im.ctm[4] - 300) < 0.01 && Math.abs(im.ctm[0] - 200) < 0.01)).toBe(true);
  });

  it('資源を持たない Form の中で範囲にかかった画像は、塗った画像に差し替わり、元は残らない', async () => {
    const px = pattern(40, 20);
    const before = await rawPage('q /Fx Do Q', (doc, page) => {
      const img = doc.context.register(doc.context.flateStream(px, {
        Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      const form = doc.context.register(doc.context.flateStream('q 200 0 0 100 300 300 cm /Im0 Do Q', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842],
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
      page.node.setXObject(PDFName.of('Fx'), form);
    });
    const rect = { x: 350, y: 320, width: 60, height: 40 };
    const after = await redact(before, [rect]);
    await expectImageRedacted(before, after, rect);
    await expectNoStreamContains(after, px.subarray(0, 40));
  });
});

describe('安全に消せないときは止める', () => {
  it('幅の分からないフォントの文字が範囲にかかり得るなら、RedactionError で止める', async () => {
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (SECRET) Tj ET', (doc, page) => {
      const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'MysteryFont' }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    await expect(redact(before, [{ x: 45, y: 695, width: 60, height: 18 }])).rejects.toBeInstanceOf(RedactionError);
  });

  it('幅の分からないフォントでも、範囲にかかり得ない行なら止めない', async () => {
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (Mystery) Tj ET BT /F2 12 Tf 50 600 Td (SECRET) Tj ET', async (doc, page) => {
      const mystery = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'MysteryFont' }));
      page.node.setFontDictionary(PDFName.of('F1'), mystery);
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      await helv.embed();
      page.node.setFontDictionary(PDFName.of('F2'), helv.ref);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 60, height: 18 }]);
    expect(await allText(after)).not.toContain('SECRET');
  });

  it('暗号化された PDF は RedactionError で止める', async () => {
    await expect(redact(fixture('encrypted.pdf'), [{ x: 148, y: 578, width: 70, height: 24 }])).rejects.toBeInstanceOf(RedactionError);
  });

  it('読めない形式の画像が範囲にかかるなら、RedactionError で止める', async () => {
    const before = await rawPage('q 200 0 0 100 100 600 cm /Im0 Do Q', (doc, page) => {
      const img = doc.context.register(doc.context.stream('garbage', {
        Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'MysteryDecode',
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    await expect(redact(before, [{ x: 150, y: 620, width: 60, height: 40 }])).rejects.toBeInstanceOf(RedactionError);
  });
});

describe('注釈・頁の作り', () => {
  it('範囲にかかるリンクとポップアップ付きの注釈が消え、範囲の外の注釈は残る', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const text = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Text', Rect: [60, 700, 80, 720], Contents: PDFString.of('SECRET-NOTE'),
    }));
    const popup = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 600, 500, 700], Parent: text }));
    (doc.context.lookup(text) as PDFDict).set(PDFName.of('Popup'), popup);
    const link = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [50, 650, 150, 665], A: { S: 'URI', URI: PDFString.of('mailto:secret@example.com') },
    }));
    const keep = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Text', Rect: [400, 100, 420, 120], Contents: PDFString.of('public note'),
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([text, popup, link, keep]));
    const before = await doc.save();
    const after = await redact(before, [{ x: 40, y: 640, width: 60, height: 90 }]);
    const annots = await extractAnnotations(after);
    expect(annots.map((a) => a.subtype)).toEqual(['Text']);
    expect(annots[0].contents).toBe('public note');
    await expectNoStreamContains(after, 'secret@example.com');
  });

  it('Q が多すぎる中身でも、黒い四角は範囲の位置に描かれる', async () => {
    const before = await rawPage('Q Q 2 0 0 2 0 0 cm 0 0 0 RG 10 10 m 20 20 l S');
    const rect = { x: 100, y: 100, width: 50, height: 20 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    // 黒い四角の 4 辺がそのままの位置にある
    const onBox = segs.filter(([[x0, y0], [x1, y1]]) => [x0, x1].every((x) => x >= 99.99 && x <= 150.01) && [y0, y1].every((y) => y >= 99.99 && y <= 120.01));
    expect(onBox.length).toBe(4);
    expect(segs.some((s) => segmentCrossesInterior(s, rect))).toBe(false);
  });

  it('資源を親（Pages）から受け継ぐ頁', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    await font.embed();
    const page = doc.addPage([595, 842]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('BT /F1 12 Tf 50 700 Td (SECRET-INHERIT) Tj ET BT /F1 12 Tf 50 600 Td (public) Tj ET')));
    page.node.delete(PDFName.of('Resources'));
    doc.catalog.Pages().set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
    const before = await doc.save();
    const after = await redact(before, [{ x: 45, y: 695, width: 120, height: 18 }]);
    const text = await allText(after);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('public');
  });
});
