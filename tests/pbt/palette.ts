/**
 * 素材の頁・画像ごとの背景の色。canvas の左上の色から、表示されているものを見分ける。
 * 互いに離れた色にする（JPEG にしなくても、描画の補間で少しずれるため）
 */
export const PALETTE: Record<string, [number, number, number]> = {
  'DOC-A PAGE-1/3': [230, 25, 75],
  'DOC-A PAGE-2/3': [60, 180, 75],
  'DOC-A PAGE-3/3': [0, 130, 200],
  'DOC-B PAGE-1/2': [245, 130, 48],
  'DOC-B PAGE-2/2': [145, 30, 180],
  'IMAGE-SMALL': [70, 240, 240],
  'IMAGE-BIG': [240, 50, 230],
};

/** いちばん近い色の名前（離れすぎていれば null） */
export function identify(rgb: number[] | null): string | null {
  if (!rgb) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const [name, c] of Object.entries(PALETTE)) {
    const d = Math.abs(c[0] - rgb[0]) + Math.abs(c[1] - rgb[1]) + Math.abs(c[2] - rgb[2]);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return bestD <= 30 ? best : null;
}
