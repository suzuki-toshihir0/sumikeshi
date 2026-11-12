/**
 * 墨消しを Web Worker で動かす。
 *
 * 壊れた画像などで復号器が終わらなくなっても、画面が固まらないようにし、
 * 時間内に終わらなければ Worker を止めて RedactionError を投げる。
 */
import type { PdfRect } from '../utils/coordinates';
import { RedactionError } from './errors';

export interface WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface RedactionRequest {
  bytes: ArrayBuffer;
  rects: [number, PdfRect[]][];
}

export type RedactionResponse =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; name: string; message: string };

/** 既定の待ち時間。大きなスキャンでも数秒で終わるので、十分に長く取る */
export const DEFAULT_TIMEOUT_MS = 120_000;

export function runRedactionInWorker(
  createWorker: () => WorkerLike,
  bytes: ArrayBuffer,
  redactionMap: Map<number, PdfRect[]>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      reject(new RedactionError(
        `墨消しが ${Math.round(timeoutMs / 1000)} 秒で終わりませんでした。PDF の中の画像が壊れているなどで、読み終わらない可能性があります。`,
      ));
    }, timeoutMs);
    worker.onmessage = (e: MessageEvent) => {
      if (done) return;
      finish();
      const res = e.data as RedactionResponse;
      if (res.ok) resolve(res.bytes);
      else if (res.name === 'RedactionError') reject(new RedactionError(res.message));
      else reject(new Error(res.message));
    };
    worker.onerror = (e: ErrorEvent) => {
      if (done) return;
      finish();
      reject(new Error(e.message || '墨消しの処理が異常終了しました'));
    };
    const request: RedactionRequest = { bytes, rects: [...redactionMap] };
    worker.postMessage(request, [bytes]);
  });
}
