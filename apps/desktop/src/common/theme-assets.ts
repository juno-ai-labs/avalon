/*
 * GENERATED FILE — do not edit.
 *
 * Written by `scripts/build-theme-assets.mjs` from the design-token JSON
 * under `config/design-tokens/`. Run `pnpm tokens:build` after editing a
 * theme; `pnpm tokens:check` fails if this file and that JSON disagree.
 */

/** The scheme cached remote font files are served from. */
export const fontScheme = 'rally-font';

/**
 * Remote font files, by the cache id `themes.css` asks for. The main process
 * fetches a miss once and keeps it; `integrity`, when a theme declares it, is
 * checked before the bytes are allowed into the cache.
 */
export const cachedFonts: Record<string, { url: string; integrity?: string }> = {
};

/**
 * The syntax colours a document *outside* the application has to declare for
 * itself.
 *
 * `MarkdownBody` colours highlighted code with `var(--av-sys-color-syntax-*)`
 * in inline styles, which resolve against the cascade — everywhere except the
 * one place that markup is re-hosted. The message exporter serializes it into
 * a standalone document that loads no stylesheet of ours, where every one of
 * those references is invalid at computed-value time and `color` falls back
 * to the inherited near-black, on a near-black code block.
 *
 * These are the dark appearance's values because the exported card is
 * deliberately not themed: a fixed light sheet with a fixed dark code block,
 * so that a saved file looks the same whoever saved it. Generated rather than
 * copied so the two cannot drift.
 */
export const exportSyntaxPalette: Record<string, string> = {
  '--av-sys-color-syntax-plain': '#e4dbcb',
  '--av-sys-color-syntax-comment': '#777772',
  '--av-sys-color-syntax-punctuation': '#a19684',
  '--av-sys-color-syntax-tag': '#e09a5e',
  '--av-sys-color-syntax-number': '#d9b168',
  '--av-sys-color-syntax-string': '#b9a3d4',
  '--av-sys-color-syntax-operator': '#c3b8a6',
  '--av-sys-color-syntax-keyword': '#e08c3a',
  '--av-sys-color-syntax-function': '#8fb3ce',
  '--av-sys-color-syntax-variable': '#d9b168',
};
