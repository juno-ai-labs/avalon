/**
 * Shared markup for the public marketing pages: the column footer and the
 * comparison table. Pages hold a marker comment and the Vite plugin in
 * `vite.config.ts` swaps in the markup, so the list of rivals and Trust Center
 * pages lives in one place instead of in every page that shows it. Node only.
 */
import { readFileSync } from 'node:fs';
import { loadBlogPosts, type BlogPost } from './blog-pages';
import { escapeHtml as escape, loadComparisons, type Comparison } from './comparison-pages';

/** Every rival, read from `content/compare/*.md` and sorted by `order`. */
export const comparisons: readonly Comparison[] = loadComparisons(new URL('../content/compare/', import.meta.url));

/** Every blog post, read from `content/blog/YYYY-MM-DD-<title>.md`, newest first. */
export const blogPosts: readonly BlogPost[] = loadBlogPosts(new URL('../content/blog/', import.meta.url));

export const trustPages: readonly { href: string; name: string }[] = [
  { href: '/trust/', name: 'Overview' },
  { href: '/trust/security/', name: 'Security' },
  { href: '/trust/privacy/', name: 'Privacy' },
  { href: '/trust/terms/', name: 'Terms' },
  { href: '/trust/dpa/', name: 'DPA' },
  { href: '/trust/subprocessors/', name: 'Sub-processors' },
  { href: '/trust/cookies/', name: 'Cookies' },
  { href: '/trust/acceptable-use/', name: 'Acceptable Use' },
];

const ORIGIN = 'https://rallywith.ai';

/** The header's links and sign-in button, the same on every marketing page. */
export function renderSiteNav(): string {
  return '<nav aria-label="Primary"><a class="header-link" href="/#features">Features</a><a class="header-link" href="/#pricing">Pricing</a>'
    + '<a class="header-link" href="/#compare">Compare</a>'
    // The web app signs in and signs up through one door, so the label rolls between the two.
    + '<a class="button button-small header-sign-in" data-site-action="sign-in-header" href="https://app.rallywith.ai" aria-label="Sign in to Rally or sign up for Rally">'
    + '<span class="header-sign-in-wheel" aria-hidden="true"><span>Sign in to Rally</span><span>Sign up for Rally</span></span></a></nav>';
}

const footerColumn = (id: string, title: string, links: readonly string[]): string =>
  `<nav class="footer-column" aria-labelledby="${id}"><h2 class="footer-heading" id="${id}">${title}</h2><ul class="footer-links">${links.map((link) => `<li>${link}</li>`).join('')}</ul></nav>`;

export function renderSiteFooter(): string {
  const compared = comparisons.map(({ slug, name }) => `<a href="/compare/${slug}/">${escape(name)}</a>`);
  const trust = trustPages.map(({ href, name }) => `<a href="${href}">${escape(name)}</a>`);
  const help = [
    '<a href="/help/">Help Center</a>',
    '<a href="/help/getting-started/">Getting started</a>',
    '<a href="/help/connecting-your-tools/">Connectors</a>',
    '<a data-site-action="support-contact-footer" href="mailto:help@rallywith.ai?subject=Rally%20support">help@rallywith.ai</a>',
  ];
  // The index, then the newest post, so the column stays one line per link as posts accumulate.
  const blog = [
    '<a href="/blog/">All posts</a>',
    ...blogPosts.slice(0, 1).map(({ slug, title }) => `<a href="/blog/${slug}/">${escape(title)}</a>`),
  ];
  return `<footer class="rally-footer"><div class="footer-grid">`
    + `<div class="footer-brand"><a class="wordmark" href="/" aria-label="Rally home"><img class="rally-symbol" src="/brand/rally-mark-ink.svg" width="24" height="24" alt=""><span>rally</span></a>`
    + `<p class="footer-tagline">Made for people who work with AI, not on it.</p></div>`
    + footerColumn('footer-compared', 'Compared to', compared)
    + footerColumn('footer-trust', 'Trust Center', trust)
    + footerColumn('footer-help', 'Help', help)
    + footerColumn('footer-blog', 'Blog', blog)
    + `</div><p class="footer-legal"><small>© 2026 Juno AI Labs · Rally</small></p></footer>`;
}

