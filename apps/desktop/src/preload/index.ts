import { contextBridge, ipcRenderer } from 'electron';
import type {
  RallyDesktopBridge,
  DesktopApplicationSettings,
  DesktopDeepLinkErrorNotice,
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
import type { DesktopRealtimeSocketEvent } from '../common/realtime-socket';
import {
  REALTIME_SOCKET_IPC_CHANNELS,
  parseRealtimeSocketEvent,
} from '../common/realtime-socket-validation';

const deepLinkListeners = new Set<(navigation: DesktopDeepLinkNavigation) => void>();
const queuedDeepLinks: DesktopDeepLinkNavigation[] = [];
const settingsSectionListeners = new Set<(section: DesktopSettingsSection) => void>();
let queuedSettingsSection: DesktopSettingsSection | null = null;
const meetingCloseListeners = new Set<(reason: MeetingCloseReason) => void>();
const deepLinkErrorListeners = new Set<(notice: DesktopDeepLinkErrorNotice | null) => void>();

/** Every IPC argument is parsed before use, this bridge's own included. */
function parseDeepLinkErrorNotice(raw: unknown): DesktopDeepLinkErrorNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== 'number' || !Number.isSafeInteger(candidate.id)) return null;
  if (typeof candidate.message !== 'string') return null;
  return { id: candidate.id, message: candidate.message };
}
let meetingCloseQueued: MeetingCloseReason | null = null;
const applicationForegroundListeners = new Set<(foregrounded: boolean) => void>();
const realtimeSocketListeners = new Set<(event: DesktopRealtimeSocketEvent) => void>();

ipcRenderer.on(REALTIME_SOCKET_IPC_CHANNELS.event, (_event, rawEvent: unknown) => {
  const parsed = parseRealtimeSocketEvent(rawEvent);
  if (!parsed) return;
  for (const listener of realtimeSocketListeners) listener(parsed);
});

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

// The failure window reads the current message once it has mounted, so unlike
// the settings section there is nothing to queue: a change arriving before React
// is listening is already in main, and the mount's own read collects it.
ipcRenderer.on('deep-link-error:changed', (_event, rawNotice: unknown) => {
  const notice = parseDeepLinkErrorNotice(rawNotice);
  for (const listener of deepLinkErrorListeners) listener(notice);
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
  getWorkspaceAttention: (input) => ipcRenderer.invoke('workspace:get-attention', input),
  leaveWorkspace: (input) => ipcRenderer.invoke('workspace:leave', input),
  activateWorkspace: (input) => ipcRenderer.invoke('onboarding:activate-workspace', input) as Promise<DesktopSession>,
  reselectActiveWorkspace: (input) => ipcRenderer.invoke('workspace:reselect-active', input) as Promise<DesktopSession | null>,
  createWorkspace: (input) => ipcRenderer.invoke('onboarding:create-workspace', input) as Promise<DesktopSession>,
  acceptInvitation: (input) => ipcRenderer.invoke('onboarding:accept-invitation', input) as Promise<DesktopSession>,
  declineInvitation: (input) => ipcRenderer.invoke('onboarding:decline-invitation', input) as Promise<void>,
  refreshSession: () => ipcRenderer.invoke('auth:refresh-session') as Promise<DesktopSession>,
  surrenderActiveWorkspace: () => ipcRenderer.invoke('workspace:surrender-active') as Promise<DesktopSession | null>,
  hasStoredCredential: () => ipcRenderer.invoke('auth:has-stored-credential') as Promise<boolean>,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<void>,
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text) as Promise<void>,
  setConversationDetailsOpen: (input) => ipcRenderer.invoke('window:set-conversation-details', input) as Promise<void>,
  exportMessage: (request) => ipcRenderer.invoke('message-export:save', request) as Promise<MessageExportResult>,
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url) as Promise<void>,
  presentArtifactPreview: (request) =>
    ipcRenderer.invoke('artifact:present-preview', request) as Promise<boolean>,
  setArtifactPreviewBounds: (bounds) =>
    ipcRenderer.invoke('artifact:set-preview-bounds', bounds) as Promise<void>,
  setArtifactPreviewHidden: (hidden) =>
    ipcRenderer.invoke('artifact:set-preview-hidden', hidden) as Promise<void>,
  closeArtifactPreview: () => ipcRenderer.invoke('artifact:close-preview') as Promise<void>,
  popOutArtifact: (request) => ipcRenderer.invoke('artifact:pop-out', request) as Promise<void>,
  openSettings: (section) => ipcRenderer.invoke('system:open-settings', section) as Promise<void>,
  openMeetingNotes: (noteId) => ipcRenderer.invoke('system:open-meeting-notes', noteId) as Promise<void>,
  closeMeetingNotes: (noteId) => ipcRenderer.invoke('system:close-meeting-notes', noteId) as Promise<void>,
  setMeetingRecordingState: (input) => ipcRenderer.invoke('meeting:set-recording-state', input) as Promise<void>,
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
  showDeepLinkError: (message) => ipcRenderer.invoke('deep-link-error:show', message) as Promise<void>,
  getDeepLinkError: async () => parseDeepLinkErrorNotice(await ipcRenderer.invoke('deep-link-error:get')),
  onDeepLinkErrorChanged: (listener) => {
    deepLinkErrorListeners.add(listener);
    return () => deepLinkErrorListeners.delete(listener);
  },
  dismissDeepLinkError: (noticeId) => ipcRenderer.invoke('deep-link-error:dismiss', noticeId) as Promise<void>,
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
  openRealtimeSocket: (input) => ipcRenderer.invoke(REALTIME_SOCKET_IPC_CHANNELS.open, input) as Promise<void>,
  sendRealtimeSocket: (input) => ipcRenderer.invoke(REALTIME_SOCKET_IPC_CHANNELS.send, input) as Promise<void>,
  closeRealtimeSocket: (input) => ipcRenderer.invoke(REALTIME_SOCKET_IPC_CHANNELS.close, input) as Promise<void>,
  onRealtimeSocketEvent: (listener) => {
    realtimeSocketListeners.add(listener);
    return () => realtimeSocketListeners.delete(listener);
  },
  observeClientFeatureFlags: (flags) => ipcRenderer.invoke('feature-flags:observe', flags) as Promise<void>,
};

contextBridge.exposeInMainWorld('rally', bridge);
