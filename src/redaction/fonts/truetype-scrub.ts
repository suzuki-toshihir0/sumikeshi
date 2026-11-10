/**
 * 埋め込みの TrueType フォントから、指定した字形のデータを消して作り直す。
 *
 * 墨消しで消した文字の字形がフォントに残っていると、使われていない字形を描くだけで消した文字が分かる。
 * - glyf / loca: 消す字形を空にする（合成字形の部品として残る字形が使うものは残す）
 * - hmtx / vmtx: 消す字形の送り幅と左右の余白を 0 にする
 * - cmap: 消す字形への対応を外す（文字の集合が分かってしまうため）
 * - post: 消す字形の名前を外す
 * - GSUB / GPOS / kern など、字形どうしの関係を持つ表は、PDF の描画には使われないので捨てる
 */

const DROP_TABLES = new Set(['GSUB', 'GPOS', 'GDEF', 'kern', 'morx', 'mort', 'kerx', 'BASE', 'JSTF', 'MATH', 'hdmx', 'LTSH', 'VDMX', 'DSIG', 'feat', 'prop', 'trak', 'COLR', 'CPAL', 'SVG ', 'sbix', 'CBDT', 'CBLC', 'EBDT', 'EBLC', 'EBSC']);

export class TrueTypeScrubError extends Error {}

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const i16 = (b: Uint8Array, o: number) => {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
};
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

class Writer {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); }
  u16(v: number) { this.parts.push((v >> 8) & 0xff, v & 0xff); }
  i16(v: number) { this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v: number) { this.parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
  bytes(b: Uint8Array) { for (const x of b) this.parts.push(x); }
  get length() { return this.parts.length; }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}

function readTables(font: Uint8Array): Map<string, Uint8Array> {
  if (String.fromCharCode(font[0], font[1], font[2], font[3]) === 'ttcf') {
    throw new TrueTypeScrubError('TrueType のコレクションは扱えない');
  }
  const n = u16(font, 4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(font[rec], font[rec + 1], font[rec + 2], font[rec + 3]);
    const off = u32(font, rec + 8);
    const len = u32(font, rec + 12);
    if (off + len > font.length) throw new TrueTypeScrubError(`表 ${tag} がファイルの外を指す`);
    tables.set(tag, font.slice(off, off + len));
  }
  return tables;
}

function checksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) {
    sum = (sum + (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0;
  }
  return sum;
}

function writeFont(tables: Map<string, Uint8Array>, sfntVersion: number): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= n) entrySelector++;
  const searchRange = 2 ** entrySelector * 16;
  const head = new Writer();
  head.u32(sfntVersion);
  head.u16(n);
  head.u16(searchRange);
  head.u16(entrySelector);
  head.u16(n * 16 - searchRange);
  let offset = 12 + n * 16;
  const body: Uint8Array[] = [];
  for (const tag of tags) {
    const data = tables.get(tag)!;
    for (let k = 0; k < 4; k++) head.u8(tag.charCodeAt(k));
    head.u32(checksum(data));
    head.u32(offset);
    head.u32(data.length);
    const padded = new Uint8Array((data.length + 3) & ~3);
    padded.set(data);
    body.push(padded);
    offset += padded.length;
  }
  const out = new Uint8Array(offset);
  out.set(head.done(), 0);
  let pos = 12 + n * 16;
  for (const b of body) {
    out.set(b, pos);
    pos += b.length;
  }
  // head.checkSumAdjustment
  const headIndex = tags.indexOf('head');
  if (headIndex >= 0) {
    const headOff = u32(out, 12 + headIndex * 16 + 8);
    out.set([0, 0, 0, 0], headOff + 8);
    const adj = (0xb1b0afba - checksum(out)) >>> 0;
    out.set([(adj >>> 24) & 0xff, (adj >>> 16) & 0xff, (adj >>> 8) & 0xff, adj & 0xff], headOff + 8);
  }
  return out;
}

