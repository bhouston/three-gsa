import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  base: './',
  resolve: { alias: [
    { find: 'three-gsa/generator', replacement: fileURLToPath(new URL('../three-gsa/src/generator.ts', import.meta.url)) },
    { find: 'three-gsa/three', replacement: fileURLToPath(new URL('../three-gsa/src/three.ts', import.meta.url)) },
    { find: 'three-gsa', replacement: fileURLToPath(new URL('../three-gsa/src/index.ts', import.meta.url)) },
  ] },
});
