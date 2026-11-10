/**
 * Type0 フォントの CMap（文字列のバイト列 → 符号 → CID）。
 * 文字幅は CID ごとに決まるので、文字列を正しく符号に分け、CID を引ける必要がある。
 */
import { BinaryCMapReader } from '../vendor/pdfjs-binary-cmap';
import { parseContentStream, latin1, type Operand } from '../content/lexer';

/** 定義済みの CMap（UniJIS-UCS2-H など）の .bcmap を取ってくる関数 */
export type CMapLoader = (name: string) => Promise<Uint8Array>;

export class UnsupportedCMapError extends Error {}

const MAX_MAP_RANGE = 2 ** 24 - 1;

export class CMap {
  /** codespaceRanges[n-1] は n バイトの符号の [low, high, low, high, ...] */
  codespaceRanges: number[][] = [[], [], [], []];
  vertical = false;
  name = '';
  private map = new Map<number, number>();
  private ranges: [number, number, number][] = [];
  identity = false;

  addCodespaceRange(n: number, low: number, high: number): void {
    this.codespaceRanges[n - 1].push(low, high);
  }

  mapCidRange(low: number, high: number, dstLow: number): void {
    if (high - low > MAX_MAP_RANGE) throw new UnsupportedCMapError('CMap の範囲が大きすぎる');
    this.ranges.push([low, high, dstLow]);
  }

  mapOne(src: number, dst: number | string): void {
    if (typeof dst === 'number') this.map.set(src, dst);
  }

  // ToUnicode 用の対応。CID を引くのには使わない
  mapBfRange(): void {}

  /** 文字列の offset から 1 つ符号を読む（pdf.js の CMap.readCharCode と同じ規則） */
  readCharCode(bytes: Uint8Array, offset: number): { code: number; length: number } {
    let c = 0;
    for (let n = 0; n < 4; n++) {
      if (offset + n >= bytes.length) break;
      c = ((c << 8) | bytes[offset + n]) >>> 0;
      const r = this.codespaceRanges[n];
      for (let k = 0; k < r.length; k += 2) {
        if (c >= r[k] && c <= r[k + 1]) return { code: c, length: n + 1 };
      }
    }
    return { code: 0, length: 1 };
  }

  lookupCid(code: number): number {
    const v = this.lookupOwn(code);
    return v ?? 0;
  }

  private parent: CMap | undefined;

  private lookupOwn(code: number): number | undefined {
    if (this.identity) return code;
    const v = this.map.get(code);
    if (v !== undefined) return v;
    // 後に書かれた範囲を優先する
    for (let i = this.ranges.length - 1; i >= 0; i--) {
      const [lo, hi, dst] = this.ranges[i];
      if (code >= lo && code <= hi) return dst + (code - lo);
    }
    return this.parent?.lookupOwn(code);
  }

  /**
   * usecmap で読んだ親の CMap を取り込む（pdf.js の extendCMap と同じ規則）。
   * 自分の対応が優先。符号の範囲は、自分が持っていないときだけ親のものを使う。
   */
  extend(parent: CMap): void {
    if (this.codespaceRanges.every((r) => r.length === 0)) {
      for (let n = 0; n < 4; n++) for (const v of parent.codespaceRanges[n]) this.codespaceRanges[n].push(v);
    }
    this.parent = parent;
  }
}

export function identityCMap(vertical: boolean): CMap {
  const c = new CMap();
  c.name = vertical ? 'Identity-V' : 'Identity-H';
  c.vertical = vertical;
  c.addCodespaceRange(2, 0, 0xffff);
  c.identity = true;
  return c;
}

/** 名前の決まった CMap を読む */
export async function loadPredefinedCMap(name: string, loader: CMapLoader | undefined, depth = 0): Promise<CMap> {
  if (name === 'Identity-H' || name === 'Identity-V') return identityCMap(name === 'Identity-V');
  if (!loader) throw new UnsupportedCMapError(`CMap ${name} を読む手段が無い`);
  if (depth > 8) throw new UnsupportedCMapError('usecmap が深すぎる');
  const data = await loader(name);
  const cmap = new CMap();
  cmap.name = name;
  const reader = new BinaryCMapReader();
  return reader.process(data, cmap, async (useName: string) => {
    const parent = await loadPredefinedCMap(useName, loader, depth + 1);
    const vertical = cmap.vertical;
    cmap.extend(parent);
    cmap.vertical = vertical;
    return cmap;
  });
}

const asInt = (o: Operand | undefined): number | undefined => {
  if (!o) return undefined;
  if (o.type === 'number') return o.value;
  if (o.type === 'string') {
    let n = 0;
    for (const b of o.bytes) n = (n * 256 + b) >>> 0;
    return n;
  }
  return undefined;
};

/** PDF に埋め込まれた CMap（テキスト形式）を読む */
export async function parseEmbeddedCMap(
  data: Uint8Array,
  loader: CMapLoader | undefined,
  useCMapFromDict?: CMap,
  wmodeFromDict?: number,
): Promise<CMap> {
  const cmap = new CMap();
  let parent: CMap | undefined = useCMapFromDict;
  let ops;
  try {
    ops = parseContentStream(data);
  } catch (e) {
    throw new UnsupportedCMapError(`埋め込みの CMap を読めない: ${(e as Error).message}`);
  }
  for (const o of ops) {
    switch (o.op) {
      case 'endcodespacerange':
        for (let i = 0; i + 1 < o.operands.length; i += 2) {
          const lo = o.operands[i];
          const hi = o.operands[i + 1];
          if (lo.type !== 'string' || hi.type !== 'string') continue;
          cmap.addCodespaceRange(Math.min(4, Math.max(1, hi.bytes.length)), asInt(lo)!, asInt(hi)!);
        }
        break;
      case 'endcidrange':
        for (let i = 0; i + 2 < o.operands.length; i += 3) {
          const lo = asInt(o.operands[i]);
          const hi = asInt(o.operands[i + 1]);
          const dst = asInt(o.operands[i + 2]);
          if (lo !== undefined && hi !== undefined && dst !== undefined) cmap.mapCidRange(lo, hi, dst);
        }
        break;
      case 'endcidchar':
        for (let i = 0; i + 1 < o.operands.length; i += 2) {
          const src = asInt(o.operands[i]);
          const dst = asInt(o.operands[i + 1]);
          if (src !== undefined && dst !== undefined) cmap.mapOne(src, dst);
        }
        break;
      case 'usecmap': {
        const n = o.operands[0];
        if (n?.type === 'name') parent = await loadPredefinedCMap(n.value, loader);
        break;
      }
      case 'def': {
        const [k, v] = o.operands;
        if (k?.type === 'name' && k.value === 'WMode' && v?.type === 'number') cmap.vertical = v.value === 1;
        if (k?.type === 'name' && k.value === 'CMapName' && v?.type === 'name') cmap.name = v.value;
        break;
      }
    }
  }
  if (parent) {
    const vertical = cmap.vertical;
    cmap.extend(parent);
    cmap.vertical = vertical || parent.vertical;
  }
  if (wmodeFromDict !== undefined) cmap.vertical = wmodeFromDict === 1;
  if (cmap.codespaceRanges.every((r) => r.length === 0)) {
    throw new UnsupportedCMapError(`埋め込みの CMap ${cmap.name || ''} に codespacerange が無い`);
  }
  return cmap;
}

export { latin1 };
