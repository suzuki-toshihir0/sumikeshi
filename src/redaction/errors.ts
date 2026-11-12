/**
 * 墨消しを安全に行えないときの例外。
 * 情報が残るおそれのある PDF を黙って出力しないよう、処理を止めて利用者に伝える。
 * message はそのまま利用者に見せる文言にする。
 */
export class RedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionError';
  }
}
