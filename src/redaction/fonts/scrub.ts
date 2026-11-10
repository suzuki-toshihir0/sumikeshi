/**
 * 墨消しで消した文字の情報を、フォントからも消す。
 *
 * 消した文字の符号のうち、文書のどこでももう使われていないものについて:
 * - 字形: Type3 の CharProcs、埋め込みの TrueType の字形（truetype-scrub.ts）
 * - 幅: Widths（単純フォント）、W / W2（複合フォント）
 * - 名前と対応: Encoding の Differences、ToUnicode、埋め込みの CMap、FontDescriptor の CharSet / CIDSet
 * 字形のデータを書き換えられない形式（CFF、Type1）は、フォントのデータそのものを外す（ビューアーは代わりのフォントで描く）。
 *
 * 字を消したフォントだけを書き換えると、書き換えた形そのものが「このフォントの字が消された」印になる
 * （Chrome の Type3 は字形の番号の区画ごとにフォントを分けるので、消した字のある区画が分かってしまう）。
 * そこで、文書の中で使われるフォントは、字を消したかどうかに関わらず同じ形に書き直す（normalize）:
 * Type3 は符号を詰めて字形名を付け直し、埋め込みの TrueType は使う字形だけに詰め、幅や ToUnicode は使う符号の分だけにする。
 */
import {
  PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFStream,
} from 'pdf-lib';
import { get, getArray, getDict, getName, getNum, numbersOf, resolve, streamBytes } from '../pdf-objects';
import { parseContentStream } from '../content/lexer';
import { createFontModel, glyphNames, parseW, parseW2, type FontModel } from './font-model';
import { collectFontUsage, rewriteFontCodes } from './usage';
import { parseTrueType, simpleTrueTypeGid, type TrueTypeInfo } from './truetype';
import { compactTrueType } from './truetype-scrub';
import type { CMapLoader } from './cmap';
import { MacRomanEncoding, STANDARD_FONT_ALIASES, WinAnsiEncoding } from '../vendor/pdfjs-encodings';

export interface FontScrubStats {
  fontsScrubbed: number;
  glyphsScrubbed: number;
  fontsUnembedded: number;
}

const hex = (n: number, bytes: number) => n.toString(16).padStart(bytes * 2, '0');

/** ToUnicode の CMap を読み、符号 → （符号のバイト数, Unicode の UTF-16BE）にする */
function readToUnicode(data: Uint8Array): { map: Map<number, [number, Uint8Array]>; spaces: [Uint8Array, Uint8Array][] } | null {
  const map = new Map<number, [number, Uint8Array]>();
  const spaces: [Uint8Array, Uint8Array][] = [];
  let ops;
  try {
    ops = parseContentStream(data);
  } catch {
    return null;
  }
  const toInt = (b: Uint8Array) => b.reduce((n, x) => n * 256 + x, 0);
  for (const o of ops) {
    const a = o.operands;
    if (o.op === 'endcodespacerange') {
      for (let i = 0; i + 1 < a.length; i += 2) {
        const lo = a[i];
        const hi = a[i + 1];
        if (lo.type === 'string' && hi.type === 'string') spaces.push([lo.bytes, hi.bytes]);
      }
    } else if (o.op === 'endbfchar') {
      for (let i = 0; i + 1 < a.length; i += 2) {
        const src = a[i];
        const dst = a[i + 1];
        if (src.type === 'string' && dst.type === 'string') map.set(toInt(src.bytes), [src.bytes.length, dst.bytes]);
      }
    } else if (o.op === 'endbfrange') {
      for (let i = 0; i + 2 < a.length; i += 3) {
        const lo = a[i];
        const hi = a[i + 1];
        const dst = a[i + 2];
        if (lo.type !== 'string' || hi.type !== 'string') continue;
        const l = toInt(lo.bytes);
        const h = toInt(hi.bytes);
        if (h - l > 0x10000) return null;
        for (let c = l; c <= h; c++) {
          if (dst.type === 'array') {
            const d = dst.items[c - l];
            if (d?.type === 'string') map.set(c, [lo.bytes.length, d.bytes]);
          } else if (dst.type === 'string') {
            const d = dst.bytes.slice();
            // 末尾のバイトを足していく（桁上がりは最後の 2 バイトまで）
            let carry = c - l;
            for (let k = d.length - 1; k >= 0 && carry > 0; k--) {
              const v = d[k] + carry;
              d[k] = v & 0xff;
              carry = v >> 8;
            }
            map.set(c, [lo.bytes.length, d]);
          }
        }
      }
    }
  }
  return { map, spaces };
}

function writeToUnicode(map: Map<number, [number, Uint8Array]>, spaces: [Uint8Array, Uint8Array][]): string {
  const hexBytes = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const lines = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
  ];
  const sp = spaces.length > 0 ? spaces : [[Uint8Array.of(0), Uint8Array.of(0xff)] as [Uint8Array, Uint8Array]];
  lines.push(`${sp.length} begincodespacerange`);
  for (const [lo, hi] of sp) lines.push(`<${hexBytes(lo)}> <${hexBytes(hi)}>`);
  lines.push('endcodespacerange');
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [code, [len, dst]] of chunk) lines.push(`<${hex(code, len)}> <${hexBytes(dst)}>`);
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

