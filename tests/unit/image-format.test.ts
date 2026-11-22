import { describe, it, expect } from 'vitest';
import { detectFileKind, outputFor } from '../../src/image/image-format';

const bytes = (...parts: (number[] | string)[]) => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], 'ftyp', brand, [0, 0, 0, 0], 'mif1', brand);
/** 主の銘柄と互換の銘柄を並べた ftyp の箱 */
const ftypWith = (major: string, ...compatible: string[]) =>
  bytes([0, 0, 0, 16 + compatible.length * 4], 'ftyp', major, [0, 0, 0, 0], ...compatible);

describe('detectFileKind: ファイル名や MIME ではなく中身で形式を決める', () => {
  it('PDF（先頭の %PDF-。前に余計なバイトがあっても読む）', () => {
    expect(detectFileKind(bytes('%PDF-1.7\n'))).toEqual({ kind: 'pdf' });
    expect(detectFileKind(bytes([0xef, 0xbb, 0xbf], '%PDF-1.4'))).toEqual({ kind: 'pdf' });
  });

  it('JPEG・PNG・WebP', () => {
    expect(detectFileKind(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toEqual({ kind: 'image', format: 'jpeg' });
    expect(detectFileKind(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toEqual({ kind: 'image', format: 'png' });
    expect(detectFileKind(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toEqual({ kind: 'image', format: 'webp' });
  });

  it('HEIC（iPhone の写真）と AVIF は ftyp の銘柄で見分ける', () => {
    expect(detectFileKind(ftyp('heic'))).toEqual({ kind: 'image', format: 'heic' });
    expect(detectFileKind(ftyp('heix'))).toEqual({ kind: 'image', format: 'heic' });
    expect(detectFileKind(ftyp('avif'))).toEqual({ kind: 'image', format: 'avif' });
  });

  it('主の銘柄が mif1・msf1 でも、互換の銘柄に heic・avif があれば読む', () => {
    expect(detectFileKind(ftypWith('mif1', 'mif1', 'heic'))).toEqual({ kind: 'image', format: 'heic' });
    expect(detectFileKind(ftypWith('msf1', 'msf1', 'hevc'))).toEqual({ kind: 'image', format: 'heic' });
    expect(detectFileKind(ftypWith('mif1', 'mif1', 'miaf', 'avif'))).toEqual({ kind: 'image', format: 'avif' });
  });

  it('互換の銘柄が箱の外にはみ出していたら見ない', () => {
    // 箱の大きさは 16（互換の銘柄なし）。後ろに続く 'heic' は次の箱のもの
    expect(detectFileKind(bytes([0, 0, 0, 16], 'ftyp', 'mif1', [0, 0, 0, 0], 'heic'))).toBeNull();
  });

  it('画像の先頭近くのコメントや文字の欄に %PDF- があっても、画像として読む', () => {
    expect(detectFileKind(bytes([0xff, 0xd8, 0xff, 0xfe, 0, 9], '%PDF-1.7'))).toEqual({ kind: 'image', format: 'jpeg' });
    expect(detectFileKind(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'tEXtComment\0%PDF-1.4'))).toEqual({ kind: 'image', format: 'png' });
  });

  it('知らない形式は null（拡張子が .jpg でも中身が違えば開かない）', () => {
    expect(detectFileKind(bytes('GIF89a'))).toBeNull();
    expect(detectFileKind(bytes('hello'))).toBeNull();
    expect(detectFileKind(new Uint8Array(0))).toBeNull();
    expect(detectFileKind(bytes('RIFF', [1, 2, 3, 4], 'WAVE'))).toBeNull();
    expect(detectFileKind(ftyp('mp42'))).toBeNull();
  });
});

describe('outputFor: 書き出す形式', () => {
  it('JPEG は JPEG のまま、HEIC は JPEG にする（どのブラウザでも開けるように）', () => {
    expect(outputFor('jpeg')).toMatchObject({ mime: 'image/jpeg', extension: 'jpg' });
    expect(outputFor('heic')).toMatchObject({ mime: 'image/jpeg', extension: 'jpg' });
  });

  it('PNG・WebP・AVIF は PNG にする（透明を保ち、劣化させない）', () => {
    for (const f of ['png', 'webp', 'avif'] as const) {
      expect(outputFor(f)).toMatchObject({ mime: 'image/png', extension: 'png' });
    }
  });
});