/** cmap の 1 つの表の、すべての（符号, 字形の番号）の組 */
function enumerateCmap(b: Uint8Array, o: number): [number, number][] | null {
  const format = u16(b, o);
  const out: [number, number][] = [];
  if (format === 0) {
    for (let c = 0; c < 256; c++) if (b[o + 6 + c]) out.push([c, b[o + 6 + c]]);
    return out;
  }
  if (format === 4) {
    const segX2 = u16(b, o + 6);
    const ends = o + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2; i += 2) {
      const end = u16(b, ends + i);
      const start = u16(b, starts + i);
      const delta = u16(b, deltas + i);
      const ro = u16(b, ranges + i);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g: number;
        if (ro === 0) g = (c + delta) & 0xffff;
        else {
          const p = ranges + i + ro + (c - start) * 2;
          if (p + 1 >= b.length) break;
          const gi = u16(b, p);
          g = gi === 0 ? 0 : (gi + delta) & 0xffff;
        }
        if (g) out.push([c, g]);
      }
    }
    return out;
  }
  if (format === 6) {
    const first = u16(b, o + 6);
    const count = u16(b, o + 8);
    for (let k = 0; k < count; k++) {
      const g = u16(b, o + 10 + k * 2);
      if (g) out.push([first + k, g]);
    }
    return out;
  }
  if (format === 12) {
    const groups = u32(b, o + 12);
    for (let i = 0; i < groups; i++) {
      const g0 = o + 16 + i * 12;
      const s = u32(b, g0);
      const e = u32(b, g0 + 4);
      const sg = u32(b, g0 + 8);
      if (e - s > 0x110000) return null;
      for (let c = s; c <= e; c++) out.push([c, sg + (c - s)]);
    }
    return out;
  }
  return null;
}

function buildFormat4(pairs: [number, number][]): Uint8Array {
  const sorted = pairs.filter(([c]) => c < 0xffff).sort((a, b) => a[0] - b[0]);
  // 連続する符号ごとに区切る。字形の番号も連続なら idDelta、そうでなければ glyphIdArray
  const segs: { start: number; end: number; gids: number[] }[] = [];
  for (const [c, g] of sorted) {
    const last = segs[segs.length - 1];
    if (last && c === last.end + 1) {
      last.end = c;
      last.gids.push(g);
    } else {
      segs.push({ start: c, end: c, gids: [g] });
    }
  }
  segs.push({ start: 0xffff, end: 0xffff, gids: [0] });
  const segCount = segs.length;
  const useDelta = segs.map((s) => s.gids.every((g, i) => g - s.start - i === s.gids[0] - s.start));
  const glyphArrays: number[][] = [];
  const rangeOffsets: number[] = [];
  let arrayWords = 0;
  segs.forEach((s, i) => {
    if (useDelta[i] || i === segCount - 1) {
      rangeOffsets.push(0);
    } else {
      // idRangeOffset は、その要素の位置から glyphIdArray の該当位置までのバイト数
      rangeOffsets.push((segCount - i + arrayWords) * 2);
      glyphArrays.push(s.gids);
      arrayWords += s.gids.length;
    }
  });
  const w = new Writer();
  const length = 16 + segCount * 8 + arrayWords * 2;
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= segCount) entrySelector++;
  const searchRange = 2 ** entrySelector * 2;
  w.u16(4);
  w.u16(length);
  w.u16(0);
  w.u16(segCount * 2);
  w.u16(searchRange);
  w.u16(entrySelector);
  w.u16(segCount * 2 - searchRange);
  for (const s of segs) w.u16(s.end);
  w.u16(0);
  for (const s of segs) w.u16(s.start);
  segs.forEach((s, i) => {
    if (useDelta[i] && i !== segCount - 1) w.u16((s.gids[0] - s.start) & 0xffff);
    else if (i === segCount - 1) w.u16(1);
    else w.u16(0);
  });
  for (const r of rangeOffsets) w.u16(r);
  for (const arr of glyphArrays) for (const g of arr) w.u16(g);
  return w.done();
}

function buildFormat12(pairs: [number, number][]): Uint8Array {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const groups: [number, number, number][] = [];
  for (const [c, g] of sorted) {
    const last = groups[groups.length - 1];
    if (last && c === last[1] + 1 && g === last[2] + (c - last[0])) last[1] = c;
    else groups.push([c, c, g]);
  }
  const w = new Writer();
  w.u16(12);
  w.u16(0);
  w.u32(16 + groups.length * 12);
  w.u32(0);
  w.u32(groups.length);
  for (const [s, e, g] of groups) {
    w.u32(s);
    w.u32(e);
    w.u32(g);
  }
  return w.done();
}

function buildFormat0(pairs: [number, number][]): Uint8Array {
  const w = new Writer();
  w.u16(0);
  w.u16(262);
  w.u16(0);
  const arr = new Uint8Array(256);
  for (const [c, g] of pairs) if (c < 256 && g < 256) arr[c] = g;
  w.bytes(arr);
  return w.done();
}

