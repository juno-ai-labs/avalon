import { renderAccessCopy } from './src/access-copy';
import { addPageCard, pageCardFile, pageCardFor, pageCards, renderPageCard } from './src/page-cards';
import { helpCenter } from './build/help/plugin';
import { renderBlogCard, renderBlogIndex, renderBlogPost } from './src/blog-pages';
import { audience, connectorNames, marketplaceTemplates, renderMarketplaceSitemap, renderTemplateCard, renderTemplatePage, templatePagePath } from './src/marketplace-catalog';
import { audiencePath, audiences, renderAudienceSitemap } from './src/audiences';
import { blogPosts, renderBlogSitemap, renderLlmsTxt, renderSiteChrome } from './src/site-chrome';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Every HTML page rendered from Markdown, by published path: the blog index,
// each blog post from `content/blog/YYYY-MM-DD-<title>.md`, and each
// marketplace template's page from `packages/skills/marketplace-skills/`.
const renderedPages = new Map<string, () => string>([
  [`${projectRoot}blog/index.html`, () => renderBlogIndex(blogPosts)],
  ...blogPosts.map((post) => [`${projectRoot}blog/${post.slug}/index.html`, () => renderBlogPost(post)] as const),
  ...marketplaceTemplates().map((template) => [`${projectRoot}marketplace/${template.slug}/index.html`, () => renderTemplatePage(template)] as const),
]);
// Everything else the blog and marketplace data produce, by published path. The build
// emits each one and the dev server answers for the same paths, so the two
// can't disagree. Cards are drawn from each page's own front matter, so a card
// can never disagree with the page it links to.
const generatedFiles = new Map<string, { type: string; render: () => string | Promise<Buffer> }>([
  ...blogPosts.flatMap((post) => [
    [`blog/${post.slug}/social.png`, { type: 'image/png', render: () => renderBlogCard(post) }],
    [`blog/${post.slug}/index.md`, { type: 'text/markdown; charset=utf-8', render: () => post.source }],
  ] as const),
  ['blog/sitemap.xml', { type: 'application/xml', render: renderBlogSitemap }],
  ...marketplaceTemplates().map(({ slug, name, description, tags, connectors }) => [
    `marketplace/${slug}/social.png`,
    { type: 'image/png', render: () => renderTemplateCard({ slug, name, description, audience: audience(tags), connectors: connectorNames(connectors) }) },
  ] as const),
  ['marketplace/sitemap.xml', { type: 'application/xml', render: renderMarketplaceSitemap }],
  ['for/sitemap.xml', { type: 'application/xml', render: renderAudienceSitemap }],
  ['llms.txt', { type: 'text/plain; charset=utf-8', render: renderLlmsTxt }],
  // The hand-written pages' link previews, from `src/page-cards.ts`.
  ...pageCards.map((card) => [pageCardFile(card), { type: 'image/png', render: () => renderPageCard(card) }] as const),
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
    // After access copy, so /start-fast/'s headline is filled in before its card's title is checked against it.
    {
      name: 'rally-page-cards',
      transformIndexHtml: (html, context) => {
        const card = pageCardFor(context.path);
        return card ? addPageCard(html, card) : html;
      },
    },
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
          const path = /^\/((?:blog|marketplace)\/(?:[a-z0-9-]+\/)?)(?:index\.html)?$/u.exec(request.url?.split('?')[0] ?? '')?.[1];
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
        canvases: `${projectRoot}canvases/index.html`,
        sidekicks: `${projectRoot}sidekicks/index.html`,
        marketplace: `${projectRoot}marketplace/index.html`,
        offTheBeatenPath: `${projectRoot}off-the-beaten-path/index.html`,
        // One hand-written page per audience, at `for/<slug>/index.html`.
        ...Object.fromEntries(audiences.map(({ slug }) => [`for-${slug}`, `${projectRoot}${audiencePath(slug).slice(1)}index.html`])),
        technology: `${projectRoot}src/technology.ts`,
        posthog: `${projectRoot}src/posthog.ts`,
        help: `${projectRoot}src/help.ts`,
        concepts: `${projectRoot}concepts/index.html`,
        horizonConcepts: `${projectRoot}concepts/horizon/index.html`,
        heroConcepts: `${projectRoot}concepts/hero/index.html`,
        invite: `${projectRoot}invite/index.html`,
        slackLink: `${projectRoot}slack/link/index.html`,
        desktopOpen: `${projectRoot}open/index.html`,
        linkHandoff: `${projectRoot}app/open/index.html`,
        slack: `${projectRoot}slack/index.html`,
        blog: `${projectRoot}blog/index.html`,
        ...Object.fromEntries(blogPosts.map(({ slug }) => [`blog-${slug}`, `${projectRoot}blog/${slug}/index.html`])),
        ...Object.fromEntries(marketplaceTemplates().map(({ slug }) => [`marketplace-${slug}`, `${projectRoot}${templatePagePath(slug).slice(1)}index.html`])),
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
