import type { Config } from 'tailwindcss';

import {
  borderRadius,
  borderWidth,
  boxShadow,
  colors,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  spacing,
} from './src/renderer/styles/tailwind-theme';

/**
 * The palette is the theme engine's, not a second copy of it. Every entry
 * resolves to a custom property declared in `src/renderer/styles/themes.css`,
 * so a utility class follows the active theme for the same reason a
 * hand-written rule does. Literal hex values here were the previous shape and
 * they silently pinned a utility to the dark theme; see `docs/theming.md`.
 *
 * `colors` is assigned rather than extended, which is what keeps that true.
 * Extending leaves Tailwind's own palette in the vocabulary, so `bg-zinc-800`
 * stays a valid class that renders correctly under whichever theme its author
 * happened to be looking at — the exact failure `themes.css` exists to end, and
 * one that no test on the stylesheet can see because it never reaches the
 * stylesheet. Replacing the palette makes it a build error instead.
 *
 * The scales are extended rather than replaced: Tailwind's numeric spacing and
 * its `text-sm`/`font-medium` steps are still the right answer for the geometry
 * a token has no opinion about. See `docs/component-library.md`.
 */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    colors,
    extend: {
      borderRadius,
      borderWidth,
      boxShadow,
      fontFamily,
      fontSize,
      fontWeight,
      lineHeight,
      spacing,
    },
  },
  plugins: [],
} satisfies Config;
