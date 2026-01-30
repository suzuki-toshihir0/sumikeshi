import { describe, it, expect, beforeEach } from 'vitest';
import { RedactionStore } from '../../src/redaction/redaction-store';

describe('RedactionStore', () => {
  let store: RedactionStore;

  beforeEach(() => {
    store = new RedactionStore();
  });

  it('空の状態ではhasRectsがfalse', () => {
    expect(store.hasRects).toBe(false);
  });

  it('領域を追加するとhasRectsがtrue', () => {
    store.add(1, { x: 0, y: 0, width: 100, height: 50 });
    expect(store.hasRects).toBe(true);
  });

  it('ページごとに領域を管理する', () => {
    store.add(1, { x: 0, y: 0, width: 100, height: 50 });
    store.add(2, { x: 10, y: 10, width: 200, height: 100 });
    store.add(1, { x: 50, y: 50, width: 100, height: 50 });

    expect(store.getRectsForPage(1)).toHaveLength(2);
    expect(store.getRectsForPage(2)).toHaveLength(1);
    expect(store.getRectsForPage(3)).toHaveLength(0);
  });

  it('指定インデックスの領域を削除できる', () => {
    store.add(1, { x: 0, y: 0, width: 100, height: 50 });
    store.add(1, { x: 50, y: 50, width: 100, height: 50 });

    store.remove(1, 0);
    const rects = store.getRectsForPage(1);
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBe(50);
  });

  it('clearで全領域がクリアされる', () => {
    store.add(1, { x: 0, y: 0, width: 100, height: 50 });
    store.add(2, { x: 10, y: 10, width: 200, height: 100 });

    store.clear();
    expect(store.hasRects).toBe(false);
    expect(store.getRectsForPage(1)).toHaveLength(0);
    expect(store.getRectsForPage(2)).toHaveLength(0);
  });

  it('getAllRectsで全ページの領域を取得できる', () => {
    store.add(1, { x: 0, y: 0, width: 100, height: 50 });
    store.add(3, { x: 10, y: 10, width: 200, height: 100 });

    const all = store.getAllRects();
    expect(all.size).toBe(2);
    expect(all.has(1)).toBe(true);
    expect(all.has(3)).toBe(true);
  });
});
