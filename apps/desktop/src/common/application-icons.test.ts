import { describe, expect, it } from 'vitest';
import {
  applicationIconChoices,
  applicationIconArtworkFileName,
  applicationIconFileName,
  automaticApplicationIcon,
  parseApplicationIconId,
} from './application-icons';

describe('application icon choices', () => {
  it('keeps the current light and dark icons ahead of the five textured choices', () => {
    expect(applicationIconChoices.map(({ id }) => id)).toEqual([
      'light',
      'dark',
      'grass-court',
      'clay-court',
      'hard-court',
      'ball-felt',
      'night-match',
    ]);
  });

  it('validates renderer-controlled identifiers before resolving a resource', () => {
    expect(parseApplicationIconId('clay-court')).toBe('clay-court');
    expect(parseApplicationIconId('../icon.png')).toBeNull();
    expect(parseApplicationIconId({ id: 'clay-court' })).toBeNull();
    // A choice retired in an earlier release is still on disk in somebody's
    // preference file; it has to degrade to the automatic icon, not resolve.
    expect(parseApplicationIconId('ruby')).toBeNull();
    expect(applicationIconFileName('night-match')).toBe('night-match.icns');
    expect(applicationIconArtworkFileName('night-match')).toBe('night-match.png');
  });

  it('uses the current icon that matches the system appearance by default', () => {
    expect(automaticApplicationIcon(false)).toBe('light');
    expect(automaticApplicationIcon(true)).toBe('dark');
  });
});
