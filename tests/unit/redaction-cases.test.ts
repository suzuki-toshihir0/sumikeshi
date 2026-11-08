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
  const n = Buffer.from(needle);
  expect(Buffer.from(after).includes(n)).toBe(false);
  const doc = await PDFDocument.load(after);
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let data: Uint8Array;
    try {
      data = decodePDFRawStream(obj).decode();
    } catch {
      continue;
    }
    expect(Buffer.from(data).includes(n), `${ref} に残っている`).toBe(false);
  }
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
    expect(Buffer.from(after).includes(Buffer.from('secret@example.com'))).toBe(false);
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
