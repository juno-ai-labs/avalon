import type { DesktopSettingsSection } from './settings';
import type { ApplicationIconId, DesktopApplicationIconState } from './application-icons';

export type AvalonRegion = 'global' | 'eu';

export interface RuntimeConfig {
  appVersion: string;
  isPackaged: boolean;
  platform: string;
  api: Record<AvalonRegion, string>;
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

export interface DesktopApplicationSettings {
  lockdownMode: boolean;
  lockdownAvailable: boolean;
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
  activateWorkspace: (input: { region: AvalonRegion; workspaceId: string }) => Promise<DesktopSession>;
  createWorkspace: (input: { region: AvalonRegion; name: string }) => Promise<DesktopSession>;
  acceptInvitation: (input: { region: AvalonRegion; invitationId: string }) => Promise<DesktopSession>;
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
  closeMeetingNotes: () => Promise<void>;
  getMeetingAudioPermissions: () => Promise<DesktopMeetingAudioPermissions>;
  prepareMeetingAudioPermissions: () => Promise<DesktopMeetingAudioPermissions>;
  startMeetingSystemAudioCapture: () => Promise<DesktopSystemAudioCaptureInfo>;
  stopMeetingSystemAudioCapture: () => Promise<void>;
  onMeetingSystemAudioData: (listener: (data: ArrayBuffer, sampleRate: number) => void) => () => void;
  openMeetingAudioSettings: (permission: MeetingAudioPermissionKind) => Promise<void>;
  onMeetingCloseRequested: (listener: () => void) => () => void;
  onSettingsSectionRequested: (listener: (section: DesktopSettingsSection) => void) => () => void;
  consumePendingDeepLinks: () => Promise<string[]>;
  onDeepLink: (listener: (url: string) => void) => () => void;
  onSessionChanged: (listener: (session: DesktopSession | null) => void) => () => void;
}
