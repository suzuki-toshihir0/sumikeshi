/// <reference lib="webworker" />
/** 墨消しを動かす Web Worker（redaction-runner.ts から使う） */
import { redactPdf } from './pdf-redactor';
import type { RedactionRequest, RedactionResponse } from './redaction-runner';

self.onmessage = async (e: MessageEvent<RedactionRequest>) => {
  let res: RedactionResponse;
  try {
    const bytes = await redactPdf(e.data.bytes, new Map(e.data.rects));
    res = { ok: true, bytes };
    (self as unknown as Worker).postMessage(res, [bytes.buffer]);
    return;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    res = { ok: false, name: error.name, message: error.message };
  }
  (self as unknown as Worker).postMessage(res);
};
