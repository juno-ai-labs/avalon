import { contextBridge, ipcRenderer } from 'electron';
import type {
  RallyDesktopBridge,
  DesktopApplicationSettings,
  DesktopAuthAttempt,
  DesktopDeepLinkNavigation,
  DesktopMeetingAudioPermissions,
  DesktopSession,
  DesktopSystemAudioCaptureInfo,
  DesktopWorkspaceOnboardingState,
  MeetingCloseReason,
  RuntimeConfig,
} from '../common/desktop';
import type { ApplicationIconId, DesktopApplicationIconState } from '../common/application-icons';
import type { MessageExportResult } from '../common/message-export';
import { parseDesktopSettingsSection } from '../common/settings';
import type { DesktopSettingsSection } from '../common/settings';
import type { ThemeChoice } from '../common/themes';

const deepLinkListeners = new Set<(navigation: DesktopDeepLinkNavigation) => void>();
const queuedDeepLinks: DesktopDeepLinkNavigation[] = [];
const settingsSectionListeners = new Set<(section: DesktopSettingsSection) => void>();
let queuedSettingsSection: DesktopSettingsSection | null = null;
const meetingCloseListeners = new Set<(reason: MeetingCloseReason) => void>();
let meetingCloseQueued: MeetingCloseReason | null = null;
const applicationForegroundListeners = new Set<(foregrounded: boolean) => void>();

ipcRenderer.on('application:foreground-changed', (_event, rawForegrounded: unknown) => {
  if (typeof rawForegrounded !== 'boolean') return;
  for (const listener of applicationForegroundListeners) listener(rawForegrounded);
});