function rebuildCmap(cmap: Uint8Array, keep: (gid: number) => boolean, remap: (gid: number) => number = (g) => g): Uint8Array {
  const n = u16(cmap, 2);
  const subs: { pid: number; eid: number; data: Uint8Array }[] = [];
  const cache = new Map<number, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const rec = 4 + i * 8;
    const pid = u16(cmap, rec);
    const eid = u16(cmap, rec + 2);
    const off = u32(cmap, rec + 4);
    let data = cache.get(off);
    if (!data) {
      const pairs = enumerateCmap(cmap, off);
      if (!pairs) continue; // 読めない形式の表は捨てる
      const kept = pairs.filter(([, g]) => keep(g)).map(([c, g]) => [c, remap(g)] as [number, number]);
      const fmt = u16(cmap, off);
      if (fmt === 0) data = buildFormat0(kept);
      else if (kept.some(([c]) => c > 0xfffe) || fmt === 12) data = buildFormat12(kept);
      else data = buildFormat4(kept);
      cache.set(off, data);
    }
    subs.push({ pid, eid, data });
  }
  const w = new Writer();
  w.u16(0);
  w.u16(subs.length);
  const offsets = new Map<Uint8Array, number>();
  let off = 4 + subs.length * 8;
  for (const s of subs) {
    if (!offsets.has(s.data)) {
      offsets.set(s.data, off);
      off += s.data.length;
    }
  }
  for (const s of subs) {
    w.u16(s.pid);
    w.u16(s.eid);
    w.u32(offsets.get(s.data)!);
  }
  for (const [d] of offsets) w.bytes(d);
  return w.done();
}

function rebuildPost(post: Uint8Array, numGlyphs: number, keep: (gid: number) => boolean): Uint8Array {
  const version = u32(post, 0);
  if (version !== 0x00020000) {
    if (version === 0x00025000) {
      const out = post.slice(0, 32);
      out.set([0, 3, 0, 0], 0);
      return out;
    }
    return post;
  }
  const n = Math.min(u16(post, 32), numGlyphs);
  const index: number[] = [];
  for (let g = 0; g < n; g++) index.push(u16(post, 34 + g * 2));
  // 独自の名前（番号 258 以上）
  const names: Uint8Array[] = [];
  let p = 34 + u16(post, 32) * 2;
  while (p < post.length) {
    const len = post[p];
    names.push(post.slice(p, p + 1 + len));
    p += 1 + len;
  }
  const newNames: Uint8Array[] = [];
  const remap = new Map<number, number>();
  const newIndex = index.map((ix, g) => {
    if (!keep(g)) return 0;
    if (ix < 258) return ix;
    const old = ix - 258;
    if (!remap.has(old)) {
      remap.set(old, 258 + newNames.length);
      newNames.push(names[old] ?? Uint8Array.of(0));
    }
    return remap.get(old)!;
  });
  const w = new Writer();
  w.bytes(post.slice(0, 32));
  w.u16(n);
  for (const ix of newIndex) w.u16(ix);
  for (const nm of newNames) w.bytes(nm);
  return w.done();
}

