import { describe, expect, it } from 'vitest';
import { allowsTrustedAudioCapture } from './media-permission';

describe('desktop media permission policy', () => {
  it('allows only audio capture from a trusted recording renderer', () => {
    expect(allowsTrustedAudioCapture({
      isAudioCaptureWindow: true,
      mediaTypes: ['audio'],
      permission: 'media',
      trustedRenderer: true,
    })).toBe(true);
    expect(allowsTrustedAudioCapture({
      isAudioCaptureWindow: true,
      mediaTypes: ['audio', 'video'],
      permission: 'media',
      trustedRenderer: true,
    })).toBe(false);
    expect(allowsTrustedAudioCapture({
      isAudioCaptureWindow: false,
      mediaTypes: ['audio'],
      permission: 'media',
      trustedRenderer: true,
    })).toBe(false);
    expect(allowsTrustedAudioCapture({
      isAudioCaptureWindow: true,
      mediaTypes: ['audio'],
      permission: 'media',
      trustedRenderer: false,
    })).toBe(false);
  });

});
