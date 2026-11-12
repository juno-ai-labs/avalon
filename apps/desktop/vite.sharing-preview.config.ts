import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Standalone component preview: no API, credentials or production permission writes. */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5175, strictPort: true, open: '/sharing-preview.html' },
});
