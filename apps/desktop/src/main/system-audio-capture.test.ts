import { describe, expect, it, vi } from 'vitest';
import {
  configureSystemAudioCapture,
  MACOS_CORE_AUDIO_CAPTURE_FEATURE,
  MACOS_SCREEN_CAPTURE_AUDIO_FEATURE,
} from './system-audio-capture';

function commandLine(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    appendSwitch: vi.fn((name: string, value: string) => { values[name] = value; }),
    getSwitchValue: vi.fn((name: string) => values[name] ?? ''),
    values,
  };
}

describe('system audio capture configuration', () => {
  it('forces the ScreenCaptureKit loopback path on macOS', () => {
    const target = commandLine();

    configureSystemAudioCapture(target, 'darwin');

    expect(target.values['enable-features']).toBe(MACOS_SCREEN_CAPTURE_AUDIO_FEATURE);
    expect(target.values['disable-features']).toBe(MACOS_CORE_AUDIO_CAPTURE_FEATURE);
  });

  it('preserves existing Chromium feature switches without duplicating values', () => {
    const target = commandLine({
      'disable-features': `ExistingDisabled,${MACOS_CORE_AUDIO_CAPTURE_FEATURE}`,
      'enable-features': `ExistingEnabled,${MACOS_SCREEN_CAPTURE_AUDIO_FEATURE}`,
    });

    configureSystemAudioCapture(target, 'darwin');

    expect(target.values['enable-features']).toBe(`ExistingEnabled,${MACOS_SCREEN_CAPTURE_AUDIO_FEATURE}`);
    expect(target.values['disable-features']).toBe(`ExistingDisabled,${MACOS_CORE_AUDIO_CAPTURE_FEATURE}`);
  });

  it('does not change feature switches on other platforms', () => {
    const target = commandLine();

    configureSystemAudioCapture(target, 'win32');

    expect(target.appendSwitch).not.toHaveBeenCalled();
  });
});
