import type {
  DesktopMediaPermissionStatus,
  DesktopMeetingAudioPermissions,
  MeetingAudioPermissionKind,
} from '../common/desktop';

interface MeetingAudioPermissionDependencies {
  askForMicrophoneAccess: () => Promise<boolean>;
  getMediaAccessStatus: (permission: 'microphone' | 'screen') => string;
  platform: NodeJS.Platform;
  requestSystemAudioAccess: () => Promise<void>;
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
  permission: 'microphone' | 'screen',
): DesktopMediaPermissionStatus {
  try {
    const status = dependencies.getMediaAccessStatus(permission) as DesktopMediaPermissionStatus;
    return MEDIA_PERMISSION_STATUSES.has(status) ? status : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function meetingAudioPermissions(
  dependencies: MeetingAudioPermissionDependencies,
): DesktopMeetingAudioPermissions {
  return {
    microphone: permissionStatus(dependencies, 'microphone'),
    systemAudio: permissionStatus(dependencies, 'screen'),
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
  if (dependencies.platform === 'darwin' && initial.systemAudio === 'not-determined') {
    try {
      // Electron has no askForMediaAccess('screen'). Enumerating the source is
      // the supported ScreenCaptureKit operation that presents macOS's native
      // Screen & System Audio Recording prompt for the signed Avalon bundle.
      await dependencies.requestSystemAudioAccess();
    } catch {
      // Denial is reflected by getMediaAccessStatus and handled in the UI.
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
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
}
