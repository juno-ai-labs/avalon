import { renderAccessCopy } from './src/access-copy';
import { helpCenter } from './build/help/plugin';
import { renderBlogIndex, renderBlogPost } from './src/blog-pages';
import { renderComparisonPage } from './src/comparison-pages';
import { renderBlogCard, renderComparisonCard } from './src/social-cards';
import { blogPosts, comparisons, renderBlogSitemap, renderComparisonSitemap, renderLlmsTxt, renderSiteChrome } from './src/site-chrome';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Each rival's page is rendered from `content/compare/<slug>.md`. No HTML file
// exists on disk: the build resolves these entry paths to rendered HTML, and
// the dev server renders the same HTML for `/compare/<slug>/`.
const comparisonEntries = new Map(comparisons.map((comparison) => [
  `${projectRoot}compare/${comparison.slug}/index.html`, comparison,
]));
// Every HTML page rendered from Markdown, by published path: the comparison
// pages, the blog index, and each blog post from `content/blog/YYYY-MM-DD-<title>.md`.
const renderedPages = new Map<string, () => string>([
  ...[...comparisonEntries].map(([path, comparison]) => [path, () => renderComparisonPage(comparison)] as const),
  [`${projectRoot}blog/index.html`, () => renderBlogIndex(blogPosts)],
  ...blogPosts.map((post) => [`${projectRoot}blog/${post.slug}/index.html`, () => renderBlogPost(post)] as const),
]);
// Everything else the comparison and blog data produce, by published path. The build
// emits each one and the dev server answers for the same paths, so the two
// can't disagree. Cards are drawn from each page's own front matter, so a card
// can never disagree with the page it links to.
const generatedFiles = new Map<string, { type: string; render: () => string | Promise<Buffer> }>([
  ...comparisons.flatMap((comparison) => [
    [`compare/${comparison.slug}/social.png`, { type: 'image/png', render: () => renderComparisonCard(comparison) }],
    // The page's own Markdown, for agents that would rather not parse HTML.
    [`compare/${comparison.slug}/index.md`, { type: 'text/markdown; charset=utf-8', render: () => comparison.source }],
  ] as const),
  ...blogPosts.flatMap((post) => [
    [`blog/${post.slug}/social.png`, { type: 'image/png', render: () => renderBlogCard(post) }],
    [`blog/${post.slug}/index.md`, { type: 'text/markdown; charset=utf-8', render: () => post.source }],
  ] as const),
  ['compare/sitemap.xml', { type: 'application/xml', render: renderComparisonSitemap }],
  ['blog/sitemap.xml', { type: 'application/xml', render: renderBlogSitemap }],
  ['llms.txt', { type: 'text/plain; charset=utf-8', render: renderLlmsTxt }],
]);
/**
 * A plugin that rewrites `attribute="/src/<file>"` in built HTML to the hashed
 * bundle of the separate entry `name`, for a page script that adds that entry
 * itself. A build that cannot find the bundle fails rather than shipping a
 * page that loads a 404.
 */
function hashedEntrySource(name: string, attribute: string, file: string): Plugin {
  return {
    name: `rally-${name}-entry`,
    transformIndexHtml: {
      order: 'post',
      handler: (html, context) => {
        const source = `${attribute}="/src/${file}"`;
        if (!context.bundle || !html.includes(source)) return html;
        const entry = Object.values(context.bundle).find(
          (output) => output.type === 'chunk' && output.isEntry && output.name === name,
        );
        if (!entry) throw new Error(`rally-${name}-entry: the ${name} bundle is missing from the build`);
        return html.replace(source, `${attribute}="/${entry.fileName}"`);
      },
    },
  };
}

const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __RALLY_SITE_RELEASE__: JSON.stringify(`site+${rootPackage.version}`),
    __RALLY_SITE_BUILD__: JSON.stringify(process.env.CF_PAGES_COMMIT_SHA?.slice(0, 40) ?? rootPackage.version),
  },
  plugins: [
    // The help center is Markdown under help/, published at /help/. Its pages
    // are not HTML entries; the plugin writes them, linking the `help` entry.
    helpCenter({
      contentRoot: `${projectRoot}help`,
      entryName: 'help',
      entrySource: '/src/help.ts',
      entryMeta: [{ name: 'rally-posthog-src', entryName: 'posthog', entrySource: '/src/posthog.ts' }],
    }),
    { name: 'rally-access-copy', transformIndexHtml: renderAccessCopy },
    { name: 'rally-site-chrome', transformIndexHtml: { order: 'pre', handler: renderSiteChrome } },
    {
      name: 'rally-markdown-pages',
      resolveId: (id) => (renderedPages.has(id) ? id : null),
      load: (id) => renderedPages.get(id)?.() ?? null,
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
          const path = /^\/((?:compare|blog)\/(?:[a-z0-9-]+\/)?)(?:index\.html)?$/u.exec(request.url?.split('?')[0] ?? '')?.[1];
          const render = path ? renderedPages.get(`${projectRoot}${path}index.html`) : undefined;
          if (!render || !request.url) return next();
          server.transformIndexHtml(request.url, render()).then((html) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(html);
          }, next);
        });
      },
    },
    // The technology schematic is its own entry so three.js stays out of the
    // landing page. `technology-loader.ts` adds its script when the figure
    // nears the screen, reading the URL from `data-tech-src`.
    hashedEntrySource('technology', 'data-tech-src', 'technology.ts'),
    // PostHog's SDK is its own entry so pages that never run it never download
    // it. `posthog-loader.ts` adds its script, reading the URL from this meta tag.
    hashedEntrySource('posthog', 'content', 'posthog.ts'),
    {
      name: 'rally-site-telemetry',
      transformIndexHtml: {
        order: 'pre',
        handler: () => [{
          tag: 'meta',
          attrs: { name: 'rally-posthog-src', content: '/src/posthog.ts' },
          injectTo: 'head',
        }, {
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
        startFast: `${projectRoot}start-fast/index.html`,
        technology: `${projectRoot}src/technology.ts`,
        posthog: `${projectRoot}src/posthog.ts`,
        help: `${projectRoot}src/help.ts`,
        concepts: `${projectRoot}concepts/index.html`,
        horizonConcepts: `${projectRoot}concepts/horizon/index.html`,
        heroConcepts: `${projectRoot}concepts/hero/index.html`,
        download: `${projectRoot}download/index.html`,
        invite: `${projectRoot}invite/index.html`,
        slackLink: `${projectRoot}slack/link/index.html`,
        desktopOpen: `${projectRoot}open/index.html`,
        linkHandoff: `${projectRoot}app/open/index.html`,
        slack: `${projectRoot}slack/index.html`,
        ...Object.fromEntries([...comparisonEntries].map(([path, { slug }]) => [`compare-${slug}`, path])),
        blog: `${projectRoot}blog/index.html`,
        ...Object.fromEntries(blogPosts.map(({ slug }) => [`blog-${slug}`, `${projectRoot}blog/${slug}/index.html`])),
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
