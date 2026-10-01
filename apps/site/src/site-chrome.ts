/**
 * Shared markup for the public marketing pages: the column footer and the
 * comparison table. Pages hold a marker comment and the Vite plugin in
 * `vite.config.ts` swaps in the markup, so the list of rivals and Trust Center
 * pages lives in one place instead of in every page that shows it. Node only.
 */
import { loadComparisons, type Comparison } from './comparison-pages';

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

const escape = (text: string): string =>
  text.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);

const footerColumn = (id: string, title: string, links: readonly string[]): string =>
  `<nav class="footer-column" aria-labelledby="${id}"><h2 class="footer-heading" id="${id}">${title}</h2><ul class="footer-links">${links.map((link) => `<li>${link}</li>`).join('')}</ul></nav>`;

export function renderSiteFooter(): string {
  const compared = [
    ...comparisons.map(({ slug, name }) => `<a href="/compare/${slug}/">${escape(name)}</a>`),
    '<a href="/compare/">All comparisons</a>',
  ];
  const trust = trustPages.map(({ href, name }) => `<a href="${href}">${escape(name)}</a>`);
  const help = [
    '<a href="/support/">Support</a>',
    '<a href="/support/getting-started/">Getting started</a>',
    '<a href="/support/connectors/">Connectors</a>',
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

/** Every rival in one table, each row linking to its own page. */
export function renderComparisonTable(): string {
  const rows = comparisons.map(({ slug, name, maker, kind, edge }) =>
    `<tr><th scope="row"><a class="compare-name" href="/compare/${slug}/">${escape(name)}</a><span class="compare-maker">${escape(maker)}</span></th>`
    + `<td data-label="What it is">${escape(kind)}</td>`
    + `<td data-label="Why teams pick Rally">${escape(edge)}</td>`
    + `<td class="compare-more"><a href="/compare/${slug}/" aria-label="Rally vs ${escape(name)}, full comparison">Rally vs ${escape(name)} <span aria-hidden="true">→</span></a></td></tr>`,
  ).join('');
  return `<div class="compare-table-wrap"><table class="compare-table">`
    + `<caption class="compare-caption">Rally compared with nine AI and team tools, as of October 2026</caption>`
    + `<thead><tr><th scope="col">Tool</th><th scope="col">What it is</th><th scope="col">Why teams pick Rally</th><th scope="col"><span class="visually-hidden">Full comparison</span></th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`;
}

const markers: Record<string, () => string> = {
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
