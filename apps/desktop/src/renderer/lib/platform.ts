import { AccountOnboardingSchema, UpdateAccountOnboardingSchema } from '@rally/contracts';
import type {
  RallyDesktopBridge,
  DesktopApplicationSettings,
  DesktopAuthAttempt,
  DesktopSession,
  DesktopWorkspaceOnboardingState,
  RuntimeConfig,
} from '../../common/desktop';
import {
  automaticApplicationIcon,
  parseApplicationIconId,
  type DesktopApplicationIconState,
} from '../../common/application-icons';

export type { DesktopWorkspaceOnboardingState } from '../../common/desktop';

let browserSession: DesktopSession | null = null;
let browserRefreshToken: string | null = null;
const browserApplicationSettings: DesktopApplicationSettings = {
  lockdownMode: false,
  lockdownAvailable: false,
  debugEnabled: false,
  // The browser fallback has no main process to poll the service, so the
  // Developer section is simply not on offer there.
  developerSettingsAvailable: false,
  // A tab has no status item. The preference reads as on so the desktop and the
  // browser agree about what the stored default is, and unavailable so the
  // toggle is offered nowhere it cannot work.
  menuBarEnabled: true,
  menuBarAvailable: false,
  menuBarPresent: false,
  // A tab is not a login item either. Both read as unavailable so neither
  // toggle is offered where it could not work.
  launchAtLogin: false,
  launchAtLoginAvailable: false,
  // Browser development follows the account-level default. There is no
  // Electron main process here to persist an offline mutation, so the browser
  // bridge exposes the state but declines writes below.
  productAnalyticsEnabled: true,
  productAnalyticsAvailable: false,
  productAnalyticsEffective: true,
  productAnalyticsPreferencePending: false,
  nativeCrashRestartRequired: false,
};
const browserApplicationSettingsListeners = new Set<(settings: DesktopApplicationSettings) => void>();
const browserSessionListeners = new Set<(session: DesktopSession | null) => void>();
const browserAuthAttempts = new Map<string, {
  apiBaseUrl: string;
  region: 'global' | 'eu';
  verifier: string;
  expiresAt: number;
}>();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomBase64Url(size: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

async function createBrowserAuthAttempt(apiBaseUrl: string, region: 'global' | 'eu'): Promise<DesktopAuthAttempt> {
  if (region !== 'global' || normalizeApiBaseUrl(apiBaseUrl) !== normalizeApiBaseUrl(browserGlobalApiBaseUrl())) {
    throw new Error('Rally sign-in must use the Global identity service.');
  }
  browserAuthAttempts.clear();
  const now = Date.now();
  for (const [id, attempt] of browserAuthAttempts) {
    if (attempt.expiresAt <= now) browserAuthAttempts.delete(id);
  }
  while (browserAuthAttempts.size >= 6) {
    const oldest = browserAuthAttempts.keys().next().value as string | undefined;
    if (!oldest) break;
    browserAuthAttempts.delete(oldest);
  }
  const attemptId = randomBase64Url(32);
  const verifier = randomBase64Url(48);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )));
  browserAuthAttempts.set(attemptId, { apiBaseUrl, region, verifier, expiresAt: now + 12 * 60_000 });
  return { attemptId, codeChallenge: challenge };
}

function notifyBrowserSession(): void {
  for (const listener of browserSessionListeners) listener(browserSession);
}

