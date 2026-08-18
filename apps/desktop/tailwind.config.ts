import type { Config } from 'tailwindcss';

/**
 * The palette is the theme engine's, not a second copy of it. Every entry
 * resolves to a custom property declared in `src/renderer/styles/themes.css`,
 * so a utility class follows the active theme for the same reason a hand-written
 * rule does. Literal hex values here were the previous shape and they silently
 * pinned a utility to the dark theme; see `docs/theming.md`.
 */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        sidebar: 'var(--sidebar)',
        surface: 'var(--surface)',
        raised: 'var(--raised)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        line: 'var(--line)',
        accent: 'var(--blue)',
        attention: 'var(--gold)',
        danger: 'var(--red)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
    },
  },
  plugins: [],
} satisfies Config;
