/**
 * A connector's company mark, or a Rally plugin's glyph, as static SVG, rendered at build time from the
 * same components the app draws (`PLUGIN_BRAND_MARKS`), so the site shows the
 * app's art without a React runtime on the page. Node only.
 */
import { IconBell, IconImageGeneration, IconWorldSearch, type Icon as TablerIcon } from '@tabler/icons-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// By path, not `@rally/ui`: the build config runs this in Node, which loads a
// bare package import unbundled and cannot resolve its extensionless imports.
import { PLUGIN_BRAND_MARKS, type PluginBrandMark } from '../../../packages/ui/src/lib/plugin-marks';
import type { TEMPLATE_PLUGINS } from '../../../packages/skills/marketplace-skills/connectors';

const rendered = new Map<PluginBrandMark, string>();

/**
 * The mark inside a `.connector-mark` span, hidden from assistive tech because
 * the connector's name sits beside it. Brands with no `mono` art arrive in
 * colour; `.connector-mark` recolours them, as the app's rule of the same
 * name does.
 */
export function renderConnectorMark(mark: PluginBrandMark): string {
  let svg = rendered.get(mark);
  if (svg === undefined) {
    const brand = PLUGIN_BRAND_MARKS[mark];
    svg = renderToStaticMarkup(brand.mono ? createElement(brand.Mark, { variant: 'mono' }) : createElement(brand.Mark));
    rendered.set(mark, svg);
  }
  return `<span class="connector-mark" aria-hidden="true">${svg}</span>`;
}

/**
 * The glyphs of Rally's own plugins, as the app's transcript draws them where
 * it has one: the public web wears `IconWorldSearch` and generation
 * `IconImageGeneration` there. Push notifications have no transcript glyph;
 * the bell is the one people expect for them.
 */
const PLUGIN_GLYPHS: Record<(typeof TEMPLATE_PLUGINS)[number]['glyph'], TablerIcon> = {
  web: IconWorldSearch,
  notifications: IconBell,
  'image-generation': IconImageGeneration,
};

/** A Rally plugin's glyph, in the same box a company mark takes. */
export function renderPluginGlyph(glyph: keyof typeof PLUGIN_GLYPHS): string {
  return `<span class="connector-mark" aria-hidden="true">${renderToStaticMarkup(createElement(PLUGIN_GLYPHS[glyph], { size: 24, stroke: 1.8 }))}</span>`;
}
