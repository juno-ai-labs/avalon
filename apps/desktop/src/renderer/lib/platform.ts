import type {
  AvalonDesktopBridge,
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
const browserApplicationSettings = { lockdownMode: false, lockdownAvailable: false };
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
    throw new Error('Avalon sign-in must use the Global identity service.');
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
    throw new Error('Avalon rejected a session issued for an unexpected service.');
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
  options: { body?: unknown; method?: 'GET' | 'POST' } = {},
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
    throw new Error('Avalon rejected a workspace session that did not match this organization request.');
  }
  return installBrowserSession(raw, browserGlobalApiBaseUrl());
}

const browserBridge: AvalonDesktopBridge = {
  async getRuntimeConfig() {
    return {
      appVersion: 'development',
      isPackaged: false,
      platform: 'browser',
      api: {
        global: import.meta.env.VITE_API_GLOBAL_URL ?? 'http://127.0.0.1:8787',
        eu: import.meta.env.VITE_API_EU_URL ?? 'http://127.0.0.1:8788',
      },
      devAuthEnabled: import.meta.env.DEV,
    } as RuntimeConfig;
  },
  async getApplicationSettings() {
    return browserApplicationSettings;
  },
  async setLockdownMode(enabled) {
    if (enabled) throw new Error('Lockdown mode is available only in the Avalon desktop app.');
    return browserApplicationSettings;
  },
  onApplicationSettingsChanged() {
    return () => undefined;
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
      throw new Error('Avalon sign-in must use the Global identity service.');
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
          throw new Error('A newer Avalon sign-in attempt replaced this callback.');
        }
        if (identitySession.workspace) {
          throw new Error('Avalon sign-in returned a workspace before platform discovery.');
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
  async logout() {
    browserSession = null;
    browserRefreshToken = null;
    browserAuthAttempts.clear();
    notifyBrowserSession();
  },
  async getOnboardingState() {
    return browserOnboardingRequest<DesktopWorkspaceOnboardingState>('/onboarding');
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
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
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
  onSettingsSectionRequested() {
    return () => undefined;
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
};

export function desktopBridge(): AvalonDesktopBridge {
  if (window.avalon) return window.avalon;
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return browserBridge;
  throw new Error('Avalon desktop services did not load. Reopen the application.');
}
