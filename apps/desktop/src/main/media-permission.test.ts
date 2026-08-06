import { describe, expect, it } from 'vitest';
import { allowsTrustedAudioCapture } from './media-permission';

describe('desktop media permission policy', () => {
  it('allows only audio capture from the trusted primary renderer', () => {
    expect(allowsTrustedAudioCapture({
      isMainWindow: true,
      mediaTypes: ['audio'],
      permission: 'media',
      trustedRenderer: true,
    })).toBe(true);
    expect(allowsTrustedAudioCapture({
      isMainWindow: true,
      mediaTypes: ['audio', 'video'],
      permission: 'media',
      trustedRenderer: true,
    })).toBe(false);
    expect(allowsTrustedAudioCapture({
      isMainWindow: false,
      mediaTypes: ['audio'],
      permission: 'media',
      trustedRenderer: true,
    })).toBe(false);
    expect(allowsTrustedAudioCapture({
      isMainWindow: true,
      mediaTypes: ['audio'],
      permission: 'media',
      trustedRenderer: false,
    })).toBe(false);
  });
});
