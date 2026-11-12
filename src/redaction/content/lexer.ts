/**
 * ContentStream の字句解析・構文解析。
 *
 * 墨消しでは、文字・画像・パスの位置を正確に追う必要があるため、
 * 正規表現ではなく PDF の構文（ISO 32000-1 7.2〜7.3, 8.9.7）どおりに読む。
 */

export type Operand =
  | { type: 'number'; value: number }
  | { type: 'string'; bytes: Uint8Array; hex: boolean }
  | { type: 'name'; value: string }
  | { type: 'array'; items: Operand[] }
  | { type: 'dict'; entries: [string, Operand][] }
  | { type: 'bool'; value: boolean }
  | { type: 'null' };

export interface InlineImage {
  /** BI と ID の間の辞書（キーは略記のまま） */
  dict: [string, Operand][];
  /** ID と EI の間の生データ */
  data: Uint8Array;
}

export interface Operation {
  op: string;
  operands: Operand[];
  /** op === 'BI' のときだけ持つ */
  inlineImage?: InlineImage;
}

export class ContentParseError extends Error {}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isWs = (c: number) => WS.has(c);
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);

type Token =
  | { kind: 'operand'; value: Operand }
  | { kind: 'keyword'; value: string }
  | { kind: 'arrayStart' }
  | { kind: 'arrayEnd' }
  | { kind: 'dictStart' }
  | { kind: 'dictEnd' };

class Lexer {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  skipWsAndComments(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWs(c)) {
        this.pos++;
      } else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else {
        break;
      }
    }
  }

  next(): Token | null {
    this.skipWsAndComments();
    const b = this.buf;
    if (this.pos >= b.length) return null;
    const c = b[this.pos];

    if (c === 0x28) return { kind: 'operand', value: this.readLiteralString() };
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { kind: 'dictStart' };
      }
      return { kind: 'operand', value: this.readHexString() };
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { kind: 'dictEnd' };
      }
      // 余計な '>'。ビューアー（pdf.js）と同じく読み飛ばす
      this.pos++;
      return this.next();
    }
    if (c === 0x5b) {
      this.pos++;
      return { kind: 'arrayStart' };
    }
    if (c === 0x5d) {
      this.pos++;
      return { kind: 'arrayEnd' };
    }
    if (c === 0x2f) return { kind: 'operand', value: this.readName() };
    if (c === 0x7b || c === 0x7d) {
      // PostScript 関数の括弧。ContentStream には現れないはずなので読み飛ばす
      this.pos++;
      return this.next();
    }
    if (c === 0x29) {
      // 余計な ')'。ビューアー（pdf.js）と同じく読み飛ばす
      this.pos++;
      return this.next();
    }

    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    const word = latin1(b.subarray(start, this.pos));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      return { kind: 'operand', value: { type: 'number', value: parseFloat(word) } };
    }
    // "--5" や "5-" のような壊れた数値（実在の PDF で見かける）
    if (/^[+-]*(\d|\.)/.test(word) && /^[+\-\d.]+$/.test(word)) {
      const m = word.match(/[+-]?(\d+\.?\d*|\.\d+)/);
      return { kind: 'operand', value: { type: 'number', value: m ? parseFloat(m[0]) : 0 } };
    }
    if (word === 'true') return { kind: 'operand', value: { type: 'bool', value: true } };
    if (word === 'false') return { kind: 'operand', value: { type: 'bool', value: false } };
    if (word === 'null') return { kind: 'operand', value: { type: 'null' } };
    return { kind: 'keyword', value: word };
  }

  readLiteralString(): Operand {
    const b = this.buf;
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        switch (n) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x28: case 0x29: case 0x5c: out.push(n); break;
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            break; // 行の継続
          case 0x0a:
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.pos++;
                } else {
                  break;
                }
              }
              out.push(v & 0xff);
            } else if (n !== undefined) {
              out.push(n);
            }
        }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29) {
        depth--;
        if (depth === 0) break;
      }
      if (c === 0x0d) {
        // 逃がしていない行末（CR、CRLF、LF）は、どれも LF の 1 バイト（ISO 32000-1 7.3.4.2）
        if (b[this.pos] === 0x0a) this.pos++;
        out.push(0x0a);
        continue;
      }
      out.push(c);
    }
    return { type: 'string', bytes: Uint8Array.from(out), hex: false };
  }

  readHexString(): Operand {
    const b = this.buf;
    this.pos++; // <
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue; // 空白などは無視
      if (hi < 0) {
        hi = v;
      } else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return { type: 'string', bytes: Uint8Array.from(out), hex: true };
  }

  readName(): Operand {
    const b = this.buf;
    this.pos++; // /
    const out: number[] = [];
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos++];
      if (c === 0x23 && this.pos + 1 < b.length + 1) {
        const h1 = hexVal(b[this.pos]);
        const h2 = hexVal(b[this.pos + 1]);
        if (h1 >= 0 && h2 >= 0) {
          out.push((h1 << 4) | h2);
          this.pos += 2;
          continue;
        }
      }
      out.push(c);
    }
    return { type: 'name', value: utf8OrLatin1(Uint8Array.from(out)) };
  }
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function utf8OrLatin1(b: Uint8Array): string {
  // 名前は普通 ASCII。そうでない場合も往復できるよう latin1 で持つ
  return latin1(b);
}

