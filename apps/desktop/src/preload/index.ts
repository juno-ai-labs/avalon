import type { ArtifactPickerPin } from "@rally/contracts";
import type { AccountOnboarding, OrganizationNameSuggestion, SupportPerson, SupportWorkspace } from '@rally/contracts';
import { NETWORK_RECOVERY_IPC, NetworkRecoveryInbox } from '../common/network-recovery';
import { contextBridge, ipcRenderer } from 'electron';
import type { ApplicationIconId, DesktopApplicationIconState } from '../common/application-icons';
import type {
  RallyDesktopBridge,
  DesktopApplicationSettings,
  DesktopRestorableArtifactWindow,
  DesktopDeepLinkErrorNotice,
  DesktopAuthAttempt,
  DesktopDeepLinkNavigation,
  DesktopPowerState,
  DesktopSession,
  DesktopSystemAudioCaptureInfo,
  DesktopUpdateStatus,
  DesktopWorkspaceOnboardingState,
  RuntimeConfig,
} from '../common/desktop';
import type { MessageExportResult } from '../common/message-export';
import type { DesktopReleaseChannel } from '../common/release-channels';
import type { DesktopRealtimeSocketEvent } from '../common/realtime-socket';
import type { EmbeddedBrowserHostRequest, EmbeddedBrowserResult, EmbeddedBrowserState } from '../common/embedded-browser';
import type { BrowserImportContext, BrowserImportProgress } from '../common/browser-import';
import {
  REALTIME_SOCKET_IPC_CHANNELS,
  parseRealtimeSocketEvent,
} from '../common/realtime-socket-validation';
import type { DesktopSettingsSection } from '../common/settings';
import { parseDesktopSettingsSection } from '../common/settings';
import type { ThemeChoice } from '../common/themes';
import {
  WORKSPACE_SYNC_RELAY_IPC_CHANNELS,
  createWorkspaceSyncRelayInbox,
  isWorkspaceSyncRelayEvent,
  type WorkspaceSyncSourceSnapshot,
} from '../common/workspace-sync-relay';

const deepLinkListeners = new Set<(navigation: DesktopDeepLinkNavigation) => void>();
const queuedDeepLinks: DesktopDeepLinkNavigation[] = [];
const settingsSectionListeners = new Set<(section: DesktopSettingsSection) => void>();
let queuedSettingsSection: DesktopSettingsSection | null = null;
const settingsRevealedListeners = new Set<() => void>();
let settingsWindowRevealed = false;
const deepLinkErrorListeners = new Set<(notice: DesktopDeepLinkErrorNotice | null) => void>();

/** Every IPC argument is parsed before use, this bridge's own included. */
function parseDeepLinkErrorNotice(raw: unknown): DesktopDeepLinkErrorNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== 'number' || !Number.isSafeInteger(candidate.id)) return null;
  if (typeof candidate.message !== 'string') return null;
  return { id: candidate.id, message: candidate.message };
}
const applicationForegroundListeners = new Set<(foregrounded: boolean) => void>();
const powerStateListeners = new Set<(state: DesktopPowerState) => void>();
const realtimeSocketListeners = new Set<(event: DesktopRealtimeSocketEvent) => void>();
const embeddedBrowserListeners = new Set<(state: EmbeddedBrowserState) => void>();
const workspaceSyncInbox = createWorkspaceSyncRelayInbox();
const networkRecoveryInbox = new NetworkRecoveryInbox();
ipcRenderer.on(NETWORK_RECOVERY_IPC.changed, (_event, raw: unknown) => networkRecoveryInbox.receive(raw));
// Start before React: a newly opened window inherits an ongoing session reset.
const networkRecoveryReady = ipcRenderer.invoke(NETWORK_RECOVERY_IPC.state).then((raw: unknown) => {
  networkRecoveryInbox.receive(raw);
});
// Keep an IPC failure observable to requests without an unhandled rejection.
void networkRecoveryReady.catch(() => undefined);

