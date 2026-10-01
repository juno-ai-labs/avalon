import { renderAccessCopy } from './src/access-copy';
import { renderComparisonPage } from './src/comparison-pages';
import { renderComparisonCard, renderSocialCard } from './src/social-cards';
import { comparisons, renderSiteChrome } from './src/site-chrome';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Each rival's page is rendered from `content/compare/<slug>.md`. No HTML file
// exists on disk: the build resolves these entry paths to rendered HTML, and
// the dev server renders the same HTML for `/compare/<slug>/`.
const comparisonEntries = new Map(comparisons.map((comparison) => [
  `${projectRoot}compare/${comparison.slug}/index.html`, comparison,
]));
const hubCard = {
  eyebrow: 'Nine tools, one table',
  headline: [{ text: 'Rally,' }, { text: 'compared.' }],
  body: 'How Rally stacks up against nine AI and team tools, from Claude Tag to Microsoft Teams.',
  address: 'rallywith.ai/compare',
};
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __RALLY_SITE_RELEASE__: JSON.stringify(`site+${rootPackage.version}`),
    __RALLY_SITE_BUILD__: JSON.stringify(process.env.CF_PAGES_COMMIT_SHA?.slice(0, 40) ?? rootPackage.version),
  },
  plugins: [
    { name: 'rally-access-copy', transformIndexHtml: renderAccessCopy },
    { name: 'rally-site-chrome', transformIndexHtml: { order: 'pre', handler: renderSiteChrome } },
    {
      name: 'rally-comparison-pages',
      resolveId: (id) => (comparisonEntries.has(id) ? id : null),
      load: (id) => {
        const comparison = comparisonEntries.get(id);
        return comparison ? renderComparisonPage(comparison) : null;
      },
      // Each page's unfurl image is drawn from its own front matter, so the
      // card can never disagree with the page it links to.
      async generateBundle() {
        for (const comparison of comparisons) {
          this.emitFile({ type: 'asset', fileName: `compare/${comparison.slug}/social.png`, source: await renderComparisonCard(comparison) });
          // The page's own Markdown, for agents that would rather not parse HTML.
          this.emitFile({ type: 'asset', fileName: `compare/${comparison.slug}/index.md`, source: comparison.source });
        }
        this.emitFile({ type: 'asset', fileName: 'compare/social.png', source: await renderSocialCard(hubCard) });
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const image = /^\/compare\/(?:([a-z0-9-]+)\/)?social\.png$/u.exec(request.url?.split('?')[0] ?? '');
          if (!image) return next();
          const comparison = image[1] ? comparisons.find(({ slug }) => slug === image[1]) : undefined;
          if (image[1] && !comparison) return next();
          (comparison ? renderComparisonCard(comparison) : renderSocialCard(hubCard)).then((png) => {
            response.setHeader('Content-Type', 'image/png');
            response.end(png);
          }, next);
        });
        server.middlewares.use((request, response, next) => {
          const slug = /^\/compare\/([a-z0-9-]+)\/(?:index\.html)?$/u.exec(request.url?.split('?')[0] ?? '')?.[1];
          const comparison = slug ? comparisonEntries.get(`${projectRoot}compare/${slug}/index.html`) : undefined;
          if (!comparison || !request.url) return next();
          server.transformIndexHtml(request.url, renderComparisonPage(comparison)).then((html) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(html);
          }, next);
        });
      },
    },
    {
      // The technology schematic is its own entry so three.js stays out of the
      // landing page. `technology-loader.ts` adds its script when the figure
      // nears the screen, reading the URL from `data-tech-src`: the source file
      // in development, rewritten here to the hashed bundle. A build that cannot
      // find the bundle fails rather than shipping a page that loads a 404.
      name: 'rally-technology-entry',
      transformIndexHtml: {
        order: 'post',
        handler: (html, context) => {
          const source = 'data-tech-src="/src/technology.ts"';
          if (!context.bundle || !html.includes(source)) return html;
          const entry = Object.values(context.bundle).find(
            (output) => output.type === 'chunk' && output.isEntry && output.name === 'technology',
          );
          if (!entry) throw new Error('rally-technology-entry: the technology bundle is missing from the build');
          return html.replace(source, `data-tech-src="/${entry.fileName}"`);
        },
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
        technology: `${projectRoot}src/technology.ts`,
        concepts: `${projectRoot}concepts/index.html`,
        horizonConcepts: `${projectRoot}concepts/horizon/index.html`,
        heroConcepts: `${projectRoot}concepts/hero/index.html`,
        download: `${projectRoot}download/index.html`,
        invite: `${projectRoot}invite/index.html`,
        slackLink: `${projectRoot}slack/link/index.html`,
        desktopOpen: `${projectRoot}open/index.html`,
        workstreamLink: `${projectRoot}app/workstreams/index.html`,
        slack: `${projectRoot}slack/index.html`,
        compare: `${projectRoot}compare/index.html`,
        ...Object.fromEntries([...comparisonEntries].map(([path, { slug }]) => [`compare-${slug}`, path])),
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
        supportAshby: `${projectRoot}support/connectors/ashby/index.html`,
        supportFireflies: `${projectRoot}support/connectors/fireflies/index.html`,
        supportCanva: `${projectRoot}support/connectors/canva/index.html`,
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
});
