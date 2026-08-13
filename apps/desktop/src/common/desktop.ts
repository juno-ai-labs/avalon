import type { DesktopSettingsSection } from './settings';
import type { ApplicationIconId, DesktopApplicationIconState } from './application-icons';

export type AvalonRegion = 'global' | 'eu';

export interface RuntimeConfig {
  appVersion: string;
  isPackaged: boolean;
  platform: string;
  api: Record<AvalonRegion, string>;
  /** Public site origin. Canonical work-stream links are minted against it. */
  webBaseUrl: string;
  devAuthEnabled: boolean;
}

export interface DesktopSession {
  accessToken: string;
  expiresAt: string;
  apiBaseUrl: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl?: string;
    timezone?: string;
  };
  workspace: {
    id: string;
    name: string;
    region: AvalonRegion;
    role: 'owner' | 'admin' | 'member';
    timezone?: string;
  } | null;
}

export interface DesktopAuthAttempt {
  attemptId: string;
  codeChallenge: string;
}

export interface DesktopLockdownSettings {
  lockdownMode: boolean;
  lockdownAvailable: boolean;
}

export interface DesktopApplicationSettings extends DesktopLockdownSettings {
  /** The **effective** Developer → Debug enabled preference: the stored choice
   * and the service's flag. A device whose flag is off reads `false` here
   * however `application-settings.json` reads. */
  debugEnabled: boolean;
  /** Whether the service allows this account the Developer section at all.
   * Off until a poll says otherwise, and off again on sign-out. */
  developerSettingsAvailable: boolean;
  /** Whether the Avalon status item is in the macOS menu bar. On by default. */
  menuBarEnabled: boolean;
  /** Whether this platform has a menu bar Avalon can live in at all. The
   * preference is still stored where it is not, so moving the same profile to a
   * Mac restores the choice rather than the default. */
  menuBarAvailable: boolean;
  /** Whether a status item is actually in the menu bar. Creating one can fail,
   * and the preference says nothing about that — so this is what lets Settings
   * tell someone their choice did not take rather than showing a switch that is
   * on beside a menu bar that is empty. */
  menuBarPresent: boolean;
  /** Whether Avalon is registered to open at login. Read back from the
   * operating system, which owns it — not from Avalon's preference file — so
   * this reports what macOS actually holds, including a registration it is
   * still waiting for the person to approve. */
  launchAtLogin: boolean;
  /** Whether this platform has login items at all. */
  launchAtLoginAvailable: boolean;
  /** The account choice shown in Settings. */
  productAnalyticsEnabled: boolean;
  /** False on the browser fallback, which can display but cannot persist the
   * account preference. Older desktop bridges omit it and remain writable. */
  productAnalyticsAvailable?: boolean;
  /** Collection is off while an enable is awaiting server acknowledgement. */
  productAnalyticsEffective: boolean;
  /** A durable offline account mutation waiting to synchronize. */
  productAnalyticsPreferencePending: boolean;
  /** Stopping the already-running Crashpad handler requires the next launch. */
  nativeCrashRestartRequired: boolean;
}

export type DesktopTelemetryScreen =
  | 'onboarding_welcome'
  | 'onboarding_region'
  | 'onboarding_workspace'
  | 'workspace_home'
  | 'workstream'
  | 'application_settings'
  | 'developer_settings';

export type DesktopTelemetryProductIntent =
  | { kind: 'onboarding_region_selected'; selectedRegion: AvalonRegion; entrypoint: 'first_run' | 'settings' | 'invitation' }
  | { kind: 'workspace_create_requested'; selectedRegion: AvalonRegion; entrypoint: 'first_run' | 'settings'; operationId: string }
  | { kind: 'workspace_activation_requested'; selectedRegion: AvalonRegion; entrypoint: 'invitation' | 'workspace_switcher'; operationId: string }
  | { kind: 'workstream_create_requested'; entrypoint: 'composer'; operationId: string }
  | { kind: 'run_requested'; entrypoint: 'composer'; operationId: string }
  | { kind: 'connector_setup_requested'; connector: 'github' | 'google' | 'linear' | 'notion' | 'slack'; operationId: string };

export interface DesktopTelemetryInspectorEntry {
  name: string;
  schemaVersion: number;
  policyClass: 'essential' | 'product' | 'diagnostic';
  propertyNames: string[];
  route: AvalonRegion;
  validation: 'accepted' | 'suppressed' | 'rejected' | 'delivered' | 'retrying' | 'terminal';
  queueState: 'none' | 'queued' | 'delivered' | 'retrying' | 'removed';
}

export interface DesktopJavascriptErrorCandidate {
  process: 'preload' | 'renderer';
  errorCode: 'type_error' | 'range_error' | 'unhandled_rejection' | 'react_boundary' | 'network_error' | 'unknown';
  frames: string[];
}

export interface DesktopWorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  region: AvalonRegion;
  role: 'owner' | 'admin' | 'member';
  createdAt: string;
}

export interface DesktopPendingWorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  region: AvalonRegion;
  email: string;
  role: 'admin' | 'member';
  invitedByName: string;
  expiresAt: string;
}

