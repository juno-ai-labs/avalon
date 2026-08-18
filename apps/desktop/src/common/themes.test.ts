import { describe, expect, it } from 'vitest';

import {
  defaultThemeChoice,
  parseResolvedTheme,
  parseThemeChoice,
  resolveTheme,
  resolvedThemes,
  themeChoices,
  themeDescriptions,
  themeWindowBackground,
} from './themes';

describe('theme choices', () => {
  it('offers a description for every choice, in the order they are listed', () => {
    expect(themeDescriptions.map((theme) => theme.id)).toEqual([...themeChoices]);
  });

  it('starts on the system appearance', () => {
    expect(defaultThemeChoice).toBe('system');
  });

  it('names a window background for every theme that can actually be drawn', () => {
    expect(Object.keys(themeWindowBackground).sort()).toEqual([...resolvedThemes].sort());
  });
});

describe('resolveTheme', () => {
  it.each([[true, 'dark'], [false, 'light']] as const)(
    'follows the Mac when the choice is system and dark is %s',
    (prefersDark, expected) => {
      expect(resolveTheme('system', prefersDark)).toBe(expected);
    },
  );

  /**
   * The point of choosing a theme is that it is not the Mac's. A build that
   * "helpfully" switched a person out of Airy at sunset would be doing the one
   * thing they said they did not want.
   */
  it.each([['light'], ['dark'], ['airy']] as const)('honours %s whatever the Mac is set to', (choice) => {
    expect(resolveTheme(choice, true)).toBe(choice);
    expect(resolveTheme(choice, false)).toBe(choice);
  });
});

describe('parsing', () => {
  it('accepts every choice it offers', () => {
    for (const choice of themeChoices) expect(parseThemeChoice(choice)).toBe(choice);
  });

  it.each([['System'], ['sepia'], [''], [null], [undefined], [7], [{}]])('rejects %p', (value) => {
    expect(parseThemeChoice(value)).toBeNull();
  });

  // `system` is a rule rather than an appearance, so it is never a value the
  // main process can paint a window with.
  it('does not accept system as something that has been resolved', () => {
    expect(parseResolvedTheme('system')).toBeNull();
    for (const theme of resolvedThemes) expect(parseResolvedTheme(theme)).toBe(theme);
  });
});
