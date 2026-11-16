/**
 * A connector's company mark as static SVG, rendered at build time from the
 * same components the app draws (`PLUGIN_BRAND_MARKS`), so the site shows the
 * app's art without a React runtime on the page. Node only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// By path, not `@rally/ui`: the build config runs this in Node, which loads a
// bare package import unbundled and cannot resolve its extensionless imports.
import { PLUGIN_BRAND_MARKS, type PluginBrandMark } from '../../../packages/ui/src/lib/plugin-marks';

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
