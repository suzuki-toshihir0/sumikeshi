import type { PageViewport } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { TextLayer } from 'pdfjs-dist';

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

  const textLayer = new TextLayer({
    textContentSource: textContent,
    container,
    viewport,
  });
  await textLayer.render();
}