function scrubToUnicode(ctx: PDFContext, font: PDFDict, drop: Set<number>, everUsed?: Set<number>, remap?: Map<number, number>): void {
  const tu = get(ctx, font, 'ToUnicode');
  if (!(tu instanceof PDFStream)) return;
  const parsed = readToUnicode(streamBytes(ctx, tu));
  if (!parsed) {
    // 読めない ToUnicode は外す（文字のコピーができなくなるが、消した文字は残らない）
    font.delete(PDFName.of('ToUnicode'));
    return;
  }
  if (remap) {
    // 符号を詰め直したフォント: 残る符号だけを新しい符号で書く
    const next = new Map<number, [number, Uint8Array]>();
    for (const [oldCode, nv] of remap) {
      const e = parsed.map.get(oldCode);
      if (e) next.set(nv, e);
    }
    font.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(writeToUnicode(next, parsed.spaces))));
    return;
  }
  // 使わない符号まで並ぶ表なら、消した文字の分も残す（抜くと、どれを消したかが分かる）
  if (everUsed) {
    const unusedListed = [...parsed.map.keys()].filter((c) => !everUsed.has(c)).length;
    if (unusedListed > 0 && unusedListed >= everUsed.size) return;
  }
  for (const c of drop) parsed.map.delete(c);
  font.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(writeToUnicode(parsed.map, parsed.spaces))));
}

function unembed(ctx: PDFContext, descriptor: PDFDict | undefined, stats: FontScrubStats): void {
  if (!descriptor) return;
  let removed = false;
  for (const k of ['FontFile', 'FontFile3']) {
    if (descriptor.has(PDFName.of(k))) {
      descriptor.delete(PDFName.of(k));
      removed = true;
    }
  }
  if (removed) stats.fontsUnembedded++;
  void ctx;
}

function cleanDescriptor(descriptor: PDFDict | undefined): void {
  descriptor?.delete(PDFName.of('CharSet'));
  descriptor?.delete(PDFName.of('CIDSet'));
}

/**
 * TrueType から字形を番号ごと取り除き、残る字形の番号を詰め直して入れ直す。古い番号 → 新しい番号を返す。
 * 書き換えられない（壊れている、コレクションなど）ときは、フォントのデータごと外して null を返す
 */
function compactFontFile2(ctx: PDFContext, descriptor: PDFDict, bytes: Uint8Array, dropGids: Set<number>, stats: FontScrubStats): Map<number, number> | null {
  try {
    const r = compactTrueType(bytes, dropGids);
    replaceFontFile2(ctx, descriptor, r.font);
    stats.glyphsScrubbed += r.dropped.size;
    return r.map;
  } catch {
    descriptor.delete(PDFName.of('FontFile2'));
    stats.fontsUnembedded++;
    return null;
  }
}

/** 書き換えた TrueType を FontFile2 に入れ直す */
function replaceFontFile2(ctx: PDFContext, descriptor: PDFDict, bytes: Uint8Array): void {
  const s = ctx.flateStream(bytes);
  s.dict.set(PDFName.of('Length1'), PDFNumber.of(bytes.length));
  descriptor.set(PDFName.of('FontFile2'), ctx.register(s));
}

function loadTrueType(ctx: PDFContext, descriptor: PDFDict | undefined): { tt: TrueTypeInfo; bytes: Uint8Array } | null {
  const ff = get(ctx, descriptor, 'FontFile2');
  if (!(ff instanceof PDFStream)) return null;
  try {
    const bytes = streamBytes(ctx, ff);
    return { tt: parseTrueType(bytes), bytes };
  } catch {
    return null;
  }
}

/** 単純フォントの符号 → グリフ名（Encoding の Differences と基本の表） */
function simpleNames(ctx: PDFContext, font: PDFDict): (string | undefined)[] {
  const base = getName(ctx, font, 'BaseFont')?.replace(/^[A-Z]{6}\+/, '') ?? '';
  const std = STANDARD_FONT_ALIASES[base] ?? base;
  return glyphNames(ctx, font, std);
}

/** グリフ名から Unicode を推し量る（uniXXXX / uXXXX と、ASCII の名前） */
function unicodeOfName(name: string | undefined, code: number): number | undefined {
  if (name) {
    const m = name.match(/^uni([0-9A-Fa-f]{4})$/) ?? name.match(/^u([0-9A-Fa-f]{4,6})$/);
    if (m) return parseInt(m[1], 16);
    if (name.length === 1) return name.charCodeAt(0);
  }
  return code >= 0x20 && code < 0x7f ? code : undefined;
}

/** Windows-1252 の 0x80〜0x9F（-1 は割り当て無し） */
const CP1252_HIGH = [
  0x20ac, -1, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, -1, 0x017d, -1,
  -1, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, -1, 0x017e, 0x0178,
];
let winAnsiNameUnicode: Map<string, number> | null = null;

/** 字形名の Unicode（uniXXXX / uXXXX、1 文字の名前、WinAnsiEncoding にある名前） */
function unicodeOfGlyphName(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const m = name.match(/^uni([0-9A-Fa-f]{4})/) ?? name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (m) return parseInt(m[1], 16);
  if (!winAnsiNameUnicode) {
    winAnsiNameUnicode = new Map();
    for (let i = 32; i < 256; i++) {
      const u = i < 0x80 ? i : i < 0xa0 ? CP1252_HIGH[i - 0x80] : i;
      const nm = WinAnsiEncoding[i];
      if (u >= 0 && nm && !winAnsiNameUnicode.has(nm)) winAnsiNameUnicode.set(nm, u);
    }
  }
  const w = winAnsiNameUnicode.get(name);
  if (w !== undefined) return w;
  return name.length === 1 ? name.charCodeAt(0) : undefined;
}

