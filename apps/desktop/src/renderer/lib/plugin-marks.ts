import github from 'thesvg/github';
import google from 'thesvg/google';
import googleDrive from 'thesvg/google-drive';
import granola from 'thesvg/granola';
import linear from 'thesvg/linear';
import notion from 'thesvg/notion';
import slack from 'thesvg/slack';
import x from 'thesvg/x';

/**
 * A company's own mark, drawn as a mask rather than as markup.
 *
 * `thesvg` hands out SVG as a string, and its own documentation renders one
 * with `dangerouslySetInnerHTML`. Nothing in this renderer injects HTML today
 * and this is not the feature to start with — the strings here are build-time
 * constants, but the pattern a reader copies from would not be. A mask cannot
 * carry markup into the document at all: the browser reads the file for its
 * alpha channel and paints `currentColor` through it, so the worst a malformed
 * icon can do is fail to draw. It is also how `.rally-mark` has always worked.
 *
 * The mask makes every mark monochrome by construction, which is what this feed
 * wants: one contrasting neutral across four themes, rather than eight brand
 * palettes of which several disappear against one ground or the other — X and
 * Notion on a dark theme, Granola on a light one.
 *
 * Because a mask reads only alpha, a brand's `mono` variant and its full-colour
 * default differ here only where the colour art is a solid silhouette of an
 * outlined mark. Google is exactly that, so the `mono` variant is preferred
 * wherever the package ships one; Slack and Granola ship none, and their colour
 * art masks to the same shape a monochrome treatment would.
 */
function maskUrl(icon: { svg: string; variants: Record<string, string> }): string {
  const source = icon.variants['mono'] ?? icon.svg;
  return `url("data:image/svg+xml,${encodeURIComponent(source)}")`;
}

/** The brands Rally connects to that have a mark of their own. */
export const PLUGIN_BRAND_MARKS = {
  github: maskUrl(github),
  google: maskUrl(google),
  'google-drive': maskUrl(googleDrive),
  granola: maskUrl(granola),
  linear: maskUrl(linear),
  notion: maskUrl(notion),
  slack: maskUrl(slack),
  x: maskUrl(x),
} as const;

export type PluginBrandMark = keyof typeof PLUGIN_BRAND_MARKS;

/**
 * Whether a glyph name is a company's mark rather than one of the shapes no
 * company owns. A guard rather than a bare `in`, so the narrowing is real: what
 * is left after it stays a closed union, and a glyph added to one table but not
 * the other fails to typecheck instead of rendering as undefined.
 */
export function isPluginBrandMark(icon: string): icon is PluginBrandMark {
  return icon in PLUGIN_BRAND_MARKS;
}

/**
 * The mark a connector wears, from the type its own manifest declares.
 *
 * This is the mapping every surface goes through, so a connector wears one mark
 * in Settings, in the transcript, and anywhere else it is drawn — the alternative
 * is what was here before, where the same company was a `GitBranch` on one
 * screen and a `brand-github` on another.
 *
 * Google is the one type that is two brands: a Gmail and Calendar connection and
 * a Drive connection share the type and are told apart by their name, which is
 * the same discriminator the backend uses.
 *
 * Null is not a failure. A webhook is not a company and has no mark to wear, and
 * a connector added before this mapping learns about it draws the generic plug.
 */
export function connectorBrandMark(
  connectorType: string,
  displayName?: string,
): PluginBrandMark | null {
  switch (connectorType) {
    case 'github': return 'github';
    case 'google': return displayName?.includes('Drive') ? 'google-drive' : 'google';
    case 'granola': return 'granola';
    case 'linear': return 'linear';
    case 'notion': return 'notion';
    case 'slack': return 'slack';
    case 'x': return 'x';
    default: return null;
  }
}
