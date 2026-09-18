/**
 * The appearance vocabulary shared by Rally's main and renderer processes.
 *
 * Rally has one visual language with a light and dark appearance. `system` is
 * a preference that resolves to one of those appearances from the Mac setting;
 * it is not a third palette.
 */

export const appearanceModes = ['system', 'light', 'dark'] as const;
export type AppearanceMode = (typeof appearanceModes)[number];

export const resolvedThemes = ['light', 'dark'] as const;
export type ResolvedTheme = (typeof resolvedThemes)[number];

/** Stored and broadcast preference. */
export type ThemeChoice = AppearanceMode;

export const defaultThemeChoice: ThemeChoice = 'system';

export interface Described<Id> {
  id: Id;
  label: string;
  description: string;
}

export const appearanceModeDescriptions: readonly Described<AppearanceMode>[] = [
  { id: 'system', label: 'System', description: 'Follow the appearance this Mac is set to.' },
  { id: 'light', label: 'Light', description: 'Stay light whatever this Mac is set to.' },
  { id: 'dark', label: 'Dark', description: 'Stay dark whatever this Mac is set to.' },
];

/**
 * The window background used before the renderer's first frame. These values
 * duplicate each appearance's canvas token and are checked against the
 * generated stylesheet.
 */
export const themeWindowBackground: Record<ResolvedTheme, string> = {
  light: '#fcfcfc',
  dark: '#070707',
};

export function parseAppearanceMode(value: unknown): AppearanceMode | null {
  return typeof value === 'string' && (appearanceModes as readonly string[]).includes(value)
    ? (value as AppearanceMode)
    : null;
}

/**
 * Read the current scalar preference and the previous `{ family, mode }`
 * storage shape. The family is deliberately ignored: every prior family now
 * migrates to the same Rally appearance while retaining its lighting choice.
 */
export function parseThemeChoice(value: unknown): ThemeChoice | null {
  const direct = parseAppearanceMode(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return parseAppearanceMode((value as Record<string, unknown>)['mode']);
}

export function parseResolvedTheme(value: unknown): ResolvedTheme | null {
  return typeof value === 'string' && (resolvedThemes as readonly string[]).includes(value)
    ? (value as ResolvedTheme)
    : null;
}

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

export function sameThemeChoice(a: ThemeChoice, b: ThemeChoice): boolean {
  return a === b;
}

export function appearanceOf(theme: ResolvedTheme): 'light' | 'dark' {
  return theme;
}
