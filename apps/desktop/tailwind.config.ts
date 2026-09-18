import type { Config } from 'tailwindcss';

/**
 * The palette is the theme engine's, not a second copy of it. Every entry
 * resolves to a custom property declared in `packages/ui/src/styles/themes.css`,
 * so a utility class follows the active theme for the same reason a hand-written
 * rule does. Literal hex values here were the previous shape and they silently
 * pinned a utility to the dark theme; see `docs/theming.md`.
 */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--av-sys-color-surface-canvas)',
        sidebar: 'var(--av-cmp-sidebar-background)',
        surface: 'var(--av-sys-color-surface-default)',
        raised: 'var(--av-sys-color-surface-raised)',
        ink: 'var(--av-sys-color-text-default)',
        muted: 'var(--av-sys-color-text-muted)',
        line: 'var(--av-sys-color-border-default)',
        accent: 'var(--av-sys-color-accent-base)',
        attention: 'var(--av-sys-color-warning-base)',
        danger: 'var(--av-sys-color-danger-base)',
      },
      borderRadius: {
        sm: 'var(--av-sys-size-radius-sm)',
        DEFAULT: 'var(--av-sys-size-radius-md)',
        md: 'var(--av-sys-size-radius-md)',
        lg: 'var(--av-sys-size-radius-lg)',
        xl: 'var(--av-sys-size-radius-xl)',
      },
    },
  },
  plugins: [],
} satisfies Config;