/**
 * 単純な TrueType で、使う符号が描く字形の番号を、ビューアーが取りうる道筋をすべてたどって集める
 * （cmap の各表を符号・0xF000 台の符号・字形名や ToUnicode の Unicode で引く、(1,0) は MacRoman の位置、post 表の字形名）。
 * どの道筋でも字形が見つからない符号があれば certain は false（ビューアーが別の道筋で描くかもしれない）。
 */
function resolveSimpleGids(ctx: PDFContext, font: PDFDict, tt: TrueTypeInfo, codes: Iterable<number>): { gids: Set<number>; certain: boolean } {
  const names = simpleNames(ctx, font);
  const tu = get(ctx, font, 'ToUnicode');
  const toUni = tu instanceof PDFStream ? readToUnicode(streamBytes(ctx, tu)) : null;
  const gids = new Set<number>();
  let certain = tt.cmaps.size > 0;
  for (const code of codes) {
    const nm = names[code];
    const us = new Set<number>();
    const u1 = unicodeOfGlyphName(nm);
    if (u1 !== undefined) us.add(u1);
    const t = toUni?.map.get(code);
    if (t && t[1].length >= 2) us.add((t[1][0] << 8) | t[1][1]);
    if (!nm && code >= 0x20 && code < 0x7f) us.add(code);
    const found = new Set<number>();
    for (const [key, fn] of tt.cmaps) {
      const cs = [code, 0xf000 + code, 0xf100 + code, 0xf200 + code, ...us];
      if (key === '1,0' && nm) {
        const mi = MacRomanEncoding.indexOf(nm);
        if (mi >= 0) cs.push(mi);
      }
      for (const c of cs) {
        const g = fn(c);
        if (g && g < tt.numGlyphs) found.add(g);
      }
    }
    if (nm) {
      const g = tt.postNames.get(nm);
      if (g && g < tt.numGlyphs) found.add(g);
    }
    for (const symbolic of [true, false]) {
      const g = simpleTrueTypeGid(tt, code, u1 ?? (code >= 0x20 && code < 0x7f ? code : undefined), symbolic);
      if (g && g < tt.numGlyphs) found.add(g);
    }
    if (found.size === 0) certain = false;
    for (const g of found) gids.add(g);
  }
  return { gids, certain };
}

/** 単純な TrueType の符号に対応しうる字形の番号（ビューアーの取りうる道筋をすべて） */
function simpleGidCandidates(tt: TrueTypeInfo, code: number, name: string | undefined): Set<number> {
  const out = new Set<number>();
  const u = unicodeOfName(name, code);
  for (const symbolic of [true, false]) {
    const g = simpleTrueTypeGid(tt, code, u, symbolic);
    if (g) out.add(g);
  }
  for (const [, fn] of tt.cmaps) {
    for (const c of [code, 0xf000 + code, ...(u !== undefined ? [u] : [])]) {
      const g = fn(c);
      if (g) out.add(g);
    }
  }
  return out;
}

function rebuildDifferences(ctx: PDFContext, font: PDFDict, drop: Set<number>): void {
  const enc = get(ctx, font, 'Encoding');
  if (!(enc instanceof PDFDict)) return;
  const diffs = getArray(ctx, enc, 'Differences');
  if (!diffs) return;
  const items: PDFObject[] = [];
  let code = 0;
  let needNumber = true;
  for (let i = 0; i < diffs.size(); i++) {
    const o = resolve(ctx, diffs.get(i));
    if (o instanceof PDFNumber) {
      code = o.asNumber();
      needNumber = true;
    } else if (o instanceof PDFName) {
      if (drop.has(code)) {
        needNumber = true;
      } else {
        if (needNumber) items.push(PDFNumber.of(code));
        items.push(o);
        needNumber = false;
      }
      code++;
    }
  }
  const newEnc = ctx.obj({}) as PDFDict;
  for (const [k, v] of enc.entries()) newEnc.set(k, v);
  newEnc.set(PDFName.of('Differences'), ctx.obj(items));
  font.set(PDFName.of('Encoding'), newEnc);
}

/**
 * 元のフォントが「使わない符号にも幅や名前を入れる」流儀か。
 * そうなら、消した文字の幅を 0 にしたり名前を抜いたりすると、かえって消した文字が目立つ（Word の PDF など）。
 * 文書のどこでも使われていなかった符号の幅を見て、0 でないものが多ければそう判断する。
 */
function fillsUnusedCodes(ctx: PDFContext, font: PDFDict, everUsed: Set<number>): boolean {
  const widths = getArray(ctx, font, 'Widths');
  if (!widths) return false;
  const first = getNum(ctx, font, 'FirstChar') ?? 0;
  let zero = 0;
  let nonZero = 0;
  numbersOf(ctx, widths).forEach((w, i) => {
    if (everUsed.has(first + i)) return;
    if (w) nonZero++;
    else zero++;
  });
  return nonZero > zero;
}

