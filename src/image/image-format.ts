/** 開ける画像の形式 */
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'heic';

export type FileKind = { kind: 'pdf' } | { kind: 'image'; format: ImageFormat };

/** 書き出す形式 */
export interface ImageOutput {
  mime: 'image/jpeg' | 'image/png';
  extension: 'jpg' | 'png';
  /** JPEG の画質（0〜1） */
  quality?: number;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return '';
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

/**
 * HEIF の箱（ftyp）の銘柄から、HEIC か AVIF かを決める。主の銘柄が汎用の mif1・msf1 のファイルもあるので、
 * 主の銘柄、互換の銘柄の順に見る（互換の銘柄は箱の大きさの中だけ）
 */
function heifFormat(bytes: Uint8Array): 'heic' | 'avif' | null {
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const end = Math.min(size === 0 ? bytes.length : size, bytes.length);
  const brands = [ascii(bytes, 8, 4)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(bytes, o, 4));
  for (const brand of brands) {
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

/**
 * ファイルの形式を中身の先頭のバイトで決める。
 * ファイル名や MIME は当てにしない（iPhone は JPEG に変えた写真に .heic の名前を残すことがある）。
 */
export function detectFileKind(bytes: Uint8Array): FileKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', format: 'png' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { kind: 'image', format: 'webp' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const format = heifFormat(bytes);
    if (format) return { kind: 'image', format };
  }
  // PDF は先頭の 1024 バイトのどこかに %PDF- があればよい（pdf.js も前の余計なバイトを読み飛ばす）。
  // 画像のコメントや文字の欄に %PDF- が入っていることもあるので、先頭で決まる画像の形式を先に見る
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024));
  if (head.includes('%PDF-')) return { kind: 'pdf' };
  return null;
}

/**
 * 墨消しした画像を書き出す形式。JPEG の写真は JPEG のまま、HEIC はどのブラウザでも開ける JPEG にする。
 * ほかは透明を保ち劣化もしない PNG にする（Safari の canvas は WebP・AVIF に書き出せない）
 */
export function outputFor(format: ImageFormat): ImageOutput {
  if (format === 'jpeg' || format === 'heic') return { mime: 'image/jpeg', extension: 'jpg', quality: 0.95 };
  return { mime: 'image/png', extension: 'png' };
}
