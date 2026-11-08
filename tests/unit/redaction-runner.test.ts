import { describe, it, expect, vi } from 'vitest';
import { runRedactionInWorker, type WorkerLike } from '../../src/redaction/redaction-runner';
import { RedactionError } from '../../src/redaction/errors';

/** 返事を手で送れる、Worker の代わり */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const bytes = () => new Uint8Array([1, 2, 3]).buffer;
const rects = new Map([[1, [{ x: 0, y: 0, width: 1, height: 1 }]]]);

describe('runRedactionInWorker', () => {
  it('Worker の結果を返し、Worker を止める', async () => {
    const w = new FakeWorker();
    const p = runRedactionInWorker(() => w, bytes(), rects, 1000);
    expect(w.posted).toHaveLength(1);
    w.reply({ ok: true, bytes: new Uint8Array([9, 9]) });
    await expect(p).resolves.toEqual(new Uint8Array([9, 9]));
    expect(w.terminated).toBe(true);
  });

  it('Worker が RedactionError を返したら、RedactionError にして投げる', async () => {
    const w = new FakeWorker();
    const p = runRedactionInWorker(() => w, bytes(), rects, 1000);
    w.reply({ ok: false, name: 'RedactionError', message: '読めない画像' });
    await expect(p).rejects.toBeInstanceOf(RedactionError);
    await expect(p).rejects.toThrow('読めない画像');
  });

  it('時間内に返事が無ければ、Worker を止めて RedactionError を投げる', async () => {
    vi.useFakeTimers();
    try {
      const w = new FakeWorker();
      const p = runRedactionInWorker(() => w, bytes(), rects, 5000);
      const check = expect(p).rejects.toBeInstanceOf(RedactionError);
      vi.advanceTimersByTime(5001);
      await check;
      expect(w.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Worker が落ちたら、Error にして投げ、Worker を止める', async () => {
    const w = new FakeWorker();
    const p = runRedactionInWorker(() => w, bytes(), rects, 1000);
    w.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(p).rejects.toThrow('boom');
    expect(w.terminated).toBe(true);
  });
});
