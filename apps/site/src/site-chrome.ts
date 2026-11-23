/**
 * Shared markup for the public marketing pages, such as the header and the
 * column footer. Pages hold a marker comment and the Vite plugin in
 * `vite.config.ts` swaps in the markup, so the list of Trust Center pages lives
 * in one place instead of in every page that shows it. Node only.
 */
import { readFileSync } from 'node:fs';
import { loadBlogPosts, type BlogPost } from './blog-pages';
import { audiencePath, audiences, renderAudienceGrid, renderAudienceStartLink, renderOtherAudiences } from './audiences';
import { escapeHtml as escape } from './html';
import { renderHomeHeader } from './home-header';
import { renderHomeIllustration } from './home-illustrations';
import { renderHomePricing } from './home-pricing';
import { marketplaceTemplates, renderMarketHeader, renderMarketplaceCards, renderMarketplaceFilters, templatePagePath } from './marketplace-catalog';
import { arrow, externalArrow, githubLink, gmailMark } from './site-icons';

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
    + '<a class="header-link" href="/#pricing">Pricing</a>'
    + githubLink('header-link github-link')
    // The web app signs in and signs up through one door, so the label rolls between the two.
    + '<a class="button button-small header-sign-in" data-site-action="sign-in-header" href="https://app.rallywith.ai" aria-label="Sign in to Rally or sign up for Rally">'
    + '<span class="header-sign-in-wheel" aria-hidden="true"><span>Sign in to Rally</span><span>Sign up for Rally</span></span></a></nav>';
}

/** A quiet header for the new reading pages; the earlier product pages keep their own nav. */
function renderReadingNav(): string {
  return '<nav class="reading-nav" aria-label="Primary"><a href="/canvases/">Canvases</a><a href="/sidekicks/">Sidekicks</a>'
    + `<a href="/#pricing">Pricing</a><a href="/help/">The manual ${externalArrow}</a>${githubLink()}`
    + `<a class="header-login" data-site-action="sign-in-header" href="https://app.rallywith.ai">Open Rally ${externalArrow}</a></nav>`;
}



/** A pointy-top hexagon, as SVG points in a 100 x 112 box, inset by `inset`. */
const hexagon = (inset: number): string =>
  [[50, 2], [96, 28.5], [96, 83.5], [50, 110], [4, 83.5], [4, 28.5]]
    .map(([x = 0, y = 0]) => `${50 + (x - 50) * (1 - inset / 50)},${56 + (y - 56) * (1 - inset / 50)}`)
    .join(' ');

const shieldCheck = (x: number, y: number, scale: number): string =>
  `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="currentColor" stroke-width="${1.6 / scale}" stroke-linecap="round" stroke-linejoin="round">`
  + '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></g>';

/**
 * Rally's own badge for its App Defense Alliance CASA AL1 validation. It is drawn
 * here rather than copied from an issuer: ADA and Google publish no badge for AL1.
 * It draws in `currentColor`, so each page's accent colors it.
 */
export function renderCasaBadge(): string {
  const label = 'App Defense Alliance CASA Assurance Level 1, validated by TAC Security, July 2026';
  return `<svg class="casa-badge" viewBox="0 0 100 112" width="104" height="116" role="img" aria-label="${label}">`
    + `<polygon points="${hexagon(0)}" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-width="2.5"/>`
    + `<polygon points="${hexagon(6)}" fill="none" stroke="currentColor" stroke-width=".8" stroke-opacity=".5"/>`
    + shieldCheck(40, 21, 0.85)
    + '<g fill="currentColor" text-anchor="middle" font-family="inherit">'
    + '<text x="50" y="64" font-size="16" font-weight="650" letter-spacing=".5">CASA</text>'
    + '<text x="50" y="83" font-size="14" font-weight="500" letter-spacing="1">AL1</text></g></svg>';
}

const footerColumn = (id: string, title: string, links: readonly string[]): string =>
  `<nav class="footer-column" aria-labelledby="${id}"><h2 class="footer-heading" id="${id}">${title}</h2><ul class="footer-links">${links.map((link) => `<li>${link}</li>`).join('')}</ul></nav>`;

/**
 * The site footer. `casaLink: false` leaves out the legal row's CASA link, for a
 * page that already shows the full CASA badge below the footer.
 */
export function renderSiteFooter({ casaLink = true }: { casaLink?: boolean } = {}): string {
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
    '<a href="/developer-mode/">Developer mode</a>',
    '<a href="/#pricing">Pricing</a>',
  ];
  const who = audiences.map(({ slug, short }) => `<a href="${audiencePath(slug)}">${escape(short)}</a>`);
  return `<footer class="rally-footer"><div class="footer-grid">`
    + `<div class="footer-brand"><a class="wordmark" href="/" aria-label="Rally home"><img class="rally-symbol" src="/brand/rally-mark-ink.svg" width="24" height="24" alt=""><span>rally</span></a>`
    + `<p class="footer-tagline">Made for people who work with AI, not on it.</p></div>`
    + footerColumn('footer-product', 'Product', product)
    + footerColumn('footer-who', 'Who it’s for', who)
    + footerColumn('footer-trust', 'Trust Center', trust)
    + footerColumn('footer-help', 'Help', help)
    + footerColumn('footer-blog', 'Blog', blog)
    + `</div><p class="footer-legal"><small>© 2026 Juno AI Labs · Rally</small>${casaLink ? '<small><a class="footer-casa" href="/trust/security/#overview">ADA CASA AL1 validated</a></small>' : ''}<small>rallywith.ai</small></p>`
    + `<p class="footer-mark" aria-hidden="true">rally</p></footer>`;
}

