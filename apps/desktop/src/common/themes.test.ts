import { describe, expect, it } from 'vitest';

import {
  appearanceModeDescriptions,
  appearanceModes,
  appearanceOf,
  defaultThemeChoice,
  parseResolvedTheme,
  parseThemeChoice,
  resolveTheme,
  resolvedThemes,
  sameThemeChoice,
  themeWindowBackground,
} from './themes';

describe('Rally appearances', () => {
  it('offers one system preference and two resolved appearances', () => {
    expect(appearanceModeDescriptions.map((mode) => mode.id)).toEqual([...appearanceModes]);
    expect(defaultThemeChoice).toBe('system');
    expect(resolvedThemes).toEqual(['light', 'dark']);
    expect(Object.keys(themeWindowBackground).sort()).toEqual(['dark', 'light']);
  });

  it('follows the Mac only in system mode', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('uses each resolved appearance as its canvas mode', () => {
    expect(appearanceOf('light')).toBe('light');
    expect(appearanceOf('dark')).toBe('dark');
  });

  it('keeps system distinct from pinned dark even when both resolve dark', () => {
    expect(resolveTheme('system', true)).toBe(resolveTheme('dark', true));
    expect(sameThemeChoice('system', 'dark')).toBe(false);
    expect(sameThemeChoice('dark', 'dark')).toBe(true);
  });
});

describe('appearance parsing', () => {
  it.each(appearanceModes)('accepts %s', (mode) => {
    expect(parseThemeChoice(mode)).toBe(mode);
  });

  it.each([
    [{ family: 'retired', mode: 'system' }, 'system'],
    [{ family: 'retired', mode: 'light' }, 'light'],
    [{ family: 'anything', mode: 'dark' }, 'dark'],
  ] as const)('migrates the previous family-shaped choice %p', (stored, expected) => {
    expect(parseThemeChoice(stored)).toBe(expected);
  });

  it.each([
    ['sepia'], [''], [null], [undefined], [7], [{}], [[]],
    [{ family: 'retired' }], [{ mode: 'sideways' }],
  ])('rejects %p', (value) => {
    expect(parseThemeChoice(value)).toBeNull();
  });

  it('accepts only concrete appearances as resolved', () => {
    expect(parseResolvedTheme('system')).toBeNull();
    expect(parseResolvedTheme('light')).toBe('light');
    expect(parseResolvedTheme('dark')).toBe('dark');
  });
});
