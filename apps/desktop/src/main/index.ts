import {
  ActivateWorkspaceRequestSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
  SessionSchema,
  WorkspaceOnboardingStateSchema,
  type Session as WireSession,
} from '@avalon/contracts';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session as electronSession,
  shell,
} from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type {
  AvalonRegion,
  DesktopSession,
  DesktopWorkspaceOnboardingState,
  RuntimeConfig,
} from '../common/desktop';
import { parseDesktopSettingsSection } from '../common/settings';
import type { DesktopSettingsSection } from '../common/settings';
import {
  definitivelyInvalidatesStoredCredential,
  responseError,
} from './api-response-error';
import { DesktopAuthAttemptStore } from './desktop-auth-attempts';
import { applicationMenuTemplate } from './application-menu';
import { allowsTrustedAudioCapture } from './media-permission';
import {
  migrateLegacyUserDataStoredSessionFile,
  migrateLegacyStoredSessionFile,
  readStoredAuthFile,
  readStoredProfileFile,
  readStoredSessionFile,
  removeStoredStateFiles,
  removeStoredSessionFiles,
  tombstoneStoredStateFiles,
  writeStoredAuthFile,
  writeStoredProfileFile,
} from './session-file';
import {
  parseStoredAuth,
  parseStoredProfile,
  sessionFromStoredState,
  sessionsShareBinding,
  storedAuthFromSession,
  storedProfileFromSession,
  type StoredAuth,
} from './stored-auth';
import { parseLegacyStoredSession } from './stored-session';
import {
  initializeAutoUpdate,
  type AutoUpdateController,
  type UpdateStatus,
} from './updater';
import {
  legacyPackagedUserDataDirectory,
  userDataDirectoryForLaunch,
} from './user-data-path';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
// Never let inherited development environment variables choose the renderer
// or API origins of an installed app. The preload bridge is privileged, so a
// packaged build must remain pinned to its embedded renderer and Avalon hosts.
const rendererDevelopmentUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const allowedExternalProtocols = new Set(['https:', 'http:']);
const customProtocol = 'avalon';
const rendererProtocol = 'app';
const rendererHost = 'avalon';
const UPDATE_SESSION_SETTLE_TIMEOUT_MS = 5_000;

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let rendererReady = false;
let inMemoryAuth: StoredAuth | null = null;
let inMemorySession: WireSession | null = null;
let refreshInFlight: Promise<DesktopSession> | null = null;
let sessionMutationTail: Promise<void> = Promise.resolve();
let sessionLifecycleEpoch = 0;
let loggingOut = false;
let updateStatus: UpdateStatus = { kind: 'idle' };
let autoUpdateController: AutoUpdateController | null = null;
let updateInstallationPending = false;
const pendingDeepLinks: string[] = [];
const hardenedWebContents = new WeakSet<WebContents>();
const desktopAuthAttempts = new DesktopAuthAttemptStore();

