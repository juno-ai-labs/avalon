import { describe, expect, it } from 'vitest';

import {
  appearanceModeDescriptions,
  appearanceModes,
  defaultThemeChoice,
  familyAppearances,
  familyOf,
  parseResolvedTheme,
  parseThemeChoice,
  resolveTheme,
  resolvedThemes,
  themeFamilies,
  themeFamilyDescriptions,
  themeWindowBackground,
} from './themes';

describe('the two axes', () => {
  it('describes every family and every mode, in the order they are offered', () => {
    expect(themeFamilyDescriptions.map((family) => family.id)).toEqual([...themeFamilies]);
    expect(appearanceModeDescriptions.map((mode) => mode.id)).toEqual([...appearanceModes]);
  });

  it('starts on the original design, following the Mac', () => {
    expect(defaultThemeChoice).toEqual({ family: 'neu', mode: 'system' });
  });

  /**
   * Every family brings both appearances, and no appearance belongs to two
   * families. A family missing one half is a family the mode row cannot
   * switch — the row would be there and one of its positions would do nothing.
   */
  it('gives every family a light and a dark appearance, and every appearance one family', () => {
    const claimed = themeFamilies.flatMap((family) => [
      familyAppearances[family].light,
      familyAppearances[family].dark,
    ]);

    expect(claimed.sort()).toEqual([...resolvedThemes].sort());
    expect(new Set(claimed).size).toBe(claimed.length);
    for (const theme of resolvedThemes) {
      expect(familyAppearances[familyOf(theme)]).toEqual(
        expect.objectContaining({ [theme === familyAppearances[familyOf(theme)].light ? 'light' : 'dark']: theme }),
      );
    }
  });

  it('names a window background for every appearance that can actually be drawn', () => {
    expect(Object.keys(themeWindowBackground).sort()).toEqual([...resolvedThemes].sort());
  });
});

describe('resolveTheme', () => {
  it.each([
    ['neu', true, 'neu'], ['neu', false, 'neu-light'],
    ['air', true, 'air-dark'], ['air', false, 'air'],
  ] as const)('follows the Mac within %s when dark is %s', (family, prefersDark, expected) => {
    expect(resolveTheme({ family, mode: 'system' }, prefersDark)).toBe(expected);
  });

  /**
   * The mode is honoured whatever the Mac says — that is the point of setting
   * it — and the *family* never follows the Mac at all. A build that switched
   * someone out of Air at sunset would be doing the one thing they did not ask
   * for, and it is the failure the flat list made easy.
   */
  it.each([
    ['neu', 'light', 'neu-light'], ['neu', 'dark', 'neu'],
    ['air', 'light', 'air'], ['air', 'dark', 'air-dark'],
  ] as const)('pins %s in %s mode whatever the Mac is set to', (family, mode, expected) => {
    expect(resolveTheme({ family, mode }, true)).toBe(expected);
    expect(resolveTheme({ family, mode }, false)).toBe(expected);
  });

  it('keeps the family when the mode changes and the mode when the family changes', () => {
    expect(resolveTheme({ family: 'air', mode: 'light' }, true)).toBe('air');
    expect(resolveTheme({ family: 'air', mode: 'dark' }, false)).toBe('air-dark');
  });
});

describe('parsing', () => {
  it('accepts every combination it offers', () => {
    for (const family of themeFamilies) {
      for (const mode of appearanceModes) {
        expect(parseThemeChoice({ family, mode })).toEqual({ family, mode });
      }
    }
  });

  /**
   * A stored preference outlives the shape it was written in. Someone who had
   * chosen the design when it was called `airy`, before the axes were
   * separated, should still be on Air after — not silently handed the default
   * design by a rename and a refactor.
   */
  it.each([
    ['system', { family: 'neu', mode: 'system' }],
    ['light', { family: 'neu', mode: 'light' }],
    ['dark', { family: 'neu', mode: 'dark' }],
    ['airy', { family: 'air', mode: 'light' }],
    ['airy-dark', { family: 'air', mode: 'dark' }],
  ] as const)('migrates the flat choice %s', (legacy, expected) => {
    expect(parseThemeChoice(legacy)).toEqual(expected);
  });

  it.each([
    ['sepia'], [''], [null], [undefined], [7], [{}], [[]],
    ['air'], ['air-dark'],
    [{ family: 'air' }], [{ mode: 'dark' }],
    [{ family: 'sepia', mode: 'dark' }], [{ family: 'air', mode: 'sideways' }],
  ])('rejects %p', (value) => {
    expect(parseThemeChoice(value)).toBeNull();
  });

  // `system` is a rule rather than an appearance, so it is never a value the
  // main process can paint a window with.
  it('does not accept a mode as something that has been resolved', () => {
    for (const mode of appearanceModes) expect(parseResolvedTheme(mode)).toBeNull();
    for (const theme of resolvedThemes) expect(parseResolvedTheme(theme)).toBe(theme);
  });
});
