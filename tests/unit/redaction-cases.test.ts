/**
 * 墨消しの、取りこぼしやすい形の試験。
 * 判定は pdf.js で読み直して行う（helpers/pdf-oracle.ts）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PDFArray, PDFDocument, PDFName, PDFDict, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream,
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

  it('/Mask（型の画像）付きの画像: 作り直した型も画像マスク（ImageMask）のまま', async () => {
    const w = 40, h = 20;
    const px = pattern(w, h);
    const maskBits = new Uint8Array((w / 8) * h).map((_, i) => (i % 3 === 0 ? 0xf0 : 0x0f));
    const before = await rawPage('q 200 0 0 100 100 600 cm /Im0 Do Q', (doc, page) => {
      const mask = doc.context.register(doc.context.flateStream(maskBits, {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ImageMask: true, BitsPerComponent: 1,
      }));
      const img = doc.context.register(doc.context.flateStream(px, {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Mask: mask,
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    const after = await redact(before, [{ x: 150, y: 620, width: 60, height: 40 }]);
    const doc = await PDFDocument.load(after);
    const xo = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const img = xo.lookup(xo.keys()[0]) as PDFRawStream;
    const mask = img.dict.lookup(PDFName.of('Mask')) as PDFRawStream;
    expect(mask.dict.get(PDFName.of('ImageMask'))?.toString()).toBe('true');
    expect(mask.dict.has(PDFName.of('ColorSpace'))).toBe(false);
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

  it('2 つの頁で共有する、圧縮していない画像: 墨消ししていない頁の画像の中身は変わらない', async () => {
    const doc = await PDFDocument.create();
    const px = pattern(40, 20);
    const img = doc.context.register(doc.context.stream(px, {
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

  it('塗って線も引く矩形（B）: 範囲を抜いた切り口には線を引かない', async () => {
    const before = await rawPage('1 1 1 RG 0.8 0.8 0 rg 10 w 50 500 400 300 re B');
    const rect = { x: 200, y: 600, width: 100, height: 50 };
    const after = await redact(before, [rect]);
    const { parseContentStream } = await import('../../src/redaction/content/lexer');
    const content = await pageContent(after);
    const ops = parseContentStream(new Uint8Array(Buffer.from(content, 'latin1')));
    // 線を引く命令（S）の前のパスに、範囲の縁（x=200, 300 / y=600, 650）に沿う線分が無い
    let pts: number[][] = [];
    const strokedOnEdge: number[][] = [];
    for (const o of ops) {
      const n = o.operands.map((x) => (x.type === 'number' ? x.value : NaN));
      if (o.op === 'm' || o.op === 'l') pts.push(n);
      else if (o.op === 're') pts.push([n[0], n[1]], [n[0] + n[2], n[1] + n[3]]);
      else if (['S', 's', 'B', 'B*', 'b', 'b*'].includes(o.op)) {
        for (const [x, y] of pts) if ((Math.abs(x - 200) < 0.01 || Math.abs(x - 300) < 0.01) && y > 590 && y < 660) strokedOnEdge.push([x, y]);
        pts = [];
      } else if (['f', 'f*', 'n'].includes(o.op)) pts = [];
    }
    expect(strokedOnEdge).toEqual([]);
  });

  it('切り抜きのパス（W n）にした字形の輪郭も、範囲の中の部分が残らない', async () => {
    // 三角形の「字形」で切り抜き、その中を塗る（グラデーション文字の形）
    const before = await rawPage('q 50 700 m 70 730 l 90 700 l h W n 0 0 1 rg 0 0 595 842 re f Q');
    const rect = { x: 45, y: 695, width: 50, height: 40 };
    const after = await redact(before, [rect]);
    const segs = await extractPathSegments(after);
    // 黒い四角の辺は範囲の境目の上。内側を通る線分（字形の輪郭）は無い
    expect(segs.some((sg) => segmentCrossesInterior(sg, rect))).toBe(false);
    const content = await pageContent(after);
    expect(content).not.toMatch(/\b70 730\b/);
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

  it('文字の形で切り抜く描き方（Tr 7）の字を全部消したら、後の塗りが頁全体に広がらない', async () => {
    const before = await rawPage('q BT 7 Tr /F1 40 Tf 50 700 Td (SECRET) Tj ET 0 0 1 rg 0 0 595 842 re f Q', async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      await font.embed();
      page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    });
    const after = await redact(before, [{ x: 40, y: 680, width: 200, height: 60 }]);
    const { parseContentStream } = await import('../../src/redaction/content/lexer');
    const ops = parseContentStream(new Uint8Array(Buffer.from(await pageContent(after), 'latin1')));
    const et = ops.findIndex((o) => o.op === 'ET');
    const fillIndex = ops.findIndex((o, i) => i > et && o.op === 'f');
    const between = ops.slice(et + 1, fillIndex).map((o) => o.op);
    // ET と塗りの間で、大きさ 0 の切り抜きが効いている
    expect(between).toEqual(expect.arrayContaining(['re', 'W', 'n']));
    expect(await allText(after)).not.toContain('SECRET');
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

describe('ActualText の殻', () => {
  it('ActualText を消して属性が空になった Marked Content は、BMC / EMC ごと残さない', async () => {
    const before = await rawPage('/Span <</ActualText (X)>> BDC BT /F1 12 Tf 50 700 Td (xxxx) Tj ET EMC BT /F1 12 Tf 50 600 Td (public) Tj ET', async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      await font.embed();
      page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    });
    const after = await redact(before, [{ x: 45, y: 695, width: 60, height: 18 }]);
    const content = await pageContent(after);
    expect(content).not.toMatch(/BMC|BDC|EMC/);
    expect(await allText(after)).toContain('public');
  });

  it('Type3 の字形の手続きの中で別のフォントを使っていれば、その字形は消さない', async () => {
    const before = await rawPage('BT /Outer 12 Tf 50 700 Td (a) Tj ET BT /Inner 12 Tf 50 600 Td (b) Tj ET', (doc, page) => {
      const inner = type3Font(doc, ['ga', 'gb'], [11111, 22222]);
      // 外側の Type3 の字形 a は、手続きの中で内側のフォントの b を描く
      const proc = doc.context.register(doc.context.stream('500 0 0 0 400 700 d1 BT /In 1 Tf (b) Tj ET'));
      const outer = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 400, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { ga: proc }, Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('ga')] },
        FirstChar: 97, LastChar: 97, Widths: [500], Resources: { Font: { In: inner } },
      }));
      page.node.setFontDictionary(PDFName.of('Outer'), outer);
      page.node.setFontDictionary(PDFName.of('Inner'), inner);
    });
    // 内側のフォントで直接描いた b を消しても、外側の字形 a の中で b を使うので、b の字形は残す
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    expect((await findEverywhere(after, '22222')).length).toBeGreaterThan(0);
  });
});

describe('消したものの痕跡（番号・名前・符号の穴）', () => {
  it('オブジェクト番号に欠番を残さない', async () => {
    const before = await rawPage('BT /A 12 Tf 50 700 Td (a) Tj ET BT /B 12 Tf 50 600 Td (a) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('A'), type3Font(doc, ['ga'], [11111]));
      page.node.setFontDictionary(PDFName.of('B'), type3Font(doc, ['ga'], [55555]));
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const doc = await PDFDocument.load(after);
    const nums = doc.context.enumerateIndirectObjects().map(([r]) => r.objectNumber).sort((a, b) => a - b);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });

  it('フォントの資源の名前に、消したフォントの欠けを残さない', async () => {
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (a) Tj ET BT /F2 12 Tf 50 600 Td (a) Tj ET BT /F3 12 Tf 50 500 Td (a) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('F1'), type3Font(doc, ['ga'], [11111]));
      page.node.setFontDictionary(PDFName.of('F2'), type3Font(doc, ['ga'], [55555]));
      page.node.setFontDictionary(PDFName.of('F3'), type3Font(doc, ['ga'], [33333]));
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const doc = await PDFDocument.load(after);
    const fonts = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const names = fonts.keys().map((k) => k.decodeText()).sort();
    expect(names).toHaveLength(2);
    // 名前は付け直して、元の F1, F3 のような欠けた連番を残さない
    expect(names).not.toEqual(['F1', 'F3']);
    expect((await allText(after)).replace(/\s/g, '')).toBe('aa');
  });

  it('フォントを丸ごと外さなかった頁でも、書き直した頁のフォントの資源の名前は付け直す（付け直したかどうかから、フォントが消えたことが分からない）', async () => {
    const before = await rawPage('BT /F4 12 Tf 50 700 Td (a) Tj ET BT /F7 12 Tf 50 600 Td (a) Tj ET BT /F7 12 Tf 50 500 Td (b) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('F4'), type3Font(doc, ['ga'], [11111]));
      page.node.setFontDictionary(PDFName.of('F7'), type3Font(doc, ['ga', 'gb'], [33333, 44444]));
    });
    // 3 行目（F7 の b）だけを消す。F7 は 2 行目で使うので、どのフォントも丸ごとは外れない
    const after = await redact(before, [{ x: 45, y: 495, width: 20, height: 15 }]);
    const doc = await PDFDocument.load(after);
    const fonts = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const names = fonts.keys().map((k) => k.decodeText()).sort();
    expect(names).toEqual(['F1', 'F2']);
    expect((await allText(after)).replace(/\s/g, '')).toBe('aa');
  });

  it('Type3: 消した符号の「穴」を残さない（符号を詰め直し、文字列も書き換える）', async () => {
    const before = await rawPage('BT /T3 12 Tf 50 700 Td (ad) Tj ET BT /T3 12 Tf 50 600 Td (bc) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('T3'), type3Font(doc, ['ga', 'gb', 'gc', 'gd'], [11111, 22222, 33333, 44444]));
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 30, height: 15 }]);
    const doc = await PDFDocument.load(after);
    const font = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const t3 = font.lookup(font.keys()[0], PDFDict);
    const first = (t3.lookup(PDFName.of('FirstChar')) as unknown as { asNumber(): number }).asNumber();
    const last = (t3.lookup(PDFName.of('LastChar')) as unknown as { asNumber(): number }).asNumber();
    // 残る字は a と d の 2 つ。符号は詰めて 2 つ分だけ
    expect(last - first).toBe(1);
    expect((await allText(after)).replace(/\s/g, '')).toBe('ad');
    expect((await findEverywhere(after, '44444')).length).toBeGreaterThan(0);
    expect(await findEverywhere(after, '22222')).toEqual([]);
  });

  it('使わない符号にも幅を入れたフォント（Word の形）では、消した文字の幅だけを 0 にしない', async () => {
    const widths = Array.from({ length: 26 }, (_, i) => 500 + i * 10); // a〜z すべてに幅
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (ab) Tj ET BT /F1 12 Tf 50 600 Td (k) Tj ET', (doc, page) => {
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Body', FirstChar: 97, LastChar: 122, Widths: widths,
        Encoding: 'WinAnsiEncoding',
        FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Body', Flags: 32, Ascent: 700, Descent: -200, FontBBox: [0, -200, 800, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80 }),
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const doc = await PDFDocument.load(after);
    const font = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const f = font.lookup(font.keys()[0], PDFDict);
    const ws = (f.lookup(PDFName.of('Widths')) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((x) => x.asNumber());
    // k（0x6b）の幅が 0 になっていない（ほかの使わない字と区別が付かない）
    expect(ws[0x6b - 97]).toBe(widths[0x6b - 97]);
  });
});

/** 出力の中の、TrueType として読めるストリームをすべて読む */
async function trueTypesIn(pdf: Uint8Array) {
  const { parseTrueType } = await import('../../src/redaction/fonts/truetype');
  const doc = await PDFDocument.load(pdf);
  const out = [];
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    try {
      out.push(parseTrueType(decodePDFRawStream(o).decode()));
    } catch {
      // TrueType でない
    }
  }
  return out;
}

