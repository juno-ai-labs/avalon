import { describe, expect, it } from 'vitest';
import {
  allowsTrustedAudioCapture,
  allowsTrustedDisplayCapturePermission,
  allowsTrustedMeetingDisplayCapture,
} from './media-permission';

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

  it('allows system audio only in a trusted top-level meeting renderer', () => {
    const request = {
      audioRequested: true,
      isMainFrame: true,
      isMeetingWindow: true,
      trustedRenderer: true,
      videoRequested: true,
    };
    expect(allowsTrustedMeetingDisplayCapture(request)).toBe(true);
    expect(allowsTrustedMeetingDisplayCapture({ ...request, isMeetingWindow: false })).toBe(false);
    expect(allowsTrustedMeetingDisplayCapture({ ...request, isMainFrame: false })).toBe(false);
    expect(allowsTrustedMeetingDisplayCapture({ ...request, trustedRenderer: false })).toBe(false);
    expect(allowsTrustedMeetingDisplayCapture({ ...request, audioRequested: false })).toBe(false);
    expect(allowsTrustedMeetingDisplayCapture({ ...request, videoRequested: false })).toBe(false);
  });

  it('limits the browser display-capture permission to meeting windows', () => {
    expect(allowsTrustedDisplayCapturePermission({
      isMeetingWindow: true,
      permission: 'display-capture',
      trustedRenderer: true,
    })).toBe(true);
    expect(allowsTrustedDisplayCapturePermission({
      isMeetingWindow: false,
      permission: 'display-capture',
      trustedRenderer: true,
    })).toBe(false);
    expect(allowsTrustedDisplayCapturePermission({
      isMeetingWindow: true,
      permission: 'media',
      trustedRenderer: true,
    })).toBe(false);
  });
});
