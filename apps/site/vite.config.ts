import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  discoverDesktopRelease,
  parseDesktopReleaseConfig,
  renderDesktopRelease,
} from './src/release-config.ts';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const desktopReleaseValue = JSON.parse(readFileSync(new URL('./release.config.json', import.meta.url), 'utf8')) as unknown;
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(async () => {
  const desktopRelease = parseDesktopReleaseConfig(desktopReleaseValue);
  const publication = process.env.RALLY_RELEASE_DISCOVERY === '1'
    ? await discoverDesktopRelease(desktopRelease)
    : undefined;
  return {
    define: {
      __RALLY_SITE_RELEASE__: JSON.stringify(`site+${rootPackage.version}`),
      __RALLY_SITE_BUILD__: JSON.stringify(process.env.CF_PAGES_COMMIT_SHA?.slice(0, 40) ?? rootPackage.version),
    },
    plugins: [
      {
        name: 'rally-desktop-release',
        transformIndexHtml(html: string) {
          return html.includes('<!-- rally-desktop-release:start -->')
            ? renderDesktopRelease(html, desktopRelease, publication)
            : html;
        },
      },
      {
        name: 'rally-site-telemetry',
        transformIndexHtml: {
          order: 'pre',
          handler: () => [{
            tag: 'script',
            attrs: { type: 'module', src: '/src/site-entry.ts' },
            injectTo: 'head',
          }],
        },
      },
    ],
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          main: `${projectRoot}index.html`,
          concepts: `${projectRoot}concepts/index.html`,
          horizonConcepts: `${projectRoot}concepts/horizon/index.html`,
          invite: `${projectRoot}invite/index.html`,
          slackLink: `${projectRoot}slack/link/index.html`,
          desktopOpen: `${projectRoot}open/index.html`,
          workstreamLink: `${projectRoot}app/workstreams/index.html`,
          slack: `${projectRoot}slack/index.html`,
          terms: `${projectRoot}terms/index.html`,
          privacy: `${projectRoot}privacy/index.html`,
          acceptableUse: `${projectRoot}acceptable-use/index.html`,
          dpa: `${projectRoot}dpa/index.html`,
          subprocessors: `${projectRoot}subprocessors/index.html`,
          cookies: `${projectRoot}cookies/index.html`,
          security: `${projectRoot}security/index.html`,
          support: `${projectRoot}support/index.html`,
          authHandoff: `${projectRoot}auth/desktop/index.html`,
          notFound: `${projectRoot}404.html`,
        },
      },
    },
  };
});