protocol.registerSchemesAsPrivileged([{
  scheme: rendererProtocol,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

// Keep development credentials and user data out of the production Avalon
// namespace. Development Electron binaries are not signed with the stable
// release identity, so sharing `Avalon Safe Storage` would make macOS re-prompt
// whenever their ad-hoc code requirement changes.
app.setName(app.isPackaged ? 'Avalon' : 'Avalon Development');
const appDataDirectory = app.getPath('appData');
app.setPath(
  'userData',
  userDataDirectoryForLaunch(
    appDataDirectory,
    app.isPackaged,
    app.commandLine.getSwitchValue('user-data-dir'),
  ),
);

function userDataDirectory(): string {
  return app.getPath('userData');
}

function publicSession(value: WireSession): DesktopSession {
  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    apiBaseUrl: value.apiBaseUrl,
    user: {
      id: value.user.id,
      email: value.user.email,
      name: value.user.name,
      timezone: value.user.timezone,
      ...(value.user.avatarUrl ? { avatarUrl: value.user.avatarUrl } : {}),
    },
    workspace: value.workspace
      ? {
          id: value.workspace.id,
          name: value.workspace.name,
          region: value.workspace.region,
          role: value.workspace.role,
          timezone: value.workspace.timezone,
        }
      : null,
  };
}

function broadcastSessionChanged(value: WireSession | null): void {
  const exposed = value ? publicSession(value) : null;
  for (const window of [mainWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('session:changed', exposed);
  }
}

async function withSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = sessionMutationTail;
  let release!: () => void;
  sessionMutationTail = new Promise<void>((resolveMutation) => {
    release = resolveMutation;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

function regionForStoredSession(value: WireSession): AvalonRegion {
  const region = value.workspace?.region ?? 'global';
  if (runtimeConfig().api[region] !== value.apiBaseUrl) {
    throw new Error('The session endpoint does not match its credential binding');
  }
  return region;
}

function apiBaseForAuth(auth: StoredAuth): string {
  return runtimeConfig().api[auth.binding.region];
}

async function writeSplitSessionFiles(value: WireSession): Promise<StoredAuth> {
  const auth = storedAuthFromSession(value, regionForStoredSession(value));
  if (safeStorage.isEncryptionAvailable()) {
    // Credentials are the durable boundary. Write them before the disposable
    // profile cache so an interrupted update can always recover by refreshing.
    await writeStoredAuthFile(
      userDataDirectory(),
      safeStorage.encryptString(JSON.stringify(auth)),
    );
    await writeStoredProfileFile(
      userDataDirectory(),
      safeStorage.encryptString(JSON.stringify(storedProfileFromSession(value))),
    );
    try {
      await removeStoredSessionFiles(userDataDirectory());
    } catch {
      // The split credential is authoritative. Logout still removes or
      // tombstones every legacy location before another launch can use it.
    }
  }
  return auth;
}

async function persistSessionUnlocked(value: WireSession): Promise<void> {
  inMemoryAuth = await writeSplitSessionFiles(value);
  inMemorySession = value;
  broadcastSessionChanged(value);
}

async function persistSession(value: WireSession): Promise<void> {
  await withSessionMutation(() => persistSessionUnlocked(value));
}

async function migrateLegacySessionToSplitStorage(): Promise<StoredAuth | null> {
  try {
    const encrypted = await readStoredSessionFile(userDataDirectory());
    const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    const legacySession = parseLegacyStoredSession(parsed);
    if (!legacySession) {
      console.warn('[avalon] the legacy desktop session did not match its durable schema');
      return null;
    }
    const auth = await writeSplitSessionFiles(legacySession);
    inMemoryAuth = auth;
    inMemorySession = legacySession;
    return auth;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      console.warn('[avalon] could not migrate the encrypted desktop session', error);
    }
    return null;
  }
}

async function loadStoredAuth(): Promise<StoredAuth | null> {
  if (inMemoryAuth) return inMemoryAuth;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = await readStoredAuthFile(userDataDirectory());
    const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    const auth = parseStoredAuth(parsed);
    if (!auth) {
      console.warn('[avalon] the stored desktop credential did not match its durable schema');
      return null;
    }
    inMemoryAuth = auth;
    return auth;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return migrateLegacySessionToSplitStorage();
    console.warn('[avalon] could not restore the stored desktop credential', error);
    return null;
  }
}

async function loadStoredSession(): Promise<WireSession | null> {
  if (inMemorySession) return inMemorySession;
  const auth = await loadStoredAuth();
  if (!auth) return null;
  if (inMemorySession) return inMemorySession;
  try {
    const encrypted = await readStoredProfileFile(userDataDirectory());
    const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    const profile = parseStoredProfile(parsed);
    if (!profile) {
      console.warn('[avalon] discarding an incompatible desktop profile cache');
      return null;
    }
    const stored = sessionFromStoredState(auth, profile, apiBaseForAuth(auth));
    if (!stored) {
      console.warn('[avalon] discarding a desktop profile cache with a mismatched credential binding');
      return null;
    }
    inMemorySession = stored;
    return stored;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      console.warn('[avalon] could not restore the desktop profile cache', error);
    }
    return null;
  }
}

async function clearStoredSessionUnlocked(): Promise<void> {
  inMemoryAuth = null;
  inMemorySession = null;
  let failure: unknown;
  const directories = [
    userDataDirectory(),
    ...(app.isPackaged ? [legacyPackagedUserDataDirectory(appDataDirectory)] : []),
  ];
  for (const directory of directories) {
    try {
      await removeStoredStateFiles(directory);
    } catch (error) {
      let directoryFailure: unknown = error;
      // If deletion is blocked but the files are still writable, replace every
      // credential and private cache copy with a value that no schema accepts.
      if (safeStorage.isEncryptionAvailable()) {
        try {
          await tombstoneStoredStateFiles(directory, safeStorage.encryptString('{}'));
          directoryFailure = undefined;
        } catch {
          // Preserve this directory's original deletion error for the caller.
        }
      }
      if (directoryFailure !== undefined && failure === undefined) failure = directoryFailure;
    }
  }
  broadcastSessionChanged(null);
  if (failure) throw failure;
}

async function clearStoredSession(): Promise<void> {
  await withSessionMutation(clearStoredSessionUnlocked);
}

function parseApiUrl(value: string | undefined, fallback: string): string {
  const parsed = new URL(value ?? fallback);
  if (!allowedExternalProtocols.has(parsed.protocol)) {
    throw new Error(`Unsupported API URL protocol: ${parsed.protocol}`);
  }
  if (app.isPackaged && parsed.protocol !== 'https:') {
    throw new Error('Packaged Avalon API endpoints must use HTTPS');
  }
  return parsed.toString().replace(/\/$/u, '');
}

function runtimeConfig(): RuntimeConfig {
  const packaged = app.isPackaged;
  return {
    appVersion: app.getVersion(),
    isPackaged: packaged,
    platform: process.platform,
    api: {
      global: parseApiUrl(
        packaged ? undefined : process.env['VITE_API_GLOBAL_URL'],
        packaged ? 'https://api.with-avalon.com' : 'http://127.0.0.1:8787',
      ),
      eu: parseApiUrl(
        packaged ? undefined : process.env['VITE_API_EU_URL'],
        packaged ? 'https://eu.api.with-avalon.com' : 'http://127.0.0.1:8788',
      ),
    },
    devAuthEnabled: process.env['AVALON_DEV_AUTH'] !== 'false' && !app.isPackaged,
  };
}

function validatedApiBase(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') throw new Error('Invalid regional API endpoint');
  const normalized = new URL(rawUrl).toString().replace(/\/$/u, '');
  if (!Object.values(runtimeConfig().api).includes(normalized)) {
    throw new Error('The requested endpoint does not match an Avalon region');
  }
  return normalized;
}

async function requestSession(
  apiBaseUrl: string,
  path: string,
  body: unknown,
  accessToken?: string,
): Promise<WireSession> {
  const response = await net.fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  const parsed = SessionSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Avalon returned an invalid authentication session');
  const returnedApiBaseUrl = new URL(parsed.data.apiBaseUrl).toString().replace(/\/$/u, '');
  if (returnedApiBaseUrl !== apiBaseUrl) {
    throw new Error('The regional service returned a mismatched endpoint');
  }
  return { ...parsed.data, apiBaseUrl: returnedApiBaseUrl };
}

async function exchangeDesktopTicket(input: unknown): Promise<DesktopSession> {
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  if (loggingOut) throw new Error('Wait for Avalon to finish signing out before signing in again');
  if (!input || typeof input !== 'object') throw new Error('Invalid desktop sign-in payload');
  const candidate = input as { apiBaseUrl?: unknown; region?: unknown; ticket?: unknown; attemptId?: unknown };
  if (
    candidate.region !== 'global'
    || typeof candidate.ticket !== 'string'
    || !/^[A-Za-z0-9_-]{20,500}$/u.test(candidate.ticket)
    || typeof candidate.attemptId !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.attemptId)
  ) {
    throw new Error('Invalid desktop sign-in payload');
  }
  const apiBaseUrl = validatedApiBase(candidate.apiBaseUrl);
  if (apiBaseUrl !== runtimeConfig().api.global) {
    throw new Error('Avalon sign-in must use the platform identity endpoint');
  }
  const attempt = desktopAuthAttempts.proof(candidate.attemptId);
  if (!attempt) throw new Error('This sign-in attempt expired. Start sign-in again.');
  if (attempt.region !== candidate.region || attempt.apiBaseUrl !== apiBaseUrl) {
    throw new Error('The sign-in callback does not match the native authentication attempt');
  }
  const session = await requestSession(apiBaseUrl, '/auth/desktop/exchange', {
    ticket: candidate.ticket,
    region: candidate.region,
    attemptId: candidate.attemptId,
    codeVerifier: attempt.verifier,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
  });
  if (session.workspace) {
    throw new Error('Avalon sign-in returned a workspace before platform discovery');
  }
  if (session.apiBaseUrl !== apiBaseUrl) throw new Error('The regional service returned a mismatched endpoint');
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      desktopAuthAttempts.discard(candidate.attemptId as string);
      throw new Error('Avalon was signed out while sign-in was completing');
    }
    const currentAttempt = desktopAuthAttempts.proof(candidate.attemptId as string);
    if (
      !currentAttempt
      || currentAttempt.apiBaseUrl !== apiBaseUrl
      || currentAttempt.region !== candidate.region
    ) {
      throw new Error('A newer Avalon sign-in attempt replaced this callback');
    }
    if (await loadStoredAuth()) {
      desktopAuthAttempts.discard(candidate.attemptId as string);
      throw new Error('Another Avalon sign-in completed first');
    }
    // One successful PKCE attempt wins. Late callbacks from any other browser
    // tab must not replace the account that just signed in.
    desktopAuthAttempts.clear();
    await persistSessionUnlocked(session);
    return publicSession(session);
  });
}

