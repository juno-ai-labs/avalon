import { contextBridge, ipcRenderer } from 'electron';
import type {
  AvalonDesktopBridge,
  DesktopApplicationSettings,
  DesktopAuthAttempt,
  DesktopMeetingAudioPermissions,
  DesktopSession,
  DesktopWorkspaceOnboardingState,
  RuntimeConfig,
} from '../common/desktop';
import type { ApplicationIconId, DesktopApplicationIconState } from '../common/application-icons';
import { parseDesktopSettingsSection } from '../common/settings';
import type { DesktopSettingsSection } from '../common/settings';

const deepLinkListeners = new Set<(url: string) => void>();
const queuedDeepLinks: string[] = [];
const settingsSectionListeners = new Set<(section: DesktopSettingsSection) => void>();
let queuedSettingsSection: DesktopSettingsSection | null = null;
const meetingCloseListeners = new Set<() => void>();
let meetingCloseQueued = false;

// Install the privileged listener before React starts. Session changes can
// briefly replace the renderer callback; a native OAuth/invitation callback
// arriving in that gap must be replayed instead of silently disappearing.
ipcRenderer.on('auth:deep-link', (_event, rawUrl: unknown) => {
  if (typeof rawUrl !== 'string') return;
  if (deepLinkListeners.size === 0) {
    if (!queuedDeepLinks.includes(rawUrl)) queuedDeepLinks.push(rawUrl);
    if (queuedDeepLinks.length > 16) queuedDeepLinks.shift();
    return;
  }
  for (const listener of deepLinkListeners) listener(rawUrl);
});

// A settings request can arrive as soon as the window finishes loading, before
// React has mounted its section listener. Retain the newest request so an
// already-open singleton and a newly-created window behave identically.
ipcRenderer.on('settings:section-requested', (_event, rawSection: unknown) => {
  const section = parseDesktopSettingsSection(rawSection);
  if (!section) return;
  if (settingsSectionListeners.size === 0) {
    queuedSettingsSection = section;
    return;
  }
  for (const listener of settingsSectionListeners) listener(section);
});

ipcRenderer.on('meeting:close-requested', () => {
  if (meetingCloseListeners.size === 0) {
    meetingCloseQueued = true;
    return;
  }
  for (const listener of meetingCloseListeners) listener();
});

const bridge: AvalonDesktopBridge = {
  getRuntimeConfig: () => ipcRenderer.invoke('runtime:get-config') as Promise<RuntimeConfig>,
  getApplicationSettings: () => ipcRenderer.invoke('application-settings:get') as Promise<DesktopApplicationSettings>,
  setLockdownMode: (enabled) =>
    ipcRenderer.invoke('application-settings:set-lockdown-mode', enabled) as Promise<DesktopApplicationSettings>,
  onApplicationSettingsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: DesktopApplicationSettings): void => listener(settings);
    ipcRenderer.on('application-settings:changed', handler);
    return () => ipcRenderer.removeListener('application-settings:changed', handler);
  },
  getApplicationIcon: () => ipcRenderer.invoke('application-icon:get') as Promise<DesktopApplicationIconState>,
  setApplicationIcon: (iconId: ApplicationIconId) =>
    ipcRenderer.invoke('application-icon:set', iconId) as Promise<DesktopApplicationIconState>,
  resetApplicationIcon: () => ipcRenderer.invoke('application-icon:reset') as Promise<DesktopApplicationIconState>,
  onApplicationIconChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopApplicationIconState): void => listener(state);
    ipcRenderer.on('application-icon:changed', handler);
    return () => ipcRenderer.removeListener('application-icon:changed', handler);
  },
  getSession: () => ipcRenderer.invoke('session:get') as Promise<DesktopSession | null>,
  createDesktopAuthAttempt: (input) => ipcRenderer.invoke('auth:create-desktop-attempt', input) as Promise<DesktopAuthAttempt>,
  cancelDesktopAuthAttempt: (attemptId) => ipcRenderer.invoke('auth:cancel-desktop-attempt', attemptId) as Promise<void>,
  exchangeDesktopTicket: (input) => ipcRenderer.invoke('auth:exchange-desktop-ticket', input) as Promise<DesktopSession>,
  createDevelopmentSession: (apiBaseUrl, workspaceName) => ipcRenderer.invoke('auth:create-development-session', { apiBaseUrl, workspaceName }) as Promise<DesktopSession>,
  getOnboardingState: () => ipcRenderer.invoke('onboarding:get-state') as Promise<DesktopWorkspaceOnboardingState>,
  activateWorkspace: (input) => ipcRenderer.invoke('onboarding:activate-workspace', input) as Promise<DesktopSession>,
  createWorkspace: (input) => ipcRenderer.invoke('onboarding:create-workspace', input) as Promise<DesktopSession>,
  acceptInvitation: (input) => ipcRenderer.invoke('onboarding:accept-invitation', input) as Promise<DesktopSession>,
  declineInvitation: (input) => ipcRenderer.invoke('onboarding:decline-invitation', input) as Promise<void>,
  refreshSession: () => ipcRenderer.invoke('auth:refresh-session') as Promise<DesktopSession>,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<void>,
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url) as Promise<void>,
  openSettings: (section) => ipcRenderer.invoke('system:open-settings', section) as Promise<void>,
  openMeetingNotes: (noteId) => ipcRenderer.invoke('system:open-meeting-notes', noteId) as Promise<void>,
  closeMeetingNotes: () => ipcRenderer.invoke('system:close-meeting-notes') as Promise<void>,
  getMeetingAudioPermissions: () =>
    ipcRenderer.invoke('meeting-audio:get-permissions') as Promise<DesktopMeetingAudioPermissions>,
  prepareMeetingAudioPermissions: () =>
    ipcRenderer.invoke('meeting-audio:prepare-permissions') as Promise<DesktopMeetingAudioPermissions>,
  openMeetingAudioSettings: (permission) =>
    ipcRenderer.invoke('meeting-audio:open-settings', permission) as Promise<void>,
  onMeetingCloseRequested: (listener) => {
    meetingCloseListeners.add(listener);
    if (meetingCloseQueued) {
      meetingCloseQueued = false;
      queueMicrotask(() => {
        if (meetingCloseListeners.has(listener)) listener();
      });
    }
    return () => meetingCloseListeners.delete(listener);
  },
  onSettingsSectionRequested: (listener) => {
    settingsSectionListeners.add(listener);
    const pending = queuedSettingsSection;
    queuedSettingsSection = null;
    if (pending) {
      queueMicrotask(() => {
        if (settingsSectionListeners.has(listener)) listener(pending);
      });
    }
    return () => settingsSectionListeners.delete(listener);
  },
  consumePendingDeepLinks: () => ipcRenderer.invoke('auth:consume-pending-deep-links') as Promise<string[]>,
  onDeepLink: (listener) => {
    deepLinkListeners.add(listener);
    const pending = queuedDeepLinks.splice(0);
    queueMicrotask(() => {
      if (!deepLinkListeners.has(listener)) return;
      for (const url of pending) listener(url);
    });
    return () => deepLinkListeners.delete(listener);
  },
  onSessionChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, session: DesktopSession | null): void => listener(session);
    ipcRenderer.on('session:changed', handler);
    return () => ipcRenderer.removeListener('session:changed', handler);
  },
};

contextBridge.exposeInMainWorld('avalon', bridge);
