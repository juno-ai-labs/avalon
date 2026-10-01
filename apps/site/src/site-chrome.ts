/**
 * Shared markup for the public marketing pages: the column footer and the
 * comparison table. Pages hold a marker comment and the Vite plugin in
 * `vite.config.ts` swaps in the markup, so the list of rivals and Trust Center
 * pages lives in one place instead of in every page that shows it. Node only.
 */
import { escapeHtml as escape, loadComparisons, type Comparison } from './comparison-pages';

/** Every rival, read from `content/compare/*.md` and sorted by `order`. */
export const comparisons: readonly Comparison[] = loadComparisons(new URL('../content/compare/', import.meta.url));

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
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** How many rivals there are, as a word while that reads well ("nine"). */
export const comparisonCount = (): string => WORDS[comparisons.length] ?? String(comparisons.length);

/** "Claude Tag, Grok Bot, …, and Microsoft Teams". */
export const comparisonNames = (): string => {
  const names = comparisons.map(({ name }) => name);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')}, and ${names.at(-1) ?? ''}`;
};

/** The newest `updated` date across the rivals, as `YYYY-MM-DD`. */
export const comparisonsUpdated = (): string => comparisons.map(({ updated }) => updated).sort().at(-1) ?? '';

const footerColumn = (id: string, title: string, links: readonly string[]): string =>
  `<nav class="footer-column" aria-labelledby="${id}"><h2 class="footer-heading" id="${id}">${title}</h2><ul class="footer-links">${links.map((link) => `<li>${link}</li>`).join('')}</ul></nav>`;

export function renderSiteFooter(): string {
  const compared = [
    ...comparisons.map(({ slug, name }) => `<a href="/compare/${slug}/">${escape(name)}</a>`),
    '<a href="/compare/">All comparisons</a>',
  ];
  const trust = trustPages.map(({ href, name }) => `<a href="${href}">${escape(name)}</a>`);
  const help = [
    '<a href="/help/">Help Center</a>',
    '<a href="/help/getting-started/">Getting started</a>',
    '<a href="/help/connecting-your-tools/">Connectors</a>',
    '<a data-site-action="support-contact-footer" href="mailto:help@rallywith.ai?subject=Rally%20support">help@rallywith.ai</a>',
  ];
  return `<footer class="rally-footer"><div class="footer-grid">`
    + `<div class="footer-brand"><a class="wordmark" href="/" aria-label="Rally home"><img class="rally-symbol" src="/brand/rally-mark-ink.svg" width="24" height="24" alt=""><span>rally</span></a>`
    + `<p class="footer-tagline">Made for people who work with AI, not on it.</p></div>`
    + footerColumn('footer-compared', 'Compared to', compared)
    + footerColumn('footer-trust', 'Trust Center', trust)
    + footerColumn('footer-help', 'Help', help)
    + `</div><p class="footer-legal"><small>© 2026 Juno AI Labs · Rally</small></p></footer>`;
}

const month = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Every rival in one table, each row linking to its own page. */
export function renderComparisonTable(): string {
  const rows = comparisons.map(({ slug, name, maker, kind, edge }) =>
    `<tr><th scope="row"><a class="compare-name" href="/compare/${slug}/">${escape(name)}</a><span class="compare-maker">${escape(maker)}</span></th>`
    + `<td data-label="What it is">${escape(kind)}</td>`
    + `<td data-label="Why teams pick Rally">${escape(edge)}</td>`
    + `<td class="compare-more"><a href="/compare/${slug}/" aria-label="Rally vs ${escape(name)}, full comparison">Rally vs ${escape(name)} <span aria-hidden="true">→</span></a></td></tr>`,
  ).join('');
  return `<div class="compare-table-wrap"><table class="compare-table">`
    + `<caption class="compare-caption">Rally compared with ${comparisonCount()} AI and team tools, as of ${month(comparisonsUpdated())}</caption>`
    + `<thead><tr><th scope="col">Tool</th><th scope="col">What it is</th><th scope="col">Why teams pick Rally</th><th scope="col"><span class="visually-hidden">Full comparison</span></th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`;
}

/** The hub's JSON-LD `ItemList` of every comparison page. */
export function renderComparisonItemList(): string {
  return JSON.stringify({
    '@type': 'ItemList',
    itemListElement: comparisons.map(({ slug, name }, index) => ({
      '@type': 'ListItem', position: index + 1, name: `Rally vs ${name}`, url: `${ORIGIN}/compare/${slug}/`,
    })),
  }).replace(/</gu, '\\u003c');
}

/** A sitemap of the comparison pages, which `robots.txt` lists beside the main one. */
export function renderComparisonSitemap(): string {
  const urls = [{ loc: `${ORIGIN}/compare/`, lastmod: comparisonsUpdated() },
    ...comparisons.map(({ slug, updated }) => ({ loc: `${ORIGIN}/compare/${slug}/`, lastmod: updated }))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(({ loc, lastmod }) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n`).join('')
    + '</urlset>\n';
}

/** `/llms.txt`: a plain index of the site for AI tools. */
export function renderLlmsTxt(): string {
  return `# Rally

> Rally is a shared place where a team and one AI work together. Spaces and Channels keep each project's files and history, Breakouts hold private side work, connectors read and write tools like Gmail, Google Drive, Slack, Notion, and GitHub, and Sidekicks run jobs on a schedule or when something happens. Pricing is per organization with no seat limit: Start is $100 a month, Grow is $250 a month. macOS beta. Made by Juno AI Labs Inc.

## Product

- [Rally home](${ORIGIN}/): what Rally is, features, pricing, team, and technology
- [Help Center](${ORIGIN}/help/): the Rally manual, from installing Rally to running an Organization. Its own index of every page, each published as Markdown: ${ORIGIN}/help/llms.txt

## Compared to

Written by the Rally team, so biased, and dated on each page. Each page's Markdown source is published beside it at \`index.md\`, for example ${ORIGIN}/compare/${comparisons[0]?.slug ?? ''}/index.md.

- [All comparisons](${ORIGIN}/compare/): one table of ${comparisonCount()} tools
${comparisons.map(({ slug, name, kind }) => `- [Rally vs ${name}](${ORIGIN}/compare/${slug}/): ${kind.replace(/\.$/u, '')}`).join('\n')}

## Trust Center

${trustPages.map(({ href, name }) => `- [${name}](${ORIGIN}${href})`).join('\n')}
`;
}

const markers: Record<string, () => string> = {
  'site-footer': renderSiteFooter,
  'comparison-table': renderComparisonTable,
  'comparison-count': comparisonCount,
  'comparison-count-title': () => comparisonCount().replace(/^./u, (letter) => letter.toUpperCase()),
  'comparison-names': () => escape(comparisonNames()),
  'comparison-item-list': renderComparisonItemList,
};

/** Replaces each `<!-- rally:name -->` marker with its shared markup. */
export function renderSiteChrome(html: string): string {
  return html.replace(/<!-- rally:([a-z-]+) -->/gu, (_match, name: string) => {
    const render = markers[name];
    if (!render) throw new Error(`Unknown site chrome marker: ${name}`);
    return render();
  });
}