function createDesktopAuthAttempt(input: unknown): { attemptId: string; codeChallenge: string } {
  if (!input || typeof input !== 'object') throw new Error('Invalid desktop authentication request');
  const candidate = input as { apiBaseUrl?: unknown; region?: unknown };
  if (candidate.region !== 'global') {
    throw new Error('Avalon uses one platform sign-in endpoint');
  }
  const apiBaseUrl = validatedApiBase(candidate.apiBaseUrl);
  if (apiBaseUrl !== runtimeConfig().api.global) {
    throw new Error('The authentication endpoint does not match Avalon sign-in');
  }
  // Starting over makes the newest browser flow authoritative. An older
  // callback can no longer win merely because it returns first.
  desktopAuthAttempts.clear();
  return desktopAuthAttempts.create(apiBaseUrl, candidate.region);
}

function cancelDesktopAuthAttempt(input: unknown): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input)) {
    throw new Error('Invalid desktop authentication attempt');
  }
  desktopAuthAttempts.discard(input);
}

async function createDevelopmentSession(input: unknown): Promise<DesktopSession> {
  if (!runtimeConfig().devAuthEnabled) throw new Error('Development authentication is unavailable');
  if (!input || typeof input !== 'object') throw new Error('Invalid development sign-in payload');
  const candidate = input as { apiBaseUrl?: unknown; workspaceName?: unknown };
  const apiBaseUrl = validatedApiBase(candidate.apiBaseUrl);
  if (typeof candidate.workspaceName !== 'string' || candidate.workspaceName.trim().length < 2 || candidate.workspaceName.length > 120) {
    throw new Error('Invalid organization name');
  }
  const session = await requestSession(apiBaseUrl, '/auth/dev/session', { workspaceName: candidate.workspaceName.trim() });
  if (
    !session.workspace
    || session.apiBaseUrl !== apiBaseUrl
    || runtimeConfig().api[session.workspace.region] !== apiBaseUrl
  ) {
    throw new Error('The development session returned a mismatched regional endpoint');
  }
  await persistSession(session);
  return publicSession(session);
}

