import { describe, it, expect } from 'vitest';
import { parseContentStream, type Operand } from '../../src/redaction/content/lexer';
import { serializeOperations } from '../../src/redaction/content/writer';

const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('parseContentStream', () => {
  it('数値・名前・オペレーターを読む', () => {
    const ops = parseContentStream(enc('q 1 0 0 1 50.5 -.25 cm /F1 12 Tf Q'));
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'Tf', 'Q']);
    expect(ops[1].operands).toEqual([1, 0, 0, 1, 50.5, -0.25].map((value) => ({ type: 'number', value })));
    expect(ops[2].operands[0]).toEqual({ type: 'name', value: 'F1' });
  });

  it('文字列リテラルのエスケープと入れ子の括弧を読む', () => {
    const ops = parseContentStream(enc('(a\\(b\\)c (d) \\101\\n\\\\) Tj'));
    const s = ops[0].operands[0] as Extract<Operand, { type: 'string' }>;
    expect(latin1(s.bytes)).toBe('a(b)c (d) A\n\\');
  });

  it('16 進の文字列を読み、奇数桁は 0 で補う', () => {
    const ops = parseContentStream(enc('<30 31 3> Tj'));
    const s = ops[0].operands[0] as Extract<Operand, { type: 'string' }>;
    expect(Array.from(s.bytes)).toEqual([0x30, 0x31, 0x30]);
    expect(s.hex).toBe(true);
  });

  it('TJ の配列と、BDC の辞書を読む', () => {
    const ops = parseContentStream(enc('/Span <</ActualText (x) /MCID 3>> BDC [(A) -120 <42>] TJ EMC'));
    expect(ops[0].op).toBe('BDC');
    const dict = ops[0].operands[1] as Extract<Operand, { type: 'dict' }>;
    expect(dict.type).toBe('dict');
    expect(dict.entries.map(([k]) => k)).toEqual(['ActualText', 'MCID']);
    const arr = ops[1].operands[0] as Extract<Operand, { type: 'array' }>;
    expect(arr.items).toHaveLength(3);
    expect(arr.items[1]).toEqual({ type: 'number', value: -120 });
  });

  it('名前の #xx を戻す', () => {
    const ops = parseContentStream(enc('/A#20B gs'));
    expect(ops[0].operands[0]).toEqual({ type: 'name', value: 'A B' });
  });

  it('コメントを読み飛ばす', () => {
    const ops = parseContentStream(enc('% comment Tj\nq Q'));
    expect(ops.map((o) => o.op)).toEqual(['q', 'Q']);
  });

  it('インライン画像（フィルターなし）を、データの長さから切り出す', () => {
    // 2x1 の 8bit グレー。データに "EI" を含めても、長さで切り出せる
    const bytes = new Uint8Array([...enc('q BI /W 2 /H 1 /BPC 8 /CS /G ID '), 0x45, 0x49, ...enc('\nEI Q')]);
    const ops = parseContentStream(bytes);
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q']);
    expect(Array.from(ops[1].inlineImage!.data)).toEqual([0x45, 0x49]);
    expect(ops[1].inlineImage!.dict.map(([k]) => k)).toEqual(['W', 'H', 'BPC', 'CS']);
  });

  it('インライン画像（フィルター付き）を、空白に挟まれた EI で切り出す', () => {
    const bytes = new Uint8Array([...enc('BI /W 1 /H 1 /F /AHx ID\n00>\nEI\nQ')]);
    const ops = parseContentStream(bytes);
    expect(ops.map((o) => o.op)).toEqual(['BI', 'Q']);
    expect(latin1(ops[0].inlineImage!.data)).toBe('00>');
  });

  it('余計な ) や > は読み飛ばす（pdf.js と同じ扱い）', () => {
    const ops = parseContentStream(enc('q ) 1 0 0 1 5 5 cm > Q'));
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'Q']);
    expect(ops[1].operands).toHaveLength(6);
  });

  it('true / false / null を読む', () => {
    const ops = parseContentStream(enc('/X <</A true /B false /C null>> BDC'));
    const dict = ops[0].operands[1] as Extract<Operand, { type: 'dict' }>;
    expect(dict.entries.map(([, v]) => v)).toEqual([
      { type: 'bool', value: true }, { type: 'bool', value: false }, { type: 'null' },
    ]);
  });
});

describe('serializeOperations', () => {
  it('読んだものを書き戻すと、同じ操作列に読める', () => {
    const src = 'q 1 0 0 1 50.5 -0.25 cm BT /F1 12 Tf [(A\\)) -120 <42ff>] TJ ET /Span <</MCID 3 /T (x)>> BDC EMC Q';
    const ops = parseContentStream(enc(src));
    const again = parseContentStream(serializeOperations(ops));
    expect(again).toEqual(ops);
  });

  it('インライン画像を書き戻せる', () => {
    const bytes = new Uint8Array([...enc('BI /W 2 /H 1 /BPC 8 /CS /G ID '), 0x00, 0xff, ...enc('\nEI')]);
    const ops = parseContentStream(bytes);
    const again = parseContentStream(serializeOperations(ops));
    expect(again).toEqual(ops);
  });

  it('数値は指数表記にしない', () => {
    const out = latin1(serializeOperations([{ op: 'cm', operands: [1e-7, 0, 0, 1, 123456789.5, 0].map((value) => ({ type: 'number' as const, value })) }]));
    expect(out).not.toMatch(/e/);
  });
});
