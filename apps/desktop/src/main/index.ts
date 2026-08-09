import {
  ActivateWorkspaceRequestSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
  SessionSchema,
  WorkspaceOnboardingStateSchema,
  type Session as WireSession,
} from '@avalon/contracts';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session as electronSession,
  shell,
  systemPreferences,
} from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type {
  AvalonRegion,
  DesktopApplicationSettings,
  DesktopSession,
  DesktopWorkspaceOnboardingState,
  MeetingAudioPermissionKind,
  RuntimeConfig,
} from '../common/desktop';
import {
  applicationIconArtworkFileName,
  automaticApplicationIcon,
  type ApplicationIconId,
  type DesktopApplicationIconState,
} from '../common/application-icons';
import { parseDesktopSettingsSection } from '../common/settings';
import type { DesktopSettingsSection } from '../common/settings';
import {
  definitivelyInvalidatesStoredCredential,
  responseError,
} from './api-response-error';
import {
  applicationIconPath,
  applicationIconPreferenceDirectoryForLaunch,
  clearStoredApplicationIcon,
  readStoredApplicationIcon,
  writeStoredApplicationIcon,
} from './application-icon';
import { ApplicationIconController } from './application-icon-controller';
import {
  readStoredApplicationSettings,
  writeStoredApplicationSettings,
} from './application-settings';
import { DesktopAuthAttemptStore } from './desktop-auth-attempts';
import { applicationMenuTemplate } from './application-menu';
import { LockdownModeController } from './lockdown-mode';
import {
  allowsTrustedAudioCapture,
} from './media-permission';
import {
  meetingAudioPermissions,
  meetingAudioSettingsUrl,
  prepareMeetingAudioPermissions,
} from './meeting-audio-permission';
import {
  nativeSystemAudioAddonPath,
  NativeSystemAudioController,
  type NativeSystemAudioBinding,
} from './native-system-audio';
import {
  migrateLegacyUserDataStoredSessionFile,
  migrateLegacyStoredSessionFile,
  readStoredAuthFile,
  readStoredProfileFile,
  readStoredSessionFile,
  removeStoredCredentialFiles,
  removeStoredStateFiles,
  removeStoredSessionFiles,
  tombstoneStoredStateFiles,
  tombstoneStoredCredentialFiles,
  writeStoredAuthFile,
  writeStoredProfileFile,
  writeStoredSessionFile,
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
  decryptSessionValue,
  encryptSessionValue,
  migrateStoredSessionEncryption,
  type SessionEncryptionMode,
} from './session-encryption';
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
const requireNativeModule = createRequire(import.meta.url);
const executeFile = promisify(execFile);
// Never let inherited development environment variables choose the renderer
// or API origins of an installed app. The preload bridge is privileged, so a
// packaged build must remain pinned to its embedded renderer and Avalon hosts.
const rendererDevelopmentUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const allowedExternalProtocols = new Set(['https:', 'http:']);
const customProtocol = 'avalon';
const rendererProtocol = 'app';
const rendererHost = 'avalon';
const UPDATE_SESSION_SETTLE_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
const meetingWindows = new Set<BrowserWindow>();
const meetingWindowsAllowedToClose = new WeakSet<BrowserWindow>();
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
let developmentDockIconUsesAppearancePreview = false;
const pendingDeepLinks: string[] = [];
const hardenedWebContents = new WeakSet<WebContents>();
const desktopAuthAttempts = new DesktopAuthAttemptStore();
const nativeSystemAudioController = new NativeSystemAudioController(() => {
  if (process.platform !== 'darwin') {
    throw new Error('Native computer audio capture is available only on macOS.');
  }
  const addonPath = nativeSystemAudioAddonPath({
    currentDirectory,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  return requireNativeModule(addonPath) as NativeSystemAudioBinding;
});

function avalonWindows(): BrowserWindow[] {
  return [mainWindow, settingsWindow, ...meetingWindows]
    .filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()));
}

