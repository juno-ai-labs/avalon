import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const developmentScriptSourceMarker = '__RALLY_DEVELOPMENT_SCRIPT_SOURCE__';

const rendererContentSecurityPolicy = {
  name: 'rally-renderer-content-security-policy',
  transformIndexHtml: {
    order: 'pre' as const,
    handler(html: string, context: { server?: unknown }): string {
      if (!html.includes(developmentScriptSourceMarker)) {
        throw new Error('Rally renderer CSP marker is missing');
      }
      // React Fast Refresh injects a small inline bootstrap only while Vite's
      // development server is active. Packaged HTML remains strict.
      const developmentSource = context.server ? "'unsafe-inline'" : '';
      return html.replace(developmentScriptSourceMarker, developmentSource);
    },
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@rally/contracts'] })],
    build: {
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
      },
    },
    plugins: [rendererContentSecurityPolicy, react()],
    build: {
      sourcemap: true,
    },
  },
});