const sitemap = (urls: readonly { loc: string; lastmod: string }[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(({ loc, lastmod }) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n`).join('')
    + '</urlset>\n';

/** A sitemap of the blog index and every post, which `robots.txt` lists beside the main one. */
export const renderBlogSitemap = (): string => {
  const posts = blogPosts.map(({ slug, date }) => ({ loc: `${ORIGIN}/blog/${slug}/`, lastmod: date }));
  // The index changes when its newest post does; with no posts there is nothing to list.
  return sitemap(blogPosts[0] ? [{ loc: `${ORIGIN}/blog/`, lastmod: blogPosts[0].date }, ...posts] : posts);
};

/** `/llms.txt`: a plain index of the site for AI tools. */
export function renderLlmsTxt(): string {
  return `# Rally

> Rally turns the email a person or a team already gets into one page they can check at a glance: a dashboard, a board or a table of their leads, orders, candidates or clients. Connect Gmail, say what you want to see in a sentence, and the page updates itself as new mail arrives, from one inbox or from several. Rally is also a general tool: in a Canvas, people talk with Rally and it makes the thing itself (a document, a spreadsheet, a dashboard, a site); Sidekicks are shared helpers that run on a schedule or when something happens; connectors read and write tools like Gmail, Google Drive, Slack, Notion, and GitHub.

## Product

- [Rally home](${ORIGIN}/): connect Gmail and get a dashboard in five minutes; who it is for, how it works, pricing
- [Developer mode](${ORIGIN}/developer-mode/): what Rally builds beyond inbox pages: dashboards, small apps, podcast feeds and websites that react to events in connected tools
- [Canvases](${ORIGIN}/canvases/): the conversation with Rally and the pages it makes beside it, kept up to date from your email and connected tools, and shared with a team
- [Sidekicks](${ORIGIN}/sidekicks/): shared helpers that run on a schedule or when something happens, and keep pages up to date
- [Help Center](${ORIGIN}/help/): the Rally manual, from installing Rally to running an Organization. Its own index of every page, each published as Markdown: ${ORIGIN}/help/llms.txt

## Who it is for

One page per kind of work, each with examples of the pages Rally builds from that inbox.

${audiences.map(({ slug, name, line }) => `- [${name}](${ORIGIN}${audiencePath(slug)}): ${line}`).join('\n')}

## Marketplace

Templates a Canvas can start from, the same ones Rally's in-app Marketplace offers. Each page says what the template builds and which connectors it works best with.

${marketplaceTemplates().map(({ slug, name, description }) => `- [${name}](${ORIGIN}${templatePagePath(slug)}): ${description}`).join('\n')}

## Blog

Each post's Markdown source is published beside it at \`index.md\`.

${blogPosts.map(({ slug, title, description }) => `- [${title}](${ORIGIN}/blog/${slug}/): ${description}`).join('\n')}

## Trust Center

${trustPages.map(({ href, name }) => `- [${name}](${ORIGIN}${href})`).join('\n')}
`;
}

/** The animated Canvas in the home page's hero and the Canvases page, from `canvas-demo.html`. */
function renderCanvasDemo(): string {
  return readFileSync(new URL('./canvas-demo.html', import.meta.url), 'utf8');
}

/** The homepage's hero story, one slide per audience, from `home-story.html`. */
function renderHomeStory(): string {
  return renderSiteChrome(readFileSync(new URL('./home-story.html', import.meta.url), 'utf8'));
}

/** A marker's markup. One that takes a word after its name, such as `audience-others legal`, is handed it. */
const markers: Record<string, (argument?: string) => string> = {
  'home-header': () => renderHomeHeader(),
  'home-story': renderHomeStory,
  'audience-grid': renderAudienceGrid,
  'audience-others': renderOtherAudiences,
  'audience-start': renderAudienceStartLink,
  'gmail-mark': () => gmailMark,
  arrow: () => arrow,
  'reading-nav': renderReadingNav,
  'home-pricing': renderHomePricing,
  'home-illustration-canvas': () => renderHomeIllustration('canvas'),
  'home-illustration-sidekick': () => renderHomeIllustration('sidekick'),
  'home-illustration-together': () => renderHomeIllustration('together'),
  'site-nav': renderSiteNav,
  'canvas-demo': renderCanvasDemo,
  'site-footer': () => renderSiteFooter(),
  'site-footer-without-casa': () => renderSiteFooter({ casaLink: false }),
  'casa-badge': renderCasaBadge,
  'market-header': () => renderMarketHeader(),
  'github-link': () => githubLink(),
  // For hand-written headers whose links are styled as `.header-link`, such as the Trust Center's.
  'github-header-link': () => githubLink('header-link github-link'),
  'marketplace-filters': renderMarketplaceFilters,
  'marketplace-cards': renderMarketplaceCards,
};

/** Replaces each `<!-- rally:name -->` marker, or `<!-- rally:name word -->`, with its shared markup. */
export function renderSiteChrome(html: string): string {
  return html.replace(/<!-- rally:([a-z-]+)(?: ([a-z-]+))? -->/gu, (_match, name: string, argument?: string) => {
    const render = markers[name];
    if (!render) throw new Error(`Unknown site chrome marker: ${name}`);
    return render(argument);
  });
}
