/**
 * The marketplace, rendered from the Canvas templates the app's own
 * Marketplace offers: `/marketplace/`'s filters and cards, and one page per
 * template at `/marketplace/<slug>/`. Node only.
 */
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
// By path, not `@rally/skills`: the build config runs this in Node, which
// loads a bare package import unbundled and cannot resolve its extensionless
// imports.
import { loadCanvasTemplates, type CanvasTemplateData } from '../../../packages/skills/marketplace-skills/catalog';
import { CANVAS_TEMPLATE_CATEGORIES } from '../../../packages/skills/marketplace-skills/categories';
import { TEMPLATE_CONNECTORS, templateConnectorHelpPath, type TemplateConnectorId } from '../../../packages/skills/marketplace-skills/connectors';
import { escapeHtml as escape } from './comparison-pages';

const ORIGIN = 'https://rallywith.ai';
const APP_ORIGIN = 'https://app.rallywith.ai';
const arrow = '<svg class="arrow-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4 14L14 4M4 4h10v10" /></svg>';
const CATEGORY_LABELS = new Map<string, string>(CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => [tag, label]));
const CONNECTOR_NAMES = new Map<string, string>(TEMPLATE_CONNECTORS.map(({ id, name }) => [id, name]));

/** Every template, in catalog order. Read on each call so the dev server serves the current files. */
export const marketplaceTemplates = (): CanvasTemplateData[] => loadCanvasTemplates((file) => readFileSync(file, 'utf8'));

/** A template's page on the site. */
export const templatePagePath = (slug: string): string => `/marketplace/${slug}/`;

const audience = (tags: readonly string[]): string =>
  `For ${tags.map((tag) => CATEGORY_LABELS.get(tag) ?? tag).join(', ').toLocaleLowerCase()}`;

/** "Start from this": the template's link on the web app, which signs the person in or up and starts it. */
const startLink = (className: string, link: string): string =>
  `<a class="${className}" data-site-action="web-app-template" href="${APP_ORIGIN}${link}">Start from this ${arrow}</a>`;

/** The recommended connectors, each linking to how to connect it; nothing when a template recommends none. */
function connectorList(connectors: readonly TemplateConnectorId[], className: string): string {
  if (connectors.length === 0) return '';
  return `<ul class="${className}" aria-label="Recommended connectors">${connectors.map((id) =>
    `<li><a href="${templateConnectorHelpPath(id)}">${escape(CONNECTOR_NAMES.get(id) ?? id)}</a></li>`).join('')}</ul>`;
}

/** The marketplace's header, the homepage's with Marketplace marked current. */
export function renderMarketHeader(): string {
  return '<header class="home-header"><a class="home-logo" href="/" aria-label="Rally home"><img src="/brand/rally-mark-ink.svg" width="32" height="32" alt="" />rally</a>'
    + '<nav class="home-nav" aria-label="Primary"><a href="/#canvases">Canvases</a><a href="/marketplace/" aria-current="page">Marketplace</a>'
    + '<a href="/#pricing">Pricing</a><a href="/help/">The manual</a></nav>'
    + `<a class="header-login" data-site-action="sign-in-header" href="${APP_ORIGIN}">Open Rally <span aria-hidden="true">${arrow}</span></a></header>`;
}

/** One filter per category, in the app's order, after All. */
export function renderMarketplaceFilters(): string {
  const button = (filter: string, label: string, pressed: boolean): string =>
    `<button type="button" data-filter="${filter}" aria-pressed="${pressed}">${escape(label)}</button>`;
  return `<div class="market-filters" role="group" aria-label="Filter by who it is for">${button('all', 'All', true)}`
    + `${CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => button(tag, label, false)).join('')}</div>`;
}

/**
 * A card per template, in catalog order; each card lists its categories for
 * the filter, its recommended connectors, "Start from this" and "More info",
 * which opens the template's own page.
 */
export function renderMarketplaceCards(): string {
  const cards = marketplaceTemplates().map(({ name, description, tags, connectors, link, slug }) =>
    `<li class="market-card" data-categories="${tags.join(' ')}"><div class="market-card-body">`
    + `<p class="market-kind">${escape(audience(tags))}</p>`
    + `<h3>${escape(name)}</h3><p>${escape(description)}</p>`
    + connectorList(connectors, 'market-connectors')
    + `<div class="market-card-actions">${startLink('text-link', link)}`
    + `<a class="text-link market-more" href="${templatePagePath(slug)}" aria-label="More info about ${escape(name)}">More info</a></div>`
    + `</div></li>`);
  return `<ul class="market-grid">${cards.join('')}</ul>`;
}

/**
 * A template's own page: who it is for, what it does, the connectors it works
 * best with, and the prompt Rally starts from, which is the template itself.
 */
export function renderTemplatePage(template: CanvasTemplateData): string {
  const { name, description, tags, connectors, link, slug, prompt } = template;
  const path = templatePagePath(slug);
  const title = `${name} · Rally Marketplace`;
  const connectorSection = connectors.length
    ? `<p>Connect these so Rally can read what it needs and keep the Canvas current:</p>${connectorList(connectors, 'market-connectors market-connectors-large')}`
    : '<p>Nothing to connect. Rally builds it from what you tell it.</p>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#fcfbf7" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon.png" type="image/png" sizes="64x64" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
    <link rel="manifest" href="/site.webmanifest" />
    <title>${escape(title)}</title>
    <meta name="description" content="${escape(description)}" />
    <link rel="canonical" href="${ORIGIN}${path}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Rally" />
    <meta property="og:title" content="${escape(title)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:url" content="${ORIGIN}${path}" />
    <meta property="og:image" content="${ORIGIN}/rally-pencil-social.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/src/marketplace.css" />
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to content</a>
    <!-- rally:market-header -->
    <main id="content">
      <article class="market-template wrap" aria-labelledby="template-title">
        <nav class="market-breadcrumbs" aria-label="Breadcrumb"><a href="/marketplace/">Marketplace</a> <span aria-hidden="true">/</span> <span aria-current="page">${escape(name)}</span></nav>
        <p class="eyebrow">${escape(audience(tags))}</p>
        <h1 id="template-title">${escape(name)}</h1>
        <p class="market-lede">${escape(description)}</p>
        <div class="market-template-actions">${startLink('button primary', link)}</div>
        <section class="market-template-section" aria-labelledby="template-connectors"><h2 id="template-connectors">Works best with</h2>${connectorSection}</section>
        <section class="market-template-section" aria-labelledby="template-prompt"><h2 id="template-prompt">What Rally builds</h2>
          <p>Starting this sends Rally these instructions as the Canvas’s first message. Rally asks for anything it needs, then builds it with you.</p>
          <blockquote class="market-prompt">${marked.parse(prompt, { async: false })}</blockquote>
        </section>
      </article>
    </main>
    <!-- rally:site-footer -->
  </body>
</html>
`;
}

/** A sitemap of every template page, which `robots.txt` lists beside the main one. */
export function renderMarketplaceSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + marketplaceTemplates().map(({ slug }) => `  <url>\n    <loc>${ORIGIN}${templatePagePath(slug)}</loc>\n  </url>\n`).join('')
    + '</urlset>\n';
}