// Install the privileged listener before React starts. Session changes can
// briefly replace the renderer callback; a native OAuth/invitation callback
// arriving in that gap must be replayed instead of silently disappearing.
ipcRenderer.on('auth:deep-link', (_event, rawNavigation: unknown) => {
  if (!rawNavigation || typeof rawNavigation !== 'object') return;
  const candidate = rawNavigation as Record<string, unknown>;
  const entrypoint = candidate.entrypoint;
  if (typeof candidate.url !== 'string'
    || (entrypoint !== 'deep_link' && entrypoint !== 'menu_bar'
      && entrypoint !== 'notification' && entrypoint !== 'in_app_link')) return;
  const navigation: DesktopDeepLinkNavigation = { url: candidate.url, entrypoint };
  if (deepLinkListeners.size === 0) {
    if (!queuedDeepLinks.some((queued) => (
      queued.url === navigation.url && queued.entrypoint === navigation.entrypoint
    ))) queuedDeepLinks.push(navigation);
    if (queuedDeepLinks.length > 16) queuedDeepLinks.shift();
    return;
  }
  for (const listener of deepLinkListeners) listener(navigation);
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

ipcRenderer.on('meeting:close-requested', (_event, rawReason: unknown) => {
  // Anything but an explicit user close is treated as a quit. Prompting when
  // the application is shutting down is the failure that hangs a quit; closing
  // without a prompt only skips a confirmation.
  const reason: MeetingCloseReason = rawReason === 'user' ? 'user' : 'quit';
  if (meetingCloseListeners.size === 0) {
    // A quit already in the queue outranks a close the person performed
    // earlier: the window has to shut either way, and only one of the two may
    // stop to ask.
    meetingCloseQueued = meetingCloseQueued === 'quit' ? 'quit' : reason;
    return;
  }
  for (const listener of meetingCloseListeners) listener(reason);
});

const bridge: RallyDesktopBridge = {
  getRuntimeConfig: () => ipcRenderer.invoke('runtime:get-config') as Promise<RuntimeConfig>,
  getApplicationForegroundState: () => ipcRenderer.invoke('application:foreground-get') as Promise<boolean>,
  onApplicationForegroundChanged: (listener) => {
    applicationForegroundListeners.add(listener);
    return () => applicationForegroundListeners.delete(listener);
  },
  getApplicationSettings: () => ipcRenderer.invoke('application-settings:get') as Promise<DesktopApplicationSettings>,
  setLockdownMode: (enabled) =>
    ipcRenderer.invoke('application-settings:set-lockdown-mode', enabled) as Promise<DesktopApplicationSettings>,
  setDebugEnabled: (enabled) =>
    ipcRenderer.invoke('application-settings:set-debug-enabled', enabled) as Promise<DesktopApplicationSettings>,
  setMenuBarEnabled: (enabled) =>
    ipcRenderer.invoke('application-settings:set-menu-bar-enabled', enabled) as Promise<DesktopApplicationSettings>,
  setLaunchAtLogin: (enabled) =>
    ipcRenderer.invoke('application-settings:set-launch-at-login', enabled) as Promise<DesktopApplicationSettings>,
  setProductAnalyticsEnabled: (enabled) =>
    ipcRenderer.invoke('application-settings:set-product-analytics', enabled) as Promise<DesktopApplicationSettings>,
  reportTelemetryScreen: (screen) => ipcRenderer.invoke('telemetry:screen', screen) as Promise<void>,
  reportTelemetryProductIntent: (intent) => ipcRenderer.invoke('telemetry:product-intent', intent) as Promise<void>,
  getTelemetryInspector: () => ipcRenderer.invoke('telemetry:inspector'),
  reportJavascriptError: (candidate) => ipcRenderer.invoke('telemetry:javascript-error', candidate) as Promise<void>,
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
  setWindowTheme: (choice: ThemeChoice) => ipcRenderer.invoke('theme:set-window', choice) as Promise<void>,
  onThemeChanged: (listener) => {
    const handler = (_event: unknown, choice: ThemeChoice): void => listener(choice);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
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
  hasStoredCredential: () => ipcRenderer.invoke('auth:has-stored-credential') as Promise<boolean>,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<void>,
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text) as Promise<void>,
  exportMessage: (request) => ipcRenderer.invoke('message-export:save', request) as Promise<MessageExportResult>,
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url) as Promise<void>,
  openSettings: (section) => ipcRenderer.invoke('system:open-settings', section) as Promise<void>,
  openMeetingNotes: (noteId) => ipcRenderer.invoke('system:open-meeting-notes', noteId) as Promise<void>,
  closeMeetingNotes: (noteId) => ipcRenderer.invoke('system:close-meeting-notes', noteId) as Promise<void>,
  getMeetingAudioPermissions: () =>
    ipcRenderer.invoke('meeting-audio:get-permissions') as Promise<DesktopMeetingAudioPermissions>,
  prepareMeetingAudioPermissions: () =>
    ipcRenderer.invoke('meeting-audio:prepare-permissions') as Promise<DesktopMeetingAudioPermissions>,
  startMeetingSystemAudioCapture: () =>
    ipcRenderer.invoke('meeting-audio:start-system-capture') as Promise<DesktopSystemAudioCaptureInfo>,
  stopMeetingSystemAudioCapture: () =>
    ipcRenderer.invoke('meeting-audio:stop-system-capture') as Promise<void>,
  onMeetingSystemAudioData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawData: unknown, rawSampleRate: unknown): void => {
      if (!(rawData instanceof Uint8Array) || typeof rawSampleRate !== 'number') return;
      const data = rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength) as ArrayBuffer;
      listener(data, rawSampleRate);
    };
    ipcRenderer.on('meeting-audio:data', handler);
    return () => ipcRenderer.removeListener('meeting-audio:data', handler);
  },
  openMeetingAudioSettings: (permission) =>
    ipcRenderer.invoke('meeting-audio:open-settings', permission) as Promise<void>,
  onMeetingCloseRequested: (listener) => {
    meetingCloseListeners.add(listener);
    const pending = meetingCloseQueued;
    if (pending) {
      meetingCloseQueued = null;
      queueMicrotask(() => {
        if (meetingCloseListeners.has(listener)) listener(pending);
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
  consumePendingDeepLinks: () => ipcRenderer.invoke('auth:consume-pending-deep-links') as Promise<DesktopDeepLinkNavigation[]>,
  onDeepLink: (listener) => {
    deepLinkListeners.add(listener);
    const pending = queuedDeepLinks.splice(0);
    queueMicrotask(() => {
      if (!deepLinkListeners.has(listener)) return;
      for (const navigation of pending) listener(navigation);
    });
    return () => deepLinkListeners.delete(listener);
  },
  onSessionChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, session: DesktopSession | null): void => listener(session);
    ipcRenderer.on('session:changed', handler);
    return () => ipcRenderer.removeListener('session:changed', handler);
  },
  observeClientFeatureFlags: (flags) => ipcRenderer.invoke('feature-flags:observe', flags) as Promise<void>,
};

contextBridge.exposeInMainWorld('rally', bridge);