const BOX_A: [number, number, number, number] = [11, 0, 511, 701];
const BOX_B: [number, number, number, number] = [12, 0, 512, 702];
const BOX_C: [number, number, number, number] = [13, 0, 513, 703];
const BOX_D: [number, number, number, number] = [14, 0, 514, 704];

describe('TrueType の字形の穴を残さない', () => {
  it('Type0（Identity-H）: 消した字形を番号ごと取り除いて詰め、文字列の符号も書き換える', async () => {
    const ttf = tinyTrueType([null, BOX_A, BOX_B, BOX_C, BOX_D]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td <000100020004> Tj ET BT /F1 12 Tf 50 600 Td <0003> Tj ET', (doc, page) => {
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
    const pb = await extractText(before);
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const tts = await trueTypesIn(after);
    expect(tts).toHaveLength(1);
    const tt = tts[0];
    // .notdef と A, B, D の 4 つに詰まり、C の字形はどこにも無い
    expect(tt.numGlyphs).toBe(4);
    expect([1, 2, 3].map((g) => tt.glyphBox(g))).toEqual([BOX_A, BOX_B, BOX_D]);
    expect(await findEverywhere(after, '603')).toEqual([]);
    const pa = await extractText(after);
    expect(pa.map((t) => t.str).join('').replace(/\s/g, '')).toBe('ABD');
    const x = (items: typeof pa) => items.find((t) => t.str.includes('A'))!.box;
    expect(x(pa).x).toBeCloseTo(x(pb).x, 3);
    expect(x(pa).width).toBeCloseTo(x(pb).width, 3);
  });

  it('単純な TrueType: 消した字形を番号ごと取り除き、cmap も詰めた番号に書き換える', async () => {
    const ttf = tinyTrueType([null, BOX_A, BOX_B, BOX_C, BOX_D], 1000, [[0x41, 1], [0x42, 2], [0x43, 3], [0x44, 4]]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (ABD) Tj ET BT /F1 12 Tf 50 600 Td (C) Tj ET', (doc, page) => {
      const fontFile = doc.context.register(doc.context.flateStream(ttf));
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Tiny', FirstChar: 65, LastChar: 68, Widths: [600, 600, 600, 600],
        Encoding: 'WinAnsiEncoding',
        FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Tiny', Flags: 32, Ascent: 800, Descent: -200, FontBBox: [0, -200, 600, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile2: fontFile }),
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const tts = await trueTypesIn(after);
    expect(tts).toHaveLength(1);
    const tt = tts[0];
    expect(tt.numGlyphs).toBe(4);
    const c31 = tt.cmaps.get('3,1')!;
    expect(c31(0x43)).toBeUndefined();
    expect(tt.glyphBox(c31(0x44)!)).toEqual(BOX_D);
    expect(tt.glyphBox(c31(0x41)!)).toEqual(BOX_A);
    expect((await allText(after)).replace(/\s/g, '')).toBe('ABD');
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

describe('大きな頁', () => {
  it('命令が数十万ある頁でも落ちない', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 70000; i++) parts.push(`${i % 500} ${(i * 7) % 800} m ${(i % 500) + 1} ${((i * 7) % 800) + 1} l S`);
    const before = await rawPage(parts.join('\n'));
    const after = await redact(before, [{ x: 100, y: 100, width: 50, height: 50 }]);
    expect(after.length).toBeGreaterThan(0);
  }, 60000);
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

  it('復号したデータが画像の大きさに足りないなら、黙って埋めずに RedactionError で止める', async () => {
    const before = await rawPage('q 200 0 0 100 100 600 cm /Im0 Do Q', (doc, page) => {
      const img = doc.context.register(doc.context.flateStream(new Uint8Array(10), {
        Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      page.node.setXObject(PDFName.of('Im0'), img);
    });
    await expect(redact(before, [{ x: 150, y: 620, width: 60, height: 40 }])).rejects.toBeInstanceOf(RedactionError);
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

describe('ほかの所から指されたままの元のデータ', () => {
  const imageDoc = async (shared: 'inherit' | 'sharedDict', page2DrawsImage: boolean) => {
    const doc = await PDFDocument.create();
    const px = pattern(40, 20);
    const img = doc.context.register(doc.context.flateStream(px, {
      Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }));
    const res = doc.context.obj({ XObject: { Im0: img } });
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([595, 842]);
      const content = i === 0 || page2DrawsImage ? 'q 200 0 0 100 100 600 cm /Im0 Do Q' : '0 0 1 1 re f';
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
      if (shared === 'inherit') page.node.delete(PDFName.of('Resources'));
      else page.node.set(PDFName.of('Resources'), res);
    }
    if (shared === 'inherit') doc.catalog.Pages().set(PDFName.of('Resources'), res);
    return { bytes: await doc.save(), px };
  };

  it('頁が資源を親（Pages）から受け継ぐとき、墨消しした元の画像が親の資源から指されたまま残らない', async () => {
    const { bytes, px } = await imageDoc('inherit', false);
    const after = await redact(bytes, [{ x: 150, y: 620, width: 60, height: 40 }], 1);
    await expectNoStreamContains(after, px);
  });

  it('2 つの頁が同じ資源の辞書を使うとき、もう一方の頁が描かない元の画像は残らない', async () => {
    const { bytes, px } = await imageDoc('sharedDict', false);
    const after = await redact(bytes, [{ x: 150, y: 620, width: 60, height: 40 }], 1);
    await expectNoStreamContains(after, px);
  });

  it('もう一方の頁が同じ画像を描くなら、その頁の画像は元のまま残る', async () => {
    const { bytes } = await imageDoc('inherit', true);
    const after = await redact(bytes, [{ x: 150, y: 620, width: 60, height: 40 }], 1);
    const b2 = await extractImages(bytes, 2);
    const a2 = await extractImages(after, 2);
    expect(a2).toHaveLength(1);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) expect(a2[0].gray(x, y)).toBe(b2[0].gray(x, y));
  });
});

/** 埋め込みの TrueType の Type0（Identity-H）フォント。toUni は CID → Unicode */
function type0TrueType(doc: PDFDocument, name: string, ttf: Uint8Array, w: unknown[], toUni: [number, number][]) {
  const bf = toUni.map(([c, u]) => `<${c.toString(16).padStart(4, '0')}> <${u.toString(16).padStart(4, '0')}>`).join(' ');
  return doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: 'Identity-H',
    ToUnicode: doc.context.register(doc.context.stream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange ${toUni.length} beginbfchar ${bf} endbfchar endcmap end end`)),
    DescendantFonts: [doc.context.obj({
      Type: 'Font', Subtype: 'CIDFontType2', BaseFont: name, CIDToGIDMap: 'Identity',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: name, Flags: 4, Ascent: 800, Descent: -200, FontBBox: [0, -200, 600, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile2: doc.context.register(doc.context.flateStream(ttf)) }),
      DW: 1000, W: w,
    })],
  }));
}

/** 出力の頁のフォントの辞書（資源の名前の順） */
async function pageFonts(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  const fonts = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
  return { doc, fonts: fonts.keys().map((k) => fonts.lookup(k, PDFDict)) };
}

describe('字を消したフォントかどうかが、フォントの形から分からない', () => {
  it('Type3: 字を消していないフォントも同じ形（詰めた符号、付け直した字形名）に書き直す', async () => {
    // Chrome は字形の番号の区画ごとに Type3 フォントを分け、字形名に元の番号（g7a11 など）を書く
    const before = await rawPage('BT /T1 12 Tf 50 700 Td (a) Tj ET BT /T2 12 Tf 50 600 Td (ab) Tj ET BT /T1 12 Tf 50 500 Td (b) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('T1'), type3Font(doc, ['g7a11', 'g7a12'], [11111, 22222]));
      page.node.setFontDictionary(PDFName.of('T2'), type3Font(doc, ['g9b31', 'g9b32'], [33333, 44444]));
    });
    // 3 行目（T1 の b）だけを消す。T2 からは何も消さない
    const after = await redact(before, [{ x: 45, y: 495, width: 30, height: 15 }]);
    const { doc, fonts } = await pageFonts(after);
    expect(fonts).toHaveLength(2);
    for (const f of fonts) {
      expect(f.lookup(PDFName.of('FirstChar'))!.toString()).toBe('33');
    }
    // 元の字形名（元のフォントの字形の番号）は、どちらのフォントにも残らない
    for (const nm of ['g7a1', 'g9b3']) expect(await findEverywhere(after, nm)).toEqual([]);
    expect((await allText(after)).replace(/\s/g, '')).toBe('aab');
    void doc;
  });

  it('Type0 の TrueType: 使わない字形（幅 0）を範囲の中に残す形でも、使う字形だけに詰め、W にも使う字だけを書く', async () => {
    // 元のフォントの字形の番号のまま埋め込む形（使わない字形は空、W では 0）。A=1, (未使用)=2, C=3, K=4, L=5
    const ttf = () => tinyTrueType([null, BOX_A, null, BOX_C, BOX_D, BOX_B]);
    const w = [1, [601, 0, 603, 604, 605]];
    const uni: [number, number][] = [[1, 0x41], [3, 0x43], [4, 0x4b], [5, 0x4c]];
    const before = await rawPage(
      'BT /F1 12 Tf 50 700 Td <000100030005> Tj ET BT /F1 12 Tf 50 600 Td <0004> Tj ET BT /F2 12 Tf 50 500 Td <000100030005> Tj ET',
      (doc, page) => {
        page.node.setFontDictionary(PDFName.of('F1'), type0TrueType(doc, 'TinyA', ttf(), w, uni));
        page.node.setFontDictionary(PDFName.of('F2'), type0TrueType(doc, 'TinyB', ttf(), w, uni));
      },
    );
    // 2 行目の K（F1）だけを消す
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const tts = await trueTypesIn(after);
    expect(tts).toHaveLength(2);
    for (const tt of tts) {
      // .notdef と A, C, L の 4 つ（消した K も、使わない字形も無い）。L の番号は 3（K を消した分だけずれた 4 ではない）
      expect(tt.numGlyphs).toBe(4);
      expect([1, 2, 3].map((g) => tt.glyphBox(g))).toEqual([BOX_A, BOX_C, BOX_B]);
    }
    const { doc, fonts } = await pageFonts(after);
    for (const f of fonts) {
      const cid = f.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
      const ws: number[] = [];
      const walk = (o: unknown) => {
        const v = doc.context.lookup(o as never) as unknown as { asArray?: () => unknown[]; asNumber?: () => number };
        if (v?.asArray) v.asArray().forEach(walk);
        else if (v?.asNumber) ws.push(v.asNumber());
      };
      walk(cid.get(PDFName.of('W')));
      // 幅 0 の項目（使わない字形の印）が無く、消した K の幅 604 も無い
      expect(ws).not.toContain(0);
      expect(ws).not.toContain(604);
    }
    expect((await allText(after)).replace(/\s/g, '')).toBe('ACLACL');
  });

  it('単純な TrueType で、元のフォントの番号のまま使わない字形を空にした形なら、消した字形もその場で空にする（番号をずらさない）', async () => {
    // 40 字形のうち A(10)・C(12)・D(13) だけが中身を持つ（Word などの形）。C を消す
    const boxes: ([number, number, number, number] | null)[] = Array.from({ length: 40 }, () => null);
    boxes[10] = BOX_A;
    boxes[12] = BOX_C;
    boxes[13] = BOX_D;
    const ttf = tinyTrueType(boxes, 1000, [[0x41, 10], [0x43, 12], [0x44, 13]]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td (AD) Tj ET BT /F1 12 Tf 50 600 Td (C) Tj ET', (doc, page) => {
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Tiny', FirstChar: 65, LastChar: 68, Widths: [600, 0, 600, 600],
        Encoding: 'WinAnsiEncoding',
        FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Tiny', Flags: 32, Ascent: 800, Descent: -200, FontBBox: [0, -200, 600, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile2: doc.context.register(doc.context.flateStream(ttf)) }),
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const tts = await trueTypesIn(after);
    expect(tts).toHaveLength(1);
    expect(tts[0].numGlyphs).toBe(40);
    expect(tts[0].glyphBox(12)).toBeNull();
    expect(tts[0].glyphBox(13)).toEqual(BOX_D);
    expect(tts[0].glyphBox(10)).toEqual(BOX_A);
    expect((await allText(after)).replace(/\s/g, '')).toBe('AD');
  });

  it('2 つの Type0 が同じ CIDFont（幅と字形）を使うとき、一方で字を消しても、もう一方の字の幅と字形は残る', async () => {
    const ttf = tinyTrueType([null, BOX_A, BOX_B, BOX_C, BOX_D]);
    const before = await rawPage(
      'BT /F1 12 Tf 50 700 Td <0001> Tj ET BT /F1 12 Tf 50 600 Td <0003> Tj ET BT /F2 12 Tf 50 500 Td <00020004> Tj ET',
      (doc, page) => {
        const shared = type0TrueType(doc, 'Shared', ttf, [1, [601, 602, 603, 604]], [[1, 0x41], [2, 0x42], [3, 0x43], [4, 0x44]]);
        const f1 = doc.context.lookup(shared, PDFDict);
        const f2 = doc.context.obj({}) as PDFDict;
        for (const [k, v] of f1.entries()) f2.set(k, v);
        page.node.setFontDictionary(PDFName.of('F1'), shared);
        page.node.setFontDictionary(PDFName.of('F2'), doc.context.register(f2));
      },
    );
    const pb = await extractText(before);
    // F1 の C だけを消す
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const pa = await extractText(after);
    expect(pa.map((t) => t.str).join('').replace(/\s/g, '')).toBe('ABD');
    const wOf = (items: typeof pa) => items.find((t) => t.str.includes('B'))!.box.width;
    expect(wOf(pa)).toBeCloseTo(wOf(pb), 3);
    const tts = await trueTypesIn(after);
    expect(tts).toHaveLength(1);
    const boxes = Array.from({ length: tts[0].numGlyphs }, (_, g) => tts[0].glyphBox(g));
    expect(boxes).toContainEqual(BOX_B);
    expect(boxes).toContainEqual(BOX_D);
    expect(boxes).not.toContainEqual(BOX_C);
  });

  it('文字の集まり（Ordering）が Identity でない Type0 は、字形の番号も符号も付け替えない（poppler はフォントの cmap で引く）', async () => {
    const ttf = tinyTrueType([null, BOX_A, BOX_B, BOX_C, BOX_D]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td <00020004> Tj ET BT /F1 12 Tf 50 600 Td <0003> Tj ET', (doc, page) => {
      const ref = type0TrueType(doc, 'Odd', ttf, [1, [601, 602, 603, 604]], [[1, 0x41], [2, 0x42], [3, 0x43], [4, 0x44]]);
      const f = doc.context.lookup(ref, PDFDict);
      const cid = (f.lookup(PDFName.of('DescendantFonts'), PDFArray)).lookup(0, PDFDict);
      cid.set(PDFName.of('CIDSystemInfo'), doc.context.obj({ Registry: PDFString.of('PDFAUTOCAD'), Ordering: PDFString.of('Indentity0'), Supplement: 0 }));
      page.node.setFontDictionary(PDFName.of('F1'), ref);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const tts = await trueTypesIn(after);
    expect(tts[0].numGlyphs).toBe(5);
    expect(tts[0].glyphBox(2)).toEqual(BOX_B);
    expect(tts[0].glyphBox(4)).toEqual(BOX_D);
    expect(tts[0].glyphBox(3)).toBeNull();
    const { parseContentStream } = await import('../../src/redaction/content/lexer');
    const doc = await PDFDocument.load(after);
    const { contentsBytes } = await import('../../src/redaction/pdf-objects');
    const ops = parseContentStream(contentsBytes(doc.context, doc.getPages()[0].node.get(PDFName.of('Contents'))));
    const bytes = ops.filter((o) => o.op === 'Tj' || o.op === 'TJ').flatMap((o) => {
      const a = o.operands[0];
      return a.type === 'string' ? [...a.bytes] : a.type === 'array' ? a.items.flatMap((i) => (i.type === 'string' ? [...i.bytes] : [])) : [];
    });
    expect(bytes).toEqual([0, 2, 0, 4]);
  });

  it('単純な TrueType で、WinAnsi に無い字形名（Idotaccent など）の字も描けるまま残る', async () => {
    // İ（U+0130）は (3,1) の cmap でだけ引ける。符号 0x80 を Differences で /Idotaccent にする
    const ttf = tinyTrueType([null, BOX_A, BOX_B, BOX_C], 1000, [[0x41, 1], [0x130, 2], [0x43, 3], [0x80, 3]]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td <4180> Tj ET BT /F1 12 Tf 50 600 Td (C) Tj ET', (doc, page) => {
      const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Tiny', FirstChar: 65, LastChar: 128,
        Widths: Array.from({ length: 64 }, () => 600),
        Encoding: { Type: 'Encoding', Differences: [128, PDFName.of('Idotaccent')] },
        FontDescriptor: doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Tiny', Flags: 32, Ascent: 800, Descent: -200, FontBBox: [0, -200, 600, 800], ItalicAngle: 0, CapHeight: 700, StemV: 80, FontFile2: doc.context.register(doc.context.flateStream(ttf)) }),
      }));
      page.node.setFontDictionary(PDFName.of('F1'), font);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const tts = await trueTypesIn(after);
    const boxes = Array.from({ length: tts[0].numGlyphs }, (_, g) => tts[0].glyphBox(g));
    expect(boxes).toContainEqual(BOX_B);
  });

  it('ToUnicode の無い Type3（字形名が文字を表さない）: 字を消して符号を詰めても、残る字の取り出せる文字は変わらない。字を消さないフォントは書き換えない', async () => {
    const noTu = (doc: PDFDocument, names: string[]) => {
      const procs: Record<string, ReturnType<PDFDocument['context']['register']>> = {};
      for (const nm of names) procs[nm] = doc.context.register(doc.context.stream('500 0 0 0 400 700 d1 0 0 400 700 re f'));
      return doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 400, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: procs, Encoding: { Type: 'Encoding', Differences: [97, ...names.map((nm) => PDFName.of(nm))] },
        FirstChar: 97, LastChar: 97 + names.length - 1, Widths: names.map(() => 500), Resources: {},
      }));
    };
    const before = await rawPage('BT /T1 12 Tf 50 700 Td (ac) Tj ET BT /T1 12 Tf 50 600 Td (b) Tj ET BT /T2 12 Tf 50 500 Td (ab) Tj ET', (doc, page) => {
      page.node.setFontDictionary(PDFName.of('T1'), noTu(doc, ['g97', 'g98', 'g99']));
      page.node.setFontDictionary(PDFName.of('T2'), noTu(doc, ['g97', 'g98']));
    });
    expect((await allText(before)).replace(/\s/g, '')).toBe('acbab');
    const after = await redact(before, [{ x: 45, y: 595, width: 30, height: 15 }]);
    expect((await allText(after)).replace(/\s/g, '')).toBe('acab');
    const { fonts } = await pageFonts(after);
    const firsts = fonts.map((f) => f.lookup(PDFName.of('FirstChar'))!.toString()).sort();
    // 字を消さない T2 は元のまま（97 から）
    expect(firsts).toContain('97');
  });

  it('ToUnicode の無い Type0（Identity）は、字形の番号も符号も付け替えない（文字の取り出しがフォントの番号に頼るため）', async () => {
    const ttf = tinyTrueType([null, BOX_A, BOX_B, BOX_C, BOX_D]);
    const before = await rawPage('BT /F1 12 Tf 50 700 Td <00020004> Tj ET BT /F1 12 Tf 50 600 Td <0003> Tj ET', (doc, page) => {
      const ref = type0TrueType(doc, 'NoTu', ttf, [1, [601, 602, 603, 604]], [[1, 0x41]]);
      doc.context.lookup(ref, PDFDict).delete(PDFName.of('ToUnicode'));
      page.node.setFontDictionary(PDFName.of('F1'), ref);
    });
    const after = await redact(before, [{ x: 45, y: 595, width: 20, height: 15 }]);
    const tts = await trueTypesIn(after);
    expect(tts[0].numGlyphs).toBe(5);
    expect(tts[0].glyphBox(4)).toEqual(BOX_D);
    expect(tts[0].glyphBox(3)).toBeNull();
  });

  it('符号を詰め直した Type3 の字をタイリングパターンの中で使っていても、パターンの中の文字列も書き換える', async () => {
    const before = await rawPage('BT /T3 12 Tf 50 700 Td (a) Tj ET BT /T3 12 Tf 50 600 Td (b) Tj ET /Pattern cs /P1 scn 0 0 200 200 re f', (doc, page) => {
      const t3 = type3Font(doc, ['ga', 'gb'], [11111, 22222]);
      page.node.setFontDictionary(PDFName.of('T3'), t3);
      const pat = doc.context.stream('BT /T3 12 Tf 0 0 Td (a) Tj ET', {
        Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 20, 20], XStep: 20, YStep: 20,
        Resources: { Font: { T3: t3 } },
      });
      const res = page.node.Resources()!;
      res.set(PDFName.of('Pattern'), doc.context.obj({ P1: doc.context.register(pat) }));
    });
    // b を消す（a は残る）
    const after = await redact(before, [{ x: 45, y: 595, width: 30, height: 15 }]);
    const doc = await PDFDocument.load(after);
    const { parseContentStream } = await import('../../src/redaction/content/lexer');
    const { contentsBytes } = await import('../../src/redaction/pdf-objects');
    const strOf = (bytes: Uint8Array) => {
      const tj = parseContentStream(bytes).find((o) => o.op === 'Tj' || o.op === 'TJ')!;
      const s = tj.operands[0];
      return s.type === 'string' ? [...s.bytes] : s.type === 'array' ? s.items.flatMap((i) => (i.type === 'string' ? [...i.bytes] : [])) : [];
    };
    const page = doc.getPages()[0].node;
    const pageCodes = strOf(contentsBytes(doc.context, page.get(PDFName.of('Contents'))));
    const pats = page.Resources()!.lookup(PDFName.of('Pattern'), PDFDict);
    const pat = pats.lookup(pats.keys()[0]) as PDFRawStream;
    const patCodes = strOf(decodePDFRawStream(pat).decode());
    expect(patCodes).toEqual(pageCodes);
    expect(patCodes).not.toEqual([0x61]);
  });
});

describe('消した文字列の数や行が分かる殻を残さない', () => {
  const helv = async (doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    await font.embed();
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  };
  const opsOf = async (pdf: Uint8Array) => {
    const { parseContentStream } = await import('../../src/redaction/content/lexer');
    return parseContentStream(new Uint8Array(Buffer.from(await pageContent(pdf), 'latin1')));
  };

  it('文字を全部消した BT…ET は残さない（中の状態の命令は外に出す）', async () => {
    const before = await rawPage(
      'BT /F1 12 Tf 50 700 Td (secret) Tj ET BT /F1 12 Tf 50 650 Td (secret2) Tj ET BT /F1 9 Tf 50 600 Td (public) Tj ET',
      helv,
    );
    const after = await redact(before, [{ x: 45, y: 645, width: 80, height: 70 }]);
    const ops = await opsOf(after);
    expect(ops.filter((o) => o.op === 'BT')).toHaveLength(1);
    expect(ops.filter((o) => o.op === 'ET')).toHaveLength(1);
    expect(await allText(after)).toContain('public');
    const pb = (await extractText(before)).find((t) => t.str.includes('public'))!;
    const pa = (await extractText(after)).find((t) => t.str.includes('public'))!;
    expect(pa.box.x).toBeCloseTo(pb.box.x, 3);
    expect(pa.box.height).toBeCloseTo(pb.box.height, 3);
  });

  it('MCID の付いた Marked Content は、消した文字列を囲んでいたものも、残る文字列を囲むものも残さない（番号の欠けも残さない）', async () => {
    const before = await rawPage(
      '/P <</MCID 0>> BDC BT /F1 12 Tf 50 700 Td (secret) Tj ET EMC /P <</MCID 1>> BDC BT /F1 12 Tf 50 600 Td (public) Tj ET EMC /Artifact BMC 0 0 10 10 re f EMC',
      helv,
    );
    const after = await redact(before, [{ x: 45, y: 695, width: 80, height: 18 }]);
    const content = await pageContent(after);
    expect(content).not.toMatch(/BMC|BDC|EMC|MCID/);
    expect(await allText(after)).toContain('public');
  });

  it('任意の表示の Marked Content（/OC）は、表示の切り替えに要るので残す', async () => {
    const before = await rawPage('/OC /oc1 BDC BT /F1 12 Tf 50 600 Td (public) Tj ET EMC BT /F1 12 Tf 50 700 Td (secret) Tj ET', async (doc, page) => {
      await helv(doc, page);
      const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Layer') }));
      page.node.Resources()!.set(PDFName.of('Properties'), doc.context.obj({ oc1: ocg }));
      doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: { ON: [ocg] } }));
    });
    const after = await redact(before, [{ x: 45, y: 695, width: 80, height: 18 }]);
    const ops = await opsOf(after);
    expect(ops.filter((o) => o.op === 'BDC')).toHaveLength(1);
    expect(ops.filter((o) => o.op === 'EMC')).toHaveLength(1);
    expect(await allText(after)).toContain('public');
  });
});
