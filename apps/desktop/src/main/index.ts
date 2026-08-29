import { RALLY_HEADERS } from '@rally/contracts/http-headers';
import {
  ActivateWorkspaceRequestSchema,
  ClientFeatureFlagsSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
  ProductAnalyticsPreferenceSchema,
  SessionSchema,
  WorkspaceOnboardingStateSchema,
  type Session as WireSession,
  type ClientFeatureFlags,
} from '@rally/contracts';
import {
  DESKTOP_DEEP_LINK_PROTOCOL,
  DESKTOP_DEEP_LINK_PROTOCOLS,
  isDesktopDeepLinkProtocol,
} from '@rally/contracts/desktop-deep-link';
import { execFile } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  screen as electronScreen,
  session as electronSession,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type {
  RallyRegion,
  DesktopApplicationSettings,
  DesktopDeepLinkEntrypoint,
  DesktopDeepLinkNavigation,
  DesktopLockdownSettings,
  DesktopSession,
  DesktopTelemetryProductIntent,
  DesktopTelemetryScreen,
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
import { logError, logWarn } from '../common/logger';
import { parseDesktopSettingsSection } from '../common/settings';
import type { DesktopSettingsSection } from '../common/settings';
import { backdropScheme, fontScheme } from '../common/theme-assets';
import {
  defaultThemeChoice,
  parseThemeChoice,
  resolveTheme,
  sameThemeChoice,
  themeWindowBackground,
  type ThemeChoice,
} from '../common/themes';
import {
  definitivelyInvalidatesStoredCredential,
  readJsonBody,
  refreshFailureIsTerminal,
  responseError,
  UnusableCredentialError,
} from './api-response-error';
import { ApplicationOpenObserver, initialApplicationOpenEntrypoint } from './application-open-observer';
import { parseTelemetryProductIntent, UUID_V7_PATTERN } from './telemetry-intent';
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
  updateStoredApplicationSettings,
} from './application-settings';
import { ApplicationLifecycleTelemetry } from './application-lifecycle-telemetry';
import {
  acknowledgeApplicationVersionTransition,
  applicationVersionTransition,
} from './application-version-telemetry';
import { DesktopAuthAttemptStore } from './desktop-auth-attempts';
import { applicationMenuTemplate } from './application-menu';
import { DebugSettingsController } from './debug-settings';
import { DeveloperSettingsFlagController } from './developer-settings-flag';
import { LaunchAtLoginController, launchedAtLogin } from './launch-at-login';
import {
  javascriptErrorProcessHealthState,
  normalizeJavascriptErrorCandidate,
} from './javascript-error-candidate';
import { LockdownModeController } from './lockdown-mode';
import { MenuBarController, type MenuBarTray } from './menu-bar';
import {
  ThemeFontCache,
  backdropResponse,
  isBackdropUrl,
  themeAssetSchemes,
} from './theme-assets';
import { MenuBarContentStore } from './menu-bar-content';
import {
  isMessageExportUrl,
  MESSAGE_EXPORT_CONTENT_SECURITY_POLICY,
  MESSAGE_EXPORT_SCHEME,
  MessageExporter,
  parseMessageExportRequest,
  type MessageExportWindow,
} from './message-export';
import { MenuBarOpenObserver } from './menu-bar-open-observer';
import {
  RealtimeSocketBroker,
  createNodeRealtimeSocketFactory,
} from './realtime-socket-broker';
import { registerRealtimeSocketIpc } from './realtime-socket-ipc';
import { invalidateActiveNativeCrashGeneration, prepareNativeCrashGeneration } from './native-crash-generation';
import { NativeCrashUploader } from './native-crash-uploader';
import { ProductAnalyticsSettingsController } from './product-analytics-settings';
import {
  readTelemetryIdentityState,
  rotateTelemetryEpochs,
  type TelemetryIdentity,
  uuidV7,
} from './telemetry-identity';
import {
  TelemetryReporter,
  type ApplicationSettingsTelemetryState,
  type TelemetryWindowContext,
} from './telemetry-reporter';
import {
  refreshTelemetryCapability,
  resolveTelemetryRoute,
  type ResolvedTelemetryRoute,
} from './telemetry-route';
import { TelemetrySpool } from './telemetry-spool';
import { TelemetryQuitBarrier } from './telemetry-quit-barrier';
import { beginTelemetryLaunch, clearTelemetryLaunch, markTelemetryLaunchReady } from './telemetry-launch-marker';
import { TelemetryBreadcrumbRing, type NewTelemetryBreadcrumb } from './telemetry-breadcrumbs';
import { supportsSectionHeaders, type MenuBarSuggestion } from './menu-bar-menu';
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
  NativePerformanceLog,
  nativeUnifiedLogAddonPath,
  type NativeUnifiedLogBinding,
} from './native-performance-log';
import {
  migrateLegacyUserDataStoredSessionFile,
  migrateLegacyStoredSessionFile,
  migrateSupersededSessionDirectory,
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
  supersededUserDataDirectories,
  userDataDirectoryForLaunch,
} from './user-data-path';
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const requireNativeModule = createRequire(import.meta.url);
const executeFile = promisify(execFile);
// Never let inherited development environment variables choose the renderer
// or API origins of an installed app. The preload bridge is privileged, so a
// packaged build must remain pinned to its embedded renderer and Rally hosts.
const rendererDevelopmentUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const allowedExternalProtocols = new Set(['https:', 'http:']);
/**
 * The deep-link schemes registered with the operating system: the one this
 * build mints, plus every one it still answers. `electron` wants them without
 * the trailing colon that `URL.protocol` carries, so the shared list is
 * trimmed rather than restated — a second literal here is exactly the copy
 * that would be missed when the legacy scheme is finally dropped.
 */
const customProtocol = DESKTOP_DEEP_LINK_PROTOCOL.replace(/:$/u, '');
const deepLinkProtocols: readonly string[] = DESKTOP_DEEP_LINK_PROTOCOLS
  .map((scheme) => scheme.replace(/:$/u, ''));
const isDeepLinkProtocol = isDesktopDeepLinkProtocol;
const rendererProtocol = 'app';
/**
 * The packaged renderer's origin, `app://rallywithai`.
 *
 * It is not only an internal name: it is the `Origin` header on every API
 * request and WebSocket upgrade this process makes, so the regional Workers'
 * `ALLOWED_ORIGINS` has to admit it. A build shipped before the rename sends
 * `app://avalon` and cannot be made to send anything else, which is why both
 * are listed there and why `app://avalon` is removed only once those builds
 * are gone.
 */
const rendererHost = 'rallywithai';
const UPDATE_SESSION_SETTLE_TIMEOUT_MS = 5_000;
/** A signed-in cold launch can pay DNS, TLS, Worker activation, and the
 * canonical regional D1 read. Keep the verification bounded without treating
 * a normal cold request as an outage. */
const PRODUCT_ANALYTICS_PREFERENCE_REQUEST_TIMEOUT_MS = 15_000;
/** Well inside the flag's poll interval, so a lost poll costs one round rather
 * than blocking the next. */
const DEVELOPER_SETTINGS_FLAG_REQUEST_TIMEOUT_MS = 15_000;
/** Short, because the drop-down is already open — or about to be — while this
 * runs, and a menu that updates a minute later has updated for nobody. */
const MENU_BAR_REQUEST_TIMEOUT_MS = 8_000;
/** How long the menu's cached content is served before the pointer arriving at
 * the status item asks for it again. */
const MENU_BAR_CONTENT_MAX_AGE_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const telemetryScreens = new Set<DesktopTelemetryScreen>([
  'onboarding_welcome', 'onboarding_region', 'onboarding_workspace',
  'workspace_home', 'workstream', 'application_settings', 'developer_settings',
]);

function parseTelemetryScreen(value: unknown): DesktopTelemetryScreen {
  if (typeof value !== 'string' || !telemetryScreens.has(value as DesktopTelemetryScreen)) {
    throw new Error('Invalid telemetry screen');
  }
  return value as DesktopTelemetryScreen;
}

function safeJavascriptFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  const pattern = /([^\s()]+\.(?:c?js)):(\d{1,7}):(\d{1,5})/gu;
  for (const match of stack.matchAll(pattern)) {
    const file = basename(match[1]!.split(/[?#]/u, 1)[0]!);
    if (!file || file.includes('..')) continue;
    frames.push(`${file}:${match[2]}:${match[3]}`);
    if (frames.length === 20) break;
  }
  return frames;
}

function javascriptErrorCode(error: unknown, fallback: 'unhandled_rejection' | 'unknown'): 'type_error' | 'range_error' | 'unhandled_rejection' | 'unknown' {
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof RangeError) return 'range_error';
  return fallback;
}


function telemetryIntentProperties<T extends DesktopTelemetryProductIntent>(intent: T): Omit<T, 'kind'> {
  return Object.fromEntries(
    Object.entries(intent).filter(([key]) => key !== 'kind'),
  ) as Omit<T, 'kind'>;
}

async function reportTelemetryProductIntent(
  value: unknown,
  windowContext?: TelemetryWindowContext,
): Promise<void> {
  const intent = parseTelemetryProductIntent(value);
  if (process.platform === 'darwin' && intent.kind === 'renderer_perf_flow') {
    // Local persistence is independent of account telemetry consent: it never
    // leaves the Mac, and remains available in Console.app even when the
    // regional reporter suppresses or cannot upload the event.
    nativePerformanceLog.write(intent);
  }
  const operation: NewTelemetryBreadcrumb | null = intent.kind === 'workspace_create_requested'
    ? { kind: 'operation', operation: 'workspace_create', state: 'requested' }
    : intent.kind === 'workspace_activation_requested'
      ? { kind: 'operation', operation: 'workspace_activate', state: 'requested' }
      : intent.kind === 'workstream_create_requested'
        ? { kind: 'operation', operation: 'workstream_create', state: 'requested' }
        : intent.kind === 'run_requested'
          ? { kind: 'operation', operation: 'run_start', state: 'requested' }
          : intent.kind === 'connector_setup_requested_v2'
            ? { kind: 'operation', operation: 'connector_setup', state: 'requested' }
            : null;
  if (operation) await telemetryBreadcrumbs?.add(operation).catch(() => undefined);
  if (!telemetryReporter) return;
  switch (intent.kind) {
    case 'onboarding_region_selected':
      await telemetryReporter.onboardingRegionSelected(intent.selectedRegion, intent.entrypoint, windowContext);
      return;
    case 'workspace_create_requested':
      await telemetryReporter.workspaceCreateRequested(
        intent.selectedRegion, intent.entrypoint, intent.operationId, windowContext,
      );
      return;
    case 'workspace_activation_requested':
      await telemetryReporter.workspaceActivationRequested(
        intent.selectedRegion, intent.entrypoint, intent.operationId, windowContext,
      );
      return;
    case 'workstream_create_requested':
      await telemetryReporter.workstreamCreateRequested(intent.entrypoint, intent.operationId, windowContext);
      return;
    case 'run_requested':
      await telemetryReporter.runRequested(intent.entrypoint, intent.operationId, windowContext);
      return;
    case 'connector_setup_requested_v2': {
      const { operationId: connectorOperationId, ...semanticIntent } = intent;
      await telemetryReporter.semanticProductIntent(
        semanticIntent,
        windowContext,
        connectorOperationId,
      );
      return;
    }
    case 'workstream_feed_visible':
    case 'workstream_send_ready':
    case 'workstream_open_started':
    case 'workstream_open_outcome':
    case 'workstream_socket_started':
    case 'renderer_perf_flow': {
      const { operationId, ...semanticIntent } = intent;
      await telemetryReporter.semanticProductIntent(semanticIntent, windowContext, operationId);
      return;
    }
    case 'command_shortcuts_revealed':
      await telemetryReporter.commandShortcutsRevealed(intent.availableCount, windowContext);
      return;
    case 'command_shortcut_used':
      await telemetryReporter.commandShortcutUsed(
        intent.shortcutNumber, intent.destinationType, windowContext,
      );
      return;
    case 'workstream_opened': {
      await telemetryReporter.workstreamOpened(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'workstream_action_completed': {
      await telemetryReporter.workstreamActionCompleted(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'automation_created': {
      await telemetryReporter.automationCreated(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'automation_action_completed': {
      await telemetryReporter.automationActionCompleted(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'message_sent': {
      await telemetryReporter.messageSent(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'content_copied': {
      await telemetryReporter.contentCopied(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'note_opened': {
      await telemetryReporter.noteOpened(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'note_created': {
      await telemetryReporter.noteCreated(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'note_action_completed': {
      await telemetryReporter.noteActionCompleted(telemetryIntentProperties(intent), windowContext);
      return;
    }
    case 'transcription_state_changed': {
      await telemetryReporter.transcriptionStateChanged(telemetryIntentProperties(intent), windowContext);
      return;
    }
    default:
      await telemetryReporter.semanticProductIntent(intent, windowContext);
      return;
  }
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: characters of the message a renderer may put in the deep-link failure
 *   window.
 * Without it: the window is always-on-top and its message is its entire
 *   contents, so whatever reaches this draws text above every other window,
 *   under Rally's own name. Checked 2026-08-29: most messages are fixed
 *   literals in `app-session.tsx`, but not all of them — the sign-in branch
 *   interpolates the link's own `error` parameter
 *   (`Sign in could not be completed: ${…}`) with no length or charset check on
 *   it, and anyone who can get the operating system to open a `rally://` URL
 *   chooses that string. So the untrusted path is the link, not only a renderer
 *   that has been taken over.
 * Direction: upper bound; the open value is +Infinity.
 * Trips: the invoke rejects and no window opens. The reporting renderer already
 *   ignores the result, so a refused message costs the failure notice, not the
 *   surface that reported it.
 * Derive from: the longest fixed message in `app-session.tsx` against the
 *   window's 420x260 at the body type size — a couple of lines of copy, not a
 *   document. Bounding the interpolation at its own source would be better
 *   still; this guard is the backstop, not the fix.
 */
const DEEP_LINK_ERROR_MESSAGE_LIMIT = Number.POSITIVE_INFINITY;

let deepLinkErrorWindow: BrowserWindow | null = null;
// Held in main rather than passed in the URL so that re-showing the singleton
// with a later failure does not have to reload the window to change its text.
let deepLinkErrorMessage: string | null = null;
const meetingWindows = new Set<BrowserWindow>();
const meetingWindowsAllowedToClose = new WeakSet<BrowserWindow>();
let rendererReady = false;
let quitting = false;
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
const realtimeSocketBroker = new RealtimeSocketBroker(createNodeRealtimeSocketFactory(
  (url) => electronSession.defaultSession.resolveProxy(url),
));
let telemetryIdentity: TelemetryIdentity | null = null;
let telemetryRoute: ResolvedTelemetryRoute = {
  route: 'global',
  basis: 'geolocation_fallback',
  anonymous: null,
};
let telemetryCapabilityRefresh: Promise<ResolvedTelemetryRoute['anonymous']> | null = null;
let telemetryReporter: TelemetryReporter | null = null;
const applicationOpenObserver = new ApplicationOpenObserver((entrypoint, phase) => {
  const reporter = telemetryReporter;
  if (reporter) void reporter.applicationOpened(entrypoint, phase).catch(() => undefined);
});
// A future native push-notification click must call
// `applicationOpenObserver.opened('push_notification')` before raising a window;
// ordinary deep links cannot truthfully identify which external surface sent them.
let applicationLaunchObserved = false;
let prelaunchDeepLinkObserved = false;
const applicationLifecycleTelemetry = new ApplicationLifecycleTelemetry((state) => {
  const reporter = telemetryReporter;
  if (reporter) void reporter.applicationLifecycle(state).catch(() => undefined);
});
let applicationForegrounded: boolean | null = null;

function observeApplicationForeground(foregrounded: boolean): void {
  const changed = applicationForegrounded !== foregrounded;
  applicationForegrounded = foregrounded;
  applicationLifecycleTelemetry.observeFocused(foregrounded);
  if (!changed) return;
  for (const window of rallyWindows()) {
    window.webContents.send('application:foreground-changed', foregrounded);
  }
}
let nativeCrashUploader: NativeCrashUploader | null = null;
let nativeCrashGenerationActive = false;
let nativeCrashGenerationInvalidated = false;
let telemetryFlushTimer: ReturnType<typeof setInterval> | null = null;
let telemetryAccountBinding: string | null = null;
let telemetryLinkInFlight: Promise<void> | null = null;
let telemetryLinkedCapability: string | null = null;
let telemetryLaunchId: string | null = null;
let telemetryBreadcrumbs: TelemetryBreadcrumbRing | null = null;
let telemetryContinuouslyEligible = false;
const pendingDeepLinks: DesktopDeepLinkNavigation[] = [];
const telemetryQuitBarrier = new TelemetryQuitBarrier(async () => {
  applicationOpenObserver.destroy();
  if (telemetryFlushTimer) clearInterval(telemetryFlushTimer);
  telemetryFlushTimer = null;
  await telemetryBreadcrumbs?.add({ kind: 'lifecycle', phase: 'graceful_exit' }).catch(() => undefined);
  const reporter = telemetryReporter;
  if (!reporter) return;
  await Promise.all([
    reporter.applicationLifecycle('graceful_exit').catch(() => undefined),
    reporter.desktopSession('ended', telemetryContinuouslyEligible).catch(() => undefined),
  ]);
  await reporter.flush().catch(() => undefined);
}, 750);
const hardenedWebContents = new WeakSet<WebContents>();
const telemetryWindowIds = new WeakMap<WebContents, string>();
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
const nativePerformanceLog = new NativePerformanceLog(
  () => {
    if (process.platform !== 'darwin') throw new Error('macOS Unified Logging is unavailable');
    return requireNativeModule(nativeUnifiedLogAddonPath({
      currentDirectory,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })) as NativeUnifiedLogBinding;
  },
  () => app.getVersion(),
  () => new Date(),
  (error) => logWarn('rally', 'could not write renderer performance data to macOS Unified Logging', error),
);

function telemetryWindowContext(contents: WebContents): TelemetryWindowContext | undefined {
  const window = BrowserWindow.fromWebContents(contents);
  if (!window || window.isDestroyed()) return undefined;
  let windowId = telemetryWindowIds.get(contents);
  if (!windowId) {
    windowId = uuidV7();
    telemetryWindowIds.set(contents, windowId);
  }
  const contentSize = window.getContentSize();
  const viewportWidth = contentSize[0];
  const viewportHeight = contentSize[1];
  const display = electronScreen.getDisplayMatching(window.getBounds());
  if (viewportWidth === undefined || viewportHeight === undefined
    || viewportWidth <= 0 || viewportHeight <= 0
    || display.size.width <= 0 || display.size.height <= 0) {
    return undefined;
  }
  return {
    windowId,
    viewportWidth,
    viewportHeight,
    screenWidth: display.size.width,
    screenHeight: display.size.height,
  };
}

async function reportJavascriptErrorCandidate(
  value: unknown,
  windowContext?: TelemetryWindowContext,
): Promise<void> {
  const normalized = await normalizeJavascriptErrorCandidate(value);
  if (!telemetryReporter) return;
  const reports = [telemetryReporter.javascriptException(
    normalized.process,
    normalized.errorCode,
    normalized.fingerprint,
    telemetryBreadcrumbs?.status() ?? 'unavailable',
    normalized.generatedFrames,
    windowContext,
  )];
  const processHealthState = javascriptErrorProcessHealthState(normalized.errorCode);
  if (processHealthState) {
    reports.push(telemetryReporter.processHealth(
      normalized.process,
      processHealthState,
      'unknown',
    ));
  }
  await Promise.all(reports);
}

function rallyWindows(): BrowserWindow[] {
  return [mainWindow, settingsWindow, deepLinkErrorWindow, ...meetingWindows]
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
}, {
  // The scheme a saved message is rendered from. Deliberately narrower than the
  // renderer's: an export document is one page of markup that fetches nothing,
  // so it needs an origin of its own and nothing else. Keeping it off
  // `app://rallywithai` is the point — a document built out of a model's words never
  // shares an origin with the application.
  scheme: MESSAGE_EXPORT_SCHEME,
  privileges: {
    standard: true,
    secure: true,
  },
}, ...themeAssetSchemes]);

// Keep development credentials and user data out of the production Rally
// namespace. Development Electron binaries are not signed with the stable
// release identity, so sharing `Rally Safe Storage` would make macOS re-prompt
// whenever their ad-hoc code requirement changes.
//
// The name is also what macOS derives the safeStorage keychain entry from, so
// a build named Rally cannot read what `Avalon Safe Storage` holds. Only Lockdown
// mode binds a session to that key; the default global mode does not, which is
// why the directory below carries almost everyone across and Lockdown users
// sign in once more. There is no Electron API that names the keychain entry
// independently of the app, so this is a consequence of the rename rather than
// a choice made here.
app.setName(app.isPackaged ? 'Rally' : 'Rally Development');
const appDataDirectory = app.getPath('appData');
app.setPath(
  'userData',
  userDataDirectoryForLaunch(
    appDataDirectory,
    app.isPackaged,
    app.commandLine.getSwitchValue('user-data-dir'),
    // Synchronous on purpose: userData has to be settled before Chromium or any
    // module that reads a path off it is allowed to observe it.
    { exists: existsSync, rename: renameSync },
  ),
);

function userDataDirectory(): string {
  return app.getPath('userData');
}

/**
 * The theme choice the last renderer reported, resolved for `backgroundColor`
 * on every window this process opens. It is read from the preference file at
 * startup so the very first window of a launch is already the right colour;
 * before that read completes it is Terra following the Mac, what Rally ships
 * with.
 *
 * The choice, not the appearance. `system` resolves against whatever the Mac is
 * set to *when it is read*, so storing the resolved value meant a Mac that
 * changed appearance while Rally was closed opened the next launch's first
 * window in yesterday's colour — precisely the flash this exists to prevent.
 */
let windowThemeChoice: ThemeChoice = defaultThemeChoice;

/**
 * Resolved at the moment a window is constructed rather than cached, so it also
 * follows a Mac that changes appearance while Rally is running.
 */
function windowBackgroundColor(): string {
  return themeWindowBackground[resolveTheme(windowThemeChoice, nativeTheme.shouldUseDarkColors)];
}

const telemetryFetch: typeof globalThis.fetch = (input, init) => net.fetch(
  input instanceof URL ? input.toString() : input,
  init,
);

const telemetrySpool = new TelemetrySpool({
  rootDirectory: join(userDataDirectory(), 'telemetry', 'events'),
});

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

/**
 * Stops waiting on `work` after `timeoutMs`, without cancelling it. The work
 * keeps running for whoever else is awaiting it; only this caller gives up.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let expire: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        expire = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (expire !== undefined) clearTimeout(expire);
  }
}

/** Who the flag poll is asking as. The endpoint is part of it because the same
 * person is a different regional account on each one. Both callers derive it
 * here: a stored credential and a live session have to agree on the identity or
 * a launch would look like an account change and poll twice. */
function flagSessionIdentity(userId: string, apiBaseUrl: string): string {
  return `${userId}@${apiBaseUrl}`;
}

function broadcastSessionChanged(value: WireSession | null): void {
  const exposed = value ? publicSession(value) : null;
  for (const window of rallyWindows()) window.webContents.send('session:changed', exposed);
  // Whether Developer may be offered belongs to the signed-in account, so a
  // sign-in asks again immediately rather than waiting out a poll interval, and
  // a sign-out closes the section on the way past. The identity is what makes
  // that distinction: this also fires on every token refresh, which is the same
  // account and must not cost an extra poll, and an account swap must not be
  // answered by a request issued as the previous one.
  if (exposed) developerSettingsFlagController.observeSession(flagSessionIdentity(exposed.user.id, exposed.apiBaseUrl));
  else {
    developerSettingsFlagController.stop();
    observeClientFeatureFlags(ClientFeatureFlagsSchema.parse({}));
  }
  // The menu bar item outlives every window, so it has to be told about a
  // sign-out directly. Leaving the previous account's work-stream titles in the
  // menu would keep them readable to whoever signs in next.
  //
  // Only the sign-out half is unconditional. This also fires on every token
  // renewal, so fetching without a status item to fill would be recurring API
  // traffic — and a cache of work-stream titles in memory — on every Windows and
  // Linux install and on any Mac with the preference off. `clear()` stays
  // ungated so a cache from a session where the item *was* on cannot outlive it.
  if (!exposed) menuBarContentStore.clear();
  else if (menuBarItemIsLive()) void menuBarContentStore.refresh();
  menuBarController.refresh();

  const nextBinding = exposed ? flagSessionIdentity(exposed.user.id, exposed.apiBaseUrl) : null;
  if (nextBinding && nextBinding !== telemetryAccountBinding) {
    void productAnalyticsSettingsController.requireRemoteVerification()
      .then(async () => {
        await productAnalyticsSettingsController.refresh();
        await telemetryReporter?.applicationSettingsState(applicationSettingsTelemetryState());
        flushTelemetryAndRetryLink();
      })
      .catch((error: unknown) => {
        logWarn('rally', 'could not synchronize the Product analytics preference', error);
      });
  }
  if (telemetryAccountBinding && telemetryAccountBinding !== nextBinding) {
    void telemetrySpool.purgeNonessential();
    void rotateTelemetryEpochsAfterAccountChange();
  }
  telemetryAccountBinding = nextBinding;
  if (exposed?.workspace) {
    const nextRoute = exposed.workspace.region;
    if (telemetryRoute.route !== nextRoute) {
      telemetryRoute = {
        route: nextRoute,
        basis: 'explicit_binding',
        anonymous: telemetryRoute.anonymous?.route === nextRoute ? telemetryRoute.anonymous : null,
      };
      if (nativeCrashGenerationActive) {
        nativeCrashGenerationInvalidated = true;
        telemetryContinuouslyEligible = false;
        void telemetryReporter?.crashUploadState('invalidated');
        void invalidateActiveNativeCrashGeneration({
          rootDirectory: join(userDataDirectory(), 'telemetry', 'native-crashes'),
          invalidatedAt: new Date(),
        }).catch((error: unknown) => logWarn('rally', 'could not invalidate the native crash generation', error));
      }
      if (productAnalyticsSettingsController.state().effectiveEnabled && telemetryLaunchId) {
        // The old generation sidecar is route-bound with its invalidated dump.
        // Keep later JavaScript breadcrumbs in memory, never in that directory.
        telemetryBreadcrumbs = new TelemetryBreadcrumbRing({
          launchId: telemetryLaunchId, sidecarPath: null, now: () => new Date(),
        });
      }
      broadcastApplicationSettingsChanged(desktopApplicationSettings());
    }
  }
  if (exposed) void linkCurrentAnonymousTelemetry();
}

async function rotateTelemetryEpochsAfterAccountChange(): Promise<void> {
  try {
    telemetryIdentity = await rotateTelemetryEpochs(userDataDirectory());
  } catch (error) {
    logWarn('rally', 'could not rotate telemetry identity epochs', error);
  }
}

function linkCurrentAnonymousTelemetry(): Promise<void> {
  const anonymous = telemetryRoute.anonymous;
  const capability = anonymous?.capability;
  if (!capability || telemetryLinkedCapability === capability) return Promise.resolve();
  if (telemetryLinkInFlight) return telemetryLinkInFlight;
  telemetryLinkInFlight = (async () => {
    // The server closes the capability after the identity transition. Drain
    // locally accepted anonymous events first so a successful link cannot
    // strand them behind a deliberately revoked journey.
    await telemetryReporter?.flush();
    const identity = telemetryIdentity;
    if (!identity || await telemetrySpool.hasPendingAccountEpoch(identity.anonymousEpochId, new Date())) return;
    const auth = await loadStoredAuth();
    if (!auth || auth.binding.region !== anonymous.route) return;
    const response = await telemetryFetch(`${apiBaseForAuth(auth)}/telemetry/link-anonymous`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ capability }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw await responseError(response);
    telemetryLinkedCapability = capability;
    if (telemetryRoute.anonymous?.capability === capability) {
      telemetryRoute = { ...telemetryRoute, anonymous: null };
    }
  })().catch((error: unknown) => {
    logWarn('rally', 'could not link the anonymous analytics epoch', error);
  }).finally(() => { telemetryLinkInFlight = null; });
  return telemetryLinkInFlight;
}

function flushTelemetryAndRetryLink(): void {
  const flush = telemetryReporter?.flush();
  if (!flush) return;
  void flush.then(() => {
    if (telemetryAccountBinding) return linkCurrentAnonymousTelemetry();
    return undefined;
  });
}

function refreshCurrentTelemetryCapability(): Promise<ResolvedTelemetryRoute['anonymous']> {
  if (telemetryCapabilityRefresh) return telemetryCapabilityRefresh;
  telemetryCapabilityRefresh = (async () => {
    if (!telemetryIdentity || !telemetryRoute.anonymous) return null;
    const refreshed = await refreshTelemetryCapability({
      current: telemetryRoute,
      anonymousEpochId: telemetryIdentity.anonymousEpochId,
      globalApiBaseUrl: runtimeConfig().api.global,
      fetch: telemetryFetch,
    });
    if (refreshed) telemetryRoute = { ...telemetryRoute, anonymous: refreshed };
    return refreshed;
  })().finally(() => { telemetryCapabilityRefresh = null; });
  return telemetryCapabilityRefresh;
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

function regionForStoredSession(value: WireSession): RallyRegion {
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
  for (const window of rallyWindows()) window.webContents.send('application-settings:changed', settings);
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
    ...supersededUserDataDirectories(appDataDirectory, app.isPackaged),
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
  writeSettings: (settings) => updateStoredApplicationSettings(userDataDirectory(), settings),
  migrateSession: migrateSessionEncryption,
  recoverGlobalSessionWithoutKeystore,
  clearCredentialsForRelogin: clearCredentialsForLockdownRelogin,
  runExclusive: withSessionMutation,
  onChange: (lockdown) => broadcastApplicationSettingsChanged(desktopApplicationSettings(lockdown)),
});

const debugSettingsController = new DebugSettingsController({
  readSettings: () => readStoredApplicationSettings(userDataDirectory()),
  writeSettings: (settings) => updateStoredApplicationSettings(userDataDirectory(), settings),
  onChange: () => broadcastApplicationSettingsChanged(desktopApplicationSettings()),
});

async function requestProductAnalyticsPreference(): Promise<{
  enabled: boolean;
  version: number;
}> {
  const auth = await loadStoredAuth();
  if (!auth) throw new Error('Sign in before changing Product analytics');
  const response = await net.fetch(`${apiBaseForAuth(auth)}/telemetry/preference`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${auth.accessToken}` },
    signal: AbortSignal.timeout(PRODUCT_ANALYTICS_PREFERENCE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await responseError(response);
  return ProductAnalyticsPreferenceSchema.parse(await readJsonBody(response));
}

async function syncProductAnalyticsPreference(
  enabled: boolean,
  expectedVersion: number,
): Promise<{ enabled: boolean; version: number }> {
  const auth = await loadStoredAuth();
  if (!auth) throw new Error('Sign in before changing Product analytics');
  const apply = (version: number) => net.fetch(`${apiBaseForAuth(auth)}/telemetry/preference`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enabled, expectedVersion: version }),
    signal: AbortSignal.timeout(15_000),
  });
  const response = await apply(expectedVersion);
  if (response.status === 409) {
    // Another installation won the compare-and-set. Adopt that canonical
    // preference instead of replaying this installation's stale choice over it.
    return requestProductAnalyticsPreference();
  }
  if (!response.ok) throw await responseError(response);
  return ProductAnalyticsPreferenceSchema.parse(await readJsonBody(response));
}

const productAnalyticsSettingsController = new ProductAnalyticsSettingsController({
  readSettings: () => readStoredApplicationSettings(userDataDirectory()),
  writeSettings: (settings) => updateStoredApplicationSettings(userDataDirectory(), settings),
  readPreference: requestProductAnalyticsPreference,
  syncPreference: syncProductAnalyticsPreference,
  invalidateNativeCrashGeneration: async () => {
    await invalidateActiveNativeCrashGeneration({
      rootDirectory: join(userDataDirectory(), 'telemetry', 'native-crashes'),
      invalidatedAt: new Date(),
    });
    if (nativeCrashGenerationActive) nativeCrashGenerationInvalidated = true;
    telemetryContinuouslyEligible = false;
    void telemetryReporter?.crashUploadState('invalidated');
    if (nativeCrashGenerationActive) void telemetryReporter?.crashUploadState('awaiting_restart');
  },
  purgeNonessentialSpool: async () => {
    await Promise.all([
      telemetrySpool.purgeNonessential(),
      nativeCrashUploader?.purgeInactive() ?? Promise.resolve(),
    ]);
  },
  onChange: (state) => {
    if (!state.effectiveEnabled) telemetryBreadcrumbs = null;
    else if (!telemetryBreadcrumbs && telemetryLaunchId) {
      telemetryBreadcrumbs = new TelemetryBreadcrumbRing({
        launchId: telemetryLaunchId, sidecarPath: null, now: () => new Date(),
      });
    }
    broadcastApplicationSettingsChanged(desktopApplicationSettings());
  },
});

const developerSettingsFlagController = new DeveloperSettingsFlagController({
  read: readDeveloperSettingsFlag,
  onChange: () => broadcastApplicationSettingsChanged(desktopApplicationSettings()),
  // Once per outage rather than once per poll: a device that cannot reach the
  // service keeps its last answer, so a permanently broken poll would otherwise
  // be indistinguishable from a quiet, working one.
  // Both edges warn, because both describe the same degraded state: the device
  // is serving an answer it can no longer confirm, and then is not. A quieter
  // level for the recovery would leave the warning that opened it unclosed.
  onAvailabilityChange: (reachable, error) => {
    if (reachable) logWarn('rally', 'the developer settings flag is readable again');
    else logWarn('rally', 'could not read the developer settings flag', error);
  },
});

const menuBarContentStore = new MenuBarContentStore({
  requestJson: rallyApiRequest,
  onChange: () => menuBarController.refresh(),
  logWarning: (message, error) => logWarn('rally', message, error),
  suggestedWorkAvailable: () => suggestedWorkAvailable,
});

const launchAtLoginController = new LaunchAtLoginController({
  supported: process.platform === 'darwin',
  // A development run's executable is a shared Electron binary in
  // `node_modules`, not an installed Rally. Registering it would add a login
  // item that outlives the checkout, so the enabled-by-default registration is
  // only made by a packaged build. The toggle itself still works.
  registersDefault: process.platform === 'darwin' && app.isPackaged,
  getLoginItemState: () => {
    const settings = app.getLoginItemSettings();
    return { openAtLogin: settings.openAtLogin, wasOpenedAtLogin: settings.wasOpenedAtLogin };
  },
  setOpenAtLogin: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
  readSettings: () => readStoredApplicationSettings(userDataDirectory()),
  writeSettings: (settings) => updateStoredApplicationSettings(userDataDirectory(), settings),
  onChange: () => broadcastApplicationSettingsChanged(desktopApplicationSettings()),
  logWarning: (message, error) => logWarn('rally', message, error),
});

/**
 * Whether there is a menu to fill. The preference and the platform both have to
 * agree before the main process spends a request on content nobody can see —
 * `MenuBarController.refresh()` returns early with no tray, so fetching for one
 * buys nothing and keeps workspace content in memory to no purpose.
 *
 * Deliberately `enabled() && available()` rather than `present()`: a status item
 * whose creation failed still has the preference on and will be retried at the
 * next launch, and content fetched meanwhile is what that retry renders.
 */
function menuBarItemIsLive(): boolean {
  return menuBarController.available() && menuBarController.enabled();
}

/** A status item click does not activate Rally the way a Dock click does, so
 * anything opened from the menu would appear behind the frontmost app. */
function activateFromMenuBar(): void {
  applicationOpenObserver.opened('menu_bar');
  app.focus({ steal: true });
}

function openMainWindowFromMenuBar(): void {
  activateFromMenuBar();
  void createMainWindow().catch((error: unknown) => {
    logError('rally', 'failed to open the main window from the menu bar', error);
  });
}

function startSuggestedWorkstreamFromMenuBar(suggestion: MenuBarSuggestion): void {
  activateFromMenuBar();
  void menuBarContentStore.startSuggestion(suggestion)
    .then((workstreamId) => {
      emitDeepLink(`${customProtocol}://workstreams/${workstreamId}`, 'menu_bar');
    })
    .catch((error: unknown) => {
      // The click has to land somewhere. Opening Rally puts the person in
      // front of the same suggestion on the home screen, where starting it
      // again reports its own failure.
      logWarn('rally', 'could not start a suggested work stream from the menu bar', error);
      openMainWindowFromMenuBar();
    });
}

let meetingRecordingAvailable = false;
let suggestedWorkAvailable = false;

function observeClientFeatureFlags(flags: ClientFeatureFlags): void {
  const changed = meetingRecordingAvailable !== flags.meetingRecordingEnabled
    || suggestedWorkAvailable !== flags.suggestedWorkEnabled;
  meetingRecordingAvailable = flags.meetingRecordingEnabled;
  suggestedWorkAvailable = flags.suggestedWorkEnabled;
  if (changed) {
    // Only the main-process surfaces are projected here. Renderer surfaces
    // consume the live workspace-socket cache directly.
    menuBarController.refresh();
  }
}

const menuBarController = new MenuBarController({
  supported: process.platform === 'darwin',
  appName: app.name,
  createTray: createMenuBarTray,
  content: () => menuBarContentStore.content(),
  // The in-memory credential rather than a live session: this is read while the
  // menu is being built, and it only decides which empty state to show.
  signedIn: () => Boolean(inMemoryAuth),
  meetingRecordingAvailable: () => meetingRecordingAvailable,
  suggestedWorkAvailable: () => suggestedWorkAvailable,
  sectionHeaders: supportsSectionHeaders(process.getSystemVersion()),
  actions: {
    selected: (action) => { void telemetryReporter?.menuBarActionSelected(action); },
    newMeetingNote: () => {
      activateFromMenuBar();
      void createMeetingWindow(undefined, 'menu_bar').catch((error: unknown) => {
        logError('rally', 'failed to open meeting notes from the menu bar', error);
      });
    },
    newWorkstream: () => {
      activateFromMenuBar();
      emitDeepLink(`${customProtocol}://workstreams/new`, 'menu_bar');
    },
    newAutomation: () => {
      activateFromMenuBar();
      emitDeepLink(`${customProtocol}://automations/new`, 'menu_bar');
    },
    startSuggestion: startSuggestedWorkstreamFromMenuBar,
    openWorkstream: (workstreamId) => {
      activateFromMenuBar();
      emitDeepLink(`${customProtocol}://workstreams/${workstreamId}`, 'menu_bar');
    },
    openRally: openMainWindowFromMenuBar,
    quit: () => app.quit(),
  },
  readSettings: () => readStoredApplicationSettings(userDataDirectory()),
  writeSettings: (settings) => updateStoredApplicationSettings(userDataDirectory(), settings),
  onChange: () => broadcastApplicationSettingsChanged(desktopApplicationSettings()),
  logWarning: (message, error) => logWarn('rally', message, error),
});

function desktopApplicationSettings(
  lockdown: DesktopLockdownSettings = lockdownModeController.state(),
): DesktopApplicationSettings {
  const developerSettingsAvailable = developerSettingsFlagController.enabled();
  return {
    ...lockdown,
    developerSettingsAvailable,
    // The effective preference, not the stored one. Debug enabled is a
    // per-device choice inside a section the service decides exists at all, so
    // a stored `true` grants nothing once the flag is off. Gating it here
    // rather than at each reader means no surface can miss the second half:
    // every window reads this one value. The stored bit is left alone, so the
    // choice is still there when the flag comes back.
    debugEnabled: debugSettingsController.enabled() && developerSettingsAvailable,
    menuBarEnabled: menuBarController.enabled(),
    menuBarAvailable: menuBarController.available(),
    menuBarPresent: menuBarController.present(),
    launchAtLogin: launchAtLoginController.enabled(),
    launchAtLoginAvailable: launchAtLoginController.available(),
    productAnalyticsEnabled: productAnalyticsSettingsController.state().desiredEnabled,
    productAnalyticsEffective: productAnalyticsSettingsController.state().effectiveEnabled,
    productAnalyticsPreferencePending: productAnalyticsSettingsController.state().pending,
    nativeCrashRestartRequired: nativeCrashGenerationActive
      && (nativeCrashGenerationInvalidated || !productAnalyticsSettingsController.state().effectiveEnabled),
  };
}

function applicationSettingsTelemetryState(): ApplicationSettingsTelemetryState {
  const lockdown = lockdownModeController.state();
  const icon = applicationIconController.state();
  return {
    launchAtLoginEnabled: launchAtLoginController.enabled(),
    launchAtLoginAvailable: launchAtLoginController.available(),
    lockdownModeEnabled: lockdown.lockdownMode,
    lockdownModeAvailable: lockdown.lockdownAvailable,
    menuBarEnabled: menuBarController.enabled(),
    menuBarAvailable: menuBarController.available(),
    menuBarPresent: menuBarController.present(),
    applicationIcon: icon.activeIcon,
    applicationIconAutomatic: icon.isAutomatic,
    applicationIconAvailable: icon.supported,
  };
}

/**
 * Asks the service whether Application → Developer may be offered. Rejects
 * rather than answering `false` when the question could not be put — the
 * controller keeps its last answer through an outage, and only a real answer
 * moves it. No stored session is an answer, though: signed out is off.
 */
async function readDeveloperSettingsFlag(): Promise<boolean> {
  const stored = await loadStoredAuth();
  if (!stored) return false;
  const apiBaseUrl = apiBaseForAuth(stored);
  const ask = async (accessToken: string): Promise<Response> => net.fetch(`${apiBaseUrl}/feature-flags`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    // A poll must always settle. A connection that hangs — a captive portal
    // answering the handshake and nothing else is the usual way — would
    // otherwise leave the request the controller shares between callers pending
    // forever, and the flag would stop being read for the life of the process.
    signal: AbortSignal.timeout(DEVELOPER_SETTINGS_FLAG_REQUEST_TIMEOUT_MS),
  });
  let response = await ask(stored.accessToken);
  if (response.status === 401) {
    // The poll runs on its own schedule, so it is often the first request to
    // meet an expired access token. Renewing through the coalescing path shares
    // whatever refresh a renderer already has in flight — and that is also why
    // the wait is bounded here rather than inside `requestSession`: the refresh
    // is shared with callers who should keep waiting for it, while this poll
    // must give up and be asked again on the next tick. Without this the hop
    // would be the one unbounded step in a function whose whole contract is
    // that it settles.
    const renewed = await withDeadline(
      coalescedRefreshSession(),
      DEVELOPER_SETTINGS_FLAG_REQUEST_TIMEOUT_MS,
      'Renewing the Rally session for the feature flag poll timed out',
    );
    response = await ask(renewed.accessToken);
  }
  if (!response.ok) throw await responseError(response);
  const parsed = ClientFeatureFlagsSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Rally returned an unreadable feature flag response');
  observeClientFeatureFlags(parsed.data);
  return parsed.data.developerSettings;
}

/**
 * Performs an authorized request against the signed-in account's regional API
 * from the main process.
 *
 * This exists for the menu bar item, which has to work when no window is open —
 * a launch at login opens none — so it cannot ask a renderer to fetch for it.
 * Like the feature-flag poll it renews once through the coalescing refresh on a
 * 401, and it always settles: a connection that hangs would otherwise wedge the
 * status item's content for the life of the process.
 */
async function rallyApiRequest(
  path: string,
  init?: { method: 'POST'; body: unknown },
): Promise<unknown> {
  const stored = await loadStoredAuth();
  if (!stored) throw new Error('No Rally session is available');
  const apiBaseUrl = apiBaseForAuth(stored);
  const ask = async (accessToken: string): Promise<Response> => net.fetch(`${apiBaseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(MENU_BAR_REQUEST_TIMEOUT_MS),
  });
  let response = await ask(stored.accessToken);
  if (response.status === 401) {
    const renewed = await withDeadline(
      coalescedRefreshSession(),
      MENU_BAR_REQUEST_TIMEOUT_MS,
      'Renewing the Rally session for the menu bar timed out',
    );
    response = await ask(renewed.accessToken);
  }
  if (!response.ok) throw await responseError(response);
  return readJsonBody(response);
}

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
      logWarn('rally', 'the legacy desktop session did not match its durable schema');
      return null;
    }
    const auth = await writeSplitSessionFiles(legacySession);
    inMemoryAuth = auth;
    inMemorySession = legacySession;
    return auth;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      logWarn('rally', 'could not migrate the encrypted desktop session', error);
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
      logWarn('rally', 'the stored desktop credential did not match its durable schema');
      return null;
    }
    inMemoryAuth = auth;
    return auth;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return migrateLegacySessionToSplitStorage();
    logWarn('rally', 'could not restore the stored desktop credential', error);
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
      logWarn('rally', 'discarding an incompatible desktop profile cache');
      return null;
    }
    const stored = sessionFromStoredState(auth, profile, apiBaseForAuth(auth));
    if (!stored) {
      logWarn('rally', 'discarding a desktop profile cache with a mismatched credential binding');
      return null;
    }
    inMemorySession = stored;
    return stored;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      logWarn('rally', 'could not restore the desktop profile cache', error);
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
    ...supersededUserDataDirectories(appDataDirectory, app.isPackaged),
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

function parseRallyBaseUrl(value: string | undefined, fallback: string): string {
  const parsed = new URL(value ?? fallback);
  if (!allowedExternalProtocols.has(parsed.protocol)) {
    throw new Error(`Unsupported Rally endpoint protocol: ${parsed.protocol}`);
  }
  if (app.isPackaged && parsed.protocol !== 'https:') {
    throw new Error('Packaged Rally endpoints must use HTTPS');
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
      global: parseRallyBaseUrl(
        packaged ? undefined : process.env['VITE_API_GLOBAL_URL'],
        packaged ? 'https://api.rallywith.ai' : 'http://127.0.0.1:8787',
      ),
      eu: parseRallyBaseUrl(
        packaged ? undefined : process.env['VITE_API_EU_URL'],
        packaged ? 'https://eu.api.rallywith.ai' : 'http://127.0.0.1:8788',
      ),
    },
    webBaseUrl: parseRallyBaseUrl(
      packaged ? undefined : process.env['PUBLIC_WEB_BASE_URL'],
      packaged ? 'https://rallywith.ai' : 'http://127.0.0.1:5174',
    ),
    devAuthEnabled: process.env['RALLY_DEV_AUTH'] !== 'false' && !app.isPackaged,
  };
}

async function telemetryAuthenticatedSession(): Promise<{
  apiBaseUrl: string;
  accessToken: string;
  workspace: boolean;
  route: 'global' | 'eu';
} | null> {
  const auth = await loadStoredAuth();
  if (!auth) return null;
  return {
    apiBaseUrl: apiBaseForAuth(auth),
    accessToken: auth.accessToken,
    workspace: auth.binding.workspaceId !== null,
    route: auth.binding.region,
  };
}

async function initializeTelemetry(launchAuth: StoredAuth | null): Promise<void> {
  telemetryLaunchId = uuidV7();
  const launchState = await beginTelemetryLaunch(userDataDirectory(), telemetryLaunchId, new Date());
  const identityState = await readTelemetryIdentityState(userDataDirectory());
  telemetryIdentity = identityState.identity;
  telemetryAccountBinding = launchAuth
    ? flagSessionIdentity(launchAuth.binding.userId, apiBaseForAuth(launchAuth))
    : null;
  telemetryRoute = await resolveTelemetryRoute({
    explicitRegion: launchAuth?.binding.workspaceId ? launchAuth.binding.region : null,
    anonymousEpochId: telemetryIdentity.anonymousEpochId,
    globalApiBaseUrl: runtimeConfig().api.global,
    fetch: telemetryFetch,
  });

  const crashRoot = join(userDataDirectory(), 'telemetry', 'native-crashes');
  const startupSpoolMaintenance = await telemetrySpool.maintain(new Date());
  telemetryContinuouslyEligible = productAnalyticsSettingsController.state().effectiveEnabled;
  const crashRoute = productAnalyticsSettingsController.state().effectiveEnabled
    && (telemetryRoute.route === 'global' || telemetryRoute.basis === 'explicit_binding')
    ? telemetryRoute.route
    : null;
  const generation = await prepareNativeCrashGeneration({
    rootDirectory: crashRoot,
    route: crashRoute,
    now: new Date(),
    generationId: uuidV7(),
    runtime: {
      release: runtimeConfig().appVersion,
      buildId: runtimeConfig().appVersion,
      platform: process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? process.platform
        : 'linux',
      architecture: process.arch === 'arm64' || process.arch === 'x64' ? process.arch : 'x64',
      launchId: telemetryLaunchId,
      channel: app.isPackaged ? 'stable' : 'development',
    },
  });
  if (productAnalyticsSettingsController.state().effectiveEnabled) {
    telemetryBreadcrumbs = new TelemetryBreadcrumbRing({
      launchId: telemetryLaunchId,
      sidecarPath: generation.activeCrashpadDirectory
        ? join(dirname(generation.activeCrashpadDirectory), 'breadcrumbs.json')
        : null,
      now: () => new Date(),
    });
    await telemetryBreadcrumbs.add({ kind: 'lifecycle', phase: 'launch_started' });
  }
  if (generation.activeCrashpadDirectory) {
    try {
      app.setPath('crashDumps', generation.activeCrashpadDirectory);
      crashReporter.start({
        productName: 'Rally',
        uploadToServer: false,
        ignoreSystemCrashHandler: true,
        rateLimit: false,
        compress: false,
        globalExtra: {
          rally_generation: generation.activeGenerationId ?? 'unknown',
          rally_region: crashRoute ?? 'unknown',
        },
      });
      nativeCrashGenerationActive = true;
    } catch (error) {
      telemetryContinuouslyEligible = false;
      nativeCrashGenerationInvalidated = true;
      await invalidateActiveNativeCrashGeneration({ rootDirectory: crashRoot, invalidatedAt: new Date() });
      logWarn('rally', 'could not start native crash reporting', error);
    }
  }

  const runtime = runtimeConfig();
  const primaryDisplay = electronScreen.getPrimaryDisplay();
  telemetryReporter = new TelemetryReporter({
    spool: telemetrySpool,
    identity: () => {
      if (!telemetryIdentity) throw new Error('Telemetry identity is unavailable');
      return telemetryIdentity;
    },
    route: () => telemetryRoute.route,
    productAnalyticsEnabled: () => productAnalyticsSettingsController.admissionEnabled(),
    productAnalyticsDeliveryEnabled: () => productAnalyticsSettingsController.state().effectiveEnabled,
    crashReportingEligible: () => telemetryContinuouslyEligible,
    authenticatedSession: telemetryAuthenticatedSession,
    anonymousSession: () => telemetryRoute.anonymous,
    refreshAnonymousSession: refreshCurrentTelemetryCapability,
    fetch: telemetryFetch,
    now: () => new Date(),
    runtime: {
      environment: app.isPackaged ? 'production' : 'development',
      release: runtime.appVersion,
      buildId: runtime.appVersion,
      ...(process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? { platform: process.platform }
        : {}),
      ...(process.arch === 'arm64' || process.arch === 'x64' ? { arch: process.arch } : {}),
      channel: app.isPackaged ? 'stable' : 'development',
      launchId: telemetryLaunchId,
      osVersion: process.getSystemVersion(),
      locale: app.getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      screenWidth: primaryDisplay.size.width,
      screenHeight: primaryDisplay.size.height,
    },
    globalApiBaseUrl: runtime.api.global,
  });
  nativeCrashUploader = new NativeCrashUploader({
    rootDirectory: crashRoot,
    enabled: () => productAnalyticsSettingsController.state().effectiveEnabled,
    identity: () => {
      if (!telemetryIdentity) throw new Error('Telemetry identity is unavailable');
      return telemetryIdentity;
    },
    authenticatedSession: telemetryAuthenticatedSession,
    anonymousSession: () => telemetryRoute.anonymous
      ? {
          capability: telemetryRoute.anonymous.capability,
          route: telemetryRoute.route,
          expiresAt: telemetryRoute.anonymous.expiresAt,
        }
      : null,
    refreshAnonymousSession: async () => {
      const refreshed = await refreshCurrentTelemetryCapability();
      return refreshed ? {
        capability: refreshed.capability,
        route: refreshed.route,
        expiresAt: refreshed.expiresAt,
      } : null;
    },
    globalApiBaseUrl: runtime.api.global,
    fetch: telemetryFetch,
    onState: (state) => telemetryReporter?.crashUploadState(state),
  });
  if (!generation.activeCrashpadDirectory) telemetryContinuouslyEligible = false;
  if (generation.rotatedGenerationIds.length > 0) await telemetryReporter.crashUploadState('rotated');
  if (generation.purgedGenerationIds.length > 0) await telemetryReporter.crashUploadState('expired');
  if (startupSpoolMaintenance.expired > 0) {
    await telemetryReporter.telemetrySpoolState('expired', startupSpoolMaintenance.expired);
  }
  if (startupSpoolMaintenance.quarantined > 0) {
    await telemetryReporter.telemetrySpoolState('quarantined', startupSpoolMaintenance.quarantined);
  }
  if (startupSpoolMaintenance.evicted > 0) {
    await telemetryReporter.telemetrySpoolState('evicted', startupSpoolMaintenance.evicted);
  }
  try {
    // At most one older pending transition and one transition into this build
    // can exist. The persisted event ID makes a retry safe even if enqueue
    // succeeds but acknowledging the version marker is interrupted.
    for (let transitionIndex = 0; transitionIndex < 2; transitionIndex += 1) {
      const pending = await applicationVersionTransition({
        userDataDirectory: userDataDirectory(),
        version: runtime.appVersion,
        // Rally publishes one immutable desktop artifact for each semantic
        // version today, so that version is also the packaged build identity.
        // Keep the fields separate for the native SDK contract and a future
        // independently versioned build without changing stored history.
        build: runtime.appVersion,
        newInstallation: identityState.created,
      });
      if (!pending) break;
      const enqueued = await telemetryReporter.applicationVersionChanged(pending.transition, pending.eventId);
      if (!enqueued) break;
      await acknowledgeApplicationVersionTransition({
        userDataDirectory: userDataDirectory(),
        eventId: pending.eventId,
      });
    }
  } catch (error) {
    logWarn('rally', 'could not record the application version transition', error);
  }
  await telemetryReporter.applicationLifecycle('launch_started');
  await telemetryReporter.desktopSession('started', telemetryContinuouslyEligible);
  if (launchState.priorUncleanExit) {
    await telemetryReporter.processHealth('main', 'unclean_exit', launchState.priorUncleanExit);
  }
  if (launchAuth) void linkCurrentAnonymousTelemetry();
  flushTelemetryAndRetryLink();
  void nativeCrashUploader.flush();
  telemetryFlushTimer = setInterval(() => {
    flushTelemetryAndRetryLink();
    void nativeCrashUploader?.flush();
  }, 30_000);
  telemetryFlushTimer.unref();
}

function validatedApiBase(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') throw new Error('Invalid regional API endpoint');
  const normalized = new URL(rawUrl).toString().replace(/\/$/u, '');
  if (!Object.values(runtimeConfig().api).includes(normalized)) {
    throw new Error('The requested endpoint does not match a Rally region');
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
  if (!parsed.success) throw new UnusableCredentialError('Rally returned an invalid authentication session');
  const returnedApiBaseUrl = new URL(parsed.data.apiBaseUrl).toString().replace(/\/$/u, '');
  if (returnedApiBaseUrl !== apiBaseUrl) {
    throw new UnusableCredentialError('The regional service returned a mismatched endpoint');
  }
  return { ...parsed.data, apiBaseUrl: returnedApiBaseUrl };
}

async function exchangeDesktopTicket(input: unknown): Promise<DesktopSession> {
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  if (loggingOut) throw new Error('Wait for Rally to finish signing out before signing in again');
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
    throw new Error('Rally sign-in must use the platform identity endpoint');
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
    throw new Error('Rally sign-in returned a workspace before platform discovery');
  }
  if (session.apiBaseUrl !== apiBaseUrl) throw new Error('The regional service returned a mismatched endpoint');
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      desktopAuthAttempts.discard(candidate.attemptId as string);
      throw new Error('Rally was signed out while sign-in was completing');
    }
    const currentAttempt = desktopAuthAttempts.proof(candidate.attemptId as string);
    if (
      !currentAttempt
      || currentAttempt.apiBaseUrl !== apiBaseUrl
      || currentAttempt.region !== candidate.region
    ) {
      throw new Error('A newer Rally sign-in attempt replaced this callback');
    }
    if (await loadStoredAuth()) {
      desktopAuthAttempts.discard(candidate.attemptId as string);
      throw new Error('Another Rally sign-in completed first');
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
    throw new Error('Rally uses one platform sign-in endpoint');
  }
  const apiBaseUrl = validatedApiBase(candidate.apiBaseUrl);
  if (apiBaseUrl !== runtimeConfig().api.global) {
    throw new Error('The authentication endpoint does not match Rally sign-in');
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
  if (!stored) throw new Error('Sign in to Rally before setting up a workspace');
  if (stored.workspace) throw new Error('This Rally account already has an active workspace');
  if (stored.apiBaseUrl !== runtimeConfig().api.global) {
    throw new Error('Workspace setup requires a Rally platform identity session');
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
  if (!parsed.success) throw new Error('Rally returned an invalid workspace setup response');
  const accountEmail = identity.user.email.toLocaleLowerCase('en-US');
  if (parsed.data.invitations.some((invitation) => invitation.email.toLocaleLowerCase('en-US') !== accountEmail)) {
    throw new Error('Rally returned an invitation for another account');
  }
  return parsed.data;
}

async function requestOnboardingSession(
  path: string,
  body: unknown,
  expectedRegion: RallyRegion,
  expectedWorkspaceId?: string,
  operationId?: string,
): Promise<DesktopSession> {
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  const identity = await requireOnboardingIdentitySession();
  if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
    throw new Error('Rally was signed out while organization setup was running');
  }
  const response = await net.fetch(`${runtimeConfig().api.global}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.accessToken}`,
      ...(operationId ? { [RALLY_HEADERS.OPERATION_ID]: operationId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  const parsed = SessionSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.workspace) {
    throw new Error('Rally returned an invalid regional workspace session');
  }
  const targetApiBaseUrl = validatedApiBase(parsed.data.apiBaseUrl);
  if (
    targetApiBaseUrl !== runtimeConfig().api[expectedRegion]
    || parsed.data.workspace.region !== expectedRegion
    || (expectedWorkspaceId !== undefined && parsed.data.workspace.id !== expectedWorkspaceId)
  ) {
    throw new Error('Rally returned a workspace session for the wrong region');
  }
  if (parsed.data.user.email.toLocaleLowerCase('en-US') !== identity.user.email.toLocaleLowerCase('en-US')) {
    throw new Error('Rally returned a workspace session for another account');
  }
  const session = { ...parsed.data, apiBaseUrl: targetApiBaseUrl };
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      throw new Error('Rally was signed out while organization setup was running');
    }
    const current = await loadStoredSession();
    if (!current) throw new Error('Rally was signed out while organization setup was running');
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
      throw new Error('The signed-in Rally account changed during organization setup');
    }
    await persistSessionUnlocked(session);
    return publicSession(session);
  });
}

async function activateWorkspace(input: unknown): Promise<DesktopSession> {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (Object.keys(candidate).some((key) => !['region', 'workspaceId', 'operationId'].includes(key))) {
    throw new Error('Invalid workspace activation request');
  }
  const parsed = ActivateWorkspaceRequestSchema.safeParse({
    region: candidate['region'], workspaceId: candidate['workspaceId'],
  });
  if (!parsed.success) throw new Error('Invalid workspace activation request');
  const operationId = candidate['operationId'];
  if (operationId !== undefined && (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId))) {
    throw new Error('Invalid workspace activation operation ID');
  }
  return requestOnboardingSession(
    '/onboarding/workspace/activate',
    parsed.data,
    parsed.data.region,
    parsed.data.workspaceId,
    operationId as string | undefined,
  );
}

async function createWorkspace(input: unknown): Promise<DesktopSession> {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (Object.keys(candidate).some((key) => !['region', 'name', 'operationId'].includes(key))) {
    throw new Error('Invalid workspace creation request');
  }
  const parsed = CreateWorkspaceRequestSchema.safeParse({ region: candidate['region'], name: candidate['name'] });
  if (!parsed.success) throw new Error('Invalid workspace creation request');
  const operationId = candidate['operationId'];
  if (operationId !== undefined && (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId))) {
    throw new Error('Invalid workspace creation operation ID');
  }
  return requestOnboardingSession(
    '/onboarding/workspace', parsed.data, parsed.data.region, undefined, operationId as string | undefined,
  );
}

function parseInvitationAction(input: unknown): {
  invitationId: string;
  region: RallyRegion;
  operationId?: string;
} {
  if (!input || typeof input !== 'object') throw new Error('Invalid workspace invitation request');
  const candidate = input as { invitationId?: unknown; region?: unknown; operationId?: unknown };
  if (Object.keys(candidate).some((key) => !['region', 'invitationId', 'operationId'].includes(key))) {
    throw new Error('Invalid workspace invitation request');
  }
  const invitationId = IdSchema.safeParse(candidate.invitationId);
  const region = OnboardingRegionRequestSchema.safeParse({ region: candidate.region });
  if (!invitationId.success || !region.success) throw new Error('Invalid workspace invitation request');
  if (candidate.operationId !== undefined
    && (typeof candidate.operationId !== 'string' || !UUID_V7_PATTERN.test(candidate.operationId))) {
    throw new Error('Invalid workspace invitation operation ID');
  }
  return {
    invitationId: invitationId.data,
    region: region.data.region,
    ...(candidate.operationId ? { operationId: candidate.operationId } : {}),
  };
}

async function acceptInvitation(input: unknown): Promise<DesktopSession> {
  const parsed = parseInvitationAction(input);
  return requestOnboardingSession(
    `/onboarding/invitations/${encodeURIComponent(parsed.invitationId)}/accept`,
    { region: parsed.region },
    parsed.region,
    undefined,
    parsed.operationId,
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
  if (!previousAuth) throw new Error('No Rally session is available to refresh');
  if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
    throw new Error('Rally was signed out while the session was refreshing');
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
    // A binding the service will never agree with cannot be retried into
    // working. Joining the organization from another device rebinds the
    // server session while this device's stored binding stays unbound, so
    // this must surrender the credential rather than loop on it forever.
    if (!sessionsShareBinding(session, previousAuth) || session.apiBaseUrl !== apiBaseUrl) {
      throw new UnusableCredentialError('The refreshed session did not match the stored credential binding');
    }
  } catch (error) {
    // Only a terminal failure may delete anything, and only the credential
    // this attempt actually presented. A sign-out/sign-in, an organization
    // activation, or a lockdown relogin can persist a newer credential while
    // this request is in flight, so the generation is rechecked under the same
    // lock the success path takes. Everything else stays on disk so renderers
    // can keep retrying instead of treating a network blip as an expired
    // session.
    if (refreshFailureIsTerminal(error)) {
      try {
        await withSessionMutation(async () => {
          if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) return;
          const currentAuth = await loadStoredAuth();
          if (!currentAuth || !storedAuthMatches(currentAuth, previousAuth)) return;
          await clearStoredSessionUnlocked();
        });
      } catch (cleanupError) {
        logWarn('rally', 'could not clear a rejected desktop credential', cleanupError);
      }
    }
    throw error;
  }
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      throw new Error('Rally was signed out while the session was refreshing');
    }
    const currentAuth = await loadStoredAuth();
    if (!currentAuth) throw new Error('Rally was signed out while the session was refreshing');
    if (!storedAuthMatches(currentAuth, previousAuth)) {
      const current = await loadStoredSession();
      if (current) return current;
      throw new Error('A newer Rally credential replaced this refresh request');
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
      if (!stored) throw new Error('No Rally session is available while installing the update');
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
    throw new AggregateError(failures, 'Rally signed out locally but could not finish every logout cleanup step');
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

function sendDeepLink(rawUrl: string, entrypoint: DesktopDeepLinkEntrypoint): void {
  const navigation: DesktopDeepLinkNavigation = { url: rawUrl, entrypoint };
  const connectorResult = (() => {
    try {
      const deepLink = new URL(rawUrl);
      const connectionId = deepLink.searchParams.get('connection');
      const isAuthCompletion = isDeepLinkProtocol(deepLink.protocol)
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
  connectorSettingsWindow?.webContents.send('auth:deep-link', navigation);

  if (!mainWindow || !rendererReady) {
    if (!pendingDeepLinks.some((pending) => (
      pending.url === navigation.url && pending.entrypoint === navigation.entrypoint
    ))) pendingDeepLinks.push(navigation);
    if ((!mainWindow || mainWindow.isDestroyed()) && app.isReady()) void createMainWindow();
    if (connectorSettingsWindow) {
      if (connectorSettingsWindow.isMinimized()) connectorSettingsWindow.restore();
      connectorSettingsWindow.show();
      connectorSettingsWindow.focus();
    }
    return;
  }
  mainWindow.webContents.send('auth:deep-link', navigation);
  const targetWindow = connectorSettingsWindow ?? mainWindow;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
}

/**
 * Takes the main window to one note and raises it, for the meeting window that
 * is about to close behind it.
 *
 * It travels as a deep link on the channel every other navigation uses, so the
 * renderer needs no second dispatcher — but it is sent only to the main window,
 * unlike `sendDeepLink`. A note is a main-window destination, and the settings
 * renderer has no business navigating because a meeting ended.
 *
 * Every path through this ends with a window in front of the person, because the
 * caller closes the meeting window whether or not this could deliver. A window
 * that is not listening yet gets the link queued for `consumePendingDeepLinks`,
 * and is still raised — leaving the meeting window to vanish onto whatever was
 * behind it is the exact "go find the note yourself" step this removes.
 */
function revealNoteInMainWindow(noteId: string): void {
  const target = `${customProtocol}://notes/${noteId}`;
  const navigation: DesktopDeepLinkNavigation = { url: target, entrypoint: 'in_app_link' };
  const raise = (window: BrowserWindow): void => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    if (!pendingDeepLinks.some((pending) => pending.url === target)) pendingDeepLinks.push(navigation);
    // Gone: a new window opens on the queued link and raises itself. Present but
    // still loading — a reload, a slow cold start — is the case that would
    // otherwise queue the link and raise nothing at all.
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) void createMainWindow();
    } else {
      raise(mainWindow);
    }
    return;
  }
  mainWindow.webContents.send('auth:deep-link', navigation);
  raise(mainWindow);
}

function acceptedDeepLink(rawUrl: string): string | null {
  try {
    const deepLink = new URL(rawUrl);
    const isAuthentication = isDeepLinkProtocol(deepLink.protocol)
      && deepLink.hostname === 'auth'
      && deepLink.pathname === '/complete';
    const isWorkstream = isDeepLinkProtocol(deepLink.protocol)
      && deepLink.hostname === 'workstreams'
      && /^\/[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(deepLink.pathname);
    const isNewWorkstream = isDeepLinkProtocol(deepLink.protocol)
      && deepLink.hostname === 'workstreams'
      && deepLink.pathname === '/new'
      && deepLink.search === '';
    const isInvitation = isDeepLinkProtocol(deepLink.protocol)
      && deepLink.hostname === 'invitations'
      && deepLink.pathname === '/accept'
      && deepLink.searchParams.get('token') !== null
      && (deepLink.searchParams.get('region') === 'global' || deepLink.searchParams.get('region') === 'eu');
    const isSettings = isDeepLinkProtocol(deepLink.protocol)
      && deepLink.hostname === 'settings'
      && (deepLink.pathname === '/workspace' || deepLink.pathname === '/connections')
      && deepLink.search === '';
    const isAutomation = isDeepLinkProtocol(deepLink.protocol)
      && deepLink.hostname === 'automations'
      && deepLink.pathname === '/new'
      && deepLink.search === '';
    const isSlackLink = isDeepLinkProtocol(deepLink.protocol)
      && deepLink.hostname === 'slack'
      && deepLink.pathname === '/link'
      && /^[A-Za-z0-9_-]{20,500}$/u.test(deepLink.searchParams.get('token') ?? '')
      && [...deepLink.searchParams.keys()].every((key) => key === 'token')
      && deepLink.searchParams.getAll('token').length === 1;
    if (
      !isAuthentication && !isWorkstream && !isNewWorkstream && !isInvitation
      && !isSettings && !isAutomation && !isSlackLink
    ) return null;
    return deepLink.toString();
  } catch {
    // Ignore malformed protocol payloads from the operating system.
    return null;
  }
}

function emitDeepLink(rawUrl: string, entrypoint: DesktopDeepLinkEntrypoint = 'deep_link'): boolean {
  const deepLink = acceptedDeepLink(rawUrl);
  if (!deepLink) return false;
  sendDeepLink(deepLink, entrypoint);
  return true;
}

function observeAcceptedDeepLinkOpen(): void {
  if (!applicationLaunchObserved) {
    prelaunchDeepLinkObserved = true;
    return;
  }
  applicationOpenObserver.opened('deep_link');
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const sender = event.sender;
  const belongsToRallyWindow = sender === mainWindow?.webContents
    || sender === settingsWindow?.webContents
    || sender === deepLinkErrorWindow?.webContents
    || isMeetingWindowContents(sender);
  if (!belongsToRallyWindow || !event.senderFrame || !rendererNavigationAllowed(event.senderFrame.url)) {
    throw new Error('Blocked IPC request from untrusted content');
  }
}

function assertMeetingIpcSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (!isMeetingWindowContents(event.sender)) {
    throw new Error('Only a meeting-notes window can request recording permissions');
  }
}

/**
 * The failure window reads and dismisses its own message and nothing else.
 *
 * Narrower than the trusted-sender check on purpose: `dismissDeepLinkError`
 * closes a window, and a renderer that is not that window closing it would
 * discard a message the person has not read.
 */
function assertDeepLinkErrorIpcSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (!deepLinkErrorWindow || event.sender !== deepLinkErrorWindow.webContents) {
    throw new Error('Only the deep-link failure window can read or dismiss its message');
  }
}

function assertMainWindowIpcSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Only the main Rally window can open realtime sockets');
  }
}

function meetingAudioPermissionDependencies() {
  return {
    askForMicrophoneAccess: () => systemPreferences.askForMediaAccess('microphone'),
    getMicrophoneAccessStatus: () => systemPreferences.getMediaAccessStatus('microphone'),
  };
}

function registerIpc(): void {
  registerRealtimeSocketIpc({
    apiBaseUrls: Object.values(runtimeConfig().api),
    assertSender: assertMainWindowIpcSender,
    broker: realtimeSocketBroker,
    ipc: ipcMain,
  });
  ipcMain.handle('runtime:get-config', (event) => {
    assertTrustedIpcSender(event);
    return runtimeConfig();
  });
  ipcMain.handle('application:foreground-get', (event) => {
    assertTrustedIpcSender(event);
    return applicationForegrounded ?? BrowserWindow.getFocusedWindow() !== null;
  });
  ipcMain.handle('application-settings:get', async (event) => {
    assertTrustedIpcSender(event);
    return desktopApplicationSettings(await lockdownModeController.settings());
  });
  ipcMain.handle('feature-flags:observe', (event, rawFlags: unknown) => {
    assertTrustedIpcSender(event);
    const flags = ClientFeatureFlagsSchema.parse(rawFlags);
    observeClientFeatureFlags(flags);
  });
  ipcMain.handle('application-settings:set-lockdown-mode', async (event, rawEnabled: unknown) => {
    assertTrustedIpcSender(event);
    const previousEnabled = lockdownModeController.state().lockdownMode;
    const lockdown = await lockdownModeController.set(rawEnabled);
    void telemetryReporter?.applicationSettingChangeCompleted(
      'lockdown_mode', previousEnabled, rawEnabled as boolean, lockdown.lockdownMode,
    );
    return desktopApplicationSettings(lockdown);
  });
  ipcMain.handle('application-settings:set-debug-enabled', async (event, rawEnabled: unknown) => {
    assertTrustedIpcSender(event);
    await debugSettingsController.set(rawEnabled);
    // Deliberately `state()` rather than `settings()`: the latter can run the
    // automatic keystore fallback, which clears credentials and forces a new
    // sign-in. Writing a debugging preference must never carry that side
    // effect. `state()` still probes keystore availability, so an unavailable
    // keystore is reported as the recoverable state the Settings pane already
    // models, and the fallback runs on the next read or Lockdown interaction.
    return desktopApplicationSettings();
  });
  ipcMain.handle('application-settings:set-menu-bar-enabled', async (event, rawEnabled: unknown) => {
    assertTrustedIpcSender(event);
    const previousEnabled = menuBarController.enabled();
    await menuBarController.set(rawEnabled);
    const appliedEnabled = menuBarController.enabled();
    void telemetryReporter?.applicationSettingChangeCompleted(
      'menu_bar', previousEnabled, rawEnabled as boolean, appliedEnabled,
    );
    // Nothing was fetched while the item was off, so an item just switched on
    // would open empty until the pointer next crossed it.
    if (menuBarItemIsLive() && inMemoryAuth) void menuBarContentStore.refresh();
    // `state()` for the same reason as the Developer preference above: reading
    // Lockdown mode's full settings can run the keystore fallback, and adding
    // or removing a status item must never cost anyone their session.
    return desktopApplicationSettings();
  });
  ipcMain.handle('application-settings:set-launch-at-login', async (event, rawEnabled: unknown) => {
    assertTrustedIpcSender(event);
    const previousEnabled = launchAtLoginController.enabled();
    const appliedEnabled = await launchAtLoginController.set(rawEnabled);
    void telemetryReporter?.applicationSettingChangeCompleted(
      'launch_at_login', previousEnabled, rawEnabled as boolean, appliedEnabled,
    );
    // `state()` for the same reason as the two preferences above: registering a
    // login item must never run Lockdown mode's keystore fallback, which clears
    // credentials and forces a new sign-in.
    return desktopApplicationSettings();
  });
  ipcMain.handle('application-settings:set-product-analytics', async (event, rawEnabled: unknown) => {
    assertTrustedIpcSender(event);
    await productAnalyticsSettingsController.set(rawEnabled);
    return desktopApplicationSettings();
  });
  ipcMain.handle('telemetry:screen', async (event, rawScreen: unknown) => {
    assertTrustedIpcSender(event);
    const screen = parseTelemetryScreen(rawScreen);
    await telemetryBreadcrumbs?.add({ kind: 'screen_changed', screen }).catch(() => undefined);
    await telemetryReporter?.screenViewed(screen, telemetryWindowContext(event.sender));
  });
  ipcMain.handle('telemetry:product-intent', async (event, rawIntent: unknown) => {
    assertTrustedIpcSender(event);
    await reportTelemetryProductIntent(rawIntent, telemetryWindowContext(event.sender));
  });
  ipcMain.handle('telemetry:inspector', (event) => {
    assertTrustedIpcSender(event);
    return developerSettingsFlagController.enabled() ? telemetryReporter?.inspector() ?? [] : [];
  });
  ipcMain.handle('telemetry:javascript-error', async (event, rawCandidate: unknown) => {
    assertTrustedIpcSender(event);
    await reportJavascriptErrorCandidate(rawCandidate, telemetryWindowContext(event.sender));
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
  // The renderer owns the theme; this only records which one, so the next
  // window is constructed with a matching background instead of flashing the
  // previous theme's canvas before the first paint. An unrecognised value is
  // dropped rather than thrown on: nothing the caller does depends on it.
  ipcMain.handle('theme:set-window', async (event, choice: unknown) => {
    assertTrustedIpcSender(event);
    const parsed = parseThemeChoice(choice);
    if (!parsed || sameThemeChoice(parsed, windowThemeChoice)) return;
    windowThemeChoice = parsed;
    // A theme is a preference of the device, not of the window it was chosen in.
    // Every window reads the same stored choice, but each holds its own document,
    // so without this the Settings window repaints and the work stream behind it
    // does not. The sender has already applied it.
    //
    // Relaying only on a *change* is what stops this echoing: a window told to
    // follow re-applies and reports back, and that report matches
    // `windowThemeChoice` and stops here.
    //
    // The comparison is over both axes. Deduplicating on the resolved
    // appearance instead meant that going from `system` to a pinned Dark while
    // the Mac was already dark resolved to the same appearance, returned here,
    // and left every other window still believing it was following the Mac —
    // no visible difference in that moment, and the wrong one at sunrise.
    for (const window of rallyWindows()) {
      if (window.webContents !== event.sender) window.webContents.send('theme:changed', parsed);
    }
    await updateStoredApplicationSettings(userDataDirectory(), { themeChoice: parsed });
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
            logWarn('rally', 'could not clear an invalid desktop credential', cleanupError);
          }
        }
        logWarn('rally', 'could not rebuild the desktop profile cache', error);
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
  ipcMain.handle('auth:has-stored-credential', async (event) => {
    assertTrustedIpcSender(event);
    // Deliberately not `session:get`: that rebuilds a missing profile cache by
    // refreshing, so a network blip would answer "no credential" and strand
    // renderers on a false expiry. `loadStoredAuth` only touches disk.
    return Boolean(await loadStoredAuth());
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
  ipcMain.handle('message-export:save', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return messageExporter.save(parseMessageExportRequest(request));
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
  ipcMain.handle('deep-link-error:show', async (event, rawMessage: unknown) => {
    assertTrustedIpcSender(event);
    // The copy is the renderer's, but the window is main's, so the string is
    // checked here rather than trusted: it is about to be the entire contents
    // of a window that sits above everything else.
    if (typeof rawMessage !== 'string') throw new Error('Invalid deep-link failure message');
    const message = rawMessage.trim();
    if (!message || message.length > DEEP_LINK_ERROR_MESSAGE_LIMIT) {
      throw new Error('Invalid deep-link failure message');
    }
    await createDeepLinkErrorWindow(message);
  });
  ipcMain.handle('deep-link-error:get', (event) => {
    assertDeepLinkErrorIpcSender(event);
    return deepLinkErrorMessage;
  });
  ipcMain.handle('deep-link-error:dismiss', (event) => {
    assertDeepLinkErrorIpcSender(event);
    deepLinkErrorWindow?.close();
  });
  ipcMain.handle('system:open-meeting-notes', async (event, rawNoteId: unknown) => {
    assertTrustedIpcSender(event);
    if (rawNoteId !== undefined && (typeof rawNoteId !== 'string' || !isUuid(rawNoteId))) {
      throw new Error('Invalid note ID');
    }
    await createMeetingWindow(rawNoteId as string | undefined, rawNoteId === undefined ? 'sidebar' : 'unknown');
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
  ipcMain.handle('system:close-meeting-notes', (event, rawNoteId: unknown) => {
    assertTrustedIpcSender(event);
    if (rawNoteId !== undefined && (typeof rawNoteId !== 'string' || !isUuid(rawNoteId))) {
      throw new Error('Invalid note ID');
    }
    const meetingWindow = [...meetingWindows].find((window) => window.webContents === event.sender);
    if (!meetingWindow) throw new Error('Only a meeting-notes window can close itself');
    // Raise the note before the window goes, so the person is handed to it
    // rather than left looking at whatever the meeting window was covering.
    if (typeof rawNoteId === 'string') revealNoteInMainWindow(rawNoteId);
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

/**
 * Fonts a theme named by URL, kept under `userData` so they survive a relaunch.
 * Constructed eagerly and lazily populated: nothing is fetched until a stylesheet
 * asks for a family, which for a theme that bundles its fonts is never.
 */
const themeFontCache = new ThemeFontCache({
  directory: join(app.getPath('userData'), 'theme-fonts'),
  fetch: (url) => net.fetch(url),
});

function installMessageExportProtocol(): void {
  protocol.handle(MESSAGE_EXPORT_SCHEME, (request) => {
    const html = messageExporter.document(request.url);
    if (html === null) return new Response('Not found', { status: 404 });
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': MESSAGE_EXPORT_CONTENT_SECURITY_POLICY,
      },
    });
  });
}

/**
 * A window that exists only to be rendered from. It is never shown, carries no
 * preload and therefore none of the desktop bridge, and is thrown away as soon
 * as the bytes are out. `backgroundThrottling` is off because a window nobody
 * can see is otherwise free to stop painting, and a capture then waits for a
 * frame that never arrives.
 */
function createMessageExportWindow(size: { width: number; height: number }): MessageExportWindow {
  const window = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  return {
    load: async (url) => {
      // Deliberately not `await loadURL(...)`: its promise also rejects when a
      // hidden window stops loading before Chromium reports the load finished,
      // which is a race rather than a failure. The events are the truth.
      const finished = new Promise<void>((resolve, reject) => {
        contents.once('did-finish-load', () => resolve());
        contents.once('did-fail-load', (_event, code, description) => {
          reject(new Error(`The export document failed to load: ${description} (${code})`));
        });
      });
      void contents.loadURL(url).catch(() => undefined);
      await finished;
    },
    evaluate: (script) => contents.executeJavaScript(script, true),
    resize: (width, height, zoom) => {
      contents.setZoomFactor(zoom);
      window.setContentSize(width, height);
    },
    captureJpeg: async (quality) => (await contents.capturePage()).toJPEG(quality),
    printPdf: async ({ footerHtml, margins }) => new Uint8Array(await contents.printToPDF({
      displayHeaderFooter: true,
      footerTemplate: footerHtml,
      // Required whenever header and footer are on at all; empty suppresses it.
      headerTemplate: '<div></div>',
      margins: { ...margins },
      pageSize: 'Letter',
      printBackground: true,
    })),
    destroy: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

const messageExporter = new MessageExporter({
  createWindow: createMessageExportWindow,
  showSaveDialog: async ({ defaultFileName, extension, filterLabel }) => {
    const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath('downloads'), defaultFileName),
      filters: [{ name: filterLabel, extensions: [extension] }],
      title: 'Save from Rally',
    };
    const result = parent && !parent.isDestroyed()
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  writeFile: (path, data) => writeFile(path, data),
  logWarning: (message, error) => logWarn('rally', message, error),
  randomToken: () => crypto.randomUUID(),
  now: () => Date.now(),
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});

function applicationWindowIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : resolve(currentDirectory, '../../resources/icon.png');
}

function menuBarIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'menu-bar', 'rallyTemplate.png')
    : resolve(currentDirectory, '../../resources/menu-bar/rallyTemplate.png');
}

function createMenuBarTray(): MenuBarTray {
  const iconPath = menuBarIconPath();
  // `nativeImage` finds the `@2x` sibling by name; only the 1x path is given.
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`The menu bar icon could not be loaded: ${iconPath}`);
  // AppKit paints a template image to match the menu bar it is drawn into,
  // which is what keeps the mark legible against the translucent menu bar in
  // macOS 26 and 27 and against a desktop picture showing through it. The
  // filename's `Template` suffix already sets this; setting it explicitly means
  // a rename cannot silently turn the item into a black blob.
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip(app.name);
  tray.setIgnoreDoubleClickEvents(true);
  // The drop-down opens from cache, so freshness is bought on the way in: the
  // pointer reaching the item is roughly a menu's worth of time before it is
  // read. `refreshIfStale` is what keeps a pointer crossing the menu bar from
  // becoming a request.
  const refreshContent = (): void => {
    // Signed out there is nothing to ask for, and every attempt would log two
    // warnings. The menu already says so, and a sign-in refreshes on its own.
    if (!inMemoryAuth) return;
    void menuBarContentStore.refreshIfStale(MENU_BAR_CONTENT_MAX_AGE_MS);
  };
  // Opening the drop-down is the moment its suggestions are seen, and seeing
  // one and passing over it is what moves the ranking. `mouse-enter` is
  // deliberately not a trigger: the pointer crossing the menu bar puts nothing
  // in front of anyone.
  const recordImpressions = (): void => {
    void menuBarContentStore.recordImpressions();
  };
  const openObserver = new MenuBarOpenObserver(() => {
    recordImpressions();
    const content = menuBarContentStore.content();
    void telemetryReporter?.menuBarOpened({
      signedIn: Boolean(inMemoryAuth),
      suggestionCount: Math.min(content.suggestions.length, 4),
      recentCount: Math.min(content.recents.length, 5),
      pinnedCount: Math.min(content.pinned.length, 5),
    });
  });
  tray.on('mouse-enter', refreshContent);
  tray.on('click', () => {
    refreshContent();
    // Both this and `menu-will-show` observe the open. Which of the two macOS
    // raises for a status item's own menu is not something this repository can
    // check — there is no menu bar in the sandbox — and reporting nothing is
    // the failure being avoided. The observer coalesces the pair for menu
    // analytics, while `recordImpressions` separately keys on the suggestion set.
    openObserver.opened();
  });
  return {
    setContextMenu: (template) => {
      const menu = Menu.buildFromTemplate(template);
      menu.on('menu-will-show', () => openObserver.opened());
      menu.on('menu-will-close', () => openObserver.closed());
      tray.setContextMenu(menu);
    },
    destroy: () => tray.destroy(),
  };
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
    process.argv.some((argument) => argument.startsWith('--rally-package-smoke=')),
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
  for (const window of rallyWindows()) window.webContents.send('application-icon:changed', state);
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
    // Development runs have no containing signed Rally bundle or Dock tile
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

async function enqueueApplicationIconChange(rawIconId: unknown): Promise<DesktopApplicationIconState> {
  const previous = applicationIconController.state();
  const state = await applicationIconController.change(rawIconId);
  void telemetryReporter?.applicationIconChanged({
    previousIcon: previous.activeIcon,
    previousAutomatic: previous.isAutomatic,
    selectedIcon: state.activeIcon,
    automatic: state.isAutomatic,
  });
  return state;
}

async function enqueueApplicationIconReset(): Promise<DesktopApplicationIconState> {
  const previous = applicationIconController.state();
  const state = await applicationIconController.reset();
  void telemetryReporter?.applicationIconChanged({
    previousIcon: previous.activeIcon,
    previousAutomatic: previous.isAutomatic,
    selectedIcon: state.activeIcon,
    automatic: state.isAutomatic,
  });
  return state;
}

async function initializeApplicationIcon(): Promise<void> {
  if (process.platform !== 'darwin') return;
  nativeTheme.on('updated', () => {
    if (applicationIconController.state().isAutomatic && developmentDockIconUsesAppearancePreview) {
      void applyApplicationIcon(automaticApplicationIcon(nativeTheme.shouldUseDarkColors)).catch((error: unknown) => {
        logWarn('rally', 'could not refresh the development application icon', error);
      });
    }
    applicationIconController.appearanceChanged();
  });
  try {
    await applicationIconController.restore();
  } catch (error) {
    logWarn('rally', 'could not restore the selected application icon', error);
  }
}

function preloadPath(): string {
  const path = join(currentDirectory, '../preload/index.cjs');
  if (!existsSync(path)) throw new Error(`Rally preload script is missing: ${path}`);
  return path;
}

function installWindowDiagnostics(
  window: BrowserWindow,
  surface: 'main' | 'settings' | 'meeting' | 'deep-link-error',
): void {
  window.webContents.on('preload-error', (_event, _scriptPath, error) => {
    logError('rally', `${surface} preload failed to initialize`, {
      errorCode: javascriptErrorCode(error, 'unknown'),
    });
    void telemetryReporter?.processHealth('preload', 'exception', 'launch_failure');
    const frames = safeJavascriptFrames(error.stack);
    if (frames.length > 0) {
      void reportJavascriptErrorCandidate({
        process: 'preload',
        errorCode: javascriptErrorCode(error, 'unknown'),
        frames,
      }).catch(() => undefined);
    }
  });
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      logError('rally', `${surface} renderer failed to load`, {
        errorCode,
        errorDescription,
        validatedUrl,
      });
    },
  );
  window.webContents.on('render-process-gone', (_event, details) => {
    logError('rally', `${surface} renderer process exited`, details);
    const reasonClass = details.reason === 'crashed'
      ? 'crashed'
      : details.reason === 'killed'
        ? 'killed'
        : details.reason === 'oom'
          ? 'oom'
          : details.reason === 'launch-failed'
            ? 'launch_failure'
            : 'unknown';
    void telemetryReporter?.processHealth('renderer', 'gone', reasonClass);
  });
  window.on('unresponsive', () => {
    logError('rally', `${surface} window became unresponsive`);
    void telemetryReporter?.processHealth('renderer', 'unresponsive', 'unknown');
  });
  window.on('responsive', () => void telemetryReporter?.processHealth('renderer', 'responsive', 'unknown'));
  if (!app.isPackaged) {
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        logError('rally', `${surface} renderer console error`, {
          message: details.message,
          lineNumber: details.lineNumber,
          sourceId: details.sourceId,
        });
      }
    });
  }
}

async function loadRenderer(
  window: BrowserWindow,
  url: string,
  surface: 'main' | 'settings' | 'meeting' | 'deep-link-error',
): Promise<void> {
  try {
    await window.loadURL(url);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED') return;
    logError('rally', `${surface} loadURL failed`, error);
    throw error;
  }
}

function rendererUrl(
  surface?: 'settings' | 'meeting' | 'deep-link-error',
  settingsSection?: DesktopSettingsSection,
  noteId?: string,
  meetingEntrypoint?: 'sidebar' | 'menu_bar' | 'unknown',
): string {
  const target = rendererDevelopmentUrl
    ? new URL(rendererDevelopmentUrl)
    : new URL(`${rendererProtocol}://${rendererHost}/index.html`);
  if (surface) target.searchParams.set('surface', surface);
  if (settingsSection) target.searchParams.set('settingsSection', settingsSection);
  if (surface === 'settings') target.hash = '/settings';
  if (surface === 'deep-link-error') target.hash = '/deep-link-error';
  if (surface === 'meeting') {
    if (noteId) target.searchParams.set('noteId', noteId);
    if (meetingEntrypoint) target.searchParams.set('meetingEntrypoint', meetingEntrypoint);
    target.hash = '/meeting';
  }
  return target.toString();
}

function requestSettingsSection(window: BrowserWindow, section: DesktopSettingsSection): void {
  const deliver = (): void => window.webContents.send('settings:section-requested', section);
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', deliver);
  else deliver();
}

/**
 * Show one refused deep link, in a window of its own.
 *
 * A deep link is the operating system handing Rally somewhere to go. When it is
 * refused there is nothing on screen that reflects the attempt, and the window
 * that is in front may not even be the one that handled it: a connector
 * completion is delivered to settings, which raises itself, while the failure
 * used to be drawn in the main window behind it. Neither an in-page banner nor
 * an in-page dialog can fix that from inside one renderer, so the message gets
 * a window — small, above the others, and in front of whichever one is focused.
 *
 * Sized rather than resizable, and deliberately not a native `showMessageBox`:
 * the message is Rally's own copy and belongs in Rally's own type and colours,
 * and a native box on Linux is drawn by whatever toolkit is installed.
 */
async function createDeepLinkErrorWindow(message: string): Promise<void> {
  deepLinkErrorMessage = message;
  if (deepLinkErrorWindow && !deepLinkErrorWindow.isDestroyed()) {
    deepLinkErrorWindow.webContents.send('deep-link-error:changed', message);
    if (deepLinkErrorWindow.isMinimized()) deepLinkErrorWindow.restore();
    deepLinkErrorWindow.show();
    deepLinkErrorWindow.focus();
    return;
  }

  const failureWindow = new BrowserWindow({
    width: 420,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: windowBackgroundColor(),
    title: 'Rally',
    ...(process.platform === 'darwin' ? {} : { icon: applicationWindowIconPath() }),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  deepLinkErrorWindow = failureWindow;
  installWindowDiagnostics(failureWindow, 'deep-link-error');
  failureWindow.setMenuBarVisibility(false);
  failureWindow.once('ready-to-show', () => failureWindow.show());
  failureWindow.on('closed', () => {
    // Only if this is still *the* window. A window disposed below has already
    // been replaced in the singleton by the time its `closed` arrives, and
    // clearing then would take the live window's message with it.
    if (deepLinkErrorWindow !== failureWindow) return;
    deepLinkErrorWindow = null;
    // Closing the window *is* the acknowledgement, whether that was the button
    // or the title bar. Leaving the message behind would hand it to the next
    // failure's window as though it had just happened.
    deepLinkErrorMessage = null;
  });
  try {
    await loadRenderer(failureWindow, rendererUrl('deep-link-error'), 'deep-link-error');
  } catch (error) {
    // A window that never loaded must not stay in the singleton. Left there it
    // is worse than no window at all: the next failure takes the re-show branch
    // above, raises a blank window with no Continue button in it, and *resolves*
    // — so the reporter reads it as delivered and its own fallback never runs
    // either. One failed load would disable every later notice for the lifetime
    // of the process. Disposing here means the next report builds a fresh one.
    if (deepLinkErrorWindow === failureWindow) {
      deepLinkErrorWindow = null;
      deepLinkErrorMessage = null;
    }
    if (!failureWindow.isDestroyed()) failureWindow.destroy();
    throw error;
  }
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
    backgroundColor: windowBackgroundColor(),
    title: 'Rally Settings',
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

async function createMeetingWindow(
  requestedNoteId?: string,
  entrypoint: 'sidebar' | 'menu_bar' | 'unknown' = 'unknown',
): Promise<void> {
  const noteId = requestedNoteId ?? crypto.randomUUID();
  const meetingWindow = new BrowserWindow({
    width: 720,
    height: 860,
    minWidth: 540,
    minHeight: 640,
    show: false,
    backgroundColor: windowBackgroundColor(),
    title: 'Meeting notes — Rally',
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
    // The screen finalizes the recording and closes the window itself. It may
    // also stop and ask first, but only for a close the person performed on
    // this window: during a quit, a window that waits for an answer is a
    // window that never shuts, and the quit dies with it.
    meetingContents.send('meeting:close-requested', quitting ? 'quit' : 'user');
  });
  meetingWindow.on('closed', () => {
    void nativeSystemAudioController.stop(meetingContents).catch((error) => {
      logWarn('meeting', 'Failed to stop native computer audio after window close', error);
    });
    meetingWindows.delete(meetingWindow);
    // A meeting window is the only thing that vetoes a quit, so while one is
    // still open the quit it abandoned is still the close every other meeting
    // window is answering. Once the last has gone, Rally is staying up, and
    // the next close is the person's again.
    if (meetingWindows.size === 0) quitting = false;
  });
  try {
    await loadRenderer(
      meetingWindow,
      rendererUrl('meeting', undefined, noteId, requestedNoteId === undefined ? entrypoint : undefined),
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
          logError('rally', 'failed to open settings', error);
        });
      },
      openWebsite: () => {
        void shell.openExternal('https://rallywith.ai/').catch((error: unknown) => {
          logError('rally', 'failed to open website', error);
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
    backgroundColor: windowBackgroundColor(),
    title: 'Rally',
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
  const mainWindowWebContentsId = mainWindow.webContents.id;

  installWindowDiagnostics(mainWindow, 'main');
  mainWindow.webContents.on('render-process-gone', () => {
    realtimeSocketBroker.closeOwner(mainWindowWebContentsId);
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    // Hash-router transitions are same-document navigations. Treating them as
    // a renderer restart strands later OAuth/invitation callbacks in the main
    // process queue because React never remounts to consume that queue.
    if (isMainFrame && !isInPlace) {
      realtimeSocketBroker.closeOwner(mainWindowWebContentsId);
      rendererReady = false;
    }
  });
  mainWindow.on('closed', () => {
    realtimeSocketBroker.closeOwner(mainWindowWebContentsId);
    rendererReady = false;
    mainWindow = null;
  });

  await loadRenderer(mainWindow, rendererUrl(), 'main');
}

function installContentSecurityPolicy(): void {
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // An export document already carries a policy of its own, and a far stricter
    // one: it is markup built out of a model's words, and it is allowed no
    // script at all. Leaving its response untouched is what keeps that the
    // policy in force. Falling through would attach the renderer's policy
    // alongside it, and while two policies are enforced conjunctively — so the
    // stricter directives would still win today — that only holds because the
    // header this handler writes is cased differently from the one the protocol
    // set. A boundary that survives on header casing is not a boundary.
    if (isMessageExportUrl(details.url)) return callback({});
    // And a backdrop document carries its own for the same reason: it is served
    // under `default-src 'none'` with no `connect-src`, which is stricter than
    // anything below in every direction except the one that matters here — this
    // handler's policy ends in `frame-ancestors 'none'`, and a backdrop that
    // cannot be framed is a backdrop that never renders.
    if (isBackdropUrl(details.url)) return callback({});
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
          `default-src 'self'; script-src ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: ${fontScheme}:; connect-src ${connectSources}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src ${backdropScheme}:; frame-ancestors 'none'`,
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
    const deepLink = commandLine.find((argument) => (
      deepLinkProtocols.some((scheme) => argument.startsWith(`${scheme}://`))
    ));
    if (deepLink) {
      if (emitDeepLink(deepLink)) observeAcceptedDeepLinkOpen();
    }
    else if (mainWindow) {
      applicationOpenObserver.opened('user_launch');
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (emitDeepLink(url)) observeAcceptedDeepLinkOpen();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('ai.rallywith.desktop');
    for (const scheme of deepLinkProtocols) app.setAsDefaultProtocolClient(scheme);
    // Before every other recovery below: they all resolve paths through the
    // current session directory, so it has to be the one holding the files.
    try {
      await migrateSupersededSessionDirectory(userDataDirectory());
    } catch (error) {
      logWarn('rally', 'could not adopt the superseded session directory', error);
    }
    // The directory adoption in `userDataDirectoryForLaunch` moves whichever
    // superseded directory it found first. Any other one it left behind still
    // holds a session file worth recovering, and holds it encrypted. Each is
    // attempted independently: an absent directory is the ordinary case, and
    // must not stop the next one from being read.
    for (const superseded of supersededUserDataDirectories(appDataDirectory, app.isPackaged)) {
      try {
        await migrateLegacyUserDataStoredSessionFile(userDataDirectory(), superseded);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'ENOENT') logWarn('rally', 'could not migrate a superseded desktop session file', error);
      }
    }
    try {
      await migrateLegacyStoredSessionFile(userDataDirectory());
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') logWarn('rally', 'could not migrate the legacy desktop session file', error);
    }
    try {
      await lockdownModeController.initialize();
    } catch (error) {
      logWarn('rally', 'could not initialize desktop session encryption', error);
    }
    try {
      // Read after Lockdown mode: its startup fallback can rewrite the file.
      await debugSettingsController.initialize();
    } catch (error) {
      logWarn('rally', 'could not read the Developer preference', error);
    }
    try {
      // Before any window is constructed, so the first one of the launch opens
      // on the theme's own canvas rather than flashing the previous default.
      windowThemeChoice = (await readStoredApplicationSettings(userDataDirectory())).themeChoice;
    } catch (error) {
      logWarn('rally', 'could not read the stored window theme', error);
    }
    // Complete the one-time full-session to split-state migration before any
    // renderer window can issue concurrent session requests.
    const launchAuth = await loadStoredAuth();
    try {
      // The durable device choice admits early events to the local spool. A
      // cold regional preference read is reconciliation, not a launch
      // dependency: waiting here both spent the opening budget and suppressed
      // every nonessential event produced before the request settled. Delivery
      // remains closed until the canonical read below succeeds.
      await productAnalyticsSettingsController.initialize(launchAuth !== null);
    } catch (error) {
      logWarn('rally', 'could not synchronize the Product analytics preference', error);
    }
    try {
      await initializeTelemetry(launchAuth);
    } catch (error) {
      // Telemetry is observational. A disk, Crashpad, or route-gate failure
      // cannot prevent the product from opening.
      logWarn('rally', 'could not initialize telemetry', error);
    }
    if (launchAuth) {
      // Never awaited by launch or by the renderer's first telemetry intents.
      // A canonical disable purges the held nonessential rows; a failed read
      // leaves them durable and keeps delivery closed for a future retry.
      void productAnalyticsSettingsController.refresh()
        .then(() => telemetryReporter?.applicationSettingsState(applicationSettingsTelemetryState()))
        .then(() => { flushTelemetryAndRetryLink(); })
        .catch((error: unknown) => {
          logWarn('rally', 'could not synchronize the Product analytics preference', error);
        });
    }
    // Launching with a credential already on disk broadcasts no session change,
    // so the first poll is asked for here. Developer stays closed until it
    // answers, which is why this does not block the first window.
    if (launchAuth) {
      developerSettingsFlagController.observeSession(
        flagSessionIdentity(launchAuth.binding.userId, apiBaseForAuth(launchAuth)),
      );
    }
    await installRendererProtocol();
    installMessageExportProtocol();
    protocol.handle(backdropScheme, (request) => backdropResponse(request.url));
    protocol.handle(fontScheme, (request) => themeFontCache.respond(request.url));
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
      onOutcome: (outcome) => {
        void telemetryBreadcrumbs?.add({
          kind: 'operation', operation: 'update', state: outcome.result === 'failed' ? 'failed' : 'succeeded',
        });
        void telemetryReporter?.updateOutcome(outcome.phase, outcome.result, outcome.durationMs);
      },
    });
    installApplicationMenu();
    try {
      await launchAtLoginController.initialize();
    } catch (error) {
      logWarn('rally', 'could not read whether Rally opens at login', error);
    }
    // Read before the first window exists, because it decides whether there is
    // one. macOS sets this on a launch that came from the login item, and
    // leaves it unset when a person opened Rally from the Dock, Finder,
    // Spotlight, or a deep link — so a login or restart starts Rally in the
    // menu bar with nothing on screen, and a click on the icon still opens it.
    const openedAtLogin = launchedAtLogin({
      platform: process.platform,
      loginItemState: app.getLoginItemSettings(),
      argv: process.argv,
    });
    const initialDeepLink = process.argv.find((argument) => acceptedDeepLink(argument) !== null);
    const launchEntrypoint = initialApplicationOpenEntrypoint({
      openedAtLogin,
      hasDeepLink: initialDeepLink !== undefined || prelaunchDeepLinkObserved,
    });
    applicationOpenObserver.launched(launchEntrypoint);
    applicationLaunchObserved = true;
    try {
      await menuBarController.initialize();
    } catch (error) {
      logWarn('rally', 'could not add Rally to the menu bar', error);
    }
    if (launchAuth && menuBarItemIsLive()) void menuBarContentStore.refresh();
    // Hidden only into somewhere. The menu bar item is what a login launch
    // leaves a person, and it is off whenever they turned it off and absent
    // whenever creating it failed — either way, opening no window would start
    // Rally with nothing on screen and nothing in the menu bar, reachable only
    // by hunting for it in the Dock.
    const startsHidden = openedAtLogin && menuBarController.present();
    if (startsHidden) observeApplicationForeground(false);
    else await createMainWindow();
    await telemetryReporter?.applicationLifecycle('ready');
    await telemetryBreadcrumbs?.add({ kind: 'lifecycle', phase: 'ready' }).catch(() => undefined);
    if (telemetryLaunchId) {
      await markTelemetryLaunchReady(userDataDirectory(), telemetryLaunchId, new Date()).catch((error: unknown) => {
        logWarn('rally', 'could not mark the telemetry launch ready', error);
      });
    }
    flushTelemetryAndRetryLink();
    void initializeApplicationIcon().then(async () => {
      await telemetryReporter?.applicationSettingsState(applicationSettingsTelemetryState());
      flushTelemetryAndRetryLink();
    });

    if (initialDeepLink) emitDeepLink(initialDeepLink);

    app.on('activate', () => {
      applicationOpenObserver.activated();
      if (!mainWindow || mainWindow.isDestroyed()) {
        void createMainWindow().catch((error: unknown) => {
          logError('rally', 'failed to recreate the main window', error);
        });
      }
    });
  }).catch((error: unknown) => {
    logError('rally', 'failed to start', error);
    app.quit();
  });
}

process.on('uncaughtExceptionMonitor', (error, origin) => {
  const frames = safeJavascriptFrames(error.stack);
  if (frames.length === 0) {
    void telemetryReporter?.processHealth(
      'main',
      origin === 'unhandledRejection' ? 'rejection' : 'exception',
      'unknown',
    );
    return;
  }
  void reportJavascriptErrorCandidate({
    process: 'main',
    errorCode: javascriptErrorCode(error, origin === 'unhandledRejection' ? 'unhandled_rejection' : 'unknown'),
    frames,
  }).catch(() => undefined);
});

app.on('browser-window-focus', () => {
  observeApplicationForeground(true);
});

app.on('browser-window-blur', () => {
  // Electron emits blur before focus while moving between Rally windows. Wait
  // one turn and observe the application as backgrounded only if no Rally
  // window acquired focus.
  setImmediate(() => {
    observeApplicationForeground(BrowserWindow.getFocusedWindow() !== null);
  });
});

app.on('window-all-closed', () => {
  // The menu bar item is not a window, and on macOS it is often the only thing
  // left — a login launch opens no window at all. Quitting here would take it
  // away the first time someone closed the last window.
  if (process.platform !== 'darwin') app.quit();
});

// A quit asks every window to close, and this is what tells a meeting window
// that the close it is answering is a quit rather than the person closing that
// window — the difference between finalizing and asking first.
//
// The flag says "a quit was requested and has not finished", not "a quit was
// requested this tick", because the cascade is not reliably synchronous: on
// macOS a window mid-fullscreen-transition defers its close until the
// transition ends, and a close arriving after a timed reset would be read as
// the person's and answered with a dialog — vetoing the quit silently, which is
// the one outcome this flag exists to rule out. It is cleared where the quit is
// known to be over instead, as the last meeting window goes.
app.on('before-quit', (event) => {
  quitting = true;
  if (telemetryQuitBarrier.hold(() => app.quit())) event.preventDefault();
});

// The bounded barrier above owns asynchronous shutdown telemetry. `will-quit`
// performs only synchronous final cleanup after Electron has accepted the
// resumed quit; promises started here would not be awaited by the process.
app.on('will-quit', () => {
  applicationOpenObserver.destroy();
  clearTelemetryLaunch(userDataDirectory());
  if (telemetryFlushTimer) clearInterval(telemetryFlushTimer);
  telemetryFlushTimer = null;
  menuBarController.destroy();
});