function zeroWidths(ctx: PDFContext, font: PDFDict, drop: Set<number>): void {
  const widths = getArray(ctx, font, 'Widths');
  if (!widths) return;
  let first = getNum(ctx, font, 'FirstChar') ?? 0;
  let ws = numbersOf(ctx, widths).map((w, i) => (drop.has(first + i) ? 0 : w));
  // 両端の 0 を詰め、FirstChar / LastChar も合わせる（端の符号を消したことが分からないように）
  let lead = 0;
  while (lead < ws.length - 1 && !ws[lead]) lead++;
  let end = ws.length;
  while (end > lead + 1 && !ws[end - 1]) end--;
  ws = ws.slice(lead, end);
  first += lead;
  font.set(PDFName.of('FirstChar'), PDFNumber.of(first));
  font.set(PDFName.of('LastChar'), PDFNumber.of(first + ws.length - 1));
  font.set(PDFName.of('Widths'), ctx.obj(ws));
}

function scrubSimple(ctx: PDFContext, font: PDFDict, drop: Set<number>, used: Set<number>, removed: Set<number>, stats: FontScrubStats): void {
  const subtype = getName(ctx, font, 'Subtype');
  const names = simpleNames(ctx, font);
  const descriptor = getDict(ctx, font, 'FontDescriptor');

  if (subtype === 'Type3') {
    const procs = get(ctx, font, 'CharProcs');
    if (procs instanceof PDFDict) {
      const keepNames = new Set([...used].map((c) => names[c]).filter(Boolean) as string[]);
      const newProcs = ctx.obj({}) as PDFDict;
      for (const [k, v] of procs.entries()) {
        const nm = k.decodeText();
        const dropped = [...drop].some((c) => names[c] === nm) && !keepNames.has(nm);
        if (dropped) stats.glyphsScrubbed++;
        else newProcs.set(k, v);
      }
      font.set(PDFName.of('CharProcs'), newProcs);
    }
  } else {
    const tt = loadTrueType(ctx, descriptor);
    if (tt && descriptor) {
      const usedGids = new Set<number>();
      for (const c of used) for (const g of simpleGidCandidates(tt.tt, c, names[c])) usedGids.add(g);
      const dropGids = new Set<number>();
      let unknown = false;
      for (const c of drop) {
        const cand = simpleGidCandidates(tt.tt, c, names[c]);
        if (cand.size === 0) unknown = true;
        for (const g of cand) if (!usedGids.has(g)) dropGids.add(g);
      }
      if (unknown) {
        // 消した文字の字形を特定できない: フォントのデータごと外す
        descriptor.delete(PDFName.of('FontFile2'));
        stats.fontsUnembedded++;
      } else if (dropGids.size > 0) {
        // 単純なフォントの符号は文字そのもの。字形の番号の付け替えは、フォントの cmap の中で済む
        compactFontFile2(ctx, descriptor, tt.bytes, dropGids, stats);
      }
    } else {
      unembed(ctx, descriptor, stats);
      if (descriptor?.has(PDFName.of('FontFile2'))) {
        descriptor.delete(PDFName.of('FontFile2'));
        stats.fontsUnembedded++;
      }
    }
  }
  // 使わない符号にも幅や名前を入れる流儀なら、消した文字の分も残す（0 にすると、どれを消したかが分かる）
  if (subtype === 'Type3') {
    // Type3 は符号を詰め直す（消した符号の「穴」を残さない）。文字列の書き換えは後で文書全体に行う
    return;
  }
  const everUsed = new Set([...used, ...removed]);
  if (!fillsUnusedCodes(ctx, font, everUsed)) {
    zeroWidths(ctx, font, drop);
    rebuildDifferences(ctx, font, drop);
  }
  scrubToUnicode(ctx, font, drop, everUsed);
  cleanDescriptor(descriptor);
}

/** 符号を詰め直す割り当て。1 バイトの 32（語間 Tw がかかる）は動かさない */
function compactCodes(kept: number[]): Map<number, number> {
  const map = new Map<number, number>();
  const pool = [...Array.from({ length: 223 }, (_, i) => 33 + i), ...Array.from({ length: 32 }, (_, i) => i)];
  let k = 0;
  for (const c of [...kept].sort((a, b) => a - b)) {
    if (c === 32) map.set(32, 32);
    else map.set(c, pool[k++]);
  }
  return map;
}

/**
 * Type3 フォントの符号を詰め直す（Differences, Widths, FirstChar / LastChar, ToUnicode, FontBBox）。古い符号 → 新しい符号を返す。
 * rename なら字形名も付け直す（ToUnicode があるときだけ。字形名は元のフォントの字形の番号を表すことがある）
 */
