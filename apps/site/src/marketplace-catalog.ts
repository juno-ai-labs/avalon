/**
 * The `/marketplace/` page's filters and cards, rendered from the Canvas
 * templates the app's own Marketplace offers. Node only.
 */
import { readFileSync } from 'node:fs';
// By path, not `@rally/skills`: the build config runs this in Node, which
// loads a bare package import unbundled and cannot resolve its extensionless
// imports.
import { loadCanvasTemplates } from '../../../packages/skills/marketplace-skills/catalog';
import { CANVAS_TEMPLATE_CATEGORIES } from '../../../packages/skills/marketplace-skills/categories';
import { escapeHtml as escape } from './comparison-pages';

const arrow = '<svg class="arrow-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4 14L14 4M4 4h10v10" /></svg>';

/** One filter per category, in the app's order, after All. */
export function renderMarketplaceFilters(): string {
  const button = (filter: string, label: string, pressed: boolean): string =>
    `<button type="button" data-filter="${filter}" aria-pressed="${pressed}">${escape(label)}</button>`;
  return `<div class="market-filters" role="group" aria-label="Filter by who it is for">${button('all', 'All', true)}`
    + `${CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => button(tag, label, false)).join('')}</div>`;
}

/**
 * A card per template, in catalog order; each card lists its categories for
 * the filter. "Start from this" is the template's link on the web app, which
 * signs the person in or up and starts that template in their Organization.
 */
export function renderMarketplaceCards(): string {
  const labels = new Map<string, string>(CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => [tag, label]));
  const cards = loadCanvasTemplates((file) => readFileSync(file, 'utf8')).map(({ name, description, tags, link }) =>
    `<li class="market-card" data-categories="${tags.join(' ')}"><div class="market-card-body">`
    + `<p class="market-kind">For ${escape(tags.map((tag) => labels.get(tag) ?? tag).join(', ').toLocaleLowerCase())}</p>`
    + `<h3>${escape(name)}</h3><p>${escape(description)}</p>`
    + `<a class="text-link" data-site-action="web-app-template" href="https://app.rallywith.ai${link}">Start from this ${arrow}</a></div></li>`);
  return `<ul class="market-grid">${cards.join('')}</ul>`;
}