async function requireOnboardingIdentitySession(): Promise<WireSession> {
  const stored = await loadStoredSession();
  if (!stored) throw new Error('Sign in to Avalon before setting up a workspace');
  if (stored.workspace) throw new Error('This Avalon account already has an active workspace');
  if (stored.apiBaseUrl !== runtimeConfig().api.global) {
    throw new Error('Workspace setup requires an Avalon platform identity session');
  }
  return stored;
}

async function getOnboardingState(): Promise<DesktopWorkspaceOnboardingState> {
  const identity = await requireOnboardingIdentitySession();
  const response = await net.fetch(`${runtimeConfig().api.global}/onboarding`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${identity.accessToken}`,
    },
  });
  if (!response.ok) throw await responseError(response);
  const parsed = WorkspaceOnboardingStateSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Avalon returned an invalid workspace setup response');
  const accountEmail = identity.user.email.toLocaleLowerCase('en-US');
  if (parsed.data.invitations.some((invitation) => invitation.email.toLocaleLowerCase('en-US') !== accountEmail)) {
    throw new Error('Avalon returned an invitation for another account');
  }
  return parsed.data;
}

async function requestOnboardingSession(
  path: string,
  body: unknown,
  expectedRegion: AvalonRegion,
  expectedWorkspaceId?: string,
): Promise<DesktopSession> {
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  const identity = await requireOnboardingIdentitySession();
  if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
    throw new Error('Avalon was signed out while organization setup was running');
  }
  const response = await net.fetch(`${runtimeConfig().api.global}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  const parsed = SessionSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.workspace) {
    throw new Error('Avalon returned an invalid regional workspace session');
  }
  const targetApiBaseUrl = validatedApiBase(parsed.data.apiBaseUrl);
  if (
    targetApiBaseUrl !== runtimeConfig().api[expectedRegion]
    || parsed.data.workspace.region !== expectedRegion
    || (expectedWorkspaceId !== undefined && parsed.data.workspace.id !== expectedWorkspaceId)
  ) {
    throw new Error('Avalon returned a workspace session for the wrong region');
  }
  if (parsed.data.user.email.toLocaleLowerCase('en-US') !== identity.user.email.toLocaleLowerCase('en-US')) {
    throw new Error('Avalon returned a workspace session for another account');
  }
  const session = { ...parsed.data, apiBaseUrl: targetApiBaseUrl };
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      throw new Error('Avalon was signed out while organization setup was running');
    }
    const current = await loadStoredSession();
    if (!current) throw new Error('Avalon was signed out while organization setup was running');
    if (current.workspace) {
      if (
        current.workspace.id === session.workspace!.id
        && current.workspace.region === session.workspace!.region
        && current.apiBaseUrl === session.apiBaseUrl
        && current.user.email.toLocaleLowerCase('en-US') === session.user.email.toLocaleLowerCase('en-US')
      ) {
        return publicSession(current);
      }
      throw new Error('Another organization session replaced this setup request');
    }
    if (
      current.apiBaseUrl !== runtimeConfig().api.global
      || current.user.email.toLocaleLowerCase('en-US') !== identity.user.email.toLocaleLowerCase('en-US')
    ) {
      throw new Error('The signed-in Avalon account changed during organization setup');
    }
    await persistSessionUnlocked(session);
    return publicSession(session);
  });
}

async function activateWorkspace(input: unknown): Promise<DesktopSession> {
  const parsed = ActivateWorkspaceRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid workspace activation request');
  return requestOnboardingSession(
    '/onboarding/workspace/activate',
    parsed.data,
    parsed.data.region,
    parsed.data.workspaceId,
  );
}

async function createWorkspace(input: unknown): Promise<DesktopSession> {
  const parsed = CreateWorkspaceRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid workspace creation request');
  return requestOnboardingSession('/onboarding/workspace', parsed.data, parsed.data.region);
}

function parseInvitationAction(input: unknown): { invitationId: string; region: AvalonRegion } {
  if (!input || typeof input !== 'object') throw new Error('Invalid workspace invitation request');
  const candidate = input as { invitationId?: unknown; region?: unknown };
  const invitationId = IdSchema.safeParse(candidate.invitationId);
  const region = OnboardingRegionRequestSchema.safeParse({ region: candidate.region });
  if (!invitationId.success || !region.success) throw new Error('Invalid workspace invitation request');
  return { invitationId: invitationId.data, region: region.data.region };
}

