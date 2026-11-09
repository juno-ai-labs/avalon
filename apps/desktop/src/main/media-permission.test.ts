import { describe, expect, it } from 'vitest';
import { allowsTrustedAudioCapture } from './media-permission';

describe('desktop media permission policy', () => {
  const main = { window: 'main' };
  const settings = { window: 'settings' };

  function grant(
    overrides: Partial<Parameters<typeof allowsTrustedAudioCapture>[0]> = {},
  ): boolean {
    return allowsTrustedAudioCapture({
      mainWindowContents: main,
      mediaTypes: ['audio'],
      permission: 'media',
      requestingContents: main,
      trustedRenderer: true,
      ...overrides,
    });
  }

  it('allows audio capture from the main window', () => {
    expect(grant({ requestingContents: main })).toBe(true);
  });

  it('refuses other Rally windows, missing contents, video, and untrusted origins', () => {
    expect(grant({ requestingContents: settings })).toBe(false);
    expect(grant({ requestingContents: null })).toBe(false);
    expect(grant({
      mainWindowContents: undefined,
      requestingContents: undefined,
    })).toBe(false);
    expect(grant({ mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(grant({ mediaTypes: [] })).toBe(false);
    expect(grant({ permission: 'display-capture' })).toBe(false);
    expect(grant({ trustedRenderer: false })).toBe(false);
  });
});
