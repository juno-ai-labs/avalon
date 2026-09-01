/**
 * The theme vocabulary both processes speak.
 *
 * A choice has two axes, not one. A **family** is a design — Terra, Rally's
 * original palette, or Air — and a **mode** is which way round it runs. They
 * are separate because they answer different questions: the family is a taste,
 * and the mode is a lighting condition that may change during the day. Folding
 * them into one flat list made `system` a peer of the designs, which meant
 * choosing to follow the Mac silently also chose Terra, and a person on Air had
 * no way to say "this design, but follow the room".
 *
 * The renderer decides what a theme *looks* like — every value lives in
 * `src/renderer/styles/themes.css`. This module holds only what the main
 * process also has to know: which appearances exist, and the one colour each
 * paints a window with before the renderer has drawn anything into it.
 */

/** A design. Each brings a light appearance and a dark one. */
export const themeFamilies = ['grok', 'terra', 'air'] as const;
export type ThemeFamily = (typeof themeFamilies)[number];

/** Which way round to run it. `system` is a rule, not an appearance. */
export const appearanceModes = ['system', 'light', 'dark'] as const;
export type AppearanceMode = (typeof appearanceModes)[number];

/** What is actually drawn, once family and mode have been combined. */
export const resolvedThemes = ['grok', 'grok-dark', 'terra-light', 'terra', 'air', 'air-dark'] as const;
export type ResolvedTheme = (typeof resolvedThemes)[number];

export interface ThemeChoice {
  family: ThemeFamily;
  mode: AppearanceMode;
}

export const defaultThemeChoice: ThemeChoice = { family: 'grok', mode: 'system' };

/**
 * The two appearances each family brings.
 *
 * This table is the whole coupling between the axes: adding a family means
 * adding a row and two theme files, and nothing else in either process learns a
 * new name.
 */
export const familyAppearances: Record<ThemeFamily, Record<'light' | 'dark', ResolvedTheme>> = {
  grok: { light: 'grok', dark: 'grok-dark' },
  terra: { light: 'terra-light', dark: 'terra' },
  air: { light: 'air', dark: 'air-dark' },
};

export interface Described<Id> {
  id: Id;
  label: string;
  description: string;
}

export const themeFamilyDescriptions: readonly Described<ThemeFamily>[] = [
  { id: 'grok', label: 'Grok', description: 'A white page, grey bubbles, and one black control at a time.' },
  { id: 'terra', label: 'Terra', description: 'The original palette: dense rows and a composer that is a card.' },
  { id: 'air', label: 'Air', description: 'Amber light on a moving field, with a great deal more room.' },
];

export const appearanceModeDescriptions: readonly Described<AppearanceMode>[] = [
  { id: 'system', label: 'System', description: 'Follow the appearance this Mac is set to.' },
  { id: 'light', label: 'Light', description: 'Stay light whatever this Mac is set to.' },
  { id: 'dark', label: 'Dark', description: 'Stay dark whatever this Mac is set to.' },
];

/**
 * The window's background before the first frame.
 *
 * These are each appearance's `--canvas`, duplicated here because the main
 * process cannot read a stylesheet and Electron needs the colour at
 * construction time. They are the one place a token value is written twice;
 * `docs/theming.md` records why, and `themes.css.node.test.ts` fails if the two
 * copies drift.
 */
export const themeWindowBackground: Record<ResolvedTheme, string> = {
  grok: '#ffffff',
  'grok-dark': '#0b0b0d',
  'terra-light': '#ffffff',
  terra: '#111210',
  air: '#f7f3ec',
  'air-dark': '#100e0c',
};

export function parseThemeFamily(value: unknown): ThemeFamily | null {
  return typeof value === 'string' && (themeFamilies as readonly string[]).includes(value)
    ? (value as ThemeFamily)
    : null;
}

export function parseAppearanceMode(value: unknown): AppearanceMode | null {
  return typeof value === 'string' && (appearanceModes as readonly string[]).includes(value)
    ? (value as AppearanceMode)
    : null;
}

/**
 * What a flat theme name used to mean, before the axes were separated.
 *
 * A stored preference outlives the shape it was written in, and a person who had
 * chosen Airy should not be handed Terra by a refactor. Anything unrecognised
 * falls through to `null` and the caller falls back to the default.
 */
const LEGACY_CHOICES: Record<string, ThemeChoice> = {
  system: { family: 'terra', mode: 'system' },
  light: { family: 'terra', mode: 'light' },
  dark: { family: 'terra', mode: 'dark' },
  // `airy` was the name before it was shortened; a stored preference should not
  // be a reason to be handed a different design.
  airy: { family: 'air', mode: 'light' },
  'airy-dark': { family: 'air', mode: 'dark' },
};

/** Families that have been renamed, so a stored choice survives the rename. */
const LEGACY_FAMILIES: Record<string, ThemeFamily> = { neu: 'terra' };

export function parseThemeChoice(value: unknown): ThemeChoice | null {
  if (typeof value === 'string') return LEGACY_CHOICES[value] ?? null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const named = candidate['family'];
  const family = parseThemeFamily(named)
    ?? (typeof named === 'string' ? LEGACY_FAMILIES[named] ?? null : null);
  const mode = parseAppearanceMode(candidate['mode']);
  return family && mode ? { family, mode } : null;
}

export function parseResolvedTheme(value: unknown): ResolvedTheme | null {
  return typeof value === 'string' && (resolvedThemes as readonly string[]).includes(value)
    ? (value as ResolvedTheme)
    : null;
}

/**
 * The appearance a choice produces.
 *
 * `system` is the only mode that consults the operating system, and it consults
 * it about the *lighting* only — the family a person chose is honoured whatever
 * the Mac is set to, which is the point of choosing one.
 */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  const appearance = choice.mode === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : choice.mode;
  return familyAppearances[choice.family][appearance];
}

/**
 * Whether two choices are the same on *both* axes.
 *
 * Two different choices can resolve to the same appearance — Terra on `system`
 * under a dark Mac, and Terra pinned to Dark, are both `terra` — so comparing
 * what they resolve to cannot answer whether the preference changed.
 */
export function sameThemeChoice(a: ThemeChoice, b: ThemeChoice): boolean {
  return a.family === b.family && a.mode === b.mode;
}

/** The family an appearance belongs to. */
export function familyOf(theme: ResolvedTheme): ThemeFamily {
  const found = themeFamilies.find((family) => (
    familyAppearances[family].light === theme || familyAppearances[family].dark === theme
  ));
  return found ?? 'terra';
}
