import { describe, expect, it } from 'vitest';
import {
  applicationIconChoices,
  applicationIconArtworkFileName,
  applicationIconFileName,
  automaticApplicationIcon,
  parseApplicationIconId,
} from './application-icons';

describe('application icon choices', () => {
  it('keeps the current light and dark icons ahead of the six custom choices', () => {
    expect(applicationIconChoices.map(({ id }) => id)).toEqual([
      'light',
      'dark',
      'sunset-sherbet',
      'ludicrous-speed',
      'ruby',
      'holographic',
      'leather',
      'blueprint',
    ]);
  });

  it('validates renderer-controlled identifiers before resolving a resource', () => {
    expect(parseApplicationIconId('ruby')).toBe('ruby');
    expect(parseApplicationIconId('../icon.png')).toBeNull();
    expect(parseApplicationIconId({ id: 'ruby' })).toBeNull();
    expect(applicationIconFileName('holographic')).toBe('holographic.icns');
    expect(applicationIconArtworkFileName('holographic')).toBe('holographic.png');
  });

  it('uses the current icon that matches the system appearance by default', () => {
    expect(automaticApplicationIcon(false)).toBe('light');
    expect(automaticApplicationIcon(true)).toBe('dark');
  });
});
