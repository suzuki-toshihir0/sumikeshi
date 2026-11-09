/**
 * 墨消しで消した文字の情報を、フォントからも消す。
 *
 * 消した文字の符号のうち、文書のどこでももう使われていないものについて:
 * - 字形: Type3 の CharProcs、埋め込みの TrueType の字形（truetype-scrub.ts）
 * - 幅: Widths（単純フォント）、W / W2（複合フォント）
 * - 名前と対応: Encoding の Differences、ToUnicode、埋め込みの CMap、FontDescriptor の CharSet / CIDSet
 * 字形のデータを書き換えられない形式（CFF、Type1）は、フォントのデータそのものを外す（ビューアーは代わりのフォントで描く）。
 */
import {
  PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFStream,
} from 'pdf-lib';
import { get, getArray, getDict, getName, getNum, numbersOf, resolve, streamBytes } from '../pdf-objects';
import { parseContentStream } from '../content/lexer';
import { createFontModel, glyphNames, parseW, parseW2, type FontModel } from './font-model';
import { collectFontUsage } from './usage';
import { parseTrueType, simpleTrueTypeGid, type TrueTypeInfo } from './truetype';
import { scrubTrueType } from './truetype-scrub';
import type { CMapLoader } from './cmap';
import { STANDARD_FONT_ALIASES } from '../vendor/pdfjs-encodings';

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

function scrubToUnicode(ctx: PDFContext, font: PDFDict, drop: Set<number>): void {
  const tu = get(ctx, font, 'ToUnicode');
  if (!(tu instanceof PDFStream)) return;
  const parsed = readToUnicode(streamBytes(ctx, tu));
  if (!parsed) {
    // 読めない ToUnicode は外す（文字のコピーができなくなるが、消した文字は残らない）
    font.delete(PDFName.of('ToUnicode'));
    return;
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

function zeroWidths(ctx: PDFContext, font: PDFDict, drop: Set<number>): void {
  const widths = getArray(ctx, font, 'Widths');
  if (!widths) return;
  const first = getNum(ctx, font, 'FirstChar') ?? 0;
  const ws = numbersOf(ctx, widths).map((w, i) => (drop.has(first + i) ? 0 : w));
  font.set(PDFName.of('Widths'), ctx.obj(ws));
}

function scrubSimple(ctx: PDFContext, font: PDFDict, drop: Set<number>, used: Set<number>, stats: FontScrubStats): void {
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
        const r = scrubTrueType(tt.bytes, dropGids);
        replaceFontFile2(ctx, descriptor, r.font);
        stats.glyphsScrubbed += r.dropped.size;
      }
    } else {
      unembed(ctx, descriptor, stats);
    }
  }
  zeroWidths(ctx, font, drop);
  rebuildDifferences(ctx, font, drop);
  scrubToUnicode(ctx, font, drop);
  cleanDescriptor(descriptor);
}

async function scrubComposite(
  ctx: PDFContext, font: PDFDict, model: FontModel, drop: Set<number>, used: Set<number>, stats: FontScrubStats,
): Promise<void> {
  const descendants = getArray(ctx, font, 'DescendantFonts');
  const cidFont = descendants ? resolve(ctx, descendants.get(0)) : undefined;
  if (!(cidFont instanceof PDFDict) || !model.cidOf) return;
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

  // 埋め込みの CMap は、使う符号の分だけにする
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

  // 字形
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
        const r = scrubTrueType(tt.bytes, dropGids);
        replaceFontFile2(ctx, descriptor, r.font);
        stats.glyphsScrubbed += r.dropped.size;
      }
    } else {
      unembed(ctx, descriptor, stats);
    }
  } else if (dropCids.size > 0) {
    unembed(ctx, descriptor, stats);
  }
  scrubToUnicode(ctx, font, drop);
  cleanDescriptor(descriptor);
}

/**
 * 消した文字の符号（フォントごと）のうち、文書のどこでももう使われていないものを、フォントから消す。
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
  const usage = await collectFontUsage(doc, new Set(removedCodes.keys()), fontCache, cmapLoader);
  for (const [font, removed] of removedCodes) {
    const used = usage.get(font) ?? new Set<number>();
    const drop = new Set([...removed].filter((c) => !used.has(c)));
    if (drop.size === 0) continue;
    stats.fontsScrubbed++;
    if (getName(ctx, font, 'Subtype') === 'Type0') {
      let model: FontModel | null = null;
      try {
        model = await (fontCache.get(font) ?? createFontModel(ctx, font, cmapLoader));
      } catch {
        model = null;
      }
      if (model) await scrubComposite(ctx, font, model, drop, used, stats);
    } else {
      scrubSimple(ctx, font, drop, used, stats);
    }
  }
  return stats;
}

export type { PDFArray };
