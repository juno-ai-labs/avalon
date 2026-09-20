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
      return html.replace(developmentScriptSourceMarker, developmentSource)
        .replace('__RALLY_DEVELOPMENT_CONNECT_SOURCE__', context.server ? 'ws://127.0.0.1:* ws://localhost:*' : '');
    },
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@rally/contracts', '@rally/ui'] })],
    build: {
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@rally/ui'] })],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), 'demo-sidecar': resolve('src/preload/demo-sidecar.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    server: {
      // Parallel visual explorations can each choose an isolated renderer port
      // without editing the project or colliding with another Electron run.
      port: Number.parseInt(process.env.RALLY_RENDERER_PORT ?? '5173', 10),
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
      },
    },
    plugins: [rendererContentSecurityPolicy, react()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), 'demo-sidecar': resolve('src/renderer/demo-sidecar.html') } },
      sourcemap: true,
    },
  },
});