/** 配列・辞書を含めて 1 つのオペランドを組み立てる */
function readComposite(lexer: Lexer, first: Token): Operand {
  if (first.kind === 'operand') return first.value;
  if (first.kind === 'arrayStart') {
    const items: Operand[] = [];
    for (;;) {
      const t = lexer.next();
      if (t === null) throw new ContentParseError('配列が閉じていない');
      if (t.kind === 'arrayEnd') break;
      if (t.kind === 'keyword') {
        // 配列の中のキーワードは不正だが、読み飛ばす
        continue;
      }
      items.push(readComposite(lexer, t));
    }
    return { type: 'array', items };
  }
  if (first.kind === 'dictStart') {
    const entries: [string, Operand][] = [];
    for (;;) {
      const k = lexer.next();
      if (k === null) throw new ContentParseError('辞書が閉じていない');
      if (k.kind === 'dictEnd') break;
      if (k.kind !== 'operand' || k.value.type !== 'name') {
        throw new ContentParseError('辞書のキーが名前でない');
      }
      const vt = lexer.next();
      if (vt === null || vt.kind === 'dictEnd') throw new ContentParseError('辞書の値が無い');
      if (vt.kind === 'keyword') throw new ContentParseError(`辞書の値にキーワード ${vt.value}`);
      entries.push([k.value.value, readComposite(lexer, vt)]);
    }
    return { type: 'dict', entries };
  }
  throw new ContentParseError(`予期しないトークン ${first.kind}`);
}

/** インライン画像の 1 行あたりのバイト数などから、フィルターなしのデータ長を求める */
function unfilteredInlineLength(dict: [string, Operand][]): number | null {
  const get = (...keys: string[]) => dict.find(([k]) => keys.includes(k))?.[1];
  const filter = get('F', 'Filter');
  if (filter && !(filter.type === 'array' && filter.items.length === 0)) return null;
  const w = get('W', 'Width');
  const h = get('H', 'Height');
  if (w?.type !== 'number' || h?.type !== 'number') return null;
  const im = get('IM', 'ImageMask');
  const isMask = im?.type === 'bool' && im.value;
  let bpc = 1;
  let ncomp = 1;
  if (!isMask) {
    const bpcOp = get('BPC', 'BitsPerComponent');
    if (bpcOp?.type !== 'number') return null;
    bpc = bpcOp.value;
    const cs = get('CS', 'ColorSpace');
    if (cs?.type === 'name') {
      const n = { G: 1, DeviceGray: 1, CalGray: 1, I: 1, Indexed: 1, RGB: 3, DeviceRGB: 3, CalRGB: 3, CMYK: 4, DeviceCMYK: 4 }[cs.value];
      if (n === undefined) return null; // 名前付きの色空間は資源を見ないと決まらない
      ncomp = n;
    } else if (cs?.type === 'array' && cs.items[0]?.type === 'name' && ['I', 'Indexed'].includes(cs.items[0].value)) {
      ncomp = 1;
    } else {
      return null;
    }
  }
  return Math.ceil((w.value * bpc * ncomp) / 8) * h.value;
}

