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
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;

  const textLayer = new TextLayer({
    textContentSource: textContent,
    container,
    viewport,
  });
  await textLayer.render();
}
