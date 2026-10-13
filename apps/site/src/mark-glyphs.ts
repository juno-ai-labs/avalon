/**
 * Every appearance icon as a standalone SVG, for the `/marks` images the site
 * Worker draws (see `worker/marks.ts` and `docs/marks.md`).
 *
 * Drawn by the app's own icon components rather than read from Lucide's files,
 * so a mark outside the app is the same glyph the sidebar shows; several stored
 * keys are Lucide aliases, which only the components resolve. Node only: Vite
 * calls it at build time and in the dev server.
 */
import { APPEARANCE_ICON_COMPONENTS } from '@rally/ui/components/appearance-icons';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** The glyph on a 24-unit grid, stroked in `currentColor`; the Worker sets the size and ink. */
export function renderMarkGlyph(Icon: (typeof APPEARANCE_ICON_COMPONENTS)[keyof typeof APPEARANCE_ICON_COMPONENTS]): string {
  return renderToStaticMarkup(createElement(Icon, { xmlns: 'http://www.w3.org/2000/svg' } as Record<string, unknown>));
}

/** Published path to SVG, one per storable icon key. */
export function markGlyphFiles(): [string, string][] {
  return Object.entries(APPEARANCE_ICON_COMPONENTS).map(([key, Icon]) => [`marks/glyphs/${key}.svg`, renderMarkGlyph(Icon)]);
}
