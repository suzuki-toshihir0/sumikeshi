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
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts'],
  },
});
