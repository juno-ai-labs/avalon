/**
 * Shared markup for the public marketing pages: the column footer and the
 * comparison table. Pages hold a marker comment and the Vite plugin in
 * `vite.config.ts` swaps in the markup, so the list of rivals and Trust Center
 * pages lives in one place instead of in every page that shows it. Node only.
 */
import { readFileSync } from 'node:fs';
import { loadBlogPosts, type BlogPost } from './blog-pages';
import { escapeHtml as escape, loadComparisons, type Comparison } from './comparison-pages';
import { renderLoopFigure, renderPeopleFigure } from './explorable-figures';
import { renderLiveCarousel } from './live-examples';
import { renderHomeIllustration } from './home-illustrations';
import { renderHomePricing } from './home-pricing';
import { renderMarketplaceCards, renderMarketplaceFilters } from './marketplace-catalog';
import { externalArrow } from './site-icons';

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
  return '<nav aria-label="Primary"><a class="header-link" href="/canvases/">Canvases</a><a class="header-link" href="/sidekicks/">Sidekicks</a>'
    + '<a class="header-link" href="/#pricing">Pricing</a><a class="header-link" href="/#footer-compared">Compare</a>'
    // The web app signs in and signs up through one door, so the label rolls between the two.
    + '<a class="button button-small header-sign-in" data-site-action="sign-in-header" href="https://app.rallywith.ai" aria-label="Sign in to Rally or sign up for Rally">'
    + '<span class="header-sign-in-wheel" aria-hidden="true"><span>Sign in to Rally</span><span>Sign up for Rally</span></span></a></nav>';
}

/** A quiet header for the new reading pages; the earlier product pages keep their own nav. */
function renderReadingNav(): string {
  return '<nav class="reading-nav" aria-label="Primary"><a href="/canvases/">Canvases</a><a href="/sidekicks/">Sidekicks</a>'
    + `<a href="/#pricing">Pricing</a><a href="/help/">The manual ${externalArrow}</a>`
    + `<a class="header-login" data-site-action="sign-in-header" href="https://app.rallywith.ai">Open Rally ${externalArrow}</a></nav>`;
}

/** Shared downloads, with mono Apple/Linux artwork from @thesvg/react. */
function renderDesktopDownloads(): string {
  return '<div class="hero-desktop-downloads">'
    + '<a class="button button-outline hero-download" data-site-action="download-hero" href="https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg" download><svg class="button-mark" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg> Download the macOS app</a>'
    + '<a class="button button-outline hero-download" data-site-action="download-linux-hero" href="https://downloads.rallywith.ai/stable/linux/x64/Rally.deb" download aria-label="Download for Linux (x64 Debian package)"><svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="button-mark" width="18" height="18" aria-hidden="true"><title>Linux</title><path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z"></path></svg> Download for Linux (.deb)</a>'
    + '</div>';
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
  const product = [
    '<a href="/canvases/">Canvases</a>',
    '<a href="/sidekicks/">Sidekicks</a>',
    '<a href="/marketplace/">Marketplace</a>',
    '<a href="/#pricing">Pricing</a>',
  ];
  return `<footer class="rally-footer"><div class="footer-grid">`
    + `<div class="footer-brand"><a class="wordmark" href="/" aria-label="Rally home"><img class="rally-symbol" src="/brand/rally-mark-ink.svg" width="24" height="24" alt=""><span>rally</span></a>`
    + `<p class="footer-tagline">Made for people who work with AI, not on it.</p></div>`
    + footerColumn('footer-product', 'Product', product)
    + footerColumn('footer-compared', 'Compared to', compared)
    + footerColumn('footer-trust', 'Trust Center', trust)
    + footerColumn('footer-help', 'Help', help)
    + footerColumn('footer-blog', 'Blog', blog)
    + `</div><p class="footer-legal"><small>© 2026 Juno AI Labs · Rally</small><small>Assurance Level 2 certified</small><small>rallywith.ai</small></p>`
    + `<p class="footer-mark" aria-hidden="true">rally</p></footer>`;
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

> Rally is a shared place where a team and AI work together. In a Canvas, people talk with Rally and it makes the artifact itself (a document, a spreadsheet, an image, a PDF, a site), shared per Canvas; Sidekicks are shared AI agents with one conversation each that run jobs on a schedule or when something happens; connectors read and write tools like Gmail, Google Drive, Slack, Notion, and GitHub. Pricing is per organization with no seat limit: Start is free with $40 of effective usage; Grow is $100 with $200, Max is $250 with $500, and Ultra is $1,000 with $2,000. Allowances are allocated weekly. macOS beta. Made by Juno AI Labs Inc.

## Product

- [Rally home](${ORIGIN}/): what Rally is, Canvases, Sidekicks, pricing, and technology
- [Canvases](${ORIGIN}/canvases/): reactive artifacts, documents, spreadsheets, dashboards and sites that Rally keeps current from your connected tools and that a team works from together
- [Sidekicks](${ORIGIN}/sidekicks/): shared AI agents that run on a schedule or when something happens
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

/** The animated Canvas in the home page's hero and the Canvases page, from `canvas-demo.html`. */
function renderCanvasDemo(): string {
  return readFileSync(new URL('./canvas-demo.html', import.meta.url), 'utf8');
}

const markers: Record<string, () => string> = {
  'reading-nav': renderReadingNav,
  'home-pricing': renderHomePricing,
  'home-illustration-canvas': () => renderHomeIllustration('canvas'),
  'home-illustration-sidekick': () => renderHomeIllustration('sidekick'),
  'home-illustration-together': () => renderHomeIllustration('together'),
  'site-nav': renderSiteNav,
  'desktop-downloads': renderDesktopDownloads,
  'landing-sections': renderLandingSections,
  'canvas-demo': renderCanvasDemo,
  'live-carousel': renderLiveCarousel,
  'loop-figure': renderLoopFigure,
  'people-figure': renderPeopleFigure,
  'site-footer': renderSiteFooter,
  'comparison-table': renderComparisonTable,
  'marketplace-filters': renderMarketplaceFilters,
  'marketplace-cards': renderMarketplaceCards,
};

/** Replaces each `<!-- rally:name -->` marker with its shared markup. */
export function renderSiteChrome(html: string): string {
  return html.replace(/<!-- rally:([a-z-]+) -->/gu, (_match, name: string) => {
    const render = markers[name];
    if (!render) throw new Error(`Unknown site chrome marker: ${name}`);
    return render();
  });
}
