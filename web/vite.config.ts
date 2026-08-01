import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The checkout IS the install: the packaged .app lives inside the repo at
// desktop/out/ and locates the source by walking up from its own binary. So
// the path baked in here (this file's parent) is the path the operator edits,
// and the Expand Build page can show it instead of guessing. Vite always runs
// from inside the checkout, in dev and in build alike.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  define: { __NYYON_REPO_ROOT__: JSON.stringify(REPO_ROOT) },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      '/api':    { target: 'http://localhost:8799', changeOrigin: true },
      // The sign-in endpoints live outside /api; without these the SPA can
      // load but never authenticate against the local worker.
      '/__gate': { target: 'http://localhost:8799', changeOrigin: true },
      '/health': { target: 'http://localhost:8799', changeOrigin: true },
    },
  },
});
