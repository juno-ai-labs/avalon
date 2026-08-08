import { describe, expect, it, vi } from 'vitest';
import {
  meetingAudioPermissions,
  meetingAudioSettingsUrl,
  prepareMeetingAudioPermissions,
} from './meeting-audio-permission';

function permissionDependencies(
  statuses: { microphone: string; screen: string },
  platform: NodeJS.Platform = 'darwin',
) {
  return {
    askForMicrophoneAccess: vi.fn(async () => {
      statuses.microphone = 'granted';
      return true;
    }),
    getMediaAccessStatus: vi.fn((permission: 'microphone' | 'screen') => statuses[permission]),
    platform,
    requestSystemAudioAccess: vi.fn(async () => {
      statuses.screen = 'granted';
    }),
  };
}

describe('meeting audio permissions', () => {
  it('asks for undecided microphone and system-audio access once', async () => {
    const dependencies = permissionDependencies({ microphone: 'not-determined', screen: 'not-determined' });

    await expect(prepareMeetingAudioPermissions(dependencies)).resolves.toEqual({
      microphone: 'granted',
      systemAudio: 'granted',
    });
    expect(dependencies.askForMicrophoneAccess).toHaveBeenCalledOnce();
    expect(dependencies.requestSystemAudioAccess).toHaveBeenCalledOnce();
  });

  it('does not re-prompt for permissions macOS already decided', async () => {
    const dependencies = permissionDependencies({ microphone: 'denied', screen: 'granted' });

    await expect(prepareMeetingAudioPermissions(dependencies)).resolves.toEqual({
      microphone: 'denied',
      systemAudio: 'granted',
    });
    expect(dependencies.askForMicrophoneAccess).not.toHaveBeenCalled();
    expect(dependencies.requestSystemAudioAccess).not.toHaveBeenCalled();
  });

  it('does not enumerate a screen source for permission on other platforms', async () => {
    const dependencies = permissionDependencies(
      { microphone: 'granted', screen: 'not-determined' },
      'win32',
    );

    await prepareMeetingAudioPermissions(dependencies);
    expect(dependencies.requestSystemAudioAccess).not.toHaveBeenCalled();
  });

  it('normalizes unrecognized or unavailable platform statuses', () => {
    const dependencies = permissionDependencies({ microphone: 'surprise', screen: 'granted' });
    dependencies.getMediaAccessStatus.mockImplementation((permission) => {
      if (permission === 'microphone') throw new Error('unsupported');
      return 'surprise';
    });
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
