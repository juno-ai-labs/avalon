import { renderAccessCopy } from './src/access-copy';
import { helpCenter } from './build/help/plugin';
import { renderComparisonPage } from './src/comparison-pages';
import { renderComparisonCard, renderSocialCard } from './src/social-cards';
import { comparisonCount, comparisons, renderComparisonSitemap, renderLlmsTxt, renderSiteChrome } from './src/site-chrome';
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
const count = comparisonCount();
const hubCard = {
  eyebrow: `${count} tools, one table`,
  headline: [{ text: 'Rally,' }, { text: 'compared.' }],
  body: `How Rally stacks up against ${count} AI and team tools, from ${comparisons[0]?.name ?? ''} to ${comparisons.at(-1)?.name ?? ''}.`,
  address: 'rallywith.ai/compare',
};

// Everything else the comparison data produces, by published path. The build
// emits each one and the dev server answers for the same paths, so the two
// can't disagree. Cards are drawn from each page's own front matter, so a card
// can never disagree with the page it links to.
const generatedFiles = new Map<string, { type: string; render: () => string | Promise<Buffer> }>([
  ...comparisons.flatMap((comparison) => [
    [`compare/${comparison.slug}/social.png`, { type: 'image/png', render: () => renderComparisonCard(comparison) }],
    // The page's own Markdown, for agents that would rather not parse HTML.
    [`compare/${comparison.slug}/index.md`, { type: 'text/markdown; charset=utf-8', render: () => comparison.source }],
  ] as const),
  ['compare/social.png', { type: 'image/png', render: () => renderSocialCard(hubCard) }],
  ['compare/sitemap.xml', { type: 'application/xml', render: renderComparisonSitemap }],
  ['llms.txt', { type: 'text/plain; charset=utf-8', render: renderLlmsTxt }],
]);
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __RALLY_SITE_RELEASE__: JSON.stringify(`site+${rootPackage.version}`),
    __RALLY_SITE_BUILD__: JSON.stringify(process.env.CF_PAGES_COMMIT_SHA?.slice(0, 40) ?? rootPackage.version),
  },
  plugins: [
    // The help center is Markdown under help/, published at /help/. Its pages
    // are not HTML entries; the plugin writes them, linking the `help` entry.
    helpCenter({ contentRoot: `${projectRoot}help`, entryName: 'help', entrySource: '/src/help.ts' }),
    { name: 'rally-access-copy', transformIndexHtml: renderAccessCopy },
    { name: 'rally-site-chrome', transformIndexHtml: { order: 'pre', handler: renderSiteChrome } },
    {
      name: 'rally-comparison-pages',
      resolveId: (id) => (comparisonEntries.has(id) ? id : null),
      load: (id) => {
        const comparison = comparisonEntries.get(id);
        return comparison ? renderComparisonPage(comparison) : null;
      },
      async generateBundle() {
        for (const [fileName, { render }] of generatedFiles) this.emitFile({ type: 'asset', fileName, source: await render() });
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const file = generatedFiles.get(request.url?.split('?')[0]?.slice(1) ?? '');
          if (!file) return next();
          Promise.resolve(file.render()).then((body) => {
            response.setHeader('Content-Type', file.type);
            response.end(body);
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
        help: `${projectRoot}src/help.ts`,
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
        authHandoff: `${projectRoot}auth/desktop/index.html`,
        notFound: `${projectRoot}404.html`,
      },
    },
  },
});