function recodeType3(ctx: PDFContext, font: PDFDict, used: Set<number>, rename = false): Map<number, number> {
  const names = simpleNames(ctx, font);
  const doRename = rename && get(ctx, font, 'ToUnicode') instanceof PDFStream;
  const newName = (oldC: number, newC: number) => (doRename ? `c${newC}` : names[oldC]!);
  const widths = numbersOf(ctx, getArray(ctx, font, 'Widths'));
  const first = getNum(ctx, font, 'FirstChar') ?? 0;
  const map = compactCodes([...used].filter((c) => names[c]));
  const newCodes = [...map.values()].sort((a, b) => a - b);
  const lo = newCodes.length > 0 ? newCodes[0] : 0;
  const hi = newCodes.length > 0 ? newCodes[newCodes.length - 1] : 0;
  const ws = Array.from({ length: hi - lo + 1 }, () => 0);
  const diffs: PDFObject[] = [];
  for (const [oldC, newC] of [...map.entries()].sort((a, b) => a[1] - b[1])) {
    ws[newC - lo] = widths[oldC - first] ?? 0;
    diffs.push(PDFNumber.of(newC), PDFName.of(newName(oldC, newC)));
  }
  const enc = ctx.obj({}) as PDFDict;
  enc.set(PDFName.of('Type'), PDFName.of('Encoding'));
  enc.set(PDFName.of('Differences'), ctx.obj(diffs));
  font.set(PDFName.of('Encoding'), enc);
  font.set(PDFName.of('FirstChar'), PDFNumber.of(lo));
  font.set(PDFName.of('LastChar'), PDFNumber.of(hi));
  font.set(PDFName.of('Widths'), ctx.obj(ws));
  // FontBBox を、残る字形（d1 の外接矩形）だけで作り直す
  const procs = get(ctx, font, 'CharProcs');
  let bbox: number[] | null = null;
  // d1 の無い字形（d0 の色付きの字形、読めない手続き）があれば、外接矩形は元のままにする
  let allD1 = true;
  if (procs instanceof PDFDict) {
    for (const oldC of map.keys()) {
      const p = resolve(ctx, procs.get(PDFName.of(names[oldC]!)));
      if (!(p instanceof PDFStream)) continue;
      try {
        const d1 = parseContentStream(streamBytes(ctx, p)).find((o) => o.op === 'd1');
        const v = d1?.operands.slice(2, 6).map((o) => (o.type === 'number' ? o.value : NaN));
        if (v && v.length === 4 && v.every(Number.isFinite)) {
          const b = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
          bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b;
        } else {
          allD1 = false;
        }
      } catch {
        allD1 = false;
      }
    }
  }
  if (allD1) font.set(PDFName.of('FontBBox'), ctx.obj(bbox ?? [0, 0, 0, 0]));
  // 新しい Differences から参照されない字形の手続きも外す（付け直した名前で入れ直す）
  if (procs instanceof PDFDict) {
    const np = ctx.obj({}) as PDFDict;
    for (const [oldC, newC] of map) {
      const v = procs.get(PDFName.of(names[oldC]!));
      if (v) np.set(PDFName.of(newName(oldC, newC)), v);
    }
    font.set(PDFName.of('CharProcs'), np);
  }
  scrubToUnicode(ctx, font, new Set(), undefined, map);
  return map;
}


/** 埋め込みの CMap は、使う符号の分だけにする */
function rewriteEmbeddedCMap(ctx: PDFContext, font: PDFDict, model: FontModel, used: Set<number>): void {
  const enc = get(ctx, font, 'Encoding');
  if (enc instanceof PDFStream && model.cmap) {
    const cm = model.cmap;
    const lines = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
      `/CMapName /Redacted-${model.vertical ? 'V' : 'H'} def`, `/WMode ${model.vertical ? 1 : 0} def`];
    const spaces: string[] = [];
    cm.codespaceRanges.forEach((r, n) => {
      for (let k = 0; k < r.length; k += 2) spaces.push(`<${hex(r[k], n + 1)}> <${hex(r[k + 1], n + 1)}>`);
    });
    lines.push(`${spaces.length} begincodespacerange`, ...spaces, 'endcodespacerange');
    const codes = [...used].sort((a, b) => a - b);
    const byteLen = (c: number) => {
      for (let n = 0; n < 4; n++) {
        const r = cm.codespaceRanges[n];
        for (let k = 0; k < r.length; k += 2) if (c >= r[k] && c <= r[k + 1]) return n + 1;
      }
      return 2;
    };
    for (let i = 0; i < codes.length; i += 100) {
      const chunk = codes.slice(i, i + 100);
      lines.push(`${chunk.length} begincidchar`, ...chunk.map((c) => `<${hex(c, byteLen(c))}> ${cm.lookupCid(c)}`), 'endcidchar');
    }
    lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    const s = ctx.flateStream(lines.join('\n'));
    s.dict.set(PDFName.of('Type'), PDFName.of('CMap'));
    s.dict.set(PDFName.of('CMapName'), PDFName.of(`Redacted-${model.vertical ? 'V' : 'H'}`));
    s.dict.set(PDFName.of('WMode'), PDFNumber.of(model.vertical ? 1 : 0));
    const sysInfo = get(ctx, enc.dict, 'CIDSystemInfo');
    if (sysInfo) s.dict.set(PDFName.of('CIDSystemInfo'), sysInfo);
    font.set(PDFName.of('Encoding'), ctx.register(s));
  }
}

