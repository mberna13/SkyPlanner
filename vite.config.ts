import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the built site works from any folder on a web server.
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
  worker: { format: 'es' },
});