async function acceptInvitation(input: unknown): Promise<DesktopSession> {
  const parsed = parseInvitationAction(input);
  return requestOnboardingSession(
    `/onboarding/invitations/${encodeURIComponent(parsed.invitationId)}/accept`,
    { region: parsed.region },
    parsed.region,
  );
}

async function declineInvitation(input: unknown): Promise<void> {
  const parsed = parseInvitationAction(input);
  const identity = await requireOnboardingIdentitySession();
  const response = await net.fetch(
    `${runtimeConfig().api.global}/onboarding/invitations/${encodeURIComponent(parsed.invitationId)}/decline`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${identity.accessToken}`,
      },
      body: JSON.stringify({ region: parsed.region }),
    },
  );
  if (!response.ok) throw await responseError(response);
}

function storedAuthMatches(left: StoredAuth, right: StoredAuth): boolean {
  return left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.binding.userId === right.binding.userId
    && left.binding.workspaceId === right.binding.workspaceId
    && left.binding.region === right.binding.region;
}

async function refreshWireSession(): Promise<WireSession> {
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  const previousAuth = await loadStoredAuth();
  if (!previousAuth) throw new Error('No Avalon session is available to refresh');
  if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
    throw new Error('Avalon was signed out while the session was refreshing');
  }
  const apiBaseUrl = apiBaseForAuth(previousAuth);
  const session = await requestSession(
    apiBaseUrl,
    '/auth/refresh',
    { refreshToken: previousAuth.refreshToken },
    previousAuth.accessToken,
  );
  if (!sessionsShareBinding(session, previousAuth) || session.apiBaseUrl !== apiBaseUrl) {
    throw new Error('The refreshed session did not match the stored credential binding');
  }
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      throw new Error('Avalon was signed out while the session was refreshing');
    }
    const currentAuth = await loadStoredAuth();
    if (!currentAuth) throw new Error('Avalon was signed out while the session was refreshing');
    if (!storedAuthMatches(currentAuth, previousAuth)) {
      const current = await loadStoredSession();
      if (current) return current;
      throw new Error('A newer Avalon credential replaced this refresh request');
    }
    await persistSessionUnlocked(session);
    return session;
  });
}

async function refreshSession(): Promise<DesktopSession> {
  return publicSession(await refreshWireSession());
}

function coalescedRefreshSession(): Promise<DesktopSession> {
  if (updateInstallationPending) {
    return loadStoredSession().then((stored) => {
      if (!stored) throw new Error('No Avalon session is available while installing the update');
      return publicSession(stored);
    });
  }
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshSession().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function logout(): Promise<void> {
  // The renderer treats a failed expiry refresh as a reason to clear native
  // credentials. During updater shutdown, networking is expected to be torn
  // down; preserve the session for the replacement process instead.
  if (updateInstallationPending) return;
  sessionLifecycleEpoch += 1;
  loggingOut = true;
  desktopAuthAttempts.clear();
  const failures: unknown[] = [];
  try {
    const stored = await loadStoredAuth();
    try {
      await clearStoredSession();
    } catch (error) {
      failures.push(error);
    }
    settingsWindow?.close();
    if (stored) {
      try {
        const apiBaseUrl = apiBaseForAuth(stored);
        const response = await net.fetch(`${apiBaseUrl}/auth/logout`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${stored.accessToken}`,
          },
          body: JSON.stringify({ refreshToken: stored.refreshToken }),
        });
        if (!response.ok) throw await responseError(response);
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    loggingOut = false;
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Avalon signed out locally but could not finish every logout cleanup step');
  }
}

async function prepareForUpdateInstall(): Promise<void> {
  updateInstallationPending = true;
  if (refreshInFlight) {
    await new Promise<void>((resolvePreparation) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePreparation();
      };
      const timer = setTimeout(finish, UPDATE_SESSION_SETTLE_TIMEOUT_MS);
      void refreshInFlight!.then(finish, finish);
    });
  }
  // A slow request may still be in the network layer after the bounded wait,
  // but atomic file replacement keeps the last credential intact if Squirrel
  // terminates it. The server accepts that predecessor briefly on relaunch.
  await sessionMutationTail;
}

function rollBackFailedUpdateInstall(): void {
  updateInstallationPending = false;
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!allowedExternalProtocols.has(url.protocol)) return false;
    if (url.protocol === 'http:' && app.isPackaged) return false;
    return true;
  } catch {
    return false;
  }
}

