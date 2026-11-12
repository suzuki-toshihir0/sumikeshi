import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  root: 'src',
  base: '/sumikeshi/',
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: '../node_modules/pdfjs-dist/cmaps/*',
          dest: 'cmaps',
        },
      ],
    }),
  ],
  // 墨消しの Web Worker は画像の復号器を必要なときだけ読み込む（動的 import）ので、ES モジュールで出す
  worker: {
    format: 'es',
  },
  // 開発サーバーは、起動時に依存を探して変換しておく。Worker とその中の動的 import は index.html からたどれないので、
  // 探す起点に足す（足さないと、初めて墨消ししたときに依存を変換し直して頁を読み直し、操作が消える）
  optimizeDeps: {
    entries: ['index.html', 'redaction/redaction-worker.ts'],
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts'],
  },
});