/** 合成字形が部品として使う字形の番号 */
function components(glyph: Uint8Array): number[] {
  if (glyph.length < 10 || i16(glyph, 0) >= 0) return [];
  const out: number[] = [];
  let p = 10;
  for (let guard = 0; guard < 256 && p + 4 <= glyph.length; guard++) {
    const flags = u16(glyph, p);
    out.push(u16(glyph, p + 2));
    p += 4;
    p += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) p += 2;
    else if (flags & 0x0040) p += 4;
    else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

/**
 * 指定した字形を消した TrueType を返す。
 * 返り値の第 2 要素は、実際に消した字形の番号（合成字形の部品として残したものを除く）。
 */
export function scrubTrueType(font: Uint8Array, dropGids: Set<number>): { font: Uint8Array; dropped: Set<number> } {
  const tables = readTables(font);
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (!head || !maxp) throw new TrueTypeScrubError('head か maxp が無い');
  const numGlyphs = u16(maxp, 4);
  const longLoca = i16(head, 50) === 1;
  const glyphs: Uint8Array[] = [];
  if (loca && glyf) {
    for (let g = 0; g < numGlyphs; g++) {
      const s = longLoca ? u32(loca, g * 4) : u16(loca, g * 2) * 2;
      const e = longLoca ? u32(loca, (g + 1) * 4) : u16(loca, (g + 1) * 2) * 2;
      glyphs.push(e > s && e <= glyf.length ? glyf.slice(s, e) : new Uint8Array(0));
    }
  }
  // 残す合成字形の部品は消さない
  const drop = new Set([...dropGids].filter((g) => g > 0 && g < numGlyphs));
  let changed = true;
  while (changed) {
    changed = false;
    for (let g = 0; g < glyphs.length; g++) {
      if (drop.has(g)) continue;
      for (const c of components(glyphs[g])) {
        if (drop.delete(c)) changed = true;
      }
    }
  }
  const keep = (g: number) => !drop.has(g);

  if (loca && glyf) {
    const newGlyf = new Writer();
    const newLoca = new Writer();
    for (let g = 0; g < numGlyphs; g++) {
      newLoca.u32(newGlyf.length);
      if (keep(g)) {
        newGlyf.bytes(glyphs[g]);
        while (newGlyf.length % 4) newGlyf.u8(0);
      }
    }
    newLoca.u32(newGlyf.length);
    tables.set('glyf', newGlyf.done());
    tables.set('loca', newLoca.done());
    const h = head.slice();
    h[50] = 0;
    h[51] = 1; // loca は 4 バイト
    tables.set('head', h);
  }

  const zeroMetrics = (mtxTag: string, heaTag: string) => {
    const mtx = tables.get(mtxTag);
    const hea = tables.get(heaTag);
    if (!mtx || !hea) return;
    const m = mtx.slice();
    const numLong = u16(hea, 34);
    for (const g of drop) {
      if (g < numLong) {
        if (g * 4 + 3 < m.length) m.fill(0, g * 4, g * 4 + 4);
      } else {
        const o = numLong * 4 + (g - numLong) * 2;
        if (o + 1 < m.length) m.fill(0, o, o + 2);
      }
    }
    tables.set(mtxTag, m);
  };
  zeroMetrics('hmtx', 'hhea');
  zeroMetrics('vmtx', 'vhea');

  const cmap = tables.get('cmap');
  if (cmap) tables.set('cmap', rebuildCmap(cmap, keep));
  const post = tables.get('post');
  if (post) tables.set('post', rebuildPost(post, numGlyphs, keep));
  for (const t of [...tables.keys()]) if (DROP_TABLES.has(t)) tables.delete(t);

  return { font: writeFont(tables, u32(font, 0)), dropped: drop };
}

/** 合成字形の部品の番号を書き換えた写し */
function remapComponents(glyph: Uint8Array, map: Map<number, number>): Uint8Array {
  if (glyph.length < 10 || i16(glyph, 0) >= 0) return glyph;
  const out = glyph.slice();
  let p = 10;
  for (let guard = 0; guard < 256 && p + 4 <= out.length; guard++) {
    const flags = u16(out, p);
    const g = u16(out, p + 2);
    const ng = map.get(g) ?? 0;
    out[p + 2] = (ng >> 8) & 0xff;
    out[p + 3] = ng & 0xff;
    p += 4;
    p += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) p += 2;
    else if (flags & 0x0040) p += 4;
    else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

/**
 * 指定した字形を番号ごと取り除き、残る字形の番号を詰め直した TrueType を返す。
 * 部分集合のフォントは使う字形だけを詰めて番号を振るので、字形を空にするだけだと「空の番号」が穴として残り、
 * 前後の残る字形から、元のフォントの字形の順で消した字の範囲が分かってしまう。
 * 返り値の map は、古い番号 → 新しい番号（残る字形だけ）。
 */
export function compactTrueType(font: Uint8Array, dropGids: Set<number>): { font: Uint8Array; map: Map<number, number>; dropped: Set<number> } {
  const tables = readTables(font);
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (!head || !maxp || !loca || !glyf) throw new TrueTypeScrubError('head・maxp・loca・glyf のどれかが無い');
  const numGlyphs = u16(maxp, 4);
  const longLoca = i16(head, 50) === 1;
  const glyphs: Uint8Array[] = [];
  for (let g = 0; g < numGlyphs; g++) {
    const s = longLoca ? u32(loca, g * 4) : u16(loca, g * 2) * 2;
    const e = longLoca ? u32(loca, (g + 1) * 4) : u16(loca, (g + 1) * 2) * 2;
    glyphs.push(e > s && e <= glyf.length ? glyf.slice(s, e) : new Uint8Array(0));
  }
  const drop = new Set([...dropGids].filter((g) => g > 0 && g < numGlyphs));
  let changed = true;
  while (changed) {
    changed = false;
    for (let g = 0; g < glyphs.length; g++) {
      if (drop.has(g)) continue;
      for (const c of components(glyphs[g])) if (drop.delete(c)) changed = true;
    }
  }
  const map = new Map<number, number>();
  for (let g = 0; g < numGlyphs; g++) if (!drop.has(g)) map.set(g, map.size);
  const kept = [...map.keys()];

  const newGlyf = new Writer();
  const newLoca = new Writer();
  for (const g of kept) {
    newLoca.u32(newGlyf.length);
    newGlyf.bytes(remapComponents(glyphs[g], map));
    while (newGlyf.length % 4) newGlyf.u8(0);
  }
  newLoca.u32(newGlyf.length);
  tables.set('glyf', newGlyf.done());
  tables.set('loca', newLoca.done());
  const h = head.slice();
  h[50] = 0;
  h[51] = 1;
  tables.set('head', h);
  const m = maxp.slice();
  m[4] = (kept.length >> 8) & 0xff;
  m[5] = kept.length & 0xff;
  tables.set('maxp', m);

  const rebuildMetrics = (mtxTag: string, heaTag: string) => {
    const mtx = tables.get(mtxTag);
    const hea = tables.get(heaTag);
    if (!mtx || !hea) return;
    const numLong = u16(hea, 34);
    const w = new Writer();
    for (const g of kept) {
      const li = Math.min(g, numLong - 1);
      const adv = li >= 0 && li * 4 + 1 < mtx.length ? u16(mtx, li * 4) : 0;
      const side = g < numLong ? (g * 4 + 3 < mtx.length ? i16(mtx, g * 4 + 2) : 0)
        : (numLong * 4 + (g - numLong) * 2 + 1 < mtx.length ? i16(mtx, numLong * 4 + (g - numLong) * 2) : 0);
      w.u16(adv);
      w.i16(side);
    }
    tables.set(mtxTag, w.done());
    const nh = hea.slice();
    nh[34] = (kept.length >> 8) & 0xff;
    nh[35] = kept.length & 0xff;
    tables.set(heaTag, nh);
  };
  rebuildMetrics('hmtx', 'hhea');
  rebuildMetrics('vmtx', 'vhea');

  const cmap = tables.get('cmap');
  if (cmap) tables.set('cmap', rebuildCmap(cmap, (g) => map.has(g), (g) => map.get(g)!));
  const post = tables.get('post');
  if (post) tables.set('post', compactPost(post, numGlyphs, kept));
  for (const t of [...tables.keys()]) if (DROP_TABLES.has(t)) tables.delete(t);
  return { font: writeFont(tables, u32(font, 0)), map, dropped: drop };
}

/** post の形式 2 を、残る字形の順に作り直す */
function compactPost(post: Uint8Array, numGlyphs: number, kept: number[]): Uint8Array {
  const version = u32(post, 0);
  if (version !== 0x00020000) {
    if (version === 0x00025000) {
      const out = post.slice(0, 32);
      out.set([0, 3, 0, 0], 0);
      return out;
    }
    return post;
  }
  const n = Math.min(u16(post, 32), numGlyphs);
  const index: number[] = [];
  for (let g = 0; g < n; g++) index.push(u16(post, 34 + g * 2));
  const names: Uint8Array[] = [];
  let p = 34 + u16(post, 32) * 2;
  while (p < post.length) {
    const len = post[p];
    names.push(post.slice(p, p + 1 + len));
    p += 1 + len;
  }
  const newNames: Uint8Array[] = [];
  const remap = new Map<number, number>();
  const newIndex = kept.map((g) => {
    const ix = index[g] ?? 0;
    if (ix < 258) return ix;
    const old = ix - 258;
    if (!remap.has(old)) {
      remap.set(old, 258 + newNames.length);
      newNames.push(names[old] ?? Uint8Array.of(0));
    }
    return remap.get(old)!;
  });
  const w = new Writer();
  w.bytes(post.slice(0, 32));
  w.u16(kept.length);
  for (const ix of newIndex) w.u16(ix);
  for (const nm of newNames) w.bytes(nm);
  return w.done();
}