async function scrubComposite(
  ctx: PDFContext, font: PDFDict, model: FontModel, drop: Set<number>, used: Set<number>, stats: FontScrubStats,
): Promise<Map<number, number> | null> {
  const descendants = getArray(ctx, font, 'DescendantFonts');
  const cidFont = descendants ? resolve(ctx, descendants.get(0)) : undefined;
  if (!(cidFont instanceof PDFDict) || !model.cidOf) return null;
  const usedCids = new Set([...used].map((c) => model.cidOf!(c)));
  const dropCids = new Set([...drop].map((c) => model.cidOf!(c)).filter((c) => !usedCids.has(c)));
  const descriptor = getDict(ctx, cidFont, 'FontDescriptor');

  // 幅
  const writeWidths = (key: 'W' | 'W2') => {
    const arr = getArray(ctx, cidFont, key);
    if (!arr) return;
    const out: PDFObject[] = [];
    if (key === 'W') {
      const w = parseW(ctx, arr);
      for (const [cid, width] of [...w.entries()].sort((a, b) => a[0] - b[0])) {
        if (dropCids.has(cid)) continue;
        out.push(PDFNumber.of(cid), ctx.obj([width]));
      }
    } else {
      const w2 = parseW2(ctx, arr);
      for (const [cid, v] of [...w2.entries()].sort((a, b) => a[0] - b[0])) {
        if (dropCids.has(cid)) continue;
        out.push(PDFNumber.of(cid), ctx.obj(v));
      }
    }
    cidFont.set(PDFName.of(key), ctx.obj(out));
  };
  writeWidths('W');
  writeWidths('W2');

  rewriteEmbeddedCMap(ctx, font, model, used);
  const enc = get(ctx, font, 'Encoding');

  // 字形
  let codeRemap: Map<number, number> | null = null;
  if (getName(ctx, cidFont, 'Subtype') === 'CIDFontType2') {
    const tt = loadTrueType(ctx, descriptor);
    if (tt && descriptor) {
      const mapObj = get(ctx, cidFont, 'CIDToGIDMap');
      let toGid = (cid: number) => cid;
      if (mapObj instanceof PDFStream) {
        const table = streamBytes(ctx, mapObj);
        toGid = (cid) => (cid * 2 + 1 < table.length ? (table[cid * 2] << 8) | table[cid * 2 + 1] : 0);
      }
      const usedGids = new Set([...usedCids].map(toGid));
      const dropGids = new Set([...dropCids].map(toGid).filter((g) => !usedGids.has(g)));
      if (dropGids.size > 0) {
        const gidMap = compactFontFile2(ctx, descriptor, tt.bytes, dropGids, stats);
        if (gidMap) {
          const encName = enc instanceof PDFName ? enc.decodeText() : undefined;
          const identity = !(mapObj instanceof PDFStream) && (encName === 'Identity-H' || encName === 'Identity-V');
          if (identity) {
            // 符号 = CID = 字形の番号。字形の番号を詰めたので、符号（CID）も同じく詰め直す（符号の穴も残さない）
            codeRemap = new Map();
            for (const c of used) {
              const ng = gidMap.get(c);
              if (ng !== undefined) codeRemap.set(c, ng);
            }
            const w = parseW(ctx, getArray(ctx, cidFont, 'W'));
            const nw: PDFObject[] = [];
            for (const [oc, nc] of [...codeRemap.entries()].sort((a, b) => a[1] - b[1])) {
              const width = w.get(oc);
              if (width !== undefined) nw.push(PDFNumber.of(nc), ctx.obj([width]));
            }
            cidFont.set(PDFName.of('W'), ctx.obj(nw));
            const w2 = parseW2(ctx, getArray(ctx, cidFont, 'W2'));
            if (w2.size > 0) {
              const nw2: PDFObject[] = [];
              for (const [oc, nc] of [...codeRemap.entries()].sort((a, b) => a[1] - b[1])) {
                const v = w2.get(oc);
                if (v) nw2.push(PDFNumber.of(nc), ctx.obj(v));
              }
              cidFont.set(PDFName.of('W2'), ctx.obj(nw2));
            }
          } else {
            // CID はそのままにし、CID → 新しい字形の番号の表を明示する
            const maxCid = Math.max(0, ...usedCids);
            const table = new Uint8Array((maxCid + 1) * 2);
            for (const cid of usedCids) {
              const ng = gidMap.get(toGid(cid)) ?? 0;
              table[cid * 2] = (ng >> 8) & 0xff;
              table[cid * 2 + 1] = ng & 0xff;
            }
            cidFont.set(PDFName.of('CIDToGIDMap'), ctx.register(ctx.flateStream(table)));
          }
        }
      }
    } else {
      unembed(ctx, descriptor, stats);
      // 読めない FontFile2 も外す
      if (descriptor?.has(PDFName.of('FontFile2')) && dropCids.size > 0) {
        descriptor.delete(PDFName.of('FontFile2'));
        stats.fontsUnembedded++;
      }
    }
  } else if (dropCids.size > 0) {
    unembed(ctx, descriptor, stats);
  }
  if (codeRemap) {
    scrubToUnicode(ctx, font, new Set(), undefined, codeRemap);
    cleanDescriptor(descriptor);
    return codeRemap;
  }
  scrubToUnicode(ctx, font, drop);
  cleanDescriptor(descriptor);
  return null;
}

/** CID → 幅（W）を、使う CID の分だけ、連続する CID をまとめた同じ形で書く */
function writeCanonicalW(ctx: PDFContext, cidFont: PDFDict, entries: [number, number[]][], key: 'W' | 'W2'): void {
  const out: PDFObject[] = [];
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j][0] === sorted[j - 1][0] + 1) j++;
    out.push(PDFNumber.of(sorted[i][0]), ctx.obj(sorted.slice(i, j).flatMap(([, v]) => v)));
    i = j;
  }
  if (out.length > 0 || cidFont.has(PDFName.of(key))) cidFont.set(PDFName.of(key), ctx.obj(out));
}

