import { defineConfig } from 'vite';

// The client lives in client/ but imports the shared engine from ../shared.
// `fs.allow: ['..']` lets Vite serve those files in dev; in build they are
// just part of the module graph and get bundled normally.
export default defineConfig({
  root: 'client',
  base: './',
  publicDir: 'public',
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
