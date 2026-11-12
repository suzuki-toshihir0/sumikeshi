import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFDict, PDFName, StandardFonts } from 'pdf-lib';
import { createFontModel } from '../../src/redaction/fonts/font-model';

const cmapDir = fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url));
const loader = async (name: string) => new Uint8Array(readFileSync(`${cmapDir}${name}.bcmap`));
const enc = (s: string) => new TextEncoder().encode(s);

describe('フォントの寸法', () => {
  it('標準 14 フォント（Widths なし）: AFM の幅を使う', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    await font.embed(); // pdf-lib は保存の時まで辞書を作らない
    const dict = doc.context.lookup(font.ref) as PDFDict;
    const m = await createFontModel(doc.context, dict);
    const codes = m.split(enc('AV '));
    expect(codes).toHaveLength(3);
    expect(m.advance(codes[0])).toBeCloseTo(0.667);
    expect(m.isWordSpace(codes[2])).toBe(true);
    expect(m.widthKnown(codes[0])).toBe(true);
    // 箱は文字送りの幅で、上下は Helvetica の高さ
    const [x0, y0, x1, y1] = m.box(codes[0]);
    expect([x0, x1]).toEqual([0, 0.667]);
    expect(y0).toBeLessThan(0);
    expect(y1).toBeGreaterThan(0.7);
  });

  it('Widths のある単純フォント', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Foo', FirstChar: 65, LastChar: 66, Widths: [500, 250],
      FontDescriptor: { Ascent: 900, Descent: -300, MissingWidth: 111, FontBBox: [0, -300, 1000, 900] },
    }) as PDFDict;
    const m = await createFontModel(doc.context, dict);
    const c = m.split(enc('ABC'));
    expect(c.map((x) => m.advance(x))).toEqual([0.5, 0.25, 0.111]);
    expect(m.box(c[0])).toEqual([0, -0.3, 0.5, 0.9]);
  });

  it('幅の表が無い、標準でないフォントは「幅が分からない」', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'MysteryFont' }) as PDFDict;
    const m = await createFontModel(doc.context, dict);
    expect(m.widthKnown(m.split(enc('A'))[0])).toBe(false);
  });

  it('Type3: FontMatrix で幅をテキスト空間に移す', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Type: 'Font', Subtype: 'Type3', FontMatrix: [0.01, 0, 0, 0.01, 0, 0], FontBBox: [0, -20, 100, 80],
      FirstChar: 65, LastChar: 65, Widths: [50], CharProcs: {}, Encoding: { Differences: [65, PDFName.of('a')] },
    }) as PDFDict;
    const m = await createFontModel(doc.context, dict);
    const [c] = m.split(enc('A'));
    expect(m.advance(c)).toBeCloseTo(0.5);
    const [, y0, , y1] = m.box(c);
    expect(y0).toBeCloseTo(-0.2);
    expect(y1).toBeCloseTo(0.8);
  });

  it('Type0 + Identity-H: 2 バイトずつ、W の幅', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'X', Encoding: 'Identity-H',
      DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'X', DW: 1000, W: [3, [500, 600], 10, 12, 250] }],
    }) as PDFDict;
    const m = await createFontModel(doc.context, dict);
    const c = m.split(new Uint8Array([0, 3, 0, 4, 0, 11, 0, 99]));
    expect(c.map((x) => x.code)).toEqual([3, 4, 11, 99]);
    expect(c.map((x) => m.advance(x))).toEqual([0.5, 0.6, 0.25, 1]);
    expect(m.vertical).toBe(false);
  });

  it('Type0 + Identity-V: 縦に進み、箱は現在の点の下', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'X', Encoding: 'Identity-V',
      DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'X',
        FontDescriptor: { Ascent: 880, Descent: -120 } }],
    }) as PDFDict;
    const m = await createFontModel(doc.context, dict);
    const [c] = m.split(new Uint8Array([0x12, 0x34]));
    expect(m.vertical).toBe(true);
    expect(m.advance(c)).toBe(-1);
    const [x0, y0, x1, y1] = m.box(c);
    expect(x0).toBeCloseTo(-0.5);
    expect(x1).toBeCloseTo(0.5);
    expect(y0).toBeCloseTo(-1);
    expect(y1).toBeCloseTo(0);
  });

  it('Type0 + 定義済みの CMap（UniJIS-UCS2-H）: CID で幅を引く', async () => {
    const doc = await PDFDocument.create();
    // UniJIS-UCS2-H で U+0041 'A' は CID 34、U+3042 'あ' は CID 843
    const dict = doc.context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'KozMinPr6N-Regular', Encoding: 'UniJIS-UCS2-H',
      DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'KozMinPr6N-Regular', W: [34, [333], 843, [777]] }],
    }) as PDFDict;
    const m = await createFontModel(doc.context, dict, loader);
    const c = m.split(new Uint8Array([0x00, 0x41, 0x30, 0x42]));
    expect(c.map((x) => x.length)).toEqual([2, 2]);
    expect(c.map((x) => m.advance(x))).toEqual([0.333, 0.777]);
  });

  it('Type0 + 1 バイトと 2 バイトが混ざる CMap（90ms-RKSJ-H）', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Mincho', Encoding: '90ms-RKSJ-H',
      DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'MS-Mincho', DW: 1000, W: [231, 325, 500] }],
    }) as PDFDict;
    const m = await createFontModel(doc.context, dict, loader);
    // "A" (1 バイト、半角の CID 231〜) と「あ」(Shift_JIS 0x82A0)
    const c = m.split(new Uint8Array([0x41, 0x82, 0xa0]));
    expect(c.map((x) => x.length)).toEqual([1, 2]);
    expect(m.advance(c[0])).toBe(0.5);
    expect(m.advance(c[1])).toBe(1);
  });

  it('Type0 + 埋め込みの CMap', async () => {
    const doc = await PDFDocument.create();
    const cmapText = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CMapName /Test def /WMode 0 def
1 begincodespacerange <00> <FF> endcodespacerange
1 begincidrange <20> <7e> 1 endcidrange
1 begincidchar <41> 500 endcidchar
endcmap CMapName currentdict /CMap defineresource pop end end`;
    const cmapRef = doc.context.register(doc.context.stream(cmapText, { Type: 'CMap', CMapName: 'Test' }));
    const dict = doc.context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'X', Encoding: cmapRef,
      DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'X', DW: 1000, W: [500, [250], 34, [600]] }],
    }) as PDFDict;
    const m = await createFontModel(doc.context, dict);
    const c = m.split(enc('AB'));
    expect(c.map((x) => x.length)).toEqual([1, 1]);
    // A は cidchar で 500 → 幅 250、B は cidrange で 0x42-0x20+1 = 35 → 既定の 1000
    expect(c.map((x) => m.advance(x))).toEqual([0.25, 1]);
  });
});

export { PDFName };