/**
 * 複合フォントを同じ形に書き直す。埋め込みの TrueType は使う字形だけに詰め、W / W2・ToUnicode・埋め込みの CMap は使う符号の分だけにする。
 * Identity-H / V で符号を詰め直したら、古い符号 → 新しい符号を返す（文字列の書き換えに使う）
 */
async function normalizeComposite(
  ctx: PDFContext, font: PDFDict, model: FontModel, drop: Set<number>, used: Set<number>, stats: FontScrubStats,
): Promise<Map<number, number> | null> {
  const descendants = getArray(ctx, font, 'DescendantFonts');
  const cidFont = descendants ? resolve(ctx, descendants.get(0)) : undefined;
  if (!(cidFont instanceof PDFDict) || !model.cidOf) return null;
  const usedCids = new Set([...used].map((c) => model.cidOf!(c)));
  const dropCids = new Set([...drop].map((c) => model.cidOf!(c)).filter((c) => !usedCids.has(c)));
  const descriptor = getDict(ctx, cidFont, 'FontDescriptor');
  rewriteEmbeddedCMap(ctx, font, model, used);
  const enc = get(ctx, font, 'Encoding');

  let codeRemap: Map<number, number> | null = null;
  if (getName(ctx, cidFont, 'Subtype') === 'CIDFontType2') {
    const tt = loadTrueType(ctx, descriptor);
    if (tt && descriptor) {
      const mapObj = get(ctx, cidFont, 'CIDToGIDMap');
      let toGid = (cid: number) => cid;
      if (mapObj instanceof PDFStream) {
        const table = streamBytes(ctx, mapObj);
        toGid = (cid) => (cid * 2 + 1 < table.length ? (table[cid * 2] << 8) | table[cid * 2 + 1] : 0);
      }
      const keep = new Set([0, ...[...usedCids].map(toGid)]);
      const dropGids = new Set<number>();
      for (let g = 1; g < tt.tt.numGlyphs; g++) if (!keep.has(g)) dropGids.add(g);
      try {
        const c = compactTrueType(tt.bytes, dropGids);
        replaceFontFile2(ctx, descriptor, c.font);
        for (const cid of dropCids) if (c.dropped.has(toGid(cid))) stats.glyphsScrubbed++;
        const encName = enc instanceof PDFName ? enc.decodeText() : undefined;
        if (!(mapObj instanceof PDFStream) && (encName === 'Identity-H' || encName === 'Identity-V')) {
          // 符号 = CID = 字形の番号。字形を詰めたので、符号も同じく詰め直す
          codeRemap = new Map();
          for (const code of used) codeRemap.set(code, c.map.get(code) ?? 0);
        } else {
          // CID はそのままにし、CID → 新しい字形の番号の表を明示する
          const maxCid = Math.max(0, ...usedCids);
          const table = new Uint8Array((maxCid + 1) * 2);
          for (const cid of usedCids) {
            const ng = c.map.get(toGid(cid)) ?? 0;
            table[cid * 2] = (ng >> 8) & 0xff;
            table[cid * 2 + 1] = ng & 0xff;
          }
          cidFont.set(PDFName.of('CIDToGIDMap'), ctx.register(ctx.flateStream(table)));
        }
      } catch {
        if (dropCids.size > 0) {
          descriptor.delete(PDFName.of('FontFile2'));
          stats.fontsUnembedded++;
        }
      }
    } else if (dropCids.size > 0) {
      unembed(ctx, descriptor, stats);
      if (descriptor?.has(PDFName.of('FontFile2'))) {
        descriptor.delete(PDFName.of('FontFile2'));
        stats.fontsUnembedded++;
      }
    }
  } else if (dropCids.size > 0) {
    unembed(ctx, descriptor, stats);
  }

  // 幅: 使う CID の分だけ（符号を詰め直したなら新しい CID で）
  const newCid = (cid: number) => (codeRemap ? codeRemap.get(cid)! : cid);
  const w = parseW(ctx, getArray(ctx, cidFont, 'W'));
  writeCanonicalW(ctx, cidFont, [...usedCids].filter((c) => w.has(c)).map((c) => [newCid(c), [w.get(c)!]]), 'W');
  const w2 = parseW2(ctx, getArray(ctx, cidFont, 'W2'));
  if (cidFont.has(PDFName.of('W2'))) {
    writeCanonicalW(ctx, cidFont, [...usedCids].filter((c) => w2.has(c)).map((c) => [newCid(c), [...w2.get(c)!]]), 'W2');
  }
  // ToUnicode: 使う符号の分だけ
  scrubToUnicode(ctx, font, new Set(), undefined, codeRemap ?? new Map([...used].map((c) => [c, c])));
  cleanDescriptor(descriptor);
  return codeRemap;
}

