import { describe, expect, it } from 'vitest';
import { allowsTrustedAudioCapture } from './media-permission';

describe('desktop media permission policy', () => {
  const main = { window: 'main' };
  const sidekicks = { window: 'sidekicks' };
  const settings = { window: 'settings' };

  function grant(
    overrides: Partial<Parameters<typeof allowsTrustedAudioCapture>[0]> = {},
  ): boolean {
    return allowsTrustedAudioCapture({
      mainWindowContents: main,
      mediaTypes: ['audio'],
      permission: 'media',
      requestingContents: main,
      sidekicksWindowContents: sidekicks,
      trustedRenderer: true,
      ...overrides,
    });
  }

  it('allows audio capture from the main window and the Sidekicks window', () => {
    expect(grant({ requestingContents: main })).toBe(true);
    expect(grant({ requestingContents: sidekicks })).toBe(true);
  });

  it('allows Sidekicks capture after the main window has closed', () => {
    expect(grant({
      mainWindowContents: undefined,
      requestingContents: sidekicks,
    })).toBe(true);
  });

  it('refuses other Rally windows, missing contents, video, and untrusted origins', () => {
    expect(grant({ requestingContents: settings })).toBe(false);
    expect(grant({ requestingContents: null })).toBe(false);
    expect(grant({
      mainWindowContents: undefined,
      requestingContents: undefined,
      sidekicksWindowContents: undefined,
    })).toBe(false);
    expect(grant({ mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(grant({ mediaTypes: [] })).toBe(false);
    expect(grant({ permission: 'display-capture' })).toBe(false);
    expect(grant({ trustedRenderer: false })).toBe(false);
  });
});
