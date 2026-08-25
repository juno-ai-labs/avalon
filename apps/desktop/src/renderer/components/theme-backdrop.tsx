import { useTheme } from '../lib/theme';
import { backdropScheme, themesWithBackdrop } from '../../common/theme-assets';

/**
 * The frame a theme's backdrop document renders in.
 *
 * Some backdrops cannot be a CSS value. Airy's is a field of light that orbits,
 * and there is no `background-image` that orbits — it needs a clock and a frame
 * loop. Rather than inventing a declarative motion vocabulary that would cover
 * that one case and none of the next ones, a theme may bring a whole document,
 * and this is where it goes.
 *
 * What keeps that from being a hole is that the document is not part of this
 * page. It is served from `rally-backdrop://`, an origin of its own, under a
 * policy with no `connect-src` at all, into a frame sandboxed *without*
 * `allow-same-origin` — so its scripts run in an opaque origin that cannot reach
 * this document, this origin's storage, or the preload bridge, and cannot make a
 * network request to say that it ran. It can paint. That is the entire grant.
 *
 * `pointer-events: none` is on the element rather than only inside the document,
 * because a backdrop that swallowed a click would be an interface element, and
 * whether it does should not depend on the theme author remembering.
 */
export function ThemeBackdrop(): React.JSX.Element | null {
  const { resolved } = useTheme();
  const themes: readonly string[] = themesWithBackdrop;
  if (!themes.includes(resolved)) return null;

  return (
    <iframe
      // Keyed by theme so switching swaps the document rather than navigating a
      // live one: the outgoing backdrop's frame loop stops with its frame.
      key={resolved}
      className="theme-backdrop"
      sandbox="allow-scripts"
      src={`${backdropScheme}://theme/${resolved}`}
      tabIndex={-1}
      title=""
    />
  );
}