function isMeetingWindowContents(contents: WebContents | null): boolean {
  if (!contents) return false;
  return [...meetingWindows].some((window) => !window.isDestroyed() && window.webContents === contents);
}

function forceCloseMeetingWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  meetingWindowsAllowedToClose.add(window);
  window.close();
}

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
  for (const window of avalonWindows()) window.webContents.send('session:changed', exposed);
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

function activeSessionEncryptionMode(): SessionEncryptionMode {
  return lockdownModeController.encryptionMode();
}

function encryptStoredSessionValue(value: string): Buffer {
  return encryptSessionValue(value, activeSessionEncryptionMode(), safeStorage);
}

function decryptStoredSessionValue(value: Uint8Array): string {
  return decryptSessionValue(value, safeStorage).plaintext;
}

function broadcastApplicationSettingsChanged(settings: DesktopApplicationSettings): void {
  for (const window of avalonWindows()) window.webContents.send('application-settings:changed', settings);
}

function storedSessionEncryptionValues() {
  const directory = userDataDirectory();
  return [
    {
      credentialBearing: true,
      read: () => readStoredAuthFile(directory),
      write: (value: Uint8Array) => writeStoredAuthFile(directory, value),
    },
    {
      credentialBearing: false,
      read: () => readStoredProfileFile(directory),
      write: (value: Uint8Array) => writeStoredProfileFile(directory, value),
    },
    {
      credentialBearing: true,
      read: () => readStoredSessionFile(directory),
      write: (value: Uint8Array) => writeStoredSessionFile(directory, value),
    },
  ];
}

async function migrateSessionEncryption(
  mode: SessionEncryptionMode,
  options?: { allowLockdownToGlobal?: boolean },
): Promise<void> {
  await migrateStoredSessionEncryption(
    storedSessionEncryptionValues(),
    mode,
    safeStorage,
    options,
  );
}

async function recoverGlobalSessionWithoutKeystore(): Promise<void> {
  if (!inMemoryAuth) {
    await clearCredentialsForLockdownRelogin();
    return;
  }
  await writeStoredAuthFile(
    userDataDirectory(),
    encryptSessionValue(JSON.stringify(inMemoryAuth), 'global', safeStorage),
  );
  if (inMemorySession) {
    await writeStoredProfileFile(
      userDataDirectory(),
      encryptSessionValue(
        JSON.stringify(storedProfileFromSession(inMemorySession)),
        'global',
        safeStorage,
      ),
    );
  }
  try {
    await removeStoredSessionFiles(userDataDirectory());
  } catch {
    // The recovered split credential is authoritative. A later logout still
    // removes every obsolete full-session credential location.
  }
}

async function clearCredentialsForLockdownRelogin(): Promise<void> {
  sessionLifecycleEpoch += 1;
  desktopAuthAttempts.clear();
  inMemoryAuth = null;
  inMemorySession = null;
  let failure: unknown;
  const directories = [
    userDataDirectory(),
    ...(app.isPackaged ? [legacyPackagedUserDataDirectory(appDataDirectory)] : []),
  ];
  for (const directory of directories) {
    try {
      await removeStoredCredentialFiles(directory);
    } catch (error) {
      let directoryFailure: unknown = error;
      try {
        await tombstoneStoredCredentialFiles(
          directory,
          encryptSessionValue('{}', 'global', safeStorage),
        );
        directoryFailure = undefined;
      } catch {
        // Preserve this directory's original deletion error for the caller.
      }
      if (directoryFailure !== undefined && failure === undefined) failure = directoryFailure;
    }
  }
  broadcastSessionChanged(null);
  if (failure) throw failure;
}

