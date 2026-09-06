import { describe, expect, it } from 'vitest';
import {
  applicationIconChoices,
  applicationIconArtworkFileName,
  applicationIconFileName,
  automaticApplicationIcon,
  parseApplicationIconId,
} from './application-icons';

describe('application icon choices', () => {
  it('keeps the current light and dark icons ahead of the five supplied artworks', () => {
    expect(applicationIconChoices.map(({ id }) => id)).toEqual([
      'light',
      'dark',
      'calm',
      'ludicrous-speed',
      'homage',
      'builder',
      'quiet',
    ]);
  });

  it('validates renderer-controlled identifiers before resolving a resource', () => {
    expect(parseApplicationIconId('ludicrous-speed')).toBe('ludicrous-speed');
    expect(parseApplicationIconId('../icon.png')).toBeNull();
    expect(parseApplicationIconId({ id: 'ludicrous-speed' })).toBeNull();
    // A choice retired in an earlier release is still on disk in somebody's
    // preference file; it has to degrade to the automatic icon, not resolve.
    expect(parseApplicationIconId('ruby')).toBeNull();
    for (const retired of ['grass-court', 'clay-court', 'hard-court', 'ball-felt', 'night-match']) {
      expect(parseApplicationIconId(retired)).toBeNull();
    }
    expect(applicationIconFileName('quiet')).toBe('quiet.icns');
    expect(applicationIconArtworkFileName('quiet')).toBe('quiet.png');
  });

  it('uses the current icon that matches the system appearance by default', () => {
    expect(automaticApplicationIcon(false)).toBe('light');
    expect(automaticApplicationIcon(true)).toBe('dark');
  });
});