export interface DesktopWorkspaceOnboardingState {
  workspace: DesktopWorkspaceSummary | null;
  invitations: DesktopPendingWorkspaceInvitation[];
}

export type DesktopMediaPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export type MeetingAudioPermissionKind = 'microphone' | 'system-audio';

/**
 * Who asked a meeting window to close, which decides whether the recording
 * screen may stop and ask first.
 *
 * `user` is a close the person performed on that window — its traffic light or
 * Command-W — and a recording in progress is worth a confirmation, because the
 * window is the only place the meeting exists until finalization lands.
 * `quit` is the application shutting down, where a window that stops to ask is
 * a window that refuses to close, and a quit vetoed that way leaves Avalon
 * running with no way to finish. That path finalizes and closes as it always
 * has.
 */
export type MeetingCloseReason = 'user' | 'quit';

export interface DesktopMeetingAudioPermissions {
  microphone: DesktopMediaPermissionStatus;
  systemAudio: DesktopMediaPermissionStatus;
}

export interface DesktopSystemAudioCaptureInfo {
  channels: 1;
  sampleRate: number;
}

export interface AvalonDesktopBridge {
  getRuntimeConfig: () => Promise<RuntimeConfig>;
  getApplicationSettings: () => Promise<DesktopApplicationSettings>;
  setLockdownMode: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setDebugEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setMenuBarEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setLaunchAtLogin: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setProductAnalyticsEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  reportTelemetryScreen: (screen: DesktopTelemetryScreen) => Promise<void>;
  reportTelemetryProductIntent: (intent: DesktopTelemetryProductIntent) => Promise<void>;
  getTelemetryInspector: () => Promise<DesktopTelemetryInspectorEntry[]>;
  reportJavascriptError: (candidate: DesktopJavascriptErrorCandidate) => Promise<void>;
  onApplicationSettingsChanged: (listener: (settings: DesktopApplicationSettings) => void) => () => void;
  getApplicationIcon: () => Promise<DesktopApplicationIconState>;
  setApplicationIcon: (iconId: ApplicationIconId) => Promise<DesktopApplicationIconState>;
  resetApplicationIcon: () => Promise<DesktopApplicationIconState>;
  onApplicationIconChanged: (listener: (state: DesktopApplicationIconState) => void) => () => void;
  getSession: () => Promise<DesktopSession | null>;
  createDesktopAuthAttempt: (input: { apiBaseUrl: string; region: AvalonRegion }) => Promise<DesktopAuthAttempt>;
  cancelDesktopAuthAttempt: (attemptId: string) => Promise<void>;
  exchangeDesktopTicket: (input: {
    apiBaseUrl: string;
    region: AvalonRegion;
    ticket: string;
    attemptId: string;
  }) => Promise<DesktopSession>;
  createDevelopmentSession: (apiBaseUrl: string, workspaceName: string) => Promise<DesktopSession>;
  getOnboardingState: () => Promise<DesktopWorkspaceOnboardingState>;
  activateWorkspace: (input: { region: AvalonRegion; workspaceId: string; operationId?: string }) => Promise<DesktopSession>;
  createWorkspace: (input: { region: AvalonRegion; name: string; operationId?: string }) => Promise<DesktopSession>;
  acceptInvitation: (input: { region: AvalonRegion; invitationId: string; operationId?: string }) => Promise<DesktopSession>;
  declineInvitation: (input: { region: AvalonRegion; invitationId: string }) => Promise<void>;
  refreshSession: () => Promise<DesktopSession>;
  /** Pure read of whether a durable credential is still stored. Unlike
   * `getSession`, this never reaches the network, so it can answer "was the
   * credential surrendered?" without a refresh of its own failing the probe. */
  hasStoredCredential: () => Promise<boolean>;
  logout: () => Promise<void>;
  copyText: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openSettings: (section?: DesktopSettingsSection) => Promise<void>;
  openMeetingNotes: (noteId?: string) => Promise<void>;
  /**
   * Closes the meeting window. Given a note id, the main window is raised and
   * taken to that note on the way out — the meeting is over, and the note is
   * the thing the person is left with.
   */
  closeMeetingNotes: (noteId?: string) => Promise<void>;
  getMeetingAudioPermissions: () => Promise<DesktopMeetingAudioPermissions>;
  prepareMeetingAudioPermissions: () => Promise<DesktopMeetingAudioPermissions>;
  startMeetingSystemAudioCapture: () => Promise<DesktopSystemAudioCaptureInfo>;
  stopMeetingSystemAudioCapture: () => Promise<void>;
  onMeetingSystemAudioData: (listener: (data: ArrayBuffer, sampleRate: number) => void) => () => void;
  openMeetingAudioSettings: (permission: MeetingAudioPermissionKind) => Promise<void>;
  onMeetingCloseRequested: (listener: (reason: MeetingCloseReason) => void) => () => void;
  onSettingsSectionRequested: (listener: (section: DesktopSettingsSection) => void) => () => void;
  consumePendingDeepLinks: () => Promise<string[]>;
  onDeepLink: (listener: (url: string) => void) => () => void;
  onSessionChanged: (listener: (session: DesktopSession | null) => void) => () => void;
}