const lockdownModeController = new LockdownModeController({
  safeStorage,
  readSettings: () => readStoredApplicationSettings(userDataDirectory()),
  writeSettings: (settings) => writeStoredApplicationSettings(userDataDirectory(), settings),
  migrateSession: migrateSessionEncryption,
  recoverGlobalSessionWithoutKeystore,
  clearCredentialsForRelogin: clearCredentialsForLockdownRelogin,
  runExclusive: withSessionMutation,
  onChange: broadcastApplicationSettingsChanged,
});

async function writeSplitSessionFiles(value: WireSession): Promise<StoredAuth> {
  const auth = storedAuthFromSession(value, regionForStoredSession(value));
  // Credentials are the durable boundary. Write them before the disposable
  // profile cache so an interrupted update can always recover by refreshing.
  await writeStoredAuthFile(
    userDataDirectory(),
    encryptStoredSessionValue(JSON.stringify(auth)),
  );
  await writeStoredProfileFile(
    userDataDirectory(),
    encryptStoredSessionValue(JSON.stringify(storedProfileFromSession(value))),
  );
  try {
    await removeStoredSessionFiles(userDataDirectory());
  } catch {
    // The split credential is authoritative. Logout still removes or
    // tombstones every legacy location before another launch can use it.
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
    const parsed: unknown = JSON.parse(decryptStoredSessionValue(encrypted));
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
  try {
    const encrypted = await readStoredAuthFile(userDataDirectory());
    const parsed: unknown = JSON.parse(decryptStoredSessionValue(encrypted));
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
    const parsed: unknown = JSON.parse(decryptStoredSessionValue(encrypted));
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
      try {
        await tombstoneStoredStateFiles(directory, encryptStoredSessionValue('{}'));
        directoryFailure = undefined;
      } catch {
        // Preserve this directory's original deletion error for the caller.
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
  let session: WireSession;
  try {
    session = await requestSession(
      apiBaseUrl,
      '/auth/refresh',
      { refreshToken: previousAuth.refreshToken },
      previousAuth.accessToken,
    );
  } catch (error) {
    // Only the service can declare the durable credential dead. Clearing it
    // here is what lets renderers retry every other failure indefinitely
    // instead of treating a network blip as an expired session.
    if (definitivelyInvalidatesStoredCredential(error)) {
      try {
        await clearStoredSession();
      } catch (cleanupError) {
        console.warn('[avalon] could not clear a rejected desktop credential', cleanupError);
      }
    }
    throw error;
  }
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
    for (const window of meetingWindows) forceCloseMeetingWindow(window);
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
  const connectorResult = (() => {
    try {
      const deepLink = new URL(rawUrl);
      const connectionId = deepLink.searchParams.get('connection');
      const isAuthCompletion = deepLink.protocol === `${customProtocol}:`
        && deepLink.hostname === 'auth'
        && deepLink.pathname === '/complete';
      if (!isAuthCompletion) return false;
      const legacySuccess = connectionId !== null
        && IdSchema.safeParse(connectionId).success
        && deepLink.searchParams.get('status') === 'connected';
      const provider = deepLink.searchParams.get('provider');
      const status = deepLink.searchParams.get('status');
      const providerResult = ['google', 'github', 'linear', 'notion', 'slack'].includes(provider ?? '')
        && (
          (status === 'connected' && connectionId !== null && IdSchema.safeParse(connectionId).success)
          || ((status === 'denied' || status === 'failed') && connectionId === null)
        );
      return legacySuccess || providerResult;
    } catch {
      return false;
    }
  })();
  const connectorSettingsWindow = connectorResult && settingsWindow && !settingsWindow.isDestroyed()
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
  const belongsToAvalonWindow = sender === mainWindow?.webContents
    || sender === settingsWindow?.webContents
    || isMeetingWindowContents(sender);
  if (!belongsToAvalonWindow || !event.senderFrame || !rendererNavigationAllowed(event.senderFrame.url)) {
    throw new Error('Blocked IPC request from untrusted content');
  }
}

function assertMeetingIpcSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (!isMeetingWindowContents(event.sender)) {
    throw new Error('Only a meeting-notes window can request recording permissions');
  }
}

function meetingAudioPermissionDependencies() {
  return {
    askForMicrophoneAccess: () => systemPreferences.askForMediaAccess('microphone'),
    getMicrophoneAccessStatus: () => systemPreferences.getMediaAccessStatus('microphone'),
  };
}

function registerIpc(): void {
  ipcMain.handle('runtime:get-config', (event) => {
    assertTrustedIpcSender(event);
    return runtimeConfig();
  });
  ipcMain.handle('application-settings:get', (event) => {
    assertTrustedIpcSender(event);
    return lockdownModeController.settings();
  });
  ipcMain.handle('application-settings:set-lockdown-mode', (event, rawEnabled: unknown) => {
    assertTrustedIpcSender(event);
    return lockdownModeController.set(rawEnabled);
  });
  ipcMain.handle('application-icon:get', (event) => {
    assertTrustedIpcSender(event);
    return desktopApplicationIconState();
  });
  ipcMain.handle('application-icon:set', (event, rawIconId: unknown) => {
    assertTrustedIpcSender(event);
    return enqueueApplicationIconChange(rawIconId);
  });
  ipcMain.handle('application-icon:reset', (event) => {
    assertTrustedIpcSender(event);
    return enqueueApplicationIconReset();
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
  ipcMain.handle('system:open-meeting-notes', async (event, rawNoteId: unknown) => {
    assertTrustedIpcSender(event);
    if (rawNoteId !== undefined && (typeof rawNoteId !== 'string' || !isUuid(rawNoteId))) {
      throw new Error('Invalid note ID');
    }
    await createMeetingWindow(rawNoteId as string | undefined);
  });
  ipcMain.handle('meeting-audio:get-permissions', (event) => {
    assertMeetingIpcSender(event);
    return meetingAudioPermissions(meetingAudioPermissionDependencies());
  });
  ipcMain.handle('meeting-audio:prepare-permissions', (event) => {
    assertMeetingIpcSender(event);
    return prepareMeetingAudioPermissions(meetingAudioPermissionDependencies());
  });
  ipcMain.handle('meeting-audio:start-system-capture', (event) => {
    assertMeetingIpcSender(event);
    return nativeSystemAudioController.start(event.sender);
  });
  ipcMain.handle('meeting-audio:stop-system-capture', (event) => {
    assertMeetingIpcSender(event);
    return nativeSystemAudioController.stop(event.sender);
  });
  ipcMain.handle('meeting-audio:open-settings', async (event, rawPermission: unknown) => {
    assertMeetingIpcSender(event);
    if (rawPermission !== 'microphone' && rawPermission !== 'system-audio') {
      throw new Error('Invalid meeting audio permission');
    }
    const url = meetingAudioSettingsUrl(rawPermission as MeetingAudioPermissionKind, process.platform);
    if (!url) throw new Error('Open this platform’s privacy settings to change recording access.');
    await shell.openExternal(url);
  });
  ipcMain.handle('system:close-meeting-notes', (event) => {
    assertTrustedIpcSender(event);
    const meetingWindow = [...meetingWindows].find((window) => window.webContents === event.sender);
    if (!meetingWindow) throw new Error('Only a meeting-notes window can close itself');
    forceCloseMeetingWindow(meetingWindow);
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

function applicationIconResourceDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-icons')
    : resolve(currentDirectory, '../../resources/app-icons');
}

function applicationIconPreferenceDirectory(): string {
  return applicationIconPreferenceDirectoryForLaunch(
    appDataDirectory,
    userDataDirectory(),
    app.isPackaged,
    process.argv.some((argument) => argument.startsWith('--avalon-package-smoke=')),
  );
}

function packagedApplicationBundlePath(): string {
  return resolve(dirname(process.execPath), '../..');
}

function nativeApplicationIconScriptPath(): string {
  return join(process.resourcesPath, 'native', 'set-application-icon.js');
}

async function runNativeApplicationIconScript(...arguments_: string[]): Promise<void> {
  await executeFile('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    nativeApplicationIconScriptPath(),
    ...arguments_,
  ], { timeout: 10_000 });
}

function desktopApplicationIconState(): DesktopApplicationIconState {
  return applicationIconController.state();
}

function broadcastApplicationIconChanged(): void {
  const state = desktopApplicationIconState();
  for (const window of avalonWindows()) window.webContents.send('application-icon:changed', state);
}

function loadDevelopmentApplicationIcon(iconId: ApplicationIconId): Electron.NativeImage {
  const iconPath = join(
    applicationIconResourceDirectory(),
    applicationIconArtworkFileName(iconId),
  );
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`Application icon could not be loaded: ${iconPath}`);
  const size = icon.getSize();
  if (size.width !== 1024 || size.height !== 1024) {
    throw new Error(`Application icon must be 1024×1024: ${iconPath}`);
  }
  return icon;
}

async function applyApplicationIcon(iconId: ApplicationIconId): Promise<void> {
  if (process.platform !== 'darwin' || !app.dock) {
    throw new Error('Custom application icons are available only on macOS');
  }
  const iconPath = applicationIconPath(applicationIconResourceDirectory(), iconId);
  if (!app.isPackaged) {
    // Development runs have no containing signed Avalon bundle or Dock tile
    // plugin. Keep the picker testable without changing Electron.app in place.
    app.dock.setIcon(loadDevelopmentApplicationIcon(iconId));
    developmentDockIconUsesAppearancePreview = true;
    return;
  }
  await runNativeApplicationIconScript(
    iconPath,
    packagedApplicationBundlePath(),
  );
}

async function resetNativeApplicationIcon(): Promise<void> {
  if (process.platform !== 'darwin' || !app.dock) {
    throw new Error('Custom application icons are available only on macOS');
  }
  if (app.isPackaged) {
    await runNativeApplicationIconScript('--reset', packagedApplicationBundlePath());
    return;
  }
  app.dock.setIcon(loadDevelopmentApplicationIcon(automaticApplicationIcon(nativeTheme.shouldUseDarkColors)));
  developmentDockIconUsesAppearancePreview = true;
}

const applicationIconController = new ApplicationIconController({
  supported: process.platform === 'darwin',
  automaticIcon: () => automaticApplicationIcon(nativeTheme.shouldUseDarkColors),
  validateIcon: (iconId) => {
    if (app.isPackaged) {
      const iconPath = applicationIconPath(applicationIconResourceDirectory(), iconId);
      if (!existsSync(iconPath)) throw new Error(`Application icon could not be loaded: ${iconPath}`);
    } else {
      loadDevelopmentApplicationIcon(iconId);
    }
  },
  readStoredIcon: () => readStoredApplicationIcon(applicationIconPreferenceDirectory()),
  writeStoredIcon: (iconId) => writeStoredApplicationIcon(applicationIconPreferenceDirectory(), iconId),
  clearStoredIcon: () => clearStoredApplicationIcon(applicationIconPreferenceDirectory()),
  applyIcon: applyApplicationIcon,
  resetNativeIcon: resetNativeApplicationIcon,
  onStateChange: broadcastApplicationIconChanged,
});

function enqueueApplicationIconChange(rawIconId: unknown): Promise<DesktopApplicationIconState> {
  return applicationIconController.change(rawIconId);
}

function enqueueApplicationIconReset(): Promise<DesktopApplicationIconState> {
  return applicationIconController.reset();
}

async function initializeApplicationIcon(): Promise<void> {
  if (process.platform !== 'darwin') return;
  nativeTheme.on('updated', () => {
    if (applicationIconController.state().isAutomatic && developmentDockIconUsesAppearancePreview) {
      void applyApplicationIcon(automaticApplicationIcon(nativeTheme.shouldUseDarkColors)).catch((error: unknown) => {
        console.warn('[avalon] could not refresh the development application icon', error);
      });
    }
    applicationIconController.appearanceChanged();
  });
  try {
    await applicationIconController.restore();
  } catch (error) {
    console.warn('[avalon] could not restore the selected application icon', error);
  }
}

function preloadPath(): string {
  const path = join(currentDirectory, '../preload/index.cjs');
  if (!existsSync(path)) throw new Error(`Avalon preload script is missing: ${path}`);
  return path;
}

function installWindowDiagnostics(window: BrowserWindow, surface: 'main' | 'settings' | 'meeting'): void {
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

async function loadRenderer(window: BrowserWindow, url: string, surface: 'main' | 'settings' | 'meeting'): Promise<void> {
  try {
    await window.loadURL(url);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED') return;
    console.error(`[avalon] ${surface} loadURL failed`, error);
    throw error;
  }
}

function rendererUrl(surface?: 'settings' | 'meeting', settingsSection?: DesktopSettingsSection, noteId?: string): string {
  const target = rendererDevelopmentUrl
    ? new URL(rendererDevelopmentUrl)
    : new URL(`${rendererProtocol}://${rendererHost}/index.html`);
  if (surface) target.searchParams.set('surface', surface);
  if (settingsSection) target.searchParams.set('settingsSection', settingsSection);
  if (surface === 'settings') target.hash = '/settings';
  if (surface === 'meeting') {
    if (noteId) target.searchParams.set('noteId', noteId);
    target.hash = '/meeting';
  }
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

async function createMeetingWindow(noteId: string = crypto.randomUUID()): Promise<void> {
  const meetingWindow = new BrowserWindow({
    width: 720,
    height: 860,
    minWidth: 540,
    minHeight: 640,
    show: false,
    backgroundColor: '#1d1e1b',
    title: 'Meeting notes — Avalon',
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
  // BrowserWindow.webContents throws after Electron emits `closed`. Retain the
  // WebContents object while the window is alive so native audio cleanup can
  // still identify its owner during teardown.
  const meetingContents = meetingWindow.webContents;
  meetingWindows.add(meetingWindow);
  installWindowDiagnostics(meetingWindow, 'meeting');
  meetingWindow.setMenuBarVisibility(false);
  meetingWindow.once('ready-to-show', () => meetingWindow.show());
  meetingWindow.on('close', (event) => {
    if (meetingWindowsAllowedToClose.has(meetingWindow)) return;
    event.preventDefault();
    meetingContents.send('meeting:close-requested');
  });
  meetingWindow.on('closed', () => {
    void nativeSystemAudioController.stop(meetingContents).catch((error) => {
      console.warn('[meeting] Failed to stop native computer audio after window close', error);
    });
    meetingWindows.delete(meetingWindow);
  });
  try {
    await loadRenderer(
      meetingWindow,
      rendererUrl('meeting', undefined, noteId),
      'meeting',
    );
  } catch (error) {
    forceCloseMeetingWindow(meetingWindow);
    throw error;
  }
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
    const trustedRenderer = rendererNavigationAllowed(details.requestingUrl);
    callback(allowsTrustedAudioCapture({
      isAudioCaptureWindow: webContents === mainWindow?.webContents || isMeetingWindowContents(webContents),
      mediaTypes: 'mediaTypes' in details ? details.mediaTypes ?? [] : [],
      permission,
      trustedRenderer,
    }));
  });
  electronSession.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const trustedRenderer = rendererNavigationAllowed(requestingOrigin);
    return allowsTrustedAudioCapture({
      isAudioCaptureWindow: webContents === mainWindow?.webContents || isMeetingWindowContents(webContents),
      mediaTypes: details.mediaType ? [details.mediaType] : [],
      permission,
      trustedRenderer,
    });
  });
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
    try {
      await lockdownModeController.initialize();
    } catch (error) {
      console.warn('[avalon] could not initialize desktop session encryption', error);
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
    void initializeApplicationIcon();

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
