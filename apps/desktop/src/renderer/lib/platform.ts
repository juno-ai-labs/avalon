import { AccountOnboardingSchema, OrganizationNameSuggestionSchema, UpdateAccountOnboardingSchema } from '@rally/contracts';
import type { Region } from "@rally/contracts/regions";
import { configuredRegions, regionConfiguration } from "@rally/contracts/regions";
import {
  automaticApplicationIcon,
  parseApplicationIconId,
  type DesktopApplicationIconState,
} from '../../common/application-icons';
import type {
  RallyDesktopBridge,
  DesktopArtifactWindowRequest,
  DesktopApplicationSettings,
  DesktopAuthAttempt,
  DesktopSession,
  DesktopWorkspaceOnboardingState,
  RuntimeConfig,
} from '../../common/desktop';
import { generatedArtifactWindowDocument } from '../../common/generated-artifact-window';
import { defaultDesktopReleaseChannel } from '../../common/release-channels';

export type { DesktopWorkspaceOnboardingState } from '../../common/desktop';

let browserSession: DesktopSession | null = null;
let browserRefreshToken: string | null = null;
const browserApplicationSettings: DesktopApplicationSettings = {
  releaseChannel: defaultDesktopReleaseChannel,
  releaseChannelAvailable: false,
  lockdownMode: false,
  lockdownAvailable: false,
  debugEnabled: false,
  // The browser fallback has no main process to poll the service, so the
  // Developer section is simply not on offer there.
  developerSettingsAvailable: false,
  // A tab has no status item. The preference reads as on so the desktop and the
  // browser agree about what the stored default is, and unavailable so the
  // toggle is offered nowhere it cannot work.
  pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
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
/**
 * The count this tab's shell last reported for the installed app's icon, or
 * null before the first. The icon is one for every tab, so only the tab that
 * holds it writes: the focused tab, or the one focused last. A tab that gains
 * focus or becomes visible takes it and puts its own count back.
 */
let browserAppBadgeCount: number | null = null;
const browserAppBadgeOwnerKey = 'rally.app-badge-owner';
const browserTabId = Math.random().toString(36).slice(2);
const browserSessionListeners = new Set<(session: DesktopSession | null) => void>();
const browserArtifactWindows = new Map<Window, { resourceId: string; version: number }>();
const browserAuthAttempts = new Map<string, {
  apiBaseUrl: string;
  region: Region;
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

async function createBrowserAuthAttempt(apiBaseUrl: string, region: Region): Promise<DesktopAuthAttempt> {
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

function browserArtifactWindowUrl(request: DesktopArtifactWindowRequest): string {
  return request.kind === 'site'
    ? request.url
    : URL.createObjectURL(new Blob(
      [generatedArtifactWindowDocument(request)],
      { type: 'text/html;charset=utf-8' },
    ));
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

function browserApiBaseUrl(region: Region): string {
  if (region === 'global') return browserGlobalApiBaseUrl();
  const config = regionConfiguration(region);
  return import.meta.env[`VITE_API_${config.bindingPrefix}_URL`] ?? config.localApiUrl;
}

function normalizeApiBaseUrl(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(/\/+$/u, '') : null;
}

async function browserOnboardingRequest<T>(
  path: string,
  options: { body?: unknown; method?: 'GET' | 'POST' | 'PATCH' } = {},
): Promise<T> {
  if (!browserSession) throw new Error('Sign in before continuing organization setup.');
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
    throw new Error(payload?.message ?? `Organization setup failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function browserOnboardingSession(
  path: string,
  body: unknown,
  expected: { region: Region; workspaceId?: string },
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
    throw new Error('Rally rejected an organization session that did not match this organization request.');
  }
  return installBrowserSession(raw, browserGlobalApiBaseUrl());
}

function setBrowserAppBadge(count: number): Promise<void> {
  return count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
}

function holdsBrowserAppBadge(): boolean {
  if (document.hasFocus()) return true;
  try {
    const owner = localStorage.getItem(browserAppBadgeOwnerKey);
    return owner === null || owner === browserTabId;
  } catch {
    return false;
  }
}

function takeBrowserAppBadge(): void {
  try {
    localStorage.setItem(browserAppBadgeOwnerKey, browserTabId);
  } catch {
    // Without storage only the focused tab writes.
  }
  void setBrowserAppBadge(browserAppBadgeCount ?? 0).catch(() => undefined);
}

const browserBridge: RallyDesktopBridge = {
  async getRuntimeConfig() {
    return {
      appVersion: 'development',
      isPackaged: false,
      platform: 'browser',
      api: Object.fromEntries(configuredRegions.map((region) => [region, browserApiBaseUrl(region)])),
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
  onPowerStateChanged(listener) {
    // A tab is told nothing about the machine sleeping, but Chromium freezes a
    // hidden tab and resumes it later, and its sockets may not survive. The
    // Page Lifecycle events stand in for main's suspend and resume, so the
    // workspace socket closes cleanly and dials again rather than waiting on a
    // heartbeat. Browsers without them never fire either.
    let paused = false;
    const suspended = (): void => {
      if (paused) return;
      paused = true;
      listener('suspended');
    };
    const resumed = (): void => {
      paused = false;
      listener('resumed');
    };
    // Safari restores pages from its back/forward cache without Chromium's
    // freeze/resume events. Chrome may deliver both pairs; resume only once.
    const pageHidden = (event: PageTransitionEvent): void => { if (event.persisted) suspended(); };
    const pageShown = (event: PageTransitionEvent): void => { if (event.persisted && paused) resumed(); };
    document.addEventListener('freeze', suspended);
    document.addEventListener('resume', resumed);
    window.addEventListener('pagehide', pageHidden);
    window.addEventListener('pageshow', pageShown);
    return () => {
      document.removeEventListener('freeze', suspended);
      document.removeEventListener('resume', resumed);
      window.removeEventListener('pagehide', pageHidden);
      window.removeEventListener('pageshow', pageShown);
    };
  },
  async getUpdateStatus() {
    return { kind: 'idle' } as const;
  },
  async checkForUpdates() {
    // Browser clients have no desktop updater.
  },
  onUpdateStatusChanged() {
    // The browser build has no updater.
    return () => undefined;
  },
  async installDownloadedUpdate() {
    // Nothing is ever downloaded outside the desktop app.
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
  async setPushNotificationsEnabled() { return this.getApplicationSettings(); },
  async openNotificationSettings() {},
  async setDockBadgeCount(count) {
    // The Badging API marks an installed app's icon (a Home Screen app on
    // iPhone and iPad); a plain tab has none, and browsers ignore the call.
    if (!('setAppBadge' in navigator)) return;
    if (browserAppBadgeCount === null) {
      window.addEventListener('focus', takeBrowserAppBadge);
      // A Home Screen app on iPhone and iPad returns from the background
      // visible, without a focus event.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') takeBrowserAppBadge();
      });
    }
    browserAppBadgeCount = count;
    if (!holdsBrowserAppBadge()) return;
    await setBrowserAppBadge(count);
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
  async setReleaseChannel() {
    throw new Error('Update channels are available only in the Rally desktop app.');
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
          throw new Error('Rally sign-in returned an organization before platform discovery.');
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
  async getOrganizationNameSuggestion() {
    return OrganizationNameSuggestionSchema.parse(await browserOnboardingRequest('/onboarding/organization-suggestion'));
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
      throw new Error('The browser keeps only its active organization session.');
    }
    const response = await fetch(`${browserSession.apiBaseUrl}/workspace/attention`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${browserSession.accessToken}` },
    });
    if (!response.ok) throw new Error(`Organization attention failed (${response.status})`);
    return response.json();
  },
  async leaveWorkspace({ expectedOutcome, region, workspaceId }) {
    if (
      !browserSession?.workspace
      || browserSession.workspace.id !== workspaceId
      || browserSession.workspace.region !== region
    ) {
      throw new Error('The browser keeps only its active organization session.');
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
      throw new Error(payload?.message ?? `Leaving the organization failed (${response.status})`);
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
  // Rally access runs through the Mac app's main process or the browser
  // app's cookie routes; this development stand-in offers none.
  async listSupportWorkspaces() {
    return null;
  },
  async listSupportPeople() {
    return [];
  },
  async startSupportSession() {
    throw new Error('Rally access is not available here.');
  },
  async endSupportSession() {
    return browserSession;
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
  async showDefinitionForSelection() {
    // Dictionary is a macOS main-process affordance; a tab has none.
  },
  async shareText() {
    // The system share sheet is a macOS main-process affordance; a tab has none.
  },
  async getEmbeddedBrowserState() {
    return { tabs: [], activeTabId: null };
  },
  async commandEmbeddedBrowser() {
    throw new Error('The embedded browser needs the Rally desktop application.');
  },
  async setEmbeddedBrowserBounds() {},
  async setEmbeddedBrowserVisible() {},
  onEmbeddedBrowserState() {
    return () => undefined;
  },
  onEmbeddedBrowserHostRequest() {
    return () => undefined;
  },
  async openBrowserImport() {
    throw new Error('The import browser needs the Rally desktop application.');
  },
  async getBrowserImportContext() {
    return null;
  },
  onBrowserImportContextChanged() {
    return () => undefined;
  },
  onOrganizationListRefreshRequested() {
    return () => undefined;
  },
  async completeBrowserImport() {},
  async reportBrowserImport() {},
  onBrowserImportProgress() {
    return () => undefined;
  },
  async exportMessage() {
    // Rendering a card and choosing where it goes are both main-process work.
    // A browser has neither, and the buttons that call this are hidden there.
    throw new Error('Saving a message needs the Rally desktop application.');
  },
  async openExternal(url) {
    // A new tab keeps the person's place, including an authorization the
    // caller records once this returns. Open it blank and cut its opener
    // before it loads the page, so the page never holds this window. A
    // blocked popup is an error the caller shows, never a navigation away.
    const opened = window.open('', '_blank');
    if (!opened) throw new Error('Allow pop-ups for Rally in this browser, then try again.');
    opened.opener = null;
    opened.location.href = url;
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
  async snapshotArtifactPreview() {
    // Nothing is composited, so there is nothing to take.
    return null;
  },
  async closeArtifactPreview() {
    // Nothing is composited, so there is nothing to tear down.
  },
  async popOutArtifact(request) {
    const url = browserArtifactWindowUrl(request);
    const opened = window.open('about:blank', '_blank');
    if (!opened) {
      if (request.kind === 'generated') URL.revokeObjectURL(url);
      return false;
    }
    opened.opener = null;
    browserArtifactWindows.set(opened, { resourceId: request.resourceId, version: request.version });
    if (request.kind === 'generated') {
      opened.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    }
    opened.location.href = url;
    return true;
  },
  async getRestorableArtifactWindows() { return []; },
  async forgetRestorableArtifactWindow() { /* Browser windows have no native saved geometry. */ },
  async getPoppedOutArtifactVersions() {
    const versions: Record<string, number> = {};
    for (const [opened, artifact] of browserArtifactWindows) {
      if (opened.closed) {
        browserArtifactWindows.delete(opened);
        continue;
      }
      const current = versions[artifact.resourceId];
      versions[artifact.resourceId] = current === undefined
        ? artifact.version
        : Math.min(current, artifact.version);
    }
    return versions;
  },
  async updatePoppedOutArtifact(request) {
    const opened = [...browserArtifactWindows.entries()]
      .filter(([candidate, artifact]) => !candidate.closed
        && artifact.resourceId === request.resourceId
        && artifact.version < request.version);
    if (opened.length === 0) {
      return false;
    }
    const [candidate, previous] = opened[0]!;
    const url = browserArtifactWindowUrl(request);
    if (request.kind === 'generated') {
      candidate.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    }
    // Reserve before navigation so an older asynchronous refresh cannot
    // overwrite the version after a newer refresh has already arrived.
    browserArtifactWindows.set(candidate, { resourceId: request.resourceId, version: request.version });
    try {
      candidate.location.href = url;
    } catch (error) {
      browserArtifactWindows.set(candidate, previous);
      if (request.kind === 'generated') URL.revokeObjectURL(url);
      throw error;
    }
    return opened.length > 1;
  },
  // A tab cannot keep a second window, so Sidekicks is a route of this one,
  // as Settings is. See `window-surface.ts`.
  async openSidekicks(requested) {
    window.location.hash = requested ? `#/sidekicks/${encodeURIComponent(requested)}` : '#/sidekicks';
  },
  // The library is a route of this tab, so opening a Thread is navigating to it.
  async openThread(workstreamId) {
    window.location.hash = `#/workstreams/${encodeURIComponent(workstreamId)}`;
  },
  async openSettings(section) {
    const target = section ? `/settings?section=${encodeURIComponent(section)}` : '/settings';
    window.location.hash = `#${target}`;
  },
  async startSystemAudioCapture() {
    throw new Error('Native computer audio capture is available only in the Rally desktop app.');
  },
  async stopSystemAudioCapture() {
    // No native capture exists in a browser tab.
  },
  onSystemAudioData() {
    return () => undefined;
  },
  onSettingsSectionRequested() {
    return () => undefined;
  },
  onSettingsWindowRevealed() {
    return () => undefined;
  },
  // A browser tab is one window: Settings is a route inside it, sharing the one
  // socket, so there is nothing to relay and nobody to relay to.
  async publishWorkspaceSync() {
    // Nothing listens.
  },
  async requestWorkspaceConversationView() {},
  async getWorkspaceSyncSource() {
    return { revision: 0, source: null };
  },
  onWorkspaceSyncRelayed() {
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

let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

/**
 * One `getRuntimeConfig()` for the window. Platform cannot change for the
 * life of the process, so each feed body must not open its own IPC.
 */
export function desktopRuntimeConfig(): Promise<RuntimeConfig> {
  runtimeConfigPromise ??= desktopBridge().getRuntimeConfig().catch((error: unknown) => {
    runtimeConfigPromise = null;
    throw error;
  });
  return runtimeConfigPromise;
}

/**
 * Whether the privileged bridge is actually there. Only for affordances that a
 * browser cannot honour at all — saving a file to a chosen place is the one — so
 * that they are absent rather than present and failing.
 */
export function desktopServicesAvailable(): boolean {
  return Boolean(window.rally);
}
