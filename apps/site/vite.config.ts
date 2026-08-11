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

export default defineConfig(async () => {
  const desktopRelease = parseDesktopReleaseConfig(desktopReleaseValue);
  const publication = process.env.AVALON_RELEASE_DISCOVERY === '1'
    ? await discoverDesktopRelease(desktopRelease)
    : undefined;
  return {
    plugins: [
      {
        name: 'avalon-desktop-release',
        transformIndexHtml(html: string) {
          return html.includes('<!-- avalon-desktop-release:start -->')
            ? renderDesktopRelease(html, desktopRelease, publication)
            : html;
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
