import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.py'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
