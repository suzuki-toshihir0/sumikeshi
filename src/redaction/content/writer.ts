import type { Operand, Operation } from './lexer';

/** 数値を、指数表記を使わずに書く */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(10);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function formatName(name: string): string {
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const regular = c > 0x20 && c < 0x7f && !'()<>[]{}/%#'.includes(name[i]);
    out += regular ? name[i] : '#' + c.toString(16).padStart(2, '0');
  }
  return out;
}

function formatString(bytes: Uint8Array, hex: boolean): string {
  if (hex) {
    let s = '<';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s + '>';
  }
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b < 0x20 || b >= 0x7f) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}

export function formatOperand(o: Operand): string {
  switch (o.type) {
    case 'number': return formatNumber(o.value);
    case 'name': return formatName(o.value);
    case 'string': return formatString(o.bytes, o.hex);
    case 'bool': return o.value ? 'true' : 'false';
    case 'null': return 'null';
    case 'array': return '[' + o.items.map(formatOperand).join(' ') + ']';
    case 'dict': return '<<' + o.entries.map(([k, v]) => `${formatName(k)} ${formatOperand(v)}`).join(' ') + '>>';
  }
}

/** 操作列を ContentStream のバイト列に戻す */
export function serializeOperations(ops: Operation[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let text = '';
  const flush = () => {
    if (text) {
      chunks.push(latin1Bytes(text));
      text = '';
    }
  };
  for (const o of ops) {
    if (o.op === 'BI' && o.inlineImage) {
      text += 'BI ' + o.inlineImage.dict.map(([k, v]) => `${formatName(k)} ${formatOperand(v)}`).join(' ') + ' ID ';
      flush();
      chunks.push(o.inlineImage.data);
      text += '\nEI\n';
      continue;
    }
    if (o.operands.length > 0) text += o.operands.map(formatOperand).join(' ') + ' ';
    text += o.op + '\n';
  }
  flush();
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
