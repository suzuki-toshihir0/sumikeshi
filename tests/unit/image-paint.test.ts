import { describe, it, expect } from 'vitest';
import { displayCanvasSize, toPixelBox, blackPixels, countNotBlack, shrinkBox, checkImageSize, MAX_IMAGE_SIDE, MAX_IMAGE_AREA } from '../../src/image/image-paint';
import { RedactionError } from '../../src/redaction/errors';

// 画像の範囲は、PDF と同じく左下を原点とし、1 画素を 1 単位とする
describe('toPixelBox: 範囲を画素の箱にする', () => {
  it('下からの y を、上からの行に直す', () => {
    expect(toPixelBox({ x: 10, y: 20, width: 30, height: 40 }, 100, 100)).toEqual({ x0: 10, y0: 40, x1: 40, y1: 80 });
  });

  it('一部でもかかる画素は箱に入れる（外向きに丸める）', () => {
    expect(toPixelBox({ x: 10.6, y: 20.2, width: 0.1, height: 0.1 }, 100, 100)).toEqual({ x0: 10, y0: 79, x1: 11, y1: 80 });
  });

  it('画像の外にはみ出す分は切り、まったくかからなければ null', () => {
    expect(toPixelBox({ x: -5, y: -5, width: 10, height: 10 }, 100, 100)).toEqual({ x0: 0, y0: 95, x1: 5, y1: 100 });
    expect(toPixelBox({ x: 100, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
    expect(toPixelBox({ x: 10, y: 10, width: 0, height: 10 }, 100, 100)).toBeNull();
  });
});

describe('blackPixels: 範囲を塗る画素の列', () => {
  it('すべて不透明の黒（0,0,0,255）', () => {
    const d = blackPixels(3, 2);
    expect(d.length).toBe(3 * 2 * 4);
    for (let i = 0; i < d.length; i += 4) expect(Array.from(d.slice(i, i + 4))).toEqual([0, 0, 0, 255]);
  });
});

describe('countNotBlack: 書き出した画像の範囲が黒いかを数える', () => {
  const rgba = (...px: number[][]) => new Uint8ClampedArray(px.flat());

  it('許す差の中の画素は黒とみなす（JPEG の圧縮で少しずれる）', () => {
    expect(countNotBlack(rgba([0, 0, 0, 255], [3, 5, 2, 255]), 8)).toBe(0);
    expect(countNotBlack(rgba([0, 0, 0, 255], [3, 9, 2, 255]), 8)).toBe(1);
  });

  it('透明な画素は黒でない（何も描かれていない canvas を見逃さない）', () => {
    expect(countNotBlack(rgba([0, 0, 0, 0], [0, 0, 0, 255]), 8)).toBe(1);
  });
});

describe('shrinkBox: 箱を内側に狭める', () => {
  it('四方を margin だけ狭め、潰れたら null', () => {
    expect(shrinkBox({ x0: 0, y0: 0, x1: 40, y1: 30 }, 8)).toEqual({ x0: 8, y0: 8, x1: 32, y1: 22 });
    expect(shrinkBox({ x0: 0, y0: 0, x1: 40, y1: 16 }, 8)).toBeNull();
  });
});

describe('checkImageSize: ブラウザの canvas に載らない大きさは止める', () => {
  it('iPhone の 4800 万画素（8064×6048）は通す', () => {
    expect(() => checkImageSize(8064, 6048)).not.toThrow();
  });

  it('辺か面積が上限を超えたら RedactionError', () => {
    expect(() => checkImageSize(MAX_IMAGE_SIDE + 1, 100)).toThrow(RedactionError);
    expect(() => checkImageSize(100, MAX_IMAGE_SIDE + 1)).toThrow(RedactionError);
    expect(MAX_IMAGE_SIDE * MAX_IMAGE_SIDE).toBeGreaterThan(MAX_IMAGE_AREA - 1);
    expect(() => checkImageSize(0, 100)).toThrow(RedactionError);
  });
});

describe('displayCanvasSize: 表示用の canvas の画素数', () => {
  it('上限に収まるなら、表示の大きさ×DPR', () => {
    expect(displayCanvasSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  });

  it('拡大表示で辺が上限を超えるなら、縦横比を保って上限まで縮める（100×8192 を 2.5 倍）', () => {
    const s = displayCanvasSize(250, 20480, 1);
    expect(s.height).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
    expect(s.width * s.height).toBeLessThanOrEqual(MAX_IMAGE_AREA);
    expect(s.width / s.height).toBeCloseTo(250 / 20480, 2);
  });

  it('面積が上限を超えるなら、上限まで縮める', () => {
    const s = displayCanvasSize(6000, 6000, 3);
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
    expect(s.width * s.height).toBeLessThanOrEqual(MAX_IMAGE_AREA);
  });

  it('1 画素より小さくはしない', () => {
    expect(displayCanvasSize(0.2, 0.2, 1)).toEqual({ width: 1, height: 1 });
  });
});
