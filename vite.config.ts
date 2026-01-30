import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: '/sumikeshi/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts'],
  },
});