/** Every rival in one table, each row linking to its own page. */
export function renderComparisonTable(): string {
  const rows = comparisons.map(({ slug, name, maker, kind, edge }) =>
    `<tr><th scope="row"><a class="compare-name" href="/compare/${slug}/">${escape(name)}</a><span class="compare-maker">${escape(maker)}</span></th>`
    + `<td data-label="What it is">${escape(kind)}</td>`
    + `<td data-label="Why teams pick Rally">${escape(edge)}</td>`
    + `<td class="compare-more"><a href="/compare/${slug}/" aria-label="Rally vs ${escape(name)}, full comparison">Rally vs ${escape(name)} <span aria-hidden="true">→</span></a></td></tr>`,
  ).join('');
  return `<div class="compare-table-wrap"><table class="compare-table">`
    + `<thead><tr><th scope="col">Tool</th><th scope="col">What it is</th><th scope="col">Why teams pick Rally</th><th scope="col"><span class="visually-hidden">Full comparison</span></th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`;
}

const sitemap = (urls: readonly { loc: string; lastmod: string }[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(({ loc, lastmod }) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n`).join('')
    + '</urlset>\n';

/** A sitemap of the comparison pages, which `robots.txt` lists beside the main one. */
export const renderComparisonSitemap = (): string =>
  sitemap(comparisons.map(({ slug, updated }) => ({ loc: `${ORIGIN}/compare/${slug}/`, lastmod: updated })));

/** A sitemap of the blog index and every post, which `robots.txt` lists beside the main one. */
export const renderBlogSitemap = (): string => {
  const posts = blogPosts.map(({ slug, date }) => ({ loc: `${ORIGIN}/blog/${slug}/`, lastmod: date }));
  // The index changes when its newest post does; with no posts there is nothing to list.
  return sitemap(blogPosts[0] ? [{ loc: `${ORIGIN}/blog/`, lastmod: blogPosts[0].date }, ...posts] : posts);
};

/** `/llms.txt`: a plain index of the site for AI tools. */
export function renderLlmsTxt(): string {
  return `# Rally

> Rally is a shared place where a team and AI work together. In a Canvas, people talk with Rally and it makes the artifact itself (a document, a spreadsheet, an image, a PDF, a site), shared per Canvas; Sidekicks are shared AI agents with one conversation each that run jobs on a schedule or when something happens; connectors read and write tools like Gmail, Google Drive, Slack, Notion, and GitHub. Pricing is per organization with no seat limit: Start is $100 a month, Grow is $250 a month. macOS beta. Made by Juno AI Labs Inc.

## Product

- [Rally home](${ORIGIN}/): what Rally is, features, pricing, team, and technology
- [Help Center](${ORIGIN}/help/): the Rally manual, from installing Rally to running an Organization. Its own index of every page, each published as Markdown: ${ORIGIN}/help/llms.txt

## Compared to

Written by the Rally team, so biased, and dated on each page. Each page's Markdown source is published beside it at \`index.md\`, for example ${ORIGIN}/compare/${comparisons[0]?.slug ?? ''}/index.md.

${comparisons.map(({ slug, name, kind }) => `- [Rally vs ${name}](${ORIGIN}/compare/${slug}/): ${kind.replace(/\.$/u, '')}`).join('\n')}

## Blog

Each post's Markdown source is published beside it at \`index.md\`.

${blogPosts.map(({ slug, title, description }) => `- [${title}](${ORIGIN}/blog/${slug}/): ${description}`).join('\n')}

## Trust Center

${trustPages.map(({ href, name }) => `- [${name}](${ORIGIN}${href})`).join('\n')}
`;
}

/**
 * Everything on the home page below the hero. The home page and its variants,
 * such as `/start-fast/`, differ only in their hero, so they share one copy of
 * the sections rather than drifting apart. Read on each render so the dev
 * server serves the current file.
 */
function renderLandingSections(): string {
  return renderSiteChrome(readFileSync(new URL('./landing-sections.html', import.meta.url), 'utf8'));
}

const markers: Record<string, () => string> = {
  'site-nav': renderSiteNav,
  'landing-sections': renderLandingSections,
  'site-footer': renderSiteFooter,
  'comparison-table': renderComparisonTable,
};

/** Replaces each `<!-- rally:name -->` marker with its shared markup. */
export function renderSiteChrome(html: string): string {
  return html.replace(/<!-- rally:([a-z-]+) -->/gu, (_match, name: string) => {
    const render = markers[name];
    if (!render) throw new Error(`Unknown site chrome marker: ${name}`);
    return render();
  });
}
