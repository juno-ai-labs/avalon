/*
 * GENERATED FILE — do not edit.
 *
 * Written by `scripts/build-theme-assets.mjs` from the design-token JSON
 * under `config/design-tokens/`. Run `pnpm tokens:build` after editing a
 * theme; `pnpm tokens:check` fails if this file and that JSON disagree.
 */

/** The scheme a theme's backdrop document is served from. */
export const backdropScheme = 'avalon-backdrop';

/** The scheme cached remote font files are served from. */
export const fontScheme = 'avalon-font';

/**
 * Themes that bring a backdrop document. A theme not listed here paints its
 * backdrop entirely with `sys.backdrop.*` and mounts no frame at all.
 */
export const themesWithBackdrop = ['airy'] as const;

export type ThemeWithBackdrop = (typeof themesWithBackdrop)[number];

/**
 * Remote font files, by the cache id `themes.css` asks for. The main process
 * fetches a miss once and keeps it; `integrity`, when a theme declares it, is
 * checked before the bytes are allowed into the cache.
 */
export const cachedFonts: Record<string, { url: string; integrity?: string }> = {
};
