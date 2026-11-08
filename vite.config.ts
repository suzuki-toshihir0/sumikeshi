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
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts'],
  },
});