function sendDeepLink(rawUrl: string): void {
  const connectorCompletion = (() => {
    try {
      const deepLink = new URL(rawUrl);
      const connectionId = deepLink.searchParams.get('connection');
      return deepLink.protocol === `${customProtocol}:`
        && deepLink.hostname === 'auth'
        && deepLink.pathname === '/complete'
        && connectionId !== null
        && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(connectionId)
        && deepLink.searchParams.get('status') === 'connected';
    } catch {
      return false;
    }
  })();
  const connectorSettingsWindow = connectorCompletion && settingsWindow && !settingsWindow.isDestroyed()
    ? settingsWindow
    : null;

  // Settings runs in its own renderer process and therefore has its own React
  // Query cache. Deliver connector completions to both renderers so the window
  // that initiated OAuth can refresh as soon as the provider redirect lands.
  // Authentication and invitation links remain exclusive to the main window.
  connectorSettingsWindow?.webContents.send('auth:deep-link', rawUrl);

  if (!mainWindow || !rendererReady) {
    if (!pendingDeepLinks.includes(rawUrl)) pendingDeepLinks.push(rawUrl);
    if ((!mainWindow || mainWindow.isDestroyed()) && app.isReady()) void createMainWindow();
    if (connectorSettingsWindow) {
      if (connectorSettingsWindow.isMinimized()) connectorSettingsWindow.restore();
      connectorSettingsWindow.show();
      connectorSettingsWindow.focus();
    }
    return;
  }
  mainWindow.webContents.send('auth:deep-link', rawUrl);
  const targetWindow = connectorSettingsWindow ?? mainWindow;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
}

function emitDeepLink(rawUrl: string): void {
  try {
    const deepLink = new URL(rawUrl);
    const isAuthentication = deepLink.protocol === `${customProtocol}:`
      && deepLink.hostname === 'auth'
      && deepLink.pathname === '/complete';
    const isWorkstream = deepLink.protocol === `${customProtocol}:`
      && deepLink.hostname === 'workstreams'
      && /^\/[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(deepLink.pathname);
    const isInvitation = deepLink.protocol === `${customProtocol}:`
      && deepLink.hostname === 'invitations'
      && deepLink.pathname === '/accept'
      && deepLink.searchParams.get('token') !== null
      && (deepLink.searchParams.get('region') === 'global' || deepLink.searchParams.get('region') === 'eu');
    const isSettings = deepLink.protocol === `${customProtocol}:`
      && deepLink.hostname === 'settings'
      && (deepLink.pathname === '/workspace' || deepLink.pathname === '/connections')
      && deepLink.search === '';
    const isAutomation = deepLink.protocol === `${customProtocol}:`
      && deepLink.hostname === 'automations'
      && deepLink.pathname === '/new'
      && deepLink.search === '';
    const isSlackLink = deepLink.protocol === `${customProtocol}:`
      && deepLink.hostname === 'slack'
      && deepLink.pathname === '/link'
      && /^[A-Za-z0-9_-]{20,500}$/u.test(deepLink.searchParams.get('token') ?? '')
      && [...deepLink.searchParams.keys()].every((key) => key === 'token')
      && deepLink.searchParams.getAll('token').length === 1;
    if (!isAuthentication && !isWorkstream && !isInvitation && !isSettings && !isAutomation && !isSlackLink) return;
    sendDeepLink(deepLink.toString());
  } catch {
    // Ignore malformed protocol payloads from the operating system.
  }
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const sender = event.sender;
  const belongsToAvalonWindow = sender === mainWindow?.webContents || sender === settingsWindow?.webContents;
  if (!belongsToAvalonWindow || !event.senderFrame || !rendererNavigationAllowed(event.senderFrame.url)) {
    throw new Error('Blocked IPC request from untrusted content');
  }
}

function registerIpc(): void {
  ipcMain.handle('runtime:get-config', (event) => {
    assertTrustedIpcSender(event);
    return runtimeConfig();
  });
  ipcMain.handle('session:get', async (event) => {
    assertTrustedIpcSender(event);
    const stored = await loadStoredSession();
    // The profile cache is intentionally disposable. If it is missing or from
    // an incompatible app version, rebuild it from the durable credential
    // instead of treating the user as signed out.
    if (!stored && await loadStoredAuth()) {
      try {
        return await coalescedRefreshSession();
      } catch (error) {
        if (definitivelyInvalidatesStoredCredential(error)) {
          try {
            await clearStoredSession();
          } catch (cleanupError) {
            console.warn('[avalon] could not clear an invalid desktop credential', cleanupError);
          }
        }
        console.warn('[avalon] could not rebuild the desktop profile cache', error);
        return null;
      }
    }
    if (!stored) return null;
    const endpointIsConfigured = Object.values(runtimeConfig().api).includes(stored.apiBaseUrl);
    const workspaceMatchesEndpoint = !stored.workspace
      || runtimeConfig().api[stored.workspace.region] === stored.apiBaseUrl;
    if (!endpointIsConfigured || !workspaceMatchesEndpoint) {
      await clearStoredSession();
      return null;
    }
    return publicSession(stored);
  });
  ipcMain.handle('auth:create-desktop-attempt', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return createDesktopAuthAttempt(input);
  });
  ipcMain.handle('auth:cancel-desktop-attempt', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    cancelDesktopAuthAttempt(input);
  });
  ipcMain.handle('auth:exchange-desktop-ticket', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return exchangeDesktopTicket(input);
  });
  ipcMain.handle('auth:create-development-session', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return createDevelopmentSession(input);
  });
  ipcMain.handle('onboarding:get-state', (event) => {
    assertTrustedIpcSender(event);
    return getOnboardingState();
  });
  ipcMain.handle('onboarding:activate-workspace', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return activateWorkspace(input);
  });
  ipcMain.handle('onboarding:create-workspace', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return createWorkspace(input);
  });
  ipcMain.handle('onboarding:accept-invitation', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return acceptInvitation(input);
  });
  ipcMain.handle('onboarding:decline-invitation', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return declineInvitation(input);
  });
  ipcMain.handle('auth:refresh-session', (event) => {
    assertTrustedIpcSender(event);
    return coalescedRefreshSession();
  });
  ipcMain.handle('auth:logout', (event) => {
    assertTrustedIpcSender(event);
    return logout();
  });
  ipcMain.handle('system:copy-text', (event, text: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof text !== 'string' || text.length === 0 || text.length > 4_000) {
      throw new Error('Invalid clipboard text');
    }
    clipboard.writeText(text);
  });
  ipcMain.handle('auth:consume-pending-deep-links', (event) => {
    // Settings shares the preload bridge but must never drain authentication
    // or invitation links intended for the primary application window.
    assertTrustedIpcSender(event);
    if (!mainWindow || event.sender !== mainWindow.webContents) return [];
    rendererReady = true;
    return pendingDeepLinks.splice(0);
  });
  ipcMain.handle('system:open-external', async (event, rawUrl: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof rawUrl !== 'string' || !isAllowedExternalUrl(rawUrl)) {
      throw new Error('Blocked external URL');
    }
    await shell.openExternal(rawUrl);
  });
  ipcMain.handle('system:open-settings', async (event, rawSection: unknown) => {
    assertTrustedIpcSender(event);
    const section = rawSection === undefined ? undefined : parseDesktopSettingsSection(rawSection);
    if (rawSection !== undefined && !section) throw new Error('Invalid settings section');
    await createSettingsWindow(section ?? undefined);
  });
}

