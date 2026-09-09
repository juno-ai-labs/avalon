import { renderAccessCopy } from './src/access-copy';
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
      { name: 'rally-access-copy', transformIndexHtml: renderAccessCopy },
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
          heroConcepts: `${projectRoot}concepts/hero/index.html`,
          download: `${projectRoot}download/index.html`,
          invite: `${projectRoot}invite/index.html`,
          slackLink: `${projectRoot}slack/link/index.html`,
          desktopOpen: `${projectRoot}open/index.html`,
          workstreamLink: `${projectRoot}app/workstreams/index.html`,
          slack: `${projectRoot}slack/index.html`,
          trust: `${projectRoot}trust/index.html`,
          trustSecurity: `${projectRoot}trust/security/index.html`,
          trustTerms: `${projectRoot}trust/terms/index.html`,
          trustPrivacy: `${projectRoot}trust/privacy/index.html`,
          trustAcceptableUse: `${projectRoot}trust/acceptable-use/index.html`,
          trustDpa: `${projectRoot}trust/dpa/index.html`,
          trustSubprocessors: `${projectRoot}trust/subprocessors/index.html`,
          trustCookies: `${projectRoot}trust/cookies/index.html`,
          support: `${projectRoot}support/index.html`,
          supportGettingStarted: `${projectRoot}support/getting-started/index.html`,
          supportContact: `${projectRoot}support/contact/index.html`,
          supportConnectors: `${projectRoot}support/connectors/index.html`,
          supportGoogle: `${projectRoot}support/connectors/google/index.html`,
          supportGitHub: `${projectRoot}support/connectors/github/index.html`,
          supportGranola: `${projectRoot}support/connectors/granola/index.html`,
          supportLinear: `${projectRoot}support/connectors/linear/index.html`,
          supportNotion: `${projectRoot}support/connectors/notion/index.html`,
          supportSlack: `${projectRoot}support/connectors/slack/index.html`,
          supportInboundWebhook: `${projectRoot}support/connectors/inbound-webhook/index.html`,
          supportX: `${projectRoot}support/connectors/x/index.html`,
          supportCustomMcp: `${projectRoot}support/connectors/custom-mcp/index.html`,
          authHandoff: `${projectRoot}auth/desktop/index.html`,
          notFound: `${projectRoot}404.html`,
        },
      },
    },
  };
});