/** 単純フォント（Type3 以外）を同じ形に書き直す。埋め込みの TrueType は使う字形だけに詰める */
function normalizeSimple(ctx: PDFContext, font: PDFDict, drop: Set<number>, used: Set<number>, removed: Set<number>, stats: FontScrubStats): void {
  const descriptor = getDict(ctx, font, 'FontDescriptor');
  const tt = loadTrueType(ctx, descriptor);
  if (tt && descriptor) {
    const r = resolveSimpleGids(ctx, font, tt.tt, used);
    if (r.certain) {
      const keep = new Set([0, ...r.gids]);
      const dropGids = new Set<number>();
      for (let g = 1; g < tt.tt.numGlyphs; g++) if (!keep.has(g)) dropGids.add(g);
      const removedGids = resolveSimpleGids(ctx, font, tt.tt, drop).gids;
      try {
        const c = compactTrueType(tt.bytes, dropGids);
        replaceFontFile2(ctx, descriptor, c.font);
        for (const g of removedGids) if (c.dropped.has(g)) stats.glyphsScrubbed++;
      } catch {
        if (drop.size > 0) {
          descriptor.delete(PDFName.of('FontFile2'));
          stats.fontsUnembedded++;
        }
      }
    } else if (drop.size > 0) {
      // 使う字の字形を確かめられない（詰めると残す字が描けなくなるかもしれない）: フォントのデータごと外す
      descriptor.delete(PDFName.of('FontFile2'));
      stats.fontsUnembedded++;
    }
  } else if (drop.size > 0) {
    unembed(ctx, descriptor, stats);
    if (descriptor?.has(PDFName.of('FontFile2'))) {
      descriptor.delete(PDFName.of('FontFile2'));
      stats.fontsUnembedded++;
    }
  }
  // 幅・名前・ToUnicode は使う符号の分だけ（使わない符号にも入れる流儀のフォントは、そのまま）
  const everUsed = new Set([...used, ...removed]);
  const unused = new Set<number>();
  for (let c = 0; c < 256; c++) if (!used.has(c)) unused.add(c);
  if (!fillsUnusedCodes(ctx, font, everUsed)) {
    zeroWidths(ctx, font, unused);
    rebuildDifferences(ctx, font, unused);
  }
  scrubToUnicode(ctx, font, unused, everUsed);
  cleanDescriptor(descriptor);
}

/** フォームの欄の外観を作り直すのに使うフォント（AcroForm の DR）。使う字が決まっていないので、詰めない */
function formFonts(doc: PDFDocument): Set<PDFDict> {
  const ctx = doc.context;
  const out = new Set<PDFDict>();
  const dr = getDict(ctx, getDict(ctx, doc.catalog, 'AcroForm'), 'DR');
  const fonts = getDict(ctx, dr, 'Font');
  if (fonts) for (const [, v] of fonts.entries()) {
    const f = resolve(ctx, v);
    if (f instanceof PDFDict) out.add(f);
  }
  return out;
}

/**
 * 消した文字の符号（フォントごと）のうち、文書のどこでももう使われていないものを、フォントから消す。
 * 文書の中で使われるほかのフォントも、同じ形に書き直す（字を消したフォントだけが書き換わって目立たないように）。
 * 墨消しの処理（content-redactor）が終わった後、文書の掃除（sanitize）の前に呼ぶ。
 */
export async function scrubFonts(
  doc: PDFDocument,
  removedCodes: Map<PDFDict, Set<number>>,
  fontCache: Map<PDFDict, Promise<FontModel>>,
  cmapLoader?: CMapLoader,
): Promise<FontScrubStats> {
  const stats: FontScrubStats = { fontsScrubbed: 0, glyphsScrubbed: 0, fontsUnembedded: 0 };
  if (removedCodes.size === 0) return stats;
  const ctx = doc.context;
  const usage = await collectFontUsage(doc, 'all', fontCache, cmapLoader);
  const keepAsIs = formFonts(doc);
  const recodeMaps = new Map<PDFDict, { map: Map<number, number>; bytes: number }>();
  for (const font of new Set([...usage.keys(), ...removedCodes.keys()])) {
    const removed = removedCodes.get(font) ?? new Set<number>();
    const used = usage.get(font) ?? new Set<number>();
    const drop = new Set([...removed].filter((c) => !used.has(c)));
    const normalize = !keepAsIs.has(font);
    if (!normalize && drop.size === 0) continue;
    if (drop.size > 0) stats.fontsScrubbed++;
    const subtype = getName(ctx, font, 'Subtype');
    if (subtype === 'Type0') {
      let model: FontModel | null = null;
      try {
        model = await (fontCache.get(font) ?? createFontModel(ctx, font, cmapLoader));
      } catch {
        model = null;
      }
      if (model) {
        const remap = normalize ? await normalizeComposite(ctx, font, model, drop, used, stats) : await scrubComposite(ctx, font, model, drop, used, stats);
        if (remap) recodeMaps.set(font, { map: remap, bytes: 2 });
      }
    } else if (subtype === 'Type3') {
      if (normalize) {
        const names = simpleNames(ctx, font);
        const keptNames = new Set([...used].map((c) => names[c]));
        stats.glyphsScrubbed += new Set([...drop].map((c) => names[c]).filter((n) => n && !keptNames.has(n))).size;
      } else {
        scrubSimple(ctx, font, drop, used, removed, stats);
      }
      recodeMaps.set(font, { map: recodeType3(ctx, font, used, normalize), bytes: 1 });
    } else if (normalize) {
      normalizeSimple(ctx, font, drop, used, removed, stats);
    } else {
      scrubSimple(ctx, font, drop, used, removed, stats);
    }
  }
  if (recodeMaps.size > 0) await rewriteFontCodes(doc, recodeMaps);
  return stats;
}

export type { PDFArray };
