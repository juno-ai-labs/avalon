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

export interface AvalonDesktopBridge {
  getRuntimeConfig: () => Promise<RuntimeConfig>;
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
  logout: () => Promise<void>;
  copyText: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openSettings: () => Promise<void>;
  consumePendingDeepLinks: () => Promise<string[]>;
  onDeepLink: (listener: (url: string) => void) => () => void;
  onSessionChanged: (listener: (session: DesktopSession | null) => void) => () => void;
}