function readInlineImage(lexer: Lexer): InlineImage {
  const dict: [string, Operand][] = [];
  for (;;) {
    const k = lexer.next();
    if (k === null) throw new ContentParseError('インライン画像の ID が無い');
    if (k.kind === 'keyword' && k.value === 'ID') break;
    if (k.kind !== 'operand' || k.value.type !== 'name') {
      throw new ContentParseError('インライン画像の辞書のキーが名前でない');
    }
    const vt = lexer.next();
    if (vt === null || vt.kind === 'keyword') throw new ContentParseError('インライン画像の辞書の値が無い');
    dict.push([k.value.value, readComposite(lexer, vt)]);
  }
  const b = lexer.buf;
  // ID の後ろの空白 1 文字を飛ばす
  if (isWs(b[lexer.pos])) lexer.pos++;
  const start = lexer.pos;

  const lengthEntry = dict.find(([k]) => k === 'L' || k === 'Length')?.[1];
  const known = lengthEntry?.type === 'number' ? lengthEntry.value : unfilteredInlineLength(dict);
  if (known !== null) {
    const end = start + known;
    // データの後ろに空白と EI が続くことを確かめる
    let p = end;
    while (p < b.length && isWs(b[p])) p++;
    if (b[p] === 0x45 && b[p + 1] === 0x49 && (p + 2 >= b.length || !isRegular(b[p + 2]))) {
      lexer.pos = p + 2;
      return { dict, data: b.slice(start, end) };
    }
  }

  // 空白 + "EI" + 空白（または終端）で、その後ろが ContentStream らしいものを探す
  for (let p = start; p < b.length - 1; p++) {
    if (b[p] !== 0x45 || b[p + 1] !== 0x49) continue;
    if (p > start && !isWs(b[p - 1])) continue;
    if (p + 2 < b.length && !isWs(b[p + 2]) && !DELIM.has(b[p + 2])) continue;
    if (!looksLikeContent(b, p + 2)) continue;
    let end = p;
    if (end > start && isWs(b[end - 1])) end--;
    lexer.pos = p + 2;
    return { dict, data: b.slice(start, end) };
  }
  throw new ContentParseError('インライン画像の EI が見つからない');
}

/** EI の後ろが、印字可能な ASCII の並び（＝ContentStream の続き）かを見る */
function looksLikeContent(b: Uint8Array, from: number): boolean {
  const end = Math.min(b.length, from + 64);
  for (let i = from; i < end; i++) {
    const c = b[i];
    if (!(isWs(c) || (c >= 0x20 && c < 0x7f))) return false;
  }
  return true;
}

/** ContentStream のバイト列を、オペレーターごとの操作列にする */
export function parseContentStream(bytes: Uint8Array): Operation[] {
  const lexer = new Lexer(bytes);
  const ops: Operation[] = [];
  let operands: Operand[] = [];
  for (;;) {
    const t = lexer.next();
    if (t === null) break;
    if (t.kind === 'keyword') {
      if (t.value === 'BI') {
        ops.push({ op: 'BI', operands: [], inlineImage: readInlineImage(lexer) });
        operands = [];
        continue;
      }
      ops.push({ op: t.value, operands });
      operands = [];
      continue;
    }
    if (t.kind === 'arrayEnd' || t.kind === 'dictEnd') {
      throw new ContentParseError(`対応しない閉じ括弧（位置 ${lexer.pos}）`);
    }
    operands.push(readComposite(lexer, t));
  }
  // 末尾にオペレーターの無いオペランドが残っても捨てる（描画には効かない）
  return ops;
}
