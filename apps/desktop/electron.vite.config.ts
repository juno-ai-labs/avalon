import { artifactPickerPlugin } from './artifact-picker-plugin';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const developmentScriptSourceMarker = '__RALLY_DEVELOPMENT_SCRIPT_SOURCE__';

function desktopSessionKey(mode: string): string | null {
  const key = process.env.RALLY_DESKTOP_SESSION_KEY;
  if (!key && mode !== 'packaged') return null;

  const bytes = Buffer.from(key ?? '', 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== key) {
    throw new Error('RALLY_DESKTOP_SESSION_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

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

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@rally/contracts', '@rally/electron-network', '@rally/ui'] })],
    // Read in src/main/index.ts: the updater prompts once a build is stale.
    define: {
      __RALLY_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __RALLY_DESKTOP_SESSION_KEY__: JSON.stringify(desktopSessionKey(mode)),
    },
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
    plugins: [rendererContentSecurityPolicy, artifactPickerPlugin(), react()],
    build: {
      sourcemap: true,
    },
  },
}));