function rendererNavigationAllowed(rawUrl: string): boolean {
  try {
    const target = new URL(rawUrl);
    if (rendererDevelopmentUrl) return target.origin === new URL(rendererDevelopmentUrl).origin;
    return target.protocol === `${rendererProtocol}:` && target.host === rendererHost;
  } catch {
    return false;
  }
}

function hardenWebContents(contents: WebContents): void {
  if (hardenedWebContents.has(contents)) return;
  hardenedWebContents.add(contents);

  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const preventUntrustedNavigation = (event: Electron.Event, url: string): void => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', preventUntrustedNavigation);
  contents.on('will-redirect', preventUntrustedNavigation);
}

app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

async function installRendererProtocol(): Promise<void> {
  const rendererRoot = resolve(currentDirectory, '../renderer');
  await protocol.handle(rendererProtocol, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== rendererHost) return new Response('Not found', { status: 404 });
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const assetPath = resolve(rendererRoot, relativePath);
      if (assetPath !== rendererRoot && !assetPath.startsWith(`${rendererRoot}${sep}`)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(assetPath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function applicationWindowIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : resolve(currentDirectory, '../../resources/icon.png');
}

function preloadPath(): string {
  const path = join(currentDirectory, '../preload/index.cjs');
  if (!existsSync(path)) throw new Error(`Avalon preload script is missing: ${path}`);
  return path;
}

function installWindowDiagnostics(window: BrowserWindow, surface: 'main' | 'settings'): void {
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      console.error(`[avalon] ${surface} renderer failed to load`, {
        errorCode,
        errorDescription,
        validatedUrl,
      });
    },
  );
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[avalon] ${surface} renderer process exited`, details);
  });
  window.on('unresponsive', () => {
    console.error(`[avalon] ${surface} window became unresponsive`);
  });
  if (!app.isPackaged) {
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        console.error(`[avalon] ${surface} renderer console error`, {
          message: details.message,
          lineNumber: details.lineNumber,
          sourceId: details.sourceId,
        });
      }
    });
  }
}

async function loadRenderer(window: BrowserWindow, url: string, surface: 'main' | 'settings'): Promise<void> {
  try {
    await window.loadURL(url);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED') return;
    console.error(`[avalon] ${surface} loadURL failed`, error);
    throw error;
  }
}

function rendererUrl(surface?: 'settings', settingsSection?: DesktopSettingsSection): string {
  const target = rendererDevelopmentUrl
    ? new URL(rendererDevelopmentUrl)
    : new URL(`${rendererProtocol}://${rendererHost}/index.html`);
  if (surface) target.searchParams.set('surface', surface);
  if (settingsSection) target.searchParams.set('settingsSection', settingsSection);
  if (surface === 'settings') target.hash = '/settings';
  return target.toString();
}

function requestSettingsSection(window: BrowserWindow, section: DesktopSettingsSection): void {
  const deliver = (): void => window.webContents.send('settings:section-requested', section);
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', deliver);
  else deliver();
}

