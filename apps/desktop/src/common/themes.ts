/**
 * The theme vocabulary both processes speak.
 *
 * The renderer decides what a theme *looks* like — every value lives in
 * `src/renderer/styles/themes.css`. This module holds only what the main
 * process also has to know: which themes exist, and the one colour each paints
 * a window with before the renderer has drawn anything into it.
 */

/** What a person chose. `system` is a rule, not an appearance. */
export const themeChoices = ['system', 'light', 'dark', 'airy'] as const;
export type ThemeChoice = (typeof themeChoices)[number];

/** What is actually drawn. `system` has been resolved away. */
export const resolvedThemes = ['light', 'dark', 'airy'] as const;
export type ResolvedTheme = (typeof resolvedThemes)[number];

export const defaultThemeChoice: ThemeChoice = 'system';

export interface ThemeDescription {
  id: ThemeChoice;
  label: string;
  description: string;
}

export const themeDescriptions: readonly ThemeDescription[] = [
  { id: 'system', label: 'System', description: 'Follow the appearance this Mac is set to.' },
  { id: 'light', label: 'Light', description: 'A warm near-white page with hairline rules.' },
  { id: 'dark', label: 'Dark', description: 'Avalon’s original low-light palette.' },
  { id: 'airy', label: 'Airy', description: 'Near-black, amber, and a great deal of room.' },
];

/**
 * The window's background before the first frame.
 *
 * These are each theme's `--canvas`, duplicated here because the main process
 * cannot read a stylesheet and Electron needs the colour at construction time.
 * They are the one place a token value is written twice; `docs/theming.md`
 * records why, and `themes.node.test.ts` fails if the two copies drift.
 */
export const themeWindowBackground: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#111210',
  airy: '#100e0c',
};

export function parseThemeChoice(value: unknown): ThemeChoice | null {
  return typeof value === 'string' && (themeChoices as readonly string[]).includes(value)
    ? (value as ThemeChoice)
    : null;
}

export function parseResolvedTheme(value: unknown): ResolvedTheme | null {
  return typeof value === 'string' && (resolvedThemes as readonly string[]).includes(value)
    ? (value as ResolvedTheme)
    : null;
}

/**
 * The appearance a choice produces. `system` is the only choice that consults
 * the operating system; every other choice is honoured whatever the Mac is set
 * to, which is the point of choosing one.
 */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}