async function browserSessionRequest(
  apiBaseUrl: string,
  path: string,
  body: unknown,
  validate?: (session: DesktopSession & { refreshToken: string }) => void,
): Promise<DesktopSession> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Authentication failed (${response.status})`);
  const raw = await response.json() as DesktopSession & { refreshToken: string };
  if (normalizeApiBaseUrl(raw.apiBaseUrl) !== normalizeApiBaseUrl(apiBaseUrl)) {
    throw new Error('Rally rejected a session issued for an unexpected service.');
  }
  validate?.(raw);
  return installBrowserSession(raw, apiBaseUrl);
}

function installBrowserSession(
  raw: DesktopSession & { refreshToken: string },
  fallbackApiBaseUrl: string,
): DesktopSession {
  browserRefreshToken = raw.refreshToken;
  browserSession = {
    accessToken: raw.accessToken,
    expiresAt: raw.expiresAt,
    apiBaseUrl: raw.apiBaseUrl || fallbackApiBaseUrl,
    user: raw.user,
    workspace: raw.workspace,
  };
  notifyBrowserSession();
  return browserSession;
}

function browserGlobalApiBaseUrl(): string {
  return import.meta.env.VITE_API_GLOBAL_URL ?? 'http://127.0.0.1:8787';
}

function browserApiBaseUrl(region: 'global' | 'eu'): string {
  if (region === 'global') return browserGlobalApiBaseUrl();
  return import.meta.env.VITE_API_EU_URL ?? 'http://127.0.0.1:8788';
}

function normalizeApiBaseUrl(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(/\/+$/u, '') : null;
}

async function browserOnboardingRequest<T>(
  path: string,
  options: { body?: unknown; method?: 'GET' | 'POST' | 'PATCH' } = {},
): Promise<T> {
  if (!browserSession) throw new Error('Sign in before continuing workspace setup.');
  const response = await fetch(`${browserGlobalApiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${browserSession.accessToken}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message ?? `Workspace setup failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function browserOnboardingSession(
  path: string,
  body: unknown,
  expected: { region: 'global' | 'eu'; workspaceId?: string },
): Promise<DesktopSession> {
  // Regional databases use a local shadow user ID linked to the immutable
  // Global platform identity. The verified email is the stable value that is
  // also checked by Electron main during the control-plane handoff.
  const identityEmail = browserSession?.user.email.toLocaleLowerCase('en-US');
  const raw = await browserOnboardingRequest<DesktopSession & { refreshToken: string }>(path, {
    method: 'POST',
    body,
  });
  const expectedApiBaseUrl = browserApiBaseUrl(expected.region);
  if (
    !raw.workspace
    || raw.workspace.region !== expected.region
    || normalizeApiBaseUrl(raw.apiBaseUrl) !== normalizeApiBaseUrl(expectedApiBaseUrl)
    || (expected.workspaceId !== undefined && raw.workspace.id !== expected.workspaceId)
    || (identityEmail !== undefined && raw.user.email.toLocaleLowerCase('en-US') !== identityEmail)
  ) {
    throw new Error('Rally rejected a workspace session that did not match this workspace request.');
  }
  return installBrowserSession(raw, browserGlobalApiBaseUrl());
}

let browserSidekicksWindow: Window | null = null;

const browserBridge: RallyDesktopBridge = {
  async getRuntimeConfig() {
    return {
      appVersion: 'development',
      isPackaged: false,
      platform: 'browser',
      api: {
        global: import.meta.env.VITE_API_GLOBAL_URL ?? 'http://127.0.0.1:8787',
        eu: import.meta.env.VITE_API_EU_URL ?? 'http://127.0.0.1:8788',
      },
      webBaseUrl: import.meta.env.VITE_PUBLIC_WEB_BASE_URL ?? 'http://127.0.0.1:5174',
      devAuthEnabled: import.meta.env.DEV,
    } as RuntimeConfig;
  },
  async getApplicationForegroundState() {
    return document.visibilityState === 'visible' && document.hasFocus();
  },
  onApplicationForegroundChanged(listener) {
    const report = (): void => listener(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
    };
  },
  async getApplicationSettings() {
    return { ...browserApplicationSettings };
  },
  async setLockdownMode(enabled) {
    // Nothing to announce: enabling throws here, and disabling is already the
    // only state this bridge has. Debug enabled below is the mutable one.
    if (enabled) throw new Error('Lockdown mode is available only in the Rally desktop app.');
    return { ...browserApplicationSettings };
  },
  async setDebugEnabled(enabled) {
    browserApplicationSettings.debugEnabled = enabled;
    // A browser tab has no second window to notify through the main process,
    // but the settings pane and the sidebar still mount separate listeners.
    for (const listener of browserApplicationSettingsListeners) {
      listener({ ...browserApplicationSettings });
    }
    return { ...browserApplicationSettings };
  },
  async setMenuBarEnabled() {
    throw new Error('The menu bar item is available only in the Rally desktop app.');
  },
  async setLaunchAtLogin() {
    throw new Error('Opening at login is available only in the Rally desktop app.');
  },
  async setProductAnalyticsEnabled() {
    throw new Error('Product analytics is managed in the Rally desktop app.');
  },
  async reportTelemetryScreen() {
    // Public-site/browser telemetry is outside this feature's V1 scope.
  },
  async reportTelemetryProductIntent() {
    // Public-site/browser telemetry is outside this feature's V1 scope.
  },
  async reportJavascriptError() {
    // Browser telemetry is outside this feature's V1 scope.
  },
  onApplicationSettingsChanged(listener) {
    browserApplicationSettingsListeners.add(listener);
    return () => browserApplicationSettingsListeners.delete(listener);
  },
  async getApplicationIcon() {
    return {
      activeIcon: automaticApplicationIcon(window.matchMedia('(prefers-color-scheme: dark)').matches),
      isAutomatic: true,
      supported: false,
    } as DesktopApplicationIconState;
  },
  async setApplicationIcon(iconId) {
    const parsed = parseApplicationIconId(iconId);
    if (!parsed) throw new Error('Unknown application icon');
    return { activeIcon: parsed, isAutomatic: false, supported: false };
  },
  async resetApplicationIcon() {
    return {
      activeIcon: automaticApplicationIcon(window.matchMedia('(prefers-color-scheme: dark)').matches),
      isAutomatic: true,
      supported: false,
    };
  },
  onApplicationIconChanged() {
    return () => undefined;
  },
  async setWindowTheme() {
    // There is no native window to colour outside the desktop app.
  },
  onThemeChanged() {
    // And no second window to keep in step with this one.
    return () => undefined;
  },
  async getSession() {
    return browserSession;
  },
  async createDesktopAuthAttempt({ apiBaseUrl, region }) {
    return createBrowserAuthAttempt(apiBaseUrl, region);
  },
  async cancelDesktopAuthAttempt(attemptId) {
    browserAuthAttempts.delete(attemptId);
  },
  async exchangeDesktopTicket(input) {
    if (
      input.region !== 'global'
      || normalizeApiBaseUrl(input.apiBaseUrl) !== normalizeApiBaseUrl(browserGlobalApiBaseUrl())
      || !/^[A-Za-z0-9_-]{20,500}$/u.test(input.ticket)
      || !/^[A-Za-z0-9_-]{43}$/u.test(input.attemptId)
    ) {
      throw new Error('Rally sign-in must use the Global identity service.');
    }
    const attempt = browserAuthAttempts.get(input.attemptId);
    if (
      !attempt
      || attempt.expiresAt <= Date.now()
      || attempt.apiBaseUrl !== input.apiBaseUrl
      || attempt.region !== input.region
    ) {
      browserAuthAttempts.delete(input.attemptId);
      throw new Error('This sign-in attempt expired. Start sign-in again.');
    }
    const session = await browserSessionRequest(
      input.apiBaseUrl,
      '/auth/desktop/exchange',
      {
        ticket: input.ticket,
        region: input.region,
        attemptId: input.attemptId,
        codeVerifier: attempt.verifier,
      },
      (identitySession) => {
        if (browserAuthAttempts.get(input.attemptId) !== attempt) {
          throw new Error('A newer Rally sign-in attempt replaced this callback.');
        }
        if (identitySession.workspace) {
          throw new Error('Rally sign-in returned a workspace before platform discovery.');
        }
      },
    );
    browserAuthAttempts.delete(input.attemptId);
    return session;
  },
  async createDevelopmentSession(apiBaseUrl, workspaceName) {
    return browserSessionRequest(apiBaseUrl, '/auth/dev/session', { workspaceName });
  },
  async refreshSession() {
    if (!browserSession || !browserRefreshToken) throw new Error('No session is available to refresh');
    return browserSessionRequest(browserSession.apiBaseUrl, '/auth/refresh', { refreshToken: browserRefreshToken });
  },
  async hasStoredCredential() {
    return browserRefreshToken !== null;
  },
  async logout() {
    browserSession = null;
    browserRefreshToken = null;
    browserAuthAttempts.clear();
    notifyBrowserSession();
  },
  async getAccountOnboarding() {
    return AccountOnboardingSchema.parse(await browserOnboardingRequest('/onboarding/account'));
  },
  async updateAccountOnboarding(input) {
    return AccountOnboardingSchema.parse(await browserOnboardingRequest('/onboarding/account', {
      method: 'PATCH', body: UpdateAccountOnboardingSchema.parse(input),
    }));
  },
  async getOnboardingState() {
    // The browser holds no stored set to merge and no identity credential to
    // lose: a discovery it can make is the whole directory.
    const state = await browserOnboardingRequest<Omit<DesktopWorkspaceOnboardingState, 'identity'>>('/onboarding');
    return { ...state, identity: 'connected' as const };
  },
  async getWorkspaceAttention({ region, workspaceId }) {
    if (
      !browserSession?.workspace
      || browserSession.workspace.id !== workspaceId
      || browserSession.workspace.region !== region
    ) {
      throw new Error('The browser keeps only its active workspace session.');
    }
    const response = await fetch(`${browserSession.apiBaseUrl}/workspace/attention`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${browserSession.accessToken}` },
    });
    if (!response.ok) throw new Error(`Workspace attention failed (${response.status})`);
    return response.json();
  },
  async leaveWorkspace({ expectedOutcome, region, workspaceId }) {
    if (
      !browserSession?.workspace
      || browserSession.workspace.id !== workspaceId
      || browserSession.workspace.region !== region
    ) {
      throw new Error('The browser keeps only its active workspace session.');
    }
    const response = await fetch(
      `${browserSession.apiBaseUrl}/workspaces/${encodeURIComponent(workspaceId)}/membership`
        + `?expectedOutcome=${expectedOutcome}`,
      {
        method: 'DELETE',
        headers: { Accept: 'application/json', Authorization: `Bearer ${browserSession.accessToken}` },
      },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(payload?.message ?? `Leaving the workspace failed (${response.status})`);
    }
    const departure = await response.json();
    browserSession = null;
    browserRefreshToken = null;
    notifyBrowserSession();
    return departure;
  },
  async surrenderActiveWorkspace() {
    browserSession = null;
    browserRefreshToken = null;
    notifyBrowserSession();
    return null;
  },
  async reselectActiveWorkspace({ region, workspaceId }) {
    const workspace = browserSession?.workspace;
    return workspace && workspace.id === workspaceId && workspace.region === region
      ? browserSession
      : null;
  },
  async activateWorkspace({ region, workspaceId }) {
    return browserOnboardingSession(
      '/onboarding/workspace/activate',
      { region, workspaceId },
      { region, workspaceId },
    );
  },
  async createWorkspace({ region, name }) {
    return browserOnboardingSession('/onboarding/workspace', { region, name }, { region });
  },
  async acceptInvitation({ region, invitationId }) {
    return browserOnboardingSession(
      `/onboarding/invitations/${encodeURIComponent(invitationId)}/accept`,
      { region },
      { region },
    );
  },
  async declineInvitation({ region, invitationId }) {
    await browserOnboardingRequest<void>(
      `/onboarding/invitations/${encodeURIComponent(invitationId)}/decline`,
      { method: 'POST', body: { region } },
    );
  },
  async copyText(text) {
    await navigator.clipboard.writeText(text);
  },
  async setConversationDetailsOpen() {
    // A browser tab cannot resize its own top-level window. The attached rail
    // still opens inside the viewport, which is the browser-safe fallback.
  },
  async exportMessage() {
    // Rendering a card and choosing where it goes are both main-process work.
    // A browser has neither, and the buttons that call this are hidden there.
    throw new Error('Saving a message needs the Rally desktop application.');
  },
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  // The browser build has no main process to composite a view, and an iframe
  // is exactly what the desktop's design refuses. So the preview is absent
  // rather than approximated: `present` answers `false`, and the rail shows the
  // same "open it in your browser" state it shows when a preview cannot render.
  async presentArtifactPreview() {
    return false;
  },
  async setArtifactPreviewBounds() {
    // Nothing is composited, so there is nothing to move.
  },
  async setArtifactPreviewHidden() {
    // Nothing is composited, so there is nothing to hide.
  },
  async closeArtifactPreview() {
    // Nothing is composited, so there is nothing to tear down.
  },
  async popOutArtifact(request) {
    window.open(request.url, '_blank', 'noopener,noreferrer');
  },
  async openSidekicks(requested) {
    const target = new URL(window.location.href);
    target.searchParams.set('surface', 'sidekicks');
    target.hash = requested ? `/sidekicks/${encodeURIComponent(requested)}` : '/sidekicks';
    if (browserSidekicksWindow && !browserSidekicksWindow.closed) {
      browserSidekicksWindow.location.href = target.toString();
      browserSidekicksWindow.focus();
      return;
    }
    // Open a same-origin blank window, sever its opener before navigating, and
    // retain our reference: noopener would discard the named-window reuse.
    browserSidekicksWindow = window.open('about:blank', 'rally-sidekicks');
    if (browserSidekicksWindow) {
      browserSidekicksWindow.opener = null;
      browserSidekicksWindow.location.href = target.toString();
    }
  },
  async openSettings(section) {
    const target = section ? `/settings?section=${encodeURIComponent(section)}` : '/settings';
    window.location.hash = `#${target}`;
  },
  async openMeetingNotes(noteId) {
    const target = new URL(window.location.href);
    target.search = new URLSearchParams({
      surface: 'meeting',
      noteId: noteId ?? crypto.randomUUID(),
    }).toString();
    target.hash = '/meeting';
    window.open(target.toString(), '_blank', 'noopener,noreferrer,width=1120,height=820');
  },
  async observeClientFeatureFlags() {
    // Browser development has no main-process-only surfaces to synchronize.
  },
  async closeMeetingNotes(noteId) {
    // A browser tab has no sibling window to hand the note to; the opener may
    // not even be reachable. Closing is the whole of what this can do here.
    void noteId;
    window.close();
  },
  async setMeetingRecordingState() {
    // Browser development has no main-process workspace switch coordinator.
  },
  async getMeetingAudioPermissions() {
    return { microphone: 'unknown', systemAudio: 'unknown' };
  },
  async prepareMeetingAudioPermissions() {
    return { microphone: 'unknown', systemAudio: 'unknown' };
  },
  async startMeetingSystemAudioCapture() {
    throw new Error('Native computer audio capture is available only in the Rally desktop app.');
  },
  async stopMeetingSystemAudioCapture() {
    // No native capture exists in a browser tab.
  },
  onMeetingSystemAudioData() {
    return () => undefined;
  },
  async openMeetingAudioSettings() {
    // Browser permission recovery is owned by the browser chrome rather than
    // an operating-system settings pane Rally can open directly.
  },
  onMeetingCloseRequested() {
    return () => undefined;
  },
  onSettingsSectionRequested() {
    return () => undefined;
  },
  async showDeepLinkError() {
    // No second window to open in a browser tab; the caller falls back to the
    // inline message it holds.
    throw new Error('Rally cannot open a window here.');
  },
  async getDeepLinkError() {
    return null;
  },
  onDeepLinkErrorChanged() {
    return () => undefined;
  },
  async dismissDeepLinkError() {
    // Nothing to dismiss: this bridge never opened a window.
  },
  async consumePendingDeepLinks() {
    return [];
  },
  onDeepLink() {
    return () => undefined;
  },
  onSessionChanged(listener) {
    browserSessionListeners.add(listener);
    return () => browserSessionListeners.delete(listener);
  },
  async openRealtimeSocket() {
    throw new Error('The realtime socket broker is available only in the Rally desktop app.');
  },
  async sendRealtimeSocket() {
    throw new Error('The realtime socket broker is available only in the Rally desktop app.');
  },
  async closeRealtimeSocket() {
    throw new Error('The realtime socket broker is available only in the Rally desktop app.');
  },
  onRealtimeSocketEvent() {
    return () => undefined;
  },
};

export function desktopBridge(): RallyDesktopBridge {
  if (window.rally) return window.rally;
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return browserBridge;
  throw new Error('Rally desktop services did not load. Reopen the application.');
}

/**
 * Whether the privileged bridge is actually there. Only for affordances that a
 * browser cannot honour at all — saving a file to a chosen place is the one — so
 * that they are absent rather than present and failing.
 */
export function desktopServicesAvailable(): boolean {
  return Boolean(window.rally);
}
