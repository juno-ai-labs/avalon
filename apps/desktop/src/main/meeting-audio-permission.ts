import type {
  DesktopMediaPermissionStatus,
  DesktopMeetingAudioPermissions,
  MeetingAudioPermissionKind,
} from '../common/desktop';

interface MeetingAudioPermissionDependencies {
  askForMicrophoneAccess: () => Promise<boolean>;
  getMicrophoneAccessStatus: () => string;
}

const MEDIA_PERMISSION_STATUSES = new Set<DesktopMediaPermissionStatus>([
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown',
]);

function permissionStatus(
  dependencies: MeetingAudioPermissionDependencies,
): DesktopMediaPermissionStatus {
  try {
    const status = dependencies.getMicrophoneAccessStatus() as DesktopMediaPermissionStatus;
    return MEDIA_PERMISSION_STATUSES.has(status) ? status : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function meetingAudioPermissions(
  dependencies: MeetingAudioPermissionDependencies,
): DesktopMeetingAudioPermissions {
  return {
    microphone: permissionStatus(dependencies),
    // Core Audio exposes no permission preflight API. AudioDeviceStart is the
    // permission request and its first successful IO callback is the grant.
    systemAudio: 'unknown',
  };
}

export async function prepareMeetingAudioPermissions(
  dependencies: MeetingAudioPermissionDependencies,
): Promise<DesktopMeetingAudioPermissions> {
  const initial = meetingAudioPermissions(dependencies);
  if (initial.microphone === 'not-determined') {
    try {
      await dependencies.askForMicrophoneAccess();
    } catch {
      // The refreshed status below remains authoritative. The live capture
      // path will surface any platform-specific error if macOS did not decide.
    }
  }
  return meetingAudioPermissions(dependencies);
}

export function meetingAudioSettingsUrl(
  permission: MeetingAudioPermissionKind,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'darwin') return undefined;
  return permission === 'microphone'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    // macOS presents Screen Recording and System Audio Recording Only in one
    // privacy pane even though Rally's Core Audio tap never requests screen.
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
}