async function createSettingsWindow(section?: DesktopSettingsSection): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (section) requestSettingsSection(settingsWindow, section);
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#111210',
    title: 'Avalon Settings',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 17 },
    ...(process.platform === 'darwin' ? {} : { icon: applicationWindowIconPath() }),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  installWindowDiagnostics(settingsWindow, 'settings');
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  await loadRenderer(settingsWindow, rendererUrl('settings', section), 'settings');
}

function installApplicationMenu(): void {
  const template = applicationMenuTemplate({
    appName: app.name,
    platform: process.platform,
    updateStatus,
    actions: {
      openSettings: () => {
        void createSettingsWindow().catch((error: unknown) => {
          console.error('[avalon] failed to open settings', error);
        });
      },
      openWebsite: () => {
        void shell.openExternal('https://with-avalon.com/').catch((error: unknown) => {
          console.error('[avalon] failed to open website', error);
        });
      },
      checkForUpdates: () => autoUpdateController?.checkForUpdates(),
      installDownloadedUpdate: () => autoUpdateController?.installDownloadedUpdate(),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 860,
    minHeight: 640,
    show: false,
    backgroundColor: '#111210',
    title: 'Avalon',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 17 },
    ...(process.platform === 'darwin' ? {} : { icon: applicationWindowIconPath() }),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  installWindowDiagnostics(mainWindow, 'main');
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    // Hash-router transitions are same-document navigations. Treating them as
    // a renderer restart strands later OAuth/invitation callbacks in the main
    // process queue because React never remounts to consume that queue.
    if (isMainFrame && !isInPlace) rendererReady = false;
  });
  mainWindow.on('closed', () => {
    rendererReady = false;
    mainWindow = null;
  });

  await loadRenderer(mainWindow, rendererUrl(), 'main');
}

function installContentSecurityPolicy(): void {
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const configuredOrigins = Object.values(runtimeConfig().api).flatMap((rawUrl) => {
      const url = new URL(rawUrl);
      const socketProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return [url.origin, `${socketProtocol}//${url.host}`];
    });
    const developmentOrigins = app.isPackaged
      ? []
      : ['http://127.0.0.1:*', 'ws://127.0.0.1:*', 'http://localhost:*', 'ws://localhost:*'];
    const connectSources = ["'self'", ...new Set([...configuredOrigins, ...developmentOrigins])].join(' ');
    // @vitejs/plugin-react injects an inline Fast Refresh preamble in development.
    // The packaged app and its build-transformed HTML both remain strict and
    // never permit inline renderer scripts.
    const scriptSources = app.isPackaged ? "'self'" : "'self' 'unsafe-inline'";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src ${connectSources}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`,
        ],
      },
    });
  });

  electronSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowsTrustedAudioCapture({
      isMainWindow: webContents === mainWindow?.webContents,
      mediaTypes: 'mediaTypes' in details ? details.mediaTypes ?? [] : [],
      permission,
      trustedRenderer: rendererNavigationAllowed(details.requestingUrl),
    }));
  });
  electronSession.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    allowsTrustedAudioCapture({
      isMainWindow: webContents === mainWindow?.webContents,
      mediaTypes: details.mediaType ? [details.mediaType] : [],
      permission,
      trustedRenderer: rendererNavigationAllowed(requestingOrigin),
    }));
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const deepLink = commandLine.find((argument) => argument.startsWith(`${customProtocol}://`));
    if (deepLink) emitDeepLink(deepLink);
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    emitDeepLink(url);
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('app.avalon.desktop');
    app.setAsDefaultProtocolClient(customProtocol);
    try {
      if (app.isPackaged) {
        await migrateLegacyUserDataStoredSessionFile(
          userDataDirectory(),
          legacyPackagedUserDataDirectory(appDataDirectory),
        );
      }
      await migrateLegacyStoredSessionFile(userDataDirectory());
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') console.warn('[avalon] could not migrate the legacy desktop session file', error);
    }
    // Complete the one-time full-session to split-state migration before any
    // renderer window can issue concurrent session requests.
    await loadStoredAuth();
    await installRendererProtocol();
    installContentSecurityPolicy();
    registerIpc();
    autoUpdateController = initializeAutoUpdate({
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      currentVersion: app.getVersion(),
      showMessageBox: (options) => dialog.showMessageBox(options),
      openExternal: (url) => shell.openExternal(url),
      beforeInstall: prepareForUpdateInstall,
      onInstallFailed: rollBackFailedUpdateInstall,
      onStatusChange: (status) => {
        updateStatus = status;
        installApplicationMenu();
      },
    });
    installApplicationMenu();
    await createMainWindow();

    const initialDeepLink = process.argv.find((argument) => argument.startsWith(`${customProtocol}://`));
    if (initialDeepLink) emitDeepLink(initialDeepLink);

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        void createMainWindow().catch((error: unknown) => {
          console.error('[avalon] failed to recreate the main window', error);
        });
      }
    });
  }).catch((error: unknown) => {
    console.error('[avalon] failed to start', error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
