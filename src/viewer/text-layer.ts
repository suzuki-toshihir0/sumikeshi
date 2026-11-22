import type { PageViewport } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { TextLayer } from 'pdfjs-dist';

/** 描画中のテキストレイヤー（次の描画を始めるときに取り消し、2 つの描画の文字が混ざらないようにする） */
let current: TextLayer | null = null;

/** テキストレイヤーを描画する */
export async function renderTextLayer(
  container: HTMLElement,
  textContent: TextContent,
  viewport: PageViewport,
): Promise<void> {
  // 既存のテキストレイヤーをクリア
  container.innerHTML = '';
  // PDF.jsのTextLayerはCSS変数でスパンのフォントサイズ・配置を計算する
  container.style.setProperty('--scale-factor', String(viewport.scale));

  current?.cancel();
  const textLayer = new TextLayer({
    textContentSource: textContent,
    container,
    viewport,
  });
  current = textLayer;
  await textLayer.render();
}
