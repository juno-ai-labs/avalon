import { describe, expect, it, vi } from 'vitest';
import {
  meetingAudioPermissions,
  meetingAudioSettingsUrl,
  prepareMeetingAudioPermissions,
} from './meeting-audio-permission';

function permissionDependencies(
  statuses: { microphone: string },
) {
  return {
    askForMicrophoneAccess: vi.fn(async () => {
      statuses.microphone = 'granted';
      return true;
    }),
    getMicrophoneAccessStatus: vi.fn(() => statuses.microphone),
  };
}

describe('meeting audio permissions', () => {
  it('asks for undecided microphone access and leaves Core Audio consent to capture start', async () => {
    const dependencies = permissionDependencies({ microphone: 'not-determined' });

    await expect(prepareMeetingAudioPermissions(dependencies)).resolves.toEqual({
      microphone: 'granted',
      systemAudio: 'unknown',
    });
    expect(dependencies.askForMicrophoneAccess).toHaveBeenCalledOnce();
  });

  it('does not re-prompt for permissions macOS already decided', async () => {
    const dependencies = permissionDependencies({ microphone: 'denied' });

    await expect(prepareMeetingAudioPermissions(dependencies)).resolves.toEqual({
      microphone: 'denied',
      systemAudio: 'unknown',
    });
    expect(dependencies.askForMicrophoneAccess).not.toHaveBeenCalled();
  });

  it('normalizes unrecognized or unavailable platform statuses', () => {
    const dependencies = permissionDependencies({ microphone: 'surprise' });
    dependencies.getMicrophoneAccessStatus.mockImplementation(() => { throw new Error('unsupported'); });
    expect(meetingAudioPermissions(dependencies)).toEqual({
      microphone: 'unknown',
      systemAudio: 'unknown',
    });
  });

  it('opens only fixed macOS privacy panes', () => {
    expect(meetingAudioSettingsUrl('microphone', 'darwin')).toContain('Privacy_Microphone');
    expect(meetingAudioSettingsUrl('system-audio', 'darwin')).toContain('Privacy_ScreenCapture');
    expect(meetingAudioSettingsUrl('system-audio', 'linux')).toBeUndefined();
  });
});