ipcRenderer.on('embedded-browser:state', (_event, raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !('tabs' in raw) || !Array.isArray(raw.tabs)) return;
  const state = raw as EmbeddedBrowserState;
  for (const listener of embeddedBrowserListeners) listener(state);
});

ipcRenderer.on(REALTIME_SOCKET_IPC_CHANNELS.event, (_event, rawEvent: unknown) => {
  const parsed = parseRealtimeSocketEvent(rawEvent);
  if (!parsed) return;
  for (const listener of realtimeSocketListeners) listener(parsed);
});

// Installed before React starts, so relayed news that lands before the
// settings provider listens is held for it rather than lost. Main built each
// event from its own closed parse of the main window's publication, so this
// checks only the structure the inbox reads.
ipcRenderer.on(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.relayed, (_event, rawEvent: unknown) => {
  if (isWorkspaceSyncRelayEvent(rawEvent)) workspaceSyncInbox.receive(rawEvent);
});

ipcRenderer.on('application:foreground-changed', (_event, rawForegrounded: unknown) => {
  if (typeof rawForegrounded !== 'boolean') return;
  for (const listener of applicationForegroundListeners) listener(rawForegrounded);
});

ipcRenderer.on('power:changed', (_event, rawState: unknown) => {
  if (rawState !== 'suspended' && rawState !== 'resumed') return;
  for (const listener of powerStateListeners) listener(rawState);
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

// Latched rather than queued, and the distinction matters: a reveal is a state
// the window is in from then on, not an event that can be missed. A prewarmed
// window is revealed while React is mounted and listening; a cold one can be
// revealed before that, and a listener arriving afterwards still needs to know.
ipcRenderer.on('settings:revealed', () => {
  settingsWindowRevealed = true;
  for (const listener of settingsRevealedListeners) listener();
});

// The failure window reads the current message once it has mounted, so unlike
// the settings section there is nothing to queue: a change arriving before React
// is listening is already in main, and the mount's own read collects it.
ipcRenderer.on('deep-link-error:changed', (_event, rawNotice: unknown) => {
  const notice = parseDeepLinkErrorNotice(rawNotice);
  for (const listener of deepLinkErrorListeners) listener(notice);
});

const bridge: RallyDesktopBridge = {
  waitForNetworkRecoveryState: () => networkRecoveryReady,
  getNetworkRecoveryState: () => networkRecoveryInbox.state,
  onNetworkRecoveryState: (listener) => networkRecoveryInbox.subscribe(listener),
  reportNetworkTicket: async (observation) => {
    networkRecoveryInbox.receive(await ipcRenderer.invoke(NETWORK_RECOVERY_IPC.observe, observation));
  },
  getRuntimeConfig: () => ipcRenderer.invoke('runtime:get-config') as Promise<RuntimeConfig>,
  getApplicationForegroundState: () => ipcRenderer.invoke('application:foreground-get') as Promise<boolean>,
  onApplicationForegroundChanged: (listener) => {
    applicationForegroundListeners.add(listener);
    return () => applicationForegroundListeners.delete(listener);
  },
  onPowerStateChanged: (listener) => {
    powerStateListeners.add(listener);
    return () => powerStateListeners.delete(listener);
  },
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status') as Promise<DesktopUpdateStatus>,
  onUpdateStatusChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus): void => listener(status);
    ipcRenderer.on('update:status-changed', handler);
    return () => ipcRenderer.removeListener('update:status-changed', handler);
  },
  installDownloadedUpdate: () => ipcRenderer.invoke('update:install') as Promise<void>,
  getApplicationSettings: () => ipcRenderer.invoke('application-settings:get') as Promise<DesktopApplicationSettings>,
  setLockdownMode: (enabled) =>
    ipcRenderer.invoke('application-settings:set-lockdown-mode', enabled) as Promise<DesktopApplicationSettings>,
  setDebugEnabled: (enabled) =>
    ipcRenderer.invoke('application-settings:set-debug-enabled', enabled) as Promise<DesktopApplicationSettings>,
  setPushNotificationsEnabled: (enabled) => ipcRenderer.invoke('application-settings:set-push-notifications', enabled) as Promise<DesktopApplicationSettings>,
  openNotificationSettings: () => ipcRenderer.invoke('application-settings:open-notifications') as Promise<void>,
  setDockBadgeCount: (count) => ipcRenderer.invoke('dock-badge:set', count) as Promise<void>,
  setMenuBarEnabled: (enabled) =>
    ipcRenderer.invoke('application-settings:set-menu-bar-enabled', enabled) as Promise<DesktopApplicationSettings>,
  setLaunchAtLogin: (enabled) =>
    ipcRenderer.invoke('application-settings:set-launch-at-login', enabled) as Promise<DesktopApplicationSettings>,
  setProductAnalyticsEnabled: (enabled) =>
    ipcRenderer.invoke('application-settings:set-product-analytics', enabled) as Promise<DesktopApplicationSettings>,
  setReleaseChannel: (channel: DesktopReleaseChannel) =>
    ipcRenderer.invoke('application-settings:set-release-channel', channel) as Promise<DesktopApplicationSettings>,
  reportTelemetryScreen: (screen) => ipcRenderer.invoke('telemetry:screen', screen) as Promise<void>,
  reportTelemetryProductIntent: (intent) => ipcRenderer.invoke('telemetry:product-intent', intent) as Promise<void>,
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
  getAccountOnboarding: () => ipcRenderer.invoke('onboarding:get-account') as Promise<AccountOnboarding>,
  updateAccountOnboarding: (input) => ipcRenderer.invoke('onboarding:update-account', input) as Promise<AccountOnboarding>,
  getOrganizationNameSuggestion: () => ipcRenderer.invoke('onboarding:get-organization-suggestion') as Promise<OrganizationNameSuggestion>,
  getOnboardingState: () => ipcRenderer.invoke('onboarding:get-state') as Promise<DesktopWorkspaceOnboardingState>,
  getWorkspaceAttention: (input) => ipcRenderer.invoke('workspace:get-attention', input),
  leaveWorkspace: (input) => ipcRenderer.invoke('workspace:leave', input),
  activateWorkspace: (input) => ipcRenderer.invoke('onboarding:activate-workspace', input) as Promise<DesktopSession>,
  listSupportWorkspaces: () => ipcRenderer.invoke('support:list-workspaces') as Promise<SupportWorkspace[] | null>,
  listSupportPeople: (workspaceId) => ipcRenderer.invoke('support:list-people', workspaceId) as Promise<SupportPerson[]>,
  startSupportSession: (input) => ipcRenderer.invoke('support:start', input) as Promise<DesktopSession>,
  endSupportSession: () => ipcRenderer.invoke('support:end') as Promise<DesktopSession | null>,
  reselectActiveWorkspace: (input) => ipcRenderer.invoke('workspace:reselect-active', input) as Promise<DesktopSession | null>,
  createWorkspace: (input) => ipcRenderer.invoke('onboarding:create-workspace', input) as Promise<DesktopSession>,
  acceptInvitation: (input) => ipcRenderer.invoke('onboarding:accept-invitation', input) as Promise<DesktopSession>,
  declineInvitation: (input) => ipcRenderer.invoke('onboarding:decline-invitation', input) as Promise<void>,
  refreshSession: () => ipcRenderer.invoke('auth:refresh-session') as Promise<DesktopSession>,
  surrenderActiveWorkspace: () => ipcRenderer.invoke('workspace:surrender-active') as Promise<DesktopSession | null>,
  hasStoredCredential: () => ipcRenderer.invoke('auth:has-stored-credential') as Promise<boolean>,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<void>,
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text) as Promise<void>,
  showDefinitionForSelection: () => ipcRenderer.invoke('system:show-definition') as Promise<void>,
  shareText: (text) => ipcRenderer.invoke('system:share-text', text) as Promise<void>,
  getEmbeddedBrowserState: () => ipcRenderer.invoke('embedded-browser:state') as Promise<EmbeddedBrowserState>,
  commandEmbeddedBrowser: (command) => ipcRenderer.invoke('embedded-browser:command', command) as Promise<EmbeddedBrowserResult>,
  setEmbeddedBrowserBounds: (bounds) => ipcRenderer.invoke('embedded-browser:bounds', bounds) as Promise<void>,
  setEmbeddedBrowserVisible: (visible) => ipcRenderer.invoke('embedded-browser:visible', visible) as Promise<void>,
  onEmbeddedBrowserHostRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: EmbeddedBrowserHostRequest): void => listener(request);
    ipcRenderer.on('embedded-browser:host-request', handler);
    return () => ipcRenderer.removeListener('embedded-browser:host-request', handler);
  },
  onEmbeddedBrowserState: (listener) => {
    embeddedBrowserListeners.add(listener);
    return () => embeddedBrowserListeners.delete(listener);
  },
  openBrowserImport: (context) => ipcRenderer.invoke('browser-import:open', context) as Promise<void>,
  getBrowserImportContext: () => ipcRenderer.invoke('browser-import:context') as Promise<BrowserImportContext | null>,
  onBrowserImportContextChanged: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on('browser-import:context-changed', handler);
    return () => ipcRenderer.removeListener('browser-import:context-changed', handler);
  },
  onOrganizationListRefreshRequested: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on('organizations:refresh-requested', handler);
    return () => ipcRenderer.removeListener('organizations:refresh-requested', handler);
  },
  completeBrowserImport: (workstreamId, substreamId) => ipcRenderer.invoke('browser-import:imported', workstreamId, substreamId) as Promise<void>,
  reportBrowserImport: (progress) => ipcRenderer.invoke('browser-import:progress', progress) as Promise<void>,
  onBrowserImportProgress: (listener) => {
    // Main parsed it from the import window before relaying it here.
    const handler = (_event: unknown, progress: BrowserImportProgress): void => listener(progress);
    ipcRenderer.on('browser-import:progress', handler);
    return () => ipcRenderer.removeListener('browser-import:progress', handler);
  },
  exportMessage: (request) => ipcRenderer.invoke('message-export:save', request) as Promise<MessageExportResult>,
  connectCanva: (operationId) => ipcRenderer.invoke('canva:connect', operationId) as Promise<{ url: string; attemptId: string }>,
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url) as Promise<void>,
  presentArtifactPreview: (request) =>
    ipcRenderer.invoke('artifact:present-preview', request) as Promise<boolean>,
  setArtifactPreviewBounds: (bounds) =>
    ipcRenderer.invoke('artifact:set-preview-bounds', bounds) as Promise<void>,
  setArtifactPreviewHidden: (hidden) =>
    ipcRenderer.invoke('artifact:set-preview-hidden', hidden) as Promise<void>,
  pickArtifactPreview: () => ipcRenderer.invoke('artifact:pick-preview') as Promise<ArtifactPickerPin | null>,
  stopPickingArtifactPreview: () => ipcRenderer.invoke('artifact:stop-picking-preview') as Promise<void>,
  snapshotArtifactPreview: () => ipcRenderer.invoke('artifact:snapshot-preview') as Promise<string | null>,
  closeArtifactPreview: () => ipcRenderer.invoke('artifact:close-preview') as Promise<void>,
  readArtifactWindow: () => ipcRenderer.invoke('artifact:read-window') as ReturnType<NonNullable<RallyDesktopBridge['readArtifactWindow']>>,
  registerAnnotationComposer: (scope, active) => ipcRenderer.invoke('artifact:register-composer', scope, active) as Promise<void>,
  returnArtifactAnnotations: (pins) => ipcRenderer.invoke('artifact:return-annotations', pins) as Promise<boolean>,
  completeArtifactAnnotationTransfer: (transferId, accepted) => ipcRenderer.invoke('artifact:complete-transfer', transferId, accepted) as Promise<void>,
  onArtifactAnnotations: (listener) => { const receive = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value); ipcRenderer.on('artifact:annotations', receive); return () => { ipcRenderer.removeListener('artifact:annotations', receive); }; },
  onArtifactWindowUpdated: (listener) => { const receive = () => listener(); ipcRenderer.on('artifact:window-updated', receive); return () => { ipcRenderer.removeListener('artifact:window-updated', receive); }; },
  popOutArtifact: (request) => ipcRenderer.invoke('artifact:pop-out', request) as Promise<boolean>,
  getRestorableArtifactWindows: () => ipcRenderer.invoke('artifact:restorable-windows') as Promise<DesktopRestorableArtifactWindow[]>,
  forgetRestorableArtifactWindow: (id) => ipcRenderer.invoke('artifact:forget-window', id) as Promise<void>,
  getPoppedOutArtifactVersions: () =>
    ipcRenderer.invoke('artifact:popped-out-versions') as Promise<Record<string, number>>,
  updatePoppedOutArtifact: (request) =>
    ipcRenderer.invoke('artifact:update-pop-out', request) as Promise<boolean>,
  openSidekicks: (target) => ipcRenderer.invoke('system:open-sidekicks', target) as Promise<void>,
  openThread: (workstreamId) => ipcRenderer.invoke('system:open-thread', workstreamId) as Promise<void>,
  openSettings: (section) => ipcRenderer.invoke('system:open-settings', section) as Promise<void>,
  startSystemAudioCapture: () =>
    ipcRenderer.invoke('transcription-audio:start-system-capture') as Promise<DesktopSystemAudioCaptureInfo>,
  stopSystemAudioCapture: () =>
    ipcRenderer.invoke('transcription-audio:stop-system-capture') as Promise<void>,
  onSystemAudioData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawData: unknown, rawSampleRate: unknown): void => {
      if (!(rawData instanceof Uint8Array) || typeof rawSampleRate !== 'number') return;
      const data = rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength) as ArrayBuffer;
      listener(data, rawSampleRate);
    };
    ipcRenderer.on('transcription-audio:data', handler);
    return () => ipcRenderer.removeListener('transcription-audio:data', handler);
  },
  onSettingsWindowRevealed: (listener) => {
    settingsRevealedListeners.add(listener);
    if (settingsWindowRevealed) {
      queueMicrotask(() => {
        if (settingsRevealedListeners.has(listener)) listener();
      });
    }
    return () => settingsRevealedListeners.delete(listener);
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
  publishWorkspaceSync: (publication) =>
    ipcRenderer.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish, publication) as Promise<void>,
  getWorkspaceSyncSource: () =>
    ipcRenderer.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.source) as Promise<WorkspaceSyncSourceSnapshot>,
  onWorkspaceSyncRelayed: (listener) => workspaceSyncInbox.subscribe(listener),
  openRealtimeSocket: (input) => ipcRenderer.invoke(REALTIME_SOCKET_IPC_CHANNELS.open, input) as Promise<void>,
  sendRealtimeSocket: (input) => ipcRenderer.invoke(REALTIME_SOCKET_IPC_CHANNELS.send, input) as Promise<void>,
  closeRealtimeSocket: (input) => ipcRenderer.invoke(REALTIME_SOCKET_IPC_CHANNELS.close, input) as Promise<void>,
  onRealtimeSocketEvent: (listener) => {
    realtimeSocketListeners.add(listener);
    return () => realtimeSocketListeners.delete(listener);
  },
};

contextBridge.exposeInMainWorld('rally', bridge);
