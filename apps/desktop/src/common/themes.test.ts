import { describe, expect, it } from 'vitest';

import {
  appearanceModeDescriptions,
  appearanceModes,
  appearanceOf,
  defaultThemeChoice,
  familyAppearances,
  familyOf,
  parseResolvedTheme,
  parseThemeChoice,
  resolveTheme,
  resolvedThemes,
  sameThemeChoice,
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
    expect(defaultThemeChoice).toEqual({ family: 'terra', mode: 'system' });
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

  /**
   * The half of its family each appearance is. A canvas cannot name a token,
   * so it has to be handed this instead; an appearance that answered with the
   * wrong half would paint pale ink on a pale ground, which is the defect this
   * answers.
   */
  it('names the half of its family every appearance is', () => {
    for (const family of themeFamilies) {
      expect(appearanceOf(familyAppearances[family].light)).toBe('light');
      expect(appearanceOf(familyAppearances[family].dark)).toBe('dark');
    }
  });

  it('names a window background for every appearance that can actually be drawn', () => {
    expect(Object.keys(themeWindowBackground).sort()).toEqual([...resolvedThemes].sort());
  });
});

describe('resolveTheme', () => {
  it.each([
    ['terra', true, 'terra'], ['terra', false, 'terra-light'],
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
    ['terra', 'light', 'terra-light'], ['terra', 'dark', 'terra'],
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

describe('what the main process builds a window from', () => {
  /**
   * The composition `windowBackgroundColor` performs: a stored *choice* plus
   * whatever the Mac says right now. Storing the resolved appearance instead
   * meant a Mac that changed overnight opened the first window of the next
   * launch in yesterday's colour and corrected itself once the renderer ran —
   * the flash the stored value exists to prevent.
   */
  it('gives one stored choice two different backgrounds as the Mac changes', () => {
    const choice = { family: 'terra', mode: 'system' } as const;

    expect(themeWindowBackground[resolveTheme(choice, false)]).toBe('#ffffff');
    expect(themeWindowBackground[resolveTheme(choice, true)]).toBe('#111210');
  });

  it('gives a pinned choice the same background whatever the Mac says', () => {
    const choice = { family: 'air', mode: 'dark' } as const;

    expect(themeWindowBackground[resolveTheme(choice, false)]).toBe('#100e0c');
    expect(themeWindowBackground[resolveTheme(choice, true)]).toBe('#100e0c');
  });

  /**
   * Why the relay compares choices rather than appearances. Under a dark Mac
   * these two draw the same thing, so an appearance-level comparison reports no
   * change and every other window goes on believing it follows the room.
   */
  it('separates two choices that resolve to the same appearance', () => {
    const following = { family: 'terra', mode: 'system' } as const;
    const pinned = { family: 'terra', mode: 'dark' } as const;

    expect(resolveTheme(following, true)).toBe(resolveTheme(pinned, true));
    expect(sameThemeChoice(following, pinned)).toBe(false);
  });

  it('treats a choice as the same as itself, on both axes', () => {
    expect(sameThemeChoice({ family: 'air', mode: 'light' }, { family: 'air', mode: 'light' })).toBe(true);
    expect(sameThemeChoice({ family: 'air', mode: 'light' }, { family: 'terra', mode: 'light' })).toBe(false);
    expect(sameThemeChoice({ family: 'air', mode: 'light' }, { family: 'air', mode: 'system' })).toBe(false);
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
    ['system', { family: 'terra', mode: 'system' }],
    ['light', { family: 'terra', mode: 'light' }],
    ['dark', { family: 'terra', mode: 'dark' }],
    ['airy', { family: 'air', mode: 'light' }],
    ['airy-dark', { family: 'air', mode: 'dark' }],
  ] as const)('migrates the flat choice %s', (legacy, expected) => {
    expect(parseThemeChoice(legacy)).toEqual(expected);
  });

  /**
   * A family that has been renamed. `neu` was this design's name for one commit
   * before it became Terra; a rename is not a reason to hand somebody a
   * different design, so the old name still resolves.
   */
  it('migrates a renamed family', () => {
    expect(parseThemeChoice({ family: 'neu', mode: 'dark' })).toEqual({ family: 'terra', mode: 'dark' });
    expect(parseThemeChoice({ family: 'neu', mode: 'system' })).toEqual({ family: 'terra', mode: 'system' });
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
