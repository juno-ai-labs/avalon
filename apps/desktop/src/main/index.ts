import { annotationDraftKeyForScope } from '../common/draft-keys';
import { createElectronFetch } from '@rally/electron-network';
import { artifactWindowActionRequest, artifactWindowSessionMatches } from './artifact-window-actions';
import { AnnotationCommentPinsSchema, AnnotationSchema, AnnotationSelectionSchema } from "@rally/contracts";
import { startCanvaConnection } from './canva-loopback';
import { clampWindowBounds, readMainWindowState, writeMainWindowState } from './main-window-state';
import { macosMajorVersion } from './macos-version';
import { EmbeddedBrowser, isEmbeddedBrowserWebContents } from './embedded-browser';
import { EmbeddedBrowserBoundsSchema, EmbeddedBrowserCommandSchema, type EmbeddedBrowserCommand } from '../common/embedded-browser';
import { describeZodIssues, zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { watchWorkspaceSocket, type ReachWatchDiagnostic } from '@rally/contracts/workspace-reach-watch';
import { ArtifactPinListSchema } from '@rally/contracts';
import { canvasCanonicalUrl, canvasDeepLink, sidekickDeepLink } from '@rally/contracts/links';
import { z, type ZodType } from 'zod';
import {
  ActivateWorkspaceRequestSchema,
  ClientFeatureFlagsSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
  ProductAnalyticsPreferenceSchema,
  RegionSchema,
  SessionSchema,
  SocketTicketSchema,
  StartSupportSessionRequestSchema,
  SupportPeopleSchema,
  SupportWorkspacesSchema,
  type SupportPerson,
  type SupportWorkspace,
  WorkspaceOnboardingStateSchema,
  WorkspaceAttentionSchema,
  WorkspaceDepartureSchema,
  WorkspaceDepartureRequestSchema,
  type Session as WireSession,
  type WorkspaceAttention,
  type WorkspaceDeparture,
  AccountOnboardingSchema,
  OrganizationNameSuggestionSchema,
  UpdateAccountOnboardingSchema,
} from '@rally/contracts';
import { DESKTOP_DEEP_LINK_PROTOCOLS } from '@rally/contracts/desktop-deep-link';
import { CLIENT_CONTRACT_VERSION, RALLY_HEADERS } from '@rally/contracts/http-headers';
import { APNS_TOPICS } from '@rally/contracts/push-notifications';
import type { Region } from "@rally/contracts/regions";
import { regions } from "@rally/contracts/regions";
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  ShareMenu,
  net,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  screen as electronScreen,
  session as electronSession,
  shell,
  Tray,
  WebContentsView,
} from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  applicationIconArtworkFileName,
  automaticApplicationIcon,
  type ApplicationIconId,
  type DesktopApplicationIconState,
} from '../common/application-icons';
import type {
  RallyRegion,
  DesktopApplicationSettings,
  DesktopArtifactPreviewBounds,
  DesktopArtifactPreviewRequest,
  DesktopArtifactWindowRequest,
  DesktopDeepLinkEntrypoint,
  DesktopDeepLinkNavigation,
  DesktopLockdownSettings,
  DesktopPowerState,
  DesktopSession,
  DesktopTelemetryProductIntent,
  DesktopUpdateStatus,
  DesktopTelemetryScreen,
  DesktopPendingWorkspaceInvitation,
  DesktopWorkspaceOnboardingState,
  DesktopWorkspaceSummary,
  RuntimeConfig,
  DesktopDeepLinkErrorNotice,
} from '../common/desktop';
import { readArtifactWindows, writeArtifactWindows, type ArtifactWindowState } from './artifact-window-state';
import { logError, logWarn } from '../common/logger';
import { AccountSessionFailure } from './account-session-failure';
import {
  defaultDesktopReleaseChannel,
  parseDesktopReleaseChannel,
  type DesktopReleaseChannel,
} from '../common/release-channels';
import type { DesktopSettingsSection } from '../common/settings';
import { parseDesktopSettingsSection } from '../common/settings';
import { WORKSPACE_SYNC_RELAY_IPC_CHANNELS } from '../common/workspace-sync-relay';
import { parseRouteId } from '../common/route-id';
import { fontScheme } from '../common/theme-assets';
import { repaintWindowBackgrounds } from './window-background';
import {
  defaultThemeChoice,
  parseThemeChoice,
  resolveTheme,
  sameThemeChoice,
  themeWindowBackground,
  type ThemeChoice,
} from '../common/themes';
import { accountReconnectRequiredFailure } from '../common/workspace-activation-error';
import {
  definitivelyInvalidatesStoredCredential,
  RallyApiResponseError,
  readJsonBody,
  refreshFailureIsTerminal,
  responseError,
  UnusableCredentialError,
} from './api-response-error';
import {
  applicationIconPath,
  applicationIconPreferenceDirectoryForLaunch,
  clearStoredApplicationIcon,
  readStoredApplicationIcon,
  writeStoredApplicationIcon,
} from './application-icon';
import { ApplicationIconController } from './application-icon-controller';
import { ApplicationLifecycleTelemetry } from './application-lifecycle-telemetry';
import { applicationMenuTemplate } from './application-menu';
import { installEditableTextMenu } from './editable-text-menu';
import { shareText, showDefinitionForSelection } from './text-services';
import { ApplicationOpenObserver, initialApplicationOpenEntrypoint } from './application-open-observer';
import { RendererCrashRecovery } from './renderer-crash-recovery';
import { availableRendererWindows } from './renderer-window-availability';
import {
  readStoredApplicationSettings,
  updateStoredApplicationSettings,
} from './application-settings';
import {
  acknowledgeApplicationVersionTransition,
  applicationVersionTransition,
} from './application-version-telemetry';
import {
  ArtifactPreviewController,
  ArtifactUserActivation,
  applyGlobalNavigationPolicy,
  artifactWebPreferences,
  confineToArtifactOrigin,
  isArtifactUrl,
  loadArtifactDocument,
  loadArtifactInitialUrl,
  type ArtifactLinkHandoff,
  type ArtifactViewHandle,
  artifactPageAnnotations,
} from './artifact-viewers';
import { CredentialRefreshRegistry } from './credential-refresh';
import { DebugSettingsController } from './debug-settings';
import {
  acceptedDeepLink,
  shouldDeliverConnectorResultToSettings,
  httpsLinkDeepLink,
  isRetiredDeepLink,
  RETIRED_LINK_MESSAGE,
} from "./deep-links";
import { DesktopAuthAttemptStore } from './desktop-auth-attempts';
import { DeveloperSettingsFlagController } from './developer-settings-flag';
import {
  javascriptErrorProcessHealthState,
  normalizeJavascriptErrorCandidate,
} from './javascript-error-candidate';
import {
  installMainProcessNetworkRecovery,
  type MainProcessFatalOrigin,
} from './main-process-network-recovery';
import { LaunchAtLoginController, launchedAtLogin } from './launch-at-login';
import { LockdownModeController } from './lockdown-mode';
import {
  allowsTrustedAudioCapture,
} from './media-permission';
import { MenuBarController, type MenuBarTray } from './menu-bar';
import { menuBarContent } from './menu-bar-content';
import {
  MENU_BAR_SECTION_LIMIT,
  supportsSectionHeaders,
} from './menu-bar-menu';
import { SidebarListsWatch } from './sidebar-lists-watch';
import { MenuBarOpenObserver } from './menu-bar-open-observer';
import {
  isMessageExportUrl,
  MESSAGE_EXPORT_CONTENT_SECURITY_POLICY,
  MESSAGE_EXPORT_SCHEME,
  MessageExporter,
  parseMessageExportRequest,
  type MessageExportWindow,
} from './message-export';
import { invalidateActiveNativeCrashGeneration, prepareNativeCrashGeneration } from './native-crash-generation';
import { NativeCrashUploader } from './native-crash-uploader';
import {
  NativePerformanceLog,
  nativeUnifiedLogAddonPath,
  type NativeUnifiedLogBinding,
} from './native-performance-log';
import {
  nativeSystemAudioAddonPath,
  NativeSystemAudioController,
  type NativeSystemAudioBinding,
} from './native-system-audio';
import { requestWithOnboardingIdentity } from './onboarding-identity-request';
import { ProductAnalyticsSettingsController } from './product-analytics-settings';
import { DesktopPushNotifications } from "./push-notifications";
import {
  RealtimeSocketBroker,
  createNodeRealtimeSocketFactory,
  reachSocketFromRealtimeClient,
} from './realtime-socket-broker';
import { registerRealtimeSocketIpc } from './realtime-socket-ipc';
import { NetworkRecovery } from './network-recovery';
import { registerNetworkRecoveryIpc } from './network-recovery-ipc';
import { NETWORK_RECOVERY_IPC } from '../common/network-recovery';
import {
  decryptSessionValue,
  encryptSessionValue,
  migrateStoredSessionEncryption,
  type SessionEncryptionMode,
} from './session-encryption';
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
import { SettingsWindowController } from './settings-window-controller';
import { WorkspaceSyncRelay } from './workspace-sync-relay';
import { registerWorkspaceSyncRelayIpc } from './workspace-sync-relay-ipc';
import {
  activeStoredCredential,
  activeStoredCredentialIsGuest,
  storedCredentialIsSupport,
  activeStoredWorkspaceCredential,
  mergeStoredSession,
  parseStoredAuthSet,
  parseStoredProfileSet,
  removeStoredWorkspace,
  sessionFromStoredState,
  sessionsShareBinding,
  storedAuthFromSession,
  storedProfileForCredential,
  storedWorkspaceCredential,
  type StoredAuth,
  type StoredAuthSet,
  type StoredProfileSet,
} from './stored-auth';
import { parseLegacyStoredSession } from './stored-session';
import { TelemetryBreadcrumbRing, type NewTelemetryBreadcrumb } from './telemetry-breadcrumbs';
import {
  readTelemetryIdentityState,
  rotateTelemetryEpochs,
  type TelemetryIdentity,
  uuidV7,
} from './telemetry-identity';
import { parseTelemetryProductIntent, UUID_V7_PATTERN } from './telemetry-intent';
import { beginTelemetryLaunch, clearTelemetryLaunch, markTelemetryLaunchReady } from './telemetry-launch-marker';
import { TelemetryQuitBarrier } from './telemetry-quit-barrier';
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
import {
  ThemeFontCache,
  themeFontSchemes,
} from './theme-assets';
import {
  initializeAutoUpdate,
  type AutoUpdateController,
} from './updater';
import {
  supersededUserDataDirectories,
  userDataDirectoryForLaunch,
} from './user-data-path';
import { revalidateWorkspaceActivation } from './workspace-activation';
import {
  endedStoredWorkspaces,
  mergeWorkspaceDirectory,
  storedWorkspaceSummaries,
} from './workspace-directory';
import { claimActiveWorkspace } from './workspace-selection';
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
const deepLinkProtocols: readonly string[] = DESKTOP_DEEP_LINK_PROTOCOLS
  .map((scheme) => scheme.replace(/:$/u, ''));
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
declare const __RALLY_BUILD_TIME__: string | undefined;
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
    case 'workspace_socket_handshake':
      {
        // Already parsed against this event's schema by `telemetry-intent.ts`.
        const { attemptId, phase, sinceTicketRequested, windowVisible } = intent;
        await telemetryReporter.workspaceSocketHandshake(
          { attemptId, phase, sinceTicketRequested, windowVisible }, windowContext,
        );
      }
      return;
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
    case 'content_copied': {
      await telemetryReporter.contentCopied(telemetryIntentProperties(intent), windowContext);
      return;
    }
    default:
      await telemetryReporter.semanticProductIntent(intent, windowContext);
      return;
  }
}

let mainWindow: BrowserWindow | null = null;
let applicationIsQuitting = false;
const accountSessionFailure = new AccountSessionFailure({
  showMessageBox: (options) => {
    const parent = mainWindow;
    return parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options);
  },
  onError: (error) => logError('rally', 'account session recovery failed', error),
});
const rendererCrashRecovery = new RendererCrashRecovery({
  showMessageBox: (options) => {
    const parent = mainWindow;
    return parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options);
  },
  isQuitting: () => applicationIsQuitting,
  relaunch: () => app.relaunch(),
  quit: () => app.quit(),
  onError: (error) => logError('rally', 'renderer crash recovery failed', error),
});
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
// Carries an id because the window's acknowledgement is matched against it: see
// `deep-link-error:dismiss`.
let deepLinkErrorNotice: DesktopDeepLinkErrorNotice | null = null;
let deepLinkErrorNoticesShown = 0;
let rendererReady = false;
let inMemoryAuthSet: StoredAuthSet | null = null;
let inMemoryProfileSet: StoredProfileSet | null = null;
let inMemorySession: WireSession | null = null;
/** The last discovery this run received, so a refetch that fails degrades to
 * a stale-but-complete directory rather than to the stored set alone. It
 * belongs to the signed-in account and is cleared with the stored set. */
let lastWorkspaceDiscovery: {
  workspaces: DesktopWorkspaceSummary[];
  invitations: DesktopPendingWorkspaceInvitation[];
} | null = null;
/** One rotation per refresh token across every path that renews a stored
 * credential; `credential-refresh.ts` says why two would be one too many. */
const credentialRefreshes = new CredentialRefreshRegistry<WireSession>();
let refreshInFlight: Promise<DesktopSession> | null = null;
let sessionMutationTail: Promise<void> = Promise.resolve();
let sessionLifecycleEpoch = 0;
let workspaceSelectionIntent = 0;
let loggingOut = false;
let updateStatus: DesktopUpdateStatus = { kind: 'idle' };
let autoUpdateController: AutoUpdateController | null = null;
let desktopReleaseChannel: DesktopReleaseChannel = defaultDesktopReleaseChannel;
let updateInstallationPending = false;
let developmentDockIconUsesAppearancePreview = false;
const realtimeSocketBroker = new RealtimeSocketBroker(createNodeRealtimeSocketFactory(
  (url) => electronSession.defaultSession.resolveProxy(url),
));
// The main window's Organization socket, relayed to the Settings window so it
// holds no socket of its own while there is one to relay. A hidden prewarmed
// window receives it too: its reads are mounted and must stay fresh.
const workspaceSyncRelay = new WorkspaceSyncRelay((event) => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.relayed, event);
});
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
let prelaunchPushObserved = false;
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
/** Relay `powerMonitor` suspend and resume to every Rally window. */
function observePowerState(state: DesktopPowerState): void {
  for (const window of rallyWindows()) window.webContents.send('power:changed', state);
}
let nativeCrashUploader: NativeCrashUploader | null = null;
let nativeCrashGenerationActive = false;
let nativeCrashGenerationInvalidated = false;
let telemetryFlushTimer: ReturnType<typeof setInterval> | null = null;
let telemetryAccountBinding: string | null = null;
let telemetryHasAuthenticated = false;
let telemetryLinkInFlight: Promise<void> | null = null;
let telemetryLinkedCapability: string | null = null;
let telemetryLaunchId: string | null = null;
let telemetryBreadcrumbs: TelemetryBreadcrumbRing | null = null;
let telemetryContinuouslyEligible = false;
const pendingDeepLinks: DesktopDeepLinkNavigation[] = [];
let mainWindowReadyToShow = false;
let mainWindowLoading: Promise<void> | null = null;
let resolveMainWindowStartup!: () => void;
const mainWindowStartup = new Promise<void>((resolve) => { resolveMainWindowStartup = resolve; });
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
/**
 * Web contents showing model-authored artifact content.
 *
 * Consulted by the global navigation hardening *at navigation time* rather than
 * at registration time, because `web-contents-created` fires synchronously
 * inside `new WebContentsView(...)` — so the global listener is always attached
 * before `confineToArtifactOrigin` gets to run, and a listener that has already
 * been added cannot be un-added by the artifact policy. Marking the contents and
 * checking the mark when the navigation actually happens is the only ordering
 * that works.
 */
const artifactWebContents = new WeakSet<WebContents>();
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
  return availableRendererWindows([mainWindow, settingsWindow, deepLinkErrorWindow]);
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
}, ...themeFontSchemes]);

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
 * before that read completes it is the Rally palette following the Mac, what Rally ships
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

const electronFetch = createElectronFetch(net);

const telemetryFetch: typeof globalThis.fetch = (input, init) => electronFetch(
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
          ...(value.workspace.accessClass ? { accessClass: value.workspace.accessClass } : {}),
          timezone: value.workspace.timezone,
        }
      : null,
    ...(value.impersonator ? {
      impersonator: {
        id: value.impersonator.id,
        email: value.impersonator.email,
        name: value.impersonator.name,
        ...(value.impersonator.avatarUrl ? { avatarUrl: value.impersonator.avatarUrl } : {}),
      },
    } : {}),
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
  closeArtifactWindowsOutsideSession(value?.workspace?.id ?? null, value?.user.id ?? null, value?.workspace?.region ?? null);
  closeEmbeddedBrowsersOutsideUser(value?.user.id ?? null);
  // The import window offers one Organization's Spaces; another Organization's
  // session would place an import in a Space it does not have.
  if (value) desktopPush.sessionChanged();
  const exposed = value ? publicSession(value) : null;
  for (const window of rallyWindows()) window.webContents.send('session:changed', exposed);
  // Whether Developer may be offered belongs to the signed-in account, so a
  // sign-in asks again immediately rather than waiting out a poll interval, and
  // a sign-out closes the section on the way past. The identity is what makes
  // that distinction: this also fires on every token refresh, which is the same
  // account and must not cost an extra poll, and an account swap must not be
  // answered by a request issued as the previous one.
  if (exposed) developerSettingsFlagController.observeSession(flagSessionIdentity(exposed.user.id, exposed.apiBaseUrl));
  else developerSettingsFlagController.stop();
  // The menu bar item outlives every window, so it has to be told about a
  // sign-out directly. Leaving the previous account's Channel titles in the
  // menu would keep them readable to whoever signs in next, so a sign-out
  // drops them here, synchronously, before the queued sync below runs.
  if (!exposed) stopMenuBarDirectory();
  syncMenuBarDirectory();
  menuBarController.refresh();

  // A sign-in is the first moment a settings window would be worth having, and
  // this is the one place every session arrival passes through. Idempotent, so
  // the token renewals that also land here cost nothing; gated inside on the
  // session, so a sign-out — which has already closed the window above — does
  // not immediately build another.
  void settingsWindowController.prewarm();

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
  if (nextBinding) telemetryHasAuthenticated = true;
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
      globalApiBaseUrl: configuredApiBase('global'),
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
  return configuredApiBase(auth.binding.region);
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
  if (!inMemoryAuthSet) {
    await clearCredentialsForLockdownRelogin();
    return;
  }
  await writeStoredAuthFile(
    userDataDirectory(),
    encryptSessionValue(JSON.stringify(inMemoryAuthSet), 'global', safeStorage),
  );
  if (inMemoryProfileSet) {
    await writeStoredProfileFile(
      userDataDirectory(),
      encryptSessionValue(
        JSON.stringify(inMemoryProfileSet),
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
  closeAndForgetArtifactWindows();
  desktopPush.signOut(inMemoryAuthSet?.workspaces);
  sessionLifecycleEpoch += 1;
  desktopAuthAttempts.clear();
  inMemoryAuthSet = null;
  inMemoryProfileSet = null;
  inMemorySession = null;
  lastWorkspaceDiscovery = null;
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
  const response = await electronFetch(`${apiBaseForAuth(auth)}/telemetry/preference`, {
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
  const apply = (version: number) => electronFetch(`${apiBaseForAuth(auth)}/telemetry/preference`, {
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

/**
 * Dials the main process's own workspace socket for the menu bar, through the
 * same Node broker route as the feed sockets. No frame ceiling: the subscribe
 * answer is the whole sidebar, and the renderer's socket has none either.
 */
const menuBarSocketFactory = createNodeRealtimeSocketFactory(
  (url) => electronSession.defaultSession.resolveProxy(url),
  undefined,
  0,
);

function logMenuBarSocketDiagnostic(diagnostic: ReachWatchDiagnostic): void {
  if (diagnostic.code === 'ticket_failed' || diagnostic.code === 'open_failed') {
    logWarn('rally', `menu bar workspace socket ${diagnostic.code}`, diagnostic.error);
  } else if (diagnostic.code === 'timeout' || diagnostic.code === 'transport_error') {
    logWarn('rally', `menu bar workspace socket ${diagnostic.phase}_${diagnostic.code}`);
  } else {
    logWarn('rally', `menu bar workspace socket ${diagnostic.code}: ${diagnostic.closeCode}`);
  }
}

/**
 * The Canvases and Sidekicks lists behind the menu bar, held over a workspace
 * socket of the main process's own so the count beside the status item is the
 * rail's count whether or not a window exists. See `docs/menu-bar.md`.
 */
const sidebarListsWatch = new SidebarListsWatch({
  socket: (handlers) => watchWorkspaceSocket({
    ticket: async (signal) => SocketTicketSchema.parse(await rallyApiRequest('/workspace/socket', undefined, signal)),
    open: (url, ticket) => reachSocketFromRealtimeClient(menuBarSocketFactory(url, socketTicketProtocols(ticket))),
    ...handlers,
    onDiagnostic: (diagnostic) => {
      logMenuBarSocketDiagnostic(diagnostic);
      // The server ended this session's access, or the session itself, and
      // the socket will not redial. Forget the rows rather than keep showing
      // titles and a count this account may no longer see; the next session
      // change finds the watch stopped and opens it again.
      if (diagnostic.code === 'stopped') stopMenuBarDirectory();
    },
  }),
  onChange: () => menuBarController.refresh(),
  logWarning: (message, error) => logWarn('rally', message, error),
});

/** Closes the menu bar's socket and forgets both lists. */
function stopMenuBarDirectory(): void {
  sidebarListsWatch.stop();
}

/** Which account and Organization the socket serves; a token renewal keeps it. */
let menuBarDirectoryIdentity: string | null = null;
/** A guest gets no menu bar socket: nothing will load, so the menu must not say it is loading. */
let menuBarDirectoryUnavailable = false;
let menuBarDirectorySync: Promise<void> = Promise.resolve();

/**
 * Opens, keeps or closes the menu bar's socket to match the stored session.
 *
 * Called on every session change (token renewals included), when the
 * preference moves, and at launch. Read from storage rather than
 * `inMemorySession`, which a login launch has not set when the status item
 * first needs content. Serialized, so two quick changes cannot open two
 * sockets. A guest gets no socket; a preference that is off, or a platform
 * with no menu bar, gets none either.
 */
function syncMenuBarDirectory(): void {
  menuBarDirectorySync = menuBarDirectorySync.then(async () => {
    const authSet = await loadStoredAuthSet();
    const active = authSet ? activeStoredCredential(authSet) : null;
    const guest = activeStoredCredentialIsGuest(authSet, await loadStoredProfileSet());
    const live = active !== null && active.binding.workspaceId !== null && menuBarItemIsLive() && !guest;
    if (menuBarDirectoryUnavailable !== guest) {
      menuBarDirectoryUnavailable = guest;
      menuBarController.refresh();
    }
    const identity = live
      ? `${active.binding.userId}:${active.binding.region}:${active.binding.workspaceId}`
      : null;
    const runningAsIdentified = (identity !== null) === sidebarListsWatch.running();
    if (identity === menuBarDirectoryIdentity && runningAsIdentified) return;
    menuBarDirectoryIdentity = identity;
    stopMenuBarDirectory();
    if (identity !== null) sidebarListsWatch.start();
  }).catch((error: unknown) => {
    logWarn('rally', 'could not open the menu bar workspace socket', error);
  });
}

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

const menuBarController = new MenuBarController({
  supported: process.platform === 'darwin',
  appName: app.name,
  createTray: createMenuBarTray,
  content: () => {
    // A guest has no socket, so nothing will load: say "nothing" rather than "loading".
    const lists = sidebarListsWatch.snapshot();
    return menuBarContent(menuBarDirectoryUnavailable
      ? { canvases: lists.canvases ?? [], sidekicks: lists.sidekicks ?? [] }
      : lists);
  },
  // The in-memory credential rather than a live session: this is read while the
  // menu is being built, and it only decides which empty state to show.
  signedIn: () => Boolean(inMemoryAuthSet),
  sectionHeaders: supportsSectionHeaders(process.getSystemVersion()),
  actions: {
    selected: (action) => { void telemetryReporter?.menuBarActionSelected(action); },
    open: (row) => {
      activateFromMenuBar();
      // A Canvas or a Sidekick link names its Organization: the one the menu
      // is showing.
      void loadStoredAuthSet().then((authSet) => {
        const active = authSet ? activeStoredCredential(authSet) : null;
        if (!active?.binding.workspaceId) return;
        const organization = { region: active.binding.region, workspaceId: active.binding.workspaceId };
        emitDeepLink(row.kind === 'canvas'
          ? canvasDeepLink({ ...organization, canvasId: row.id })
          : sidekickDeepLink({ ...organization, sidekickId: row.id }), 'menu_bar');
      });
    },
    openRally: openMainWindowFromMenuBar,
    quit: () => app.quit(),
  },
  readSettings: () => readStoredApplicationSettings(userDataDirectory()),
  writeSettings: (settings) => updateStoredApplicationSettings(userDataDirectory(), settings),
  onChange: () => broadcastApplicationSettingsChanged(desktopApplicationSettings()),
  logWarning: (message, error) => logWarn('rally', message, error),
});

const desktopPush = new DesktopPushNotifications({
  // A support session is somebody else's; their notifications are not this device's.
  credentials: async () => {
    const auth = await loadStoredAuthSet();
    const profiles = await loadStoredProfileSet();
    return (auth?.workspaces ?? []).filter((credential) => !storedCredentialIsSupport(profiles, credential));
  },
  request: async (credential, path, init = {}) => {
    const ask = (auth: StoredAuth) => electronFetch(`${apiBaseForAuth(auth)}${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${auth.accessToken}` },
    });
    let response = await ask(credential);
    if (response.status === 401 && init.method !== 'DELETE' && !init.signal?.aborted) {
      await response.body?.cancel();
      const renewed = await refreshStoredCredential(credential);
      response = await ask(storedAuthFromSession(renewed, regionForStoredSession(renewed)));
    }
    return response;
  },
  clicked: (url) => {
    if (applicationLaunchObserved) applicationOpenObserver.opened('push_notification');
    else prelaunchPushObserved = true;
    const link = url ? httpsLinkDeepLink(url) : null;
    if (link) sendDeepLink(link, 'notification');
    else if (app.isReady()) void createMainWindow();
  },
  changed: () => broadcastApplicationSettingsChanged(desktopApplicationSettings()),
  warn: () => logWarn('rally', 'Push notifications could not register on this Mac'),
});

/**
 * The active Organization's attention count, as the main window last sent it.
 * An APNs alert from another Organization can replace the dock badge while
 * Rally is in the background; focusing Rally puts this one back.
 */
let dockBadgeCount: number | null = null;

// Install the response delegate before ready so a notification cold launch is retained.
desktopPush.installNativeBridge();

function desktopApplicationSettings(
  lockdown: DesktopLockdownSettings = lockdownModeController.state(),
): DesktopApplicationSettings {
  const developerSettingsAvailable = developerSettingsFlagController.enabled();
  return {
    ...lockdown,
    ...desktopPush.state(),
    releaseChannel: desktopReleaseChannel,
    releaseChannelAvailable: process.platform === 'darwin' && process.arch === 'arm64',
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
  const ask = async (accessToken: string): Promise<Response> => electronFetch(`${apiBaseUrl}/feature-flags`, {
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
  desktopPush.featureFlagChanged(parsed.data.pushNotificationsEnabled);
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
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const stored = await loadStoredAuth();
  if (!stored) throw new Error('No Rally session is available');
  const apiBaseUrl = apiBaseForAuth(stored);
  const ask = async (accessToken: string): Promise<Response> => electronFetch(`${apiBaseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      // The socket ticket route admits only a client that names its contract.
      [RALLY_HEADERS.CLIENT_CONTRACT]: String(CLIENT_CONTRACT_VERSION),
      ...(init ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(MENU_BAR_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(MENU_BAR_REQUEST_TIMEOUT_MS),
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

async function writeSplitSessionFiles(
  value: WireSession,
  options: { activate?: boolean } = {},
): Promise<StoredAuthSet> {
  // Merge against the profile cache on disk, not against whatever this
  // process happens to have read so far. A refresh can run before anything
  // has loaded the profiles — a main-process task at launch whose access
  // token had expired overnight does exactly that — and merging into an
  // empty set here rewrote the cache with one profile, dropping the identity
  // profile and every other workspace's. The credentials beside them were
  // intact, but an identity without its profile reads as no identity at all.
  const currentProfiles = inMemoryProfileSet ?? await loadStoredProfileSet();
  const stored = mergeStoredSession(
    inMemoryAuthSet,
    currentProfiles,
    value,
    regionForStoredSession(value),
    options,
  );
  // Credentials are the durable boundary. Write them before the disposable
  // profile cache so an interrupted update can always recover by refreshing.
  await writeStoredAuthFile(
    userDataDirectory(),
    encryptStoredSessionValue(JSON.stringify(stored.auth)),
  );
  await writeStoredProfileFile(
    userDataDirectory(),
    encryptStoredSessionValue(JSON.stringify(stored.profiles)),
  );
  try {
    await removeStoredSessionFiles(userDataDirectory());
  } catch {
    // The split credential is authoritative. Logout still removes or
    // tombstones every legacy location before another launch can use it.
  }
  inMemoryProfileSet = stored.profiles;
  return stored.auth;
}

async function persistSessionUnlocked(value: WireSession): Promise<void> {
  inMemoryAuthSet = await writeSplitSessionFiles(value);
  inMemorySession = value;
  broadcastSessionChanged(value);
}

async function migrateLegacySessionToSplitStorage(): Promise<StoredAuthSet | null> {
  try {
    const encrypted = await readStoredSessionFile(userDataDirectory());
    const parsed: unknown = JSON.parse(decryptStoredSessionValue(encrypted));
    const legacySession = parseLegacyStoredSession(parsed);
    if (!legacySession) {
      logWarn('rally', 'the legacy desktop session did not match its durable schema');
      return null;
    }
    const auth = await writeSplitSessionFiles(legacySession);
    inMemoryAuthSet = auth;
    inMemorySession = legacySession;
    return auth;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      logWarn('rally', 'could not migrate the encrypted desktop session', error);
    }
    return null;
  }
}

async function loadStoredAuthSet(): Promise<StoredAuthSet | null> {
  if (inMemoryAuthSet) return inMemoryAuthSet;
  try {
    const encrypted = await readStoredAuthFile(userDataDirectory());
    const parsed: unknown = JSON.parse(decryptStoredSessionValue(encrypted));
    const auth = parseStoredAuthSet(parsed);
    if (!auth) {
      logWarn('rally', 'the stored desktop credential did not match its durable schema');
      return null;
    }
    inMemoryAuthSet = auth;
    if ((parsed as { version?: unknown } | null)?.version === 1) {
      await writeStoredAuthFile(
        userDataDirectory(),
        encryptStoredSessionValue(JSON.stringify(auth)),
      );
    }
    return auth;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return migrateLegacySessionToSplitStorage();
    logWarn('rally', 'could not restore the stored desktop credential', error);
    return null;
  }
}

async function loadStoredAuth(): Promise<StoredAuth | null> {
  const stored = await loadStoredAuthSet();
  return stored ? activeStoredCredential(stored) : null;
}

async function loadStoredProfileSet(): Promise<StoredProfileSet | null> {
  if (inMemoryProfileSet) return inMemoryProfileSet;
  try {
    const encrypted = await readStoredProfileFile(userDataDirectory());
    const parsed: unknown = JSON.parse(decryptStoredSessionValue(encrypted));
    const profiles = parseStoredProfileSet(parsed);
    if (!profiles) {
      logWarn('rally', 'discarding an incompatible desktop profile cache');
      return null;
    }
    inMemoryProfileSet = profiles;
    if ((parsed as { version?: unknown } | null)?.version === 1) {
      await writeStoredProfileFile(
        userDataDirectory(),
        encryptStoredSessionValue(JSON.stringify(profiles)),
      );
    }
    return profiles;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      logWarn('rally', 'could not restore the desktop profile cache', error);
    }
    return null;
  }
}

async function storedSessionForCredential(auth: StoredAuth): Promise<WireSession | null> {
  const profiles = await loadStoredProfileSet();
  if (!profiles) return null;
  const profile = storedProfileForCredential(profiles, auth);
  if (!profile) return null;
  return sessionFromStoredState(auth, profile, apiBaseForAuth(auth));
}

async function loadStoredSession(): Promise<WireSession | null> {
  if (inMemorySession) return inMemorySession;
  const auth = await loadStoredAuth();
  if (!auth) return null;
  if (inMemorySession) return inMemorySession;
  const stored = await storedSessionForCredential(auth);
  if (!stored) {
    logWarn('rally', 'discarding a desktop profile cache with a mismatched credential binding');
    return null;
  }
  inMemorySession = stored;
  return stored;
}

/**
 * The stored identity session, or null when no identity credential is stored.
 *
 * The credential is the durable boundary; the profile beside it is a cache
 * that an interrupted or early write can leave behind. A credential without
 * its profile is rebuilt by refreshing it — the way `session:get` already
 * rebuilds a workspace's — rather than read as a missing identity. A refresh
 * that fails throws, so a caller can tell "unreachable" from "not signed in";
 * a terminal failure has surrendered the credential by the time it throws.
 */
async function loadStoredIdentitySession(): Promise<WireSession | null> {
  const auth = await loadStoredAuthSet();
  if (!auth?.account) return null;
  const stored = await storedSessionForCredential(auth.account);
  if (stored) return stored;
  logWarn('rally', 'rebuilding the identity profile cache from its credential');
  return refreshStoredCredential(auth.account);
}

async function clearStoredSessionUnlocked(): Promise<void> {
  closeAndForgetArtifactWindows();
  inMemoryAuthSet = null;
  inMemoryProfileSet = null;
  inMemorySession = null;
  lastWorkspaceDiscovery = null;
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

/** A dead account cannot leave otherwise valid organization windows signed in. */
async function endAccountSession(rejected?: StoredAuth): Promise<void> {
  await accountSessionFailure.end(() => withSessionMutation(async () => {
    if (loggingOut || updateInstallationPending || applicationIsQuitting) return false;
    const auth = await loadStoredAuthSet();
    if (!auth) return false;
    // A delayed rejection must never sign out a newer browser sign-in.
    if (rejected) {
      if (!auth.account || !storedAuthMatches(auth.account, rejected)) return false;
    } else if (auth.account || auth.workspaces.length === 0) return false;
    sessionLifecycleEpoch += 1;
    desktopAuthAttempts.clear();
    desktopPush.signOut(auth.workspaces);
    loggingOut = true;
    try {
      await clearStoredSessionUnlocked();
      settingsWindow?.close();
    } finally {
      loggingOut = false;
    }
    // Local sign-out and its notice must not wait for an unreachable server.
    void revokeStoredCredentials(auth).then((failures) => {
      if (failures.length > 0) logWarn('rally', 'could not revoke every session after account failure',
        new AggregateError(failures, 'Rally could not revoke every stored session'));
    }).catch((error: unknown) => {
      logWarn('rally', 'could not revoke sessions after account failure', error);
    });
    return true;
  }));
}

async function removeStoredCredentialUnlocked(rejected: StoredAuth): Promise<void> {
  const auth = await loadStoredAuthSet();
  if (!auth) return;
  const profiles = await loadStoredProfileSet() ?? {
    version: 2 as const,
    account: null,
    workspaces: [],
  };
  let nextAuth: StoredAuthSet;
  let nextProfiles: StoredProfileSet;
  if (rejected.binding.workspaceId === null) {
    if (!auth.account || !storedAuthMatches(auth.account, rejected)) return;
    nextAuth = { ...auth, account: null };
    nextProfiles = { ...profiles, account: null };
  } else {
    const current = storedWorkspaceCredential(auth, rejected.binding.workspaceId, rejected.binding.region);
    if (!current || !storedAuthMatches(current, rejected)) return;
    ({ auth: nextAuth, profiles: nextProfiles } = removeStoredWorkspace(
      auth,
      profiles,
      rejected.binding.workspaceId,
      rejected.binding.region,
    ));
  }
  if (!nextAuth.account && nextAuth.workspaces.length === 0) {
    await clearStoredSessionUnlocked();
    return;
  }
  await writeStoredAuthFile(
    userDataDirectory(),
    encryptStoredSessionValue(JSON.stringify(nextAuth)),
  );
  await writeStoredProfileFile(
    userDataDirectory(),
    encryptStoredSessionValue(JSON.stringify(nextProfiles)),
  );
  if (rejected.binding.workspaceId !== null) {
    for (const [window, artifact] of poppedOutArtifacts) {
      if (artifactWindowSessionMatches(artifact, rejected.binding)
        && !window.isDestroyed()) window.destroy();
    }
    savedArtifactWindows = artifactWindowStates().filter((item) =>
      !artifactWindowSessionMatches(item, rejected.binding));
    saveArtifactWindowStates();
  }
  inMemoryAuthSet = nextAuth;
  inMemoryProfileSet = nextProfiles;
  if (rejected.binding.workspaceId === null && inMemorySession?.workspace) return;
  const nextCredential = activeStoredCredential(nextAuth);
  inMemorySession = nextCredential
    ? await storedSessionForCredential(nextCredential)
    : null;
  broadcastSessionChanged(inMemorySession);
}

async function surrenderActiveWorkspace(): Promise<DesktopSession | null> {
  return withSessionMutation(async () => {
    const auth = await loadStoredAuthSet();
    const active = auth ? activeStoredCredential(auth) : null;
    if (!active?.binding.workspaceId) {
      return inMemorySession ? publicSession(inMemorySession) : null;
    }
    await removeStoredCredentialUnlocked(active);
    return inMemorySession ? publicSession(inMemorySession) : null;
  });
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

function configuredApiBase(region: RallyRegion): string {
  const url = runtimeConfig().api[region];
  if (!url) throw new Error('The region is unavailable');
  return url;
}

function runtimeConfig(): RuntimeConfig {
  const packaged = app.isPackaged;
  return {
    ...(!telemetryHasAuthenticated && telemetryIdentity?.firstSignupFlowId
      ? { firstSignupFlowId: telemetryIdentity.firstSignupFlowId } : {}),
    appVersion: app.getVersion(),
    isPackaged: packaged,
    platform: process.platform,
    api: Object.fromEntries(Object.entries(regions).map(([region, config]) => [region, parseRallyBaseUrl(
      packaged ? undefined : process.env[`VITE_API_${config.bindingPrefix}_URL`],
      packaged ? config.apiUrl : config.localApiUrl,
    )])),
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
  route: Region;
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
  telemetryHasAuthenticated = launchAuth !== null;
  telemetryAccountBinding = launchAuth
    ? flagSessionIdentity(launchAuth.binding.userId, apiBaseForAuth(launchAuth))
    : null;
  telemetryRoute = await resolveTelemetryRoute({
    explicitRegion: launchAuth?.binding.workspaceId ? launchAuth.binding.region : null,
    anonymousEpochId: telemetryIdentity.anonymousEpochId,
    globalApiBaseUrl: configuredApiBase('global'),
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
    globalApiBaseUrl: configuredApiBase('global'),
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
    globalApiBaseUrl: configuredApiBase('global'),
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
  if (identityState.created && !launchAuth && telemetryIdentity.firstSignupFlowId) {
    await telemetryReporter.freshInstallOpened(telemetryIdentity.firstSignupFlowId);
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
  const response = await electronFetch(`${apiBaseUrl}${path}`, {
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
  if (!parsed.success) throw new UnusableCredentialError(
    zodDiagnosticCode(parsed.error, 'authentication_session') ?? 'authentication_session_invalid',
  );
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
  if (apiBaseUrl !== configuredApiBase('global')) {
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
    throw new Error('Rally sign-in returned an organization before platform discovery');
  }
  if (session.apiBaseUrl !== apiBaseUrl) throw new Error('The regional service returned a mismatched endpoint');
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      desktopAuthAttempts.discard(candidate.attemptId as string);
      throw new Error('Rally was signed out while sign-in was completing');
    }
    // Read the stored state before checking the attempt. Creating an attempt
    // does not take this lock, so one can start during any await here; nothing
    // may yield between the check and clearing the registry, or this older
    // callback would retire a newer attempt and overwrite its sign-in.
    const currentAuth = await loadStoredAuthSet();
    const currentSession = currentAuth ? await loadStoredSession() : null;
    const currentAttempt = desktopAuthAttempts.proof(candidate.attemptId as string);
    if (
      !currentAttempt
      || currentAttempt.apiBaseUrl !== apiBaseUrl
      || currentAttempt.region !== candidate.region
    ) {
      throw new Error('A newer Rally sign-in attempt replaced this callback');
    }
    if (
      currentSession?.workspace
      && currentSession.user.email.toLocaleLowerCase('en-US')
        !== session.user.email.toLocaleLowerCase('en-US')
    ) {
      desktopAuthAttempts.discard(candidate.attemptId as string);
      throw new Error('This Rally account does not match the active organization');
    }
    // One successful PKCE attempt wins. Late callbacks from any other browser
    // tab must not replace the account that just signed in.
    desktopAuthAttempts.clear();
    if (currentAuth && currentSession?.workspace) {
      inMemoryAuthSet = await writeSplitSessionFiles(session, { activate: false });
      if (currentAuth.account) revokeReplacedCredentials({ ...currentAuth, workspaces: [] });
      return publicSession(currentSession);
    }
    // Past here nothing stored can be shown: the state the renderer drew
    // sign-in for. The attempt was live, so nothing newer has signed in since
    // it began, and replacing the stored state is safe.
    if (currentAuth?.account && currentAuth.account.binding.userId === session.user.id) {
      // The same person: keep their organizations, but drop the selection,
      // since it is what could not be shown.
      inMemoryAuthSet = { ...currentAuth, activeWorkspace: null };
      await persistSessionUnlocked(session);
      revokeReplacedCredentials({ ...currentAuth, workspaces: [] });
      return publicSession(session);
    }
    if (currentAuth) {
      sessionLifecycleEpoch += 1;
      desktopPush.signOut(currentAuth.workspaces);
      await clearStoredSessionUnlocked();
      revokeReplacedCredentials(currentAuth);
    }
    await persistSessionUnlocked(session);
    return publicSession(session);
  });
}

/** A sign-in that displaces stored credentials must not wait on the server
 * to end their sessions, nor fail because it could not. */
function revokeReplacedCredentials(replaced: StoredAuthSet): void {
  void revokeStoredCredentials(replaced).then((failures) => {
    if (failures.length > 0) logWarn('rally', 'could not revoke every replaced session',
      new AggregateError(failures, 'Rally could not revoke every replaced session'));
  }).catch((error: unknown) => {
    logWarn('rally', 'could not revoke replaced sessions', error);
  });
}

function createDesktopAuthAttempt(input: unknown): { attemptId: string; codeChallenge: string } {
  if (!input || typeof input !== 'object') throw new Error('Invalid desktop authentication request');
  const candidate = input as { apiBaseUrl?: unknown; region?: unknown };
  if (candidate.region !== 'global') {
    throw new Error('Rally uses one platform sign-in endpoint');
  }
  const apiBaseUrl = validatedApiBase(candidate.apiBaseUrl);
  if (apiBaseUrl !== configuredApiBase('global')) {
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
  const identity = await requestSession(configuredApiBase('global'), '/auth/dev/identity', {});
  if (
    !session.workspace
    || session.apiBaseUrl !== apiBaseUrl
    || runtimeConfig().api[session.workspace.region] !== apiBaseUrl
    || identity.workspace
    || identity.apiBaseUrl !== configuredApiBase('global')
    || identity.user.email.toLocaleLowerCase('en-US') !== session.user.email.toLocaleLowerCase('en-US')
  ) {
    throw new Error('The development session returned a mismatched regional endpoint');
  }
  return withSessionMutation(async () => {
    inMemoryAuthSet = await writeSplitSessionFiles(identity);
    inMemorySession = identity;
    inMemoryAuthSet = await writeSplitSessionFiles(session);
    inMemorySession = session;
    broadcastSessionChanged(session);
    return publicSession(session);
  });
}

/**
 * A renewal of the account identity that the service refused for good has
 * already surrendered the credential (see `refreshStoredCredentialOnce`). To
 * the request that needed it, that is the same answer as never having had
 * one: the renderer signs in from the action that asked, in the same click,
 * rather than reporting an outage and signing in on the next.
 */
function identityRenewalFailure(error: unknown): Error {
  if (refreshFailureIsTerminal(error)) return accountReconnectRequiredFailure();
  return error instanceof Error ? error : new Error(String(error));
}

async function requireOnboardingIdentitySession(): Promise<WireSession> {
  const stored = await loadStoredIdentitySession().catch((error: unknown) => {
    throw identityRenewalFailure(error);
  });
  if (!stored) {
    await endAccountSession();
    throw accountReconnectRequiredFailure();
  }
  if (stored.apiBaseUrl !== configuredApiBase('global')) {
    throw new Error('Organization setup requires a Rally platform identity session');
  }
  return stored;
}

async function onboardingIdentityRequest(
  request: (identity: WireSession) => Promise<Response>,
  /** The identity the caller already loaded, so the request does not read it twice. */
  loaded?: WireSession,
): Promise<{ identity: WireSession; response: Response }> {
  return requestWithOnboardingIdentity({
    load: loaded ? async () => loaded : requireOnboardingIdentitySession,
    refresh: async (identity) => {
      const auth = await loadStoredAuthSet();
      const account = auth?.account;
      if (!account) throw accountReconnectRequiredFailure();
      if (!storedAuthMatches(account, storedAuthFromSession(identity, 'global'))) {
        // Something already replaced the credential this request presented: a
        // refresh that finished first, or a fresh sign-in. Use what is stored
        // rather than rotating a token the service has since retired, and
        // refresh the stored one only when it has itself expired.
        const replacement = await storedSessionForCredential(account);
        if (replacement && Date.parse(replacement.expiresAt) > Date.now()) return replacement;
      }
      return refreshStoredCredential(account).catch((error: unknown) => {
        throw identityRenewalFailure(error);
      });
    },
    fetch: request,
  });
}

interface WorkspaceDiscovery {
  identity: WireSession;
  workspace: DesktopWorkspaceSummary | null;
  workspaces: DesktopWorkspaceSummary[];
  invitations: DesktopPendingWorkspaceInvitation[];
}

function workspaceSummary(workspace: {
  id: string;
  name: string;
  slug: string;
  region: RallyRegion;
  role: 'owner' | 'admin' | 'member' | null;
  accessClass?: 'member' | 'guest';
  createdAt: string;
}): DesktopWorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    region: workspace.region,
    role: workspace.role,
    ...(workspace.accessClass ? { accessClass: workspace.accessClass } : {}),
    createdAt: workspace.createdAt,
  };
}

/** Ask Global for the account's complete membership and invitations. */
async function discoverWorkspaces(): Promise<WorkspaceDiscovery> {
  const { identity, response } = await onboardingIdentityRequest((credential) => electronFetch(
    `${configuredApiBase('global')}/onboarding`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
        // Declares that this build opens a guest relationship it is offered.
        [RALLY_HEADERS.CLIENT_CONTRACT]: String(CLIENT_CONTRACT_VERSION),
      },
    },
  ));
  if (!response.ok) throw await responseError(response);
  const parsed = WorkspaceOnboardingStateSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Rally returned an invalid organization setup response');
  const accountEmail = identity.user.email.toLocaleLowerCase('en-US');
  if (parsed.data.invitations.some((invitation) => invitation.email.toLocaleLowerCase('en-US') !== accountEmail)) {
    throw new Error('Rally returned an invitation for another account');
  }
  return {
    identity,
    workspace: parsed.data.workspace ? workspaceSummary(parsed.data.workspace) : null,
    workspaces: parsed.data.workspaces.map(workspaceSummary),
    invitations: parsed.data.invitations,
  };
}

/** Discovery's rows over this device's stored set, in device recency order. */
async function workspaceDirectoryRows(discovered: DesktopWorkspaceSummary[]): Promise<DesktopWorkspaceSummary[]> {
  const auth = await loadStoredAuthSet();
  const profiles = await loadStoredProfileSet();
  return mergeWorkspaceDirectory(discovered, storedWorkspaceSummaries(auth, profiles), auth);
}

/**
 * Drop the stored credential and profile of every background workspace a
 * complete discovery no longer lists. Listing the stored set regardless of
 * discovery is what keeps a workspace on the menu when the account cannot be
 * reached; this is what keeps a membership that has actually ended from
 * living on as a stored row that can never open. `endedStoredWorkspaces`
 * spares the active workspace and anything written after `discoveredAt`.
 */
async function reconcileStoredWorkspaces(
  identity: WireSession,
  discovered: DesktopWorkspaceSummary[],
  discoveredAt: string,
): Promise<void> {
  await withSessionMutation(async () => {
    const auth = await loadStoredAuthSet();
    const profiles = await loadStoredProfileSet();
    if (!auth || !profiles || auth.account?.binding.userId !== identity.user.id) return;
    const ended = endedStoredWorkspaces(auth, profiles, discovered, discoveredAt);
    if (ended.length === 0) return;
    let nextAuth = auth;
    let nextProfiles = profiles;
    for (const reference of ended) {
      ({ auth: nextAuth, profiles: nextProfiles } = removeStoredWorkspace(
        nextAuth,
        nextProfiles,
        reference.workspaceId,
        reference.region,
      ));
    }
    await writeStoredAuthFile(
      userDataDirectory(),
      encryptStoredSessionValue(JSON.stringify(nextAuth)),
    );
    await writeStoredProfileFile(
      userDataDirectory(),
      encryptStoredSessionValue(JSON.stringify(nextProfiles)),
    );
    inMemoryAuthSet = nextAuth;
    inMemoryProfileSet = nextProfiles;
    logWarn('rally', `removed ${ended.length} stored organization credential(s) whose membership has ended`);
  });
}

/**
 * The account menu's directory. Never rejects on discovery's account: the
 * stored set is listed whatever happened, and the answer says which of three
 * states the account is in, so the renderer shows a state rather than
 * retrying an error into a menu item that comes and goes.
 */
async function getOnboardingState(): Promise<DesktopWorkspaceOnboardingState> {
  const discoveredAt = new Date().toISOString();
  let discovered: WorkspaceDiscovery;
  try {
    discovered = await discoverWorkspaces();
  } catch (error) {
    // The difference between "reconnect the account" and "try again later"
    // is whether an identity credential is still on this device: a refresh
    // that just proved one dead has surrendered it by the time this runs.
    const identityStored = Boolean((await loadStoredAuthSet())?.account);
    return {
      workspace: null,
      workspaces: await workspaceDirectoryRows(lastWorkspaceDiscovery?.workspaces ?? []),
      invitations: lastWorkspaceDiscovery?.invitations ?? [],
      identity: identityStored ? 'unavailable' : 'reconnect_required',
      // A sentence for the no-workspace gate, which shows this as it is; the
      // coded failure's own detail is written for a caption, without the stop.
      identityError: !identityStored
        ? 'Sign in to Rally again to continue.'
        : error instanceof Error ? error.message : 'Rally could not check your organizations.',
    };
  }
  lastWorkspaceDiscovery = { workspaces: discovered.workspaces, invitations: discovered.invitations };
  await reconcileStoredWorkspaces(discovered.identity, discovered.workspaces, discoveredAt);
  return {
    workspace: discovered.workspace,
    workspaces: await workspaceDirectoryRows(discovered.workspaces),
    invitations: discovered.invitations,
    identity: 'connected',
  };
}

/** Renew exactly this stored credential, sharing the rotation with any other
 * request that found the same token expired. */
function refreshStoredCredential(previous: StoredAuth): Promise<WireSession> {
  return credentialRefreshes.run(previous, () => refreshStoredCredentialOnce(previous));
}

async function refreshStoredCredentialOnce(previous: StoredAuth): Promise<WireSession> {
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  if (loggingOut) throw new Error('Rally is signing out');
  const apiBaseUrl = apiBaseForAuth(previous);
  let session: WireSession;
  try {
    session = await requestSession(
      apiBaseUrl,
      '/auth/refresh',
      { refreshToken: previous.refreshToken },
      previous.accessToken,
    );
    if (!sessionsShareBinding(session, previous) || session.apiBaseUrl !== apiBaseUrl) {
      throw new UnusableCredentialError('The refreshed session did not match the stored credential binding');
    }
  } catch (error) {
    if (refreshFailureIsTerminal(error)) {
      try {
        if (previous.binding.workspaceId === null) await endAccountSession(previous);
        else await withSessionMutation(() => removeStoredCredentialUnlocked(previous));
      } catch (cleanupError) {
        logWarn('rally', 'could not remove a terminally rejected stored credential', cleanupError);
      }
    }
    throw error;
  }
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      throw new Error('Rally was signed out while the session was refreshing');
    }
    const auth = await loadStoredAuthSet();
    if (!auth) throw new Error('Rally was signed out while the session was refreshing');
    const current = previous.binding.workspaceId === null
      ? auth.account
      : storedWorkspaceCredential(auth, previous.binding.workspaceId, previous.binding.region);
    if (!current || !storedAuthMatches(current, previous)) {
      throw new Error('A newer Rally credential replaced this refresh request');
    }
    const activate = previous.binding.workspaceId === null
      ? auth.activeWorkspace === null
      : auth.activeWorkspace?.workspaceId === previous.binding.workspaceId
        && auth.activeWorkspace.region === previous.binding.region;
    inMemoryAuthSet = await writeSplitSessionFiles(session, { activate });
    if (activate) {
      inMemorySession = session;
      broadcastSessionChanged(session);
    }
    return session;
  });
}

async function getWorkspaceAttention(input: unknown): Promise<WorkspaceAttention> {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const workspaceId = IdSchema.safeParse(candidate['workspaceId']);
  const region = RegionSchema.safeParse(candidate['region']);
  if (
    !workspaceId.success
    || !region.success
    || Object.keys(candidate).some((key) => key !== 'workspaceId' && key !== 'region')
  ) {
    throw new Error('Invalid organization attention request');
  }
  const authSet = await loadStoredAuthSet();
  const auth = authSet ? storedWorkspaceCredential(authSet, workspaceId.data, region.data) : null;
  if (!auth) throw new Error('No credential is stored for this organization');
  const ask = (credential: StoredAuth) => electronFetch(`${apiBaseForAuth(credential)}/workspace/attention`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}` },
  });
  let response = await ask(auth);
  if (response.status === 401) {
    const renewed = await refreshStoredCredential(auth);
    response = await ask(storedAuthFromSession(renewed, regionForStoredSession(renewed)));
  }
  if (!response.ok) throw await responseError(response);
  return WorkspaceAttentionSchema.parse(await readJsonBody(response));
}

async function leaveWorkspace(input: unknown): Promise<WorkspaceDeparture> {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const workspaceId = IdSchema.safeParse(candidate['workspaceId']);
  const region = RegionSchema.safeParse(candidate['region']);
  const parsedDeparture = WorkspaceDepartureRequestSchema.safeParse({ expectedOutcome: candidate['expectedOutcome'] });
  if (
    !workspaceId.success
    || !region.success
    || !parsedDeparture.success
    || Object.keys(candidate).some((key) => !['expectedOutcome', 'workspaceId', 'region'].includes(key))
  ) {
    throw new Error('Invalid organization departure request');
  }
  {
    const authSet = await loadStoredAuthSet();
    let credential = authSet
      ? activeStoredWorkspaceCredential(authSet, workspaceId.data, region.data)
      : null;
    if (!credential) throw new Error('No credential is stored for this organization');
    const ask = (stored: StoredAuth) => electronFetch(
      `${apiBaseForAuth(stored)}/workspaces/${encodeURIComponent(workspaceId.data)}/membership`
        + `?expectedOutcome=${parsedDeparture.data.expectedOutcome}`,
      {
        method: 'DELETE',
        headers: { Accept: 'application/json', Authorization: `Bearer ${stored.accessToken}` },
      },
    );
    let response = await ask(credential);
    if (response.status === 401) {
      const renewed = await refreshStoredCredential(credential);
      credential = storedAuthFromSession(renewed, regionForStoredSession(renewed));
      response = await ask(credential);
    }
    if (!response.ok) throw await responseError(response);
    const departure = WorkspaceDepartureSchema.parse(await readJsonBody(response));
    await withSessionMutation(() => removeStoredCredentialUnlocked(credential));
    return departure;
  }
}

async function requestOnboardingSession(
  path: string,
  body: unknown,
  expectedRegion: RallyRegion,
  expectedWorkspaceId?: string,
  operationId?: string,
  selectionIntent = ++workspaceSelectionIntent,
): Promise<DesktopSession> {
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  const identity = await requireOnboardingIdentitySession();
  if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
    throw new Error('Rally was signed out while organization setup was running');
  }
  const requested = await onboardingIdentityRequest((credential) => electronFetch(
    `${configuredApiBase('global')}${path}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
        [RALLY_HEADERS.CLIENT_CONTRACT]: String(CLIENT_CONTRACT_VERSION),
        ...(operationId ? { [RALLY_HEADERS.OPERATION_ID]: operationId } : {}),
      },
      body: JSON.stringify(body),
    },
  ), identity);
  const response = requested.response;
  if (!response.ok) throw await responseError(response);
  const parsed = SessionSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.workspace) {
    throw new Error('Rally returned an invalid regional organization session');
  }
  const targetApiBaseUrl = validatedApiBase(parsed.data.apiBaseUrl);
  if (
    targetApiBaseUrl !== runtimeConfig().api[expectedRegion]
    || parsed.data.workspace.region !== expectedRegion
    || (expectedWorkspaceId !== undefined && parsed.data.workspace.id !== expectedWorkspaceId)
  ) {
    throw new Error('Rally returned an organization session for the wrong organization or region');
  }
  if (parsed.data.user.email.toLocaleLowerCase('en-US') !== identity.user.email.toLocaleLowerCase('en-US')) {
    throw new Error('Rally returned an organization session for another account');
  }
  const session = { ...parsed.data, apiBaseUrl: targetApiBaseUrl };
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      throw new Error('Rally was signed out while organization setup was running');
    }
    const currentAuth = await loadStoredAuthSet();
    if (!currentAuth?.account || currentAuth.account.binding.userId !== identity.user.id) {
      throw new Error('The signed-in Rally account changed during organization setup');
    }
    const activate = selectionIntent === workspaceSelectionIntent;
    const displaced = await displacedSupportCredentialUnlocked(session);
    inMemoryAuthSet = await writeSplitSessionFiles(session, { activate });
    if (displaced) revokeInBackground(displaced);
    if (activate) {
      await dropBackgroundSupportCredentialsUnlocked();
      inMemorySession = session;
      broadcastSessionChanged(session);
      return publicSession(session);
    }
    const current = await loadStoredSession() ?? await loadStoredIdentitySession();
    if (!current) throw new Error('Rally was signed out while organization setup was running');
    return publicSession(current);
  });
}

/**
 * Rally staff support access (`docs/impersonation.md`). Every call goes to
 * Global with the account's identity credential, which is what the API checks
 * staff membership against; the support session itself is stored and used
 * like any other Organization credential, marked by its profile's
 * `impersonator`.
 */
async function supportIdentityGet<T>(path: string, schema: ZodType<T>): Promise<T> {
  const { response } = await onboardingIdentityRequest((credential) => electronFetch(
    `${configuredApiBase('global')}${path}`,
    { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}` } },
  ));
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`Rally returned an invalid Rally access response (${describeZodIssues(parsed.error)})`);
  return parsed.data;
}

/** `null` when the account is not Rally staff, which is final; anything else throws so it is retried. */
async function listSupportWorkspaces(): Promise<SupportWorkspace[] | null> {
  try {
    return (await supportIdentityGet('/auth/support/workspaces', SupportWorkspacesSchema)).workspaces;
  } catch (error) {
    if (error instanceof RallyApiResponseError && error.code === 'support_access_staff_required') return null;
    throw error;
  }
}

async function listSupportPeople(input: unknown): Promise<SupportPerson[]> {
  const workspaceId = IdSchema.safeParse(input);
  if (!workspaceId.success) throw new Error('Invalid organization');
  return (await supportIdentityGet(`/auth/support/workspaces/${workspaceId.data}/people`, SupportPeopleSchema)).people;
}

async function startSupportSession(input: unknown): Promise<DesktopSession> {
  const request = StartSupportSessionRequestSchema.safeParse(input);
  if (!request.success) throw new Error('Invalid Rally access request');
  const expectedLifecycleEpoch = sessionLifecycleEpoch;
  const selectionIntent = ++workspaceSelectionIntent;
  const identity = await requireOnboardingIdentitySession();
  const { response } = await onboardingIdentityRequest((credential) => electronFetch(
    `${configuredApiBase('global')}/auth/support/session`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
      },
      body: JSON.stringify(request.data),
    },
  ), identity);
  if (!response.ok) throw await responseError(response);
  const parsed = SessionSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`Rally returned an invalid support session (${describeZodIssues(parsed.error)})`);
  if (!parsed.data.workspace || !parsed.data.impersonator) {
    throw new Error(`Rally returned a support session without its ${parsed.data.workspace ? 'impersonator' : 'workspace'}`);
  }
  const apiBaseUrl = validatedApiBase(parsed.data.apiBaseUrl);
  if (
    parsed.data.workspace.id !== request.data.workspaceId
    || parsed.data.user.id !== request.data.userId
    || parsed.data.impersonator.id !== identity.user.id
    || apiBaseUrl !== runtimeConfig().api[parsed.data.workspace.region]
  ) {
    throw new Error('Rally returned a support session for the wrong person or organization');
  }
  const session = { ...parsed.data, apiBaseUrl };
  return withSessionMutation(async () => {
    if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) {
      throw new Error('Rally was signed out while Rally access was starting');
    }
    const currentAuth = await loadStoredAuthSet();
    if (!currentAuth?.account || currentAuth.account.binding.userId !== identity.user.id) {
      throw new Error('The signed-in Rally account changed while Rally access was starting');
    }
    const activate = selectionIntent === workspaceSelectionIntent;
    const displaced = await displacedSupportCredentialUnlocked(session);
    inMemoryAuthSet = await writeSplitSessionFiles(session, { activate });
    // A support session for another person in the same Organization takes its
    // slot; the one it replaces is ended on the server rather than orphaned.
    if (displaced) revokeInBackground(displaced);
    await dropBackgroundSupportCredentialsUnlocked();
    if (!activate) {
      const current = await loadStoredSession() ?? await loadStoredIdentitySession();
      if (!current) throw new Error('Rally was signed out while Rally access was starting');
      return publicSession(current);
    }
    inMemorySession = session;
    broadcastSessionChanged(session);
    return publicSession(session);
  });
}

/**
 * End the active support session: revoke it on the server, forget it here, and
 * return to the Organization this device used before it, the way leaving one
 * does. A no-op when the active credential is the account's own.
 */
async function endSupportSession(): Promise<DesktopSession | null> {
  return withSessionMutation(async () => {
    const auth = await loadStoredAuthSet();
    const active = auth ? activeStoredCredential(auth) : null;
    if (active && storedCredentialIsSupport(await loadStoredProfileSet(), active)) {
      revokeInBackground(active);
      await removeStoredCredentialUnlocked(active);
    }
    return inMemorySession ? publicSession(inMemorySession) : null;
  });
}

/**
 * A support session lasts only while it is in front of the person. Selecting
 * any other Organization ends whichever support session was open, so none is
 * left behind to be refreshed, listed or asked for attention in the
 * background. Caller holds the session mutation lock.
 */
async function dropBackgroundSupportCredentialsUnlocked(): Promise<void> {
  const auth = await loadStoredAuthSet();
  const profiles = await loadStoredProfileSet();
  if (!auth || !profiles) return;
  const active = activeStoredCredential(auth);
  const dropped = auth.workspaces.filter((credential) => (
    credential !== active && storedCredentialIsSupport(profiles, credential)
  ));
  if (dropped.length === 0) return;
  let nextAuth = auth;
  let nextProfiles = profiles;
  for (const credential of dropped) {
    revokeInBackground(credential);
    ({ auth: nextAuth, profiles: nextProfiles } = removeStoredWorkspace(
      nextAuth, nextProfiles, credential.binding.workspaceId!, credential.binding.region,
    ));
  }
  await writeStoredAuthFile(userDataDirectory(), encryptStoredSessionValue(JSON.stringify(nextAuth)));
  await writeStoredProfileFile(userDataDirectory(), encryptStoredSessionValue(JSON.stringify(nextProfiles)));
  inMemoryAuthSet = nextAuth;
  inMemoryProfileSet = nextProfiles;
}

/**
 * The support credential `session` is about to replace in its Organization's
 * slot, if one is stored there. Writing the new session overwrites it, so the
 * caller revokes it afterwards. Caller holds the session mutation lock.
 */
async function displacedSupportCredentialUnlocked(session: WireSession): Promise<StoredAuth | null> {
  if (!session.workspace) return null;
  const auth = await loadStoredAuthSet();
  const current = auth ? storedWorkspaceCredential(auth, session.workspace.id, session.workspace.region) : null;
  if (!current || current.refreshToken === session.refreshToken) return null;
  return storedCredentialIsSupport(await loadStoredProfileSet(), current) ? current : null;
}

function revokeInBackground(credential: StoredAuth): void {
  void revokeStoredCredentials({
    version: 2, account: null, workspaces: [credential], activeWorkspace: null, workspaceRecency: [],
  }).then((failures) => {
    if (failures.length > 0) logWarn('rally', 'A support session could not be revoked on the server', failures[0]);
  });
}

async function activateWorkspace(input: unknown): Promise<DesktopSession> {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (Object.keys(candidate).some((key) => !['region', 'workspaceId', 'operationId'].includes(key))) {
    throw new Error('Invalid organization activation request');
  }
  const parsed = ActivateWorkspaceRequestSchema.safeParse({
    region: candidate['region'], workspaceId: candidate['workspaceId'],
  });
  if (!parsed.success) throw new Error('Invalid organization activation request');
  const operationId = candidate['operationId'];
  if (operationId !== undefined && (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId))) {
    throw new Error('Invalid organization activation operation ID');
  }
  return revalidateWorkspaceActivation(parsed.data, operationId as string | undefined, {
    nextSelectionIntent: () => ++workspaceSelectionIntent,
    request: (request) => requestOnboardingSession(
      request.path,
      request.body,
      request.expectedRegion,
      request.expectedWorkspaceId,
      request.operationId,
      request.selectionIntent,
    ),
  });
}

/**
 * Answer a link that names the active workspace with the session already in
 * use, taking a selection intent so the link is the newest selection. Nothing
 * is written: the credential, its file, and the broadcast state are all
 * unchanged. Any other target gets `null`, and the caller activates it.
 */
async function reselectActiveWorkspace(input: unknown): Promise<DesktopSession | null> {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (Object.keys(candidate).some((key) => !['region', 'workspaceId'].includes(key))) {
    throw new Error('Invalid organization selection request');
  }
  const parsed = ActivateWorkspaceRequestSchema.safeParse({
    region: candidate['region'], workspaceId: candidate['workspaceId'],
  });
  if (!parsed.success) throw new Error('Invalid organization selection request');
  if (loggingOut) return null;
  const claimed = claimActiveWorkspace(parsed.data, {
    activeSession: await loadStoredSession(),
    nextSelectionIntent: () => ++workspaceSelectionIntent,
  });
  return claimed ? publicSession(claimed) : null;
}

async function createWorkspace(input: unknown): Promise<DesktopSession> {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (Object.keys(candidate).some((key) => !['region', 'name', 'operationId'].includes(key))) {
    throw new Error('Invalid organization creation request');
  }
  const parsed = CreateWorkspaceRequestSchema.safeParse({ region: candidate['region'], name: candidate['name'] });
  if (!parsed.success) throw new Error('Invalid organization creation request');
  const operationId = candidate['operationId'];
  if (operationId !== undefined && (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId))) {
    throw new Error('Invalid organization creation operation ID');
  }
  {
    return await requestOnboardingSession(
      '/onboarding/workspace', parsed.data, parsed.data.region, undefined, operationId as string | undefined,
    );
  }
}

function parseInvitationAction(input: unknown): {
  invitationId: string;
  region: RallyRegion;
  operationId?: string;
} {
  if (!input || typeof input !== 'object') throw new Error('Invalid organization invitation request');
  const candidate = input as { invitationId?: unknown; region?: unknown; operationId?: unknown };
  if (Object.keys(candidate).some((key) => !['region', 'invitationId', 'operationId'].includes(key))) {
    throw new Error('Invalid organization invitation request');
  }
  const invitationId = IdSchema.safeParse(candidate.invitationId);
  const region = OnboardingRegionRequestSchema.safeParse({ region: candidate.region });
  if (!invitationId.success || !region.success) throw new Error('Invalid organization invitation request');
  if (candidate.operationId !== undefined
    && (typeof candidate.operationId !== 'string' || !UUID_V7_PATTERN.test(candidate.operationId))) {
    throw new Error('Invalid organization invitation operation ID');
  }
  return {
    invitationId: invitationId.data,
    region: region.data.region,
    ...(candidate.operationId ? { operationId: candidate.operationId } : {}),
  };
}

async function acceptInvitation(input: unknown): Promise<DesktopSession> {
  const parsed = parseInvitationAction(input);
  {
    return await requestOnboardingSession(
      `/onboarding/invitations/${encodeURIComponent(parsed.invitationId)}/accept`,
      { region: parsed.region },
      parsed.region,
      undefined,
      parsed.operationId,
    );
  }
}

async function declineInvitation(input: unknown): Promise<void> {
  const parsed = parseInvitationAction(input);
  const { response } = await onboardingIdentityRequest((identity) => electronFetch(
    `${configuredApiBase('global')}/onboarding/invitations/${encodeURIComponent(parsed.invitationId)}/decline`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${identity.accessToken}`,
      },
      body: JSON.stringify({ region: parsed.region }),
    },
  ));
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
  // The active credential can also be presented by `refreshStoredCredential`
  // — leaving the workspace does — so both share the registry and one token
  // is rotated once whichever path asks first.
  return credentialRefreshes.run(previousAuth, () => refreshActiveSessionOnce(previousAuth, expectedLifecycleEpoch));
}

async function refreshActiveSessionOnce(previousAuth: StoredAuth, expectedLifecycleEpoch: number): Promise<WireSession> {
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
    // working. Joining the workspace from another device rebinds the
    // server session while this device's stored binding stays unbound, so
    // this must surrender the credential rather than loop on it forever.
    if (!sessionsShareBinding(session, previousAuth) || session.apiBaseUrl !== apiBaseUrl) {
      throw new UnusableCredentialError('The refreshed session did not match the stored credential binding');
    }
  } catch (error) {
    // Only a terminal failure may delete anything, and only the credential
    // this attempt actually presented. A sign-out/sign-in, a workspace
    // activation, or a lockdown relogin can persist a newer credential while
    // this request is in flight, so the generation is rechecked under the same
    // lock the success path takes. Everything else stays on disk so renderers
    // can keep retrying instead of treating a network blip as an expired
    // session.
    if (refreshFailureIsTerminal(error)) {
      try {
        if (previousAuth.binding.workspaceId === null) await endAccountSession(previousAuth);
        else await withSessionMutation(async () => {
          if (loggingOut || expectedLifecycleEpoch !== sessionLifecycleEpoch) return;
          const currentAuth = await loadStoredAuth();
          if (!currentAuth || !storedAuthMatches(currentAuth, previousAuth)) return;
          await removeStoredCredentialUnlocked(previousAuth);
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

async function revokeStoredCredentials(stored: StoredAuthSet): Promise<unknown[]> {
  const failures: unknown[] = [];
  const credentials = [
    ...(stored.account ? [stored.account] : []),
    ...stored.workspaces,
  ];
  for (const credential of credentials) {
    try {
      const apiBaseUrl = apiBaseForAuth(credential);
      const response = await electronFetch(`${apiBaseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential.accessToken}`,
        },
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
      });
      if (!response.ok) throw await responseError(response);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
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
    const stored = await loadStoredAuthSet();
    desktopPush.signOut(stored?.workspaces);
    try {
      await clearStoredSession();
    } catch (error) {
      failures.push(error);
    }
    settingsWindow?.close();
    if (stored) {
      try { failures.push(...await revokeStoredCredentials(stored)); }
      catch (error) { failures.push(error); }
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

function revealWindow(window: BrowserWindow): void {
  if (window === mainWindow && !mainWindowReadyToShow) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function sendDeepLink(rawUrl: string, entrypoint: DesktopDeepLinkEntrypoint): void {
  const navigation: DesktopDeepLinkNavigation = { url: rawUrl, entrypoint };
  const connectorSettingsWindow = shouldDeliverConnectorResultToSettings(rawUrl)
    ? revealedSettingsWindow()
    : null;

  // A legacy active-relative callback also refreshes the initiating Settings
  // renderer's React Query cache. An addressed callback is main-only: main
  // activates its target and reopens Connections, while a second delivery to
  // Settings would race the same activation from another renderer process.
  // Authentication and invitation links are likewise exclusive to main.
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
  revealWindow(targetWindow);
}

function emitDeepLink(rawUrl: string, entrypoint: DesktopDeepLinkEntrypoint = 'deep_link'): boolean {
  const deepLink = acceptedDeepLink(rawUrl);
  if (!deepLink) {
    // A Space or Breakout link opens nothing now (a Thread's own deep link
    // was accepted above, as its Canvas); say so, as
    // the site's handoff page and the web app do, rather than drop it. It can
    // arrive before `ready` on a cold launch, and a window cannot open before.
    if (isRetiredDeepLink(rawUrl)) {
      void app.whenReady()
        .then(() => createDeepLinkErrorWindow(RETIRED_LINK_MESSAGE))
        .catch((error: unknown) => logWarn('rally', 'could not show the retired-link notice', error));
    }
    return false;
  }
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

/**
 * One live preview per window, and never more.
 *
 * Keyed by window rather than global because a person can have several Rally
 * windows open, each showing a different work stream; two views over one
 * rectangle would leave the one underneath running and invisible.
 */
const artifactPreviews = new Map<BrowserWindow, ArtifactPreviewController>();
const poppedOutArtifacts = new Map<BrowserWindow, {
  region: string;
  workspaceId: string;
  userId: string;
  resourceId: string;
  version: number;
  stateId: string;
  request: DesktopArtifactWindowRequest;
  owner?: WebContents | undefined;
}>();
const annotationTransfers = new Map<string, {owner:WebContents; scope:string; window:BrowserWindow; resolve:(accepted:boolean)=>void}>();
const annotationComposerScopes = new WeakMap<WebContents, Set<string>>();
let savedArtifactWindows: ArtifactWindowState[] | null = null;
const preservedArtifactWindows = new WeakSet<BrowserWindow>();
function artifactWindowStates(): ArtifactWindowState[] {
  return savedArtifactWindows ??= readArtifactWindows(userDataDirectory());
}
function saveArtifactWindowStates(): void {
  try { writeArtifactWindows(userDataDirectory(), artifactWindowStates()); }
  catch (error) { logWarn('rally', 'Could not save artifact window placement', error); }
}
function closeAndForgetArtifactWindows(): void {
  for (const window of poppedOutArtifacts.keys()) {
    if (!window.isDestroyed()) window.destroy();
  }
  savedArtifactWindows = [];
  saveArtifactWindowStates();
}
function closeArtifactWindowsOutsideSession(workspaceId: string | null, userId: string | null, region: string | null): void {
  let closed = false;
  for (const [window, artifact] of poppedOutArtifacts) {
    if (artifactWindowSessionMatches(artifact, { workspaceId, userId, region })) continue;
    preservedArtifactWindows.add(window);
    if (!window.isDestroyed()) window.destroy();
    closed = true;
  }
  if (closed) saveArtifactWindowStates();
}
const artifactViews = new WeakMap<ArtifactViewHandle, WebContentsView>();
const embeddedBrowsers = new Map<BrowserWindow, { userId: string; browser: EmbeddedBrowser }>();

function closeEmbeddedBrowsersOutsideUser(userId: string | null): void {
  for (const [window, entry] of embeddedBrowsers) {
    if (entry.userId === userId && !window.isDestroyed()) continue;
    entry.browser.dispose();
    embeddedBrowsers.delete(window);
  }
}

/**
 * A browser request's input, or an error naming the field and issue it failed
 * on — never the rejected value. These callers are Rally's own renderers.
 */
function parseBrowserIpc<T>(schema: ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new Error(zodDiagnosticCode(parsed.error, label, { namesUnknownKeys: true }) ?? `${label}_invalid`);
}

function embeddedBrowserHost(event: IpcMainInvokeEvent): BrowserWindow {
  assertTrustedIpcSender(event);
  // The main window's right rail is the one browser host.
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Only the main Rally window can use the browser');
  return mainWindow;
}

function embeddedBrowserFor(window: BrowserWindow): EmbeddedBrowser {
  const userId = inMemorySession?.user.id;
  if (!userId) throw new Error('Sign in to use the browser');
  const previous = embeddedBrowsers.get(window);
  if (previous?.userId === userId) return previous.browser;
  previous?.browser.dispose();
  const browser = new EmbeddedBrowser(window, userId, (state) => {
    if (!window.isDestroyed()) window.webContents.send('embedded-browser:state', state);
  }, (request) => {
    // Keyboard focus is in the visited page; the controls are Rally's own.
    if (window.isDestroyed()) return;
    window.webContents.focus();
    window.webContents.send('embedded-browser:host-request', request);
  }, false);
  embeddedBrowsers.set(window, { userId, browser });
  window.once('closed', () => embeddedBrowsers.delete(window));
  return browser;
}

/**
 * The domain artifacts are served from, as this build was configured.
 *
 * Read from the renderer's own configuration rather than hard-coded: a sandbox
 * and a packaged build serve artifacts from different places, and a constant
 * here would make the main process refuse every URL in one of them.
 */
function artifactServingDomain(): string {
  return process.env.VITE_ARTIFACT_SERVING_DOMAIN?.trim() || 'rallyusercontent.com';
}

/**
 * How one artifact surface is allowed to leave its origin.
 *
 * The activation state is built here rather than in the policy module because
 * it is reconstructed from Electron's own `input-event` stream: the main
 * process is told nothing about user activation when a navigation starts, so
 * the presses that reach these contents are the only evidence there is. One
 * tracker per surface — the rail preview and a pop-out show different
 * documents, and a shared flag would let a click in one send the other away.
 */
function artifactLinkHandoff(contents: WebContents): ArtifactLinkHandoff {
  const activation = new ArtifactUserActivation();
  contents.on('input-event', (_event, input) => activation.record(input.type));
  // A committed main-frame navigation ends the document the press belonged to.
  // `did-navigate` is the right event and `did-navigate-in-page` deliberately is
  // not: a fragment jump leaves the same document on screen, and a browser does
  // not drop activation for one either.
  contents.on('did-navigate', () => activation.reset());
  return {
    takeActivation: () => activation.take(),
    // The same scheme policy every other handoff in this process uses: http(s)
    // only, and https only once packaged.
    externalAllowed: isAllowedExternalUrl,
    // Caught rather than discarded: the OS opener rejects when it cannot launch
    // the URL — no registered default browser, a handler that refuses — and an
    // unhandled rejection takes the main process down, since this process only
    // *monitors* uncaught exceptions. Failing to follow a link must cost a log
    // line, not the window somebody was reading.
    openExternal: (url) => {
      void shell.openExternal(url).catch((error: unknown) => {
        logWarn('rally', 'could not open an artifact link in the browser', error);
      });
    },
    // Through the same loader the initial presentation uses, so a page that
    // redeems or redirects on arrival is not mistaken for a failed load. The URL
    // is never logged: it is model-authored and may carry whatever the page put
    // in it.
    navigateInPlace: (url) => {
      void loadArtifactInitialUrl(() => contents.loadURL(url)).then((loaded) => {
        if (!loaded) logWarn('rally', 'could not follow a link inside a site preview');
      });
    },
  };
}

function artifactPreviewFor(window: BrowserWindow): ArtifactPreviewController {
  const existing = artifactPreviews.get(window);
  if (existing) return existing;
  const controller = new ArtifactPreviewController(
    {
      destroyed: () => window.isDestroyed(),
      contentSize: () => {
        const [width = 0, height = 0] = window.getContentSize();
        return { width, height };
      },
      zoomFactor: () => window.webContents.getZoomFactor(),
      removeView: (view) => {
        const child = artifactViews.get(view);
        if (child) window.contentView.removeChildView(child);
      },
    },
    artifactServingDomain(),
    (request): ArtifactViewHandle => {
      const view = new WebContentsView({
        webPreferences: artifactWebPreferences(request.artifactId, app.isPackaged),
      });
      // Captured once rather than read back off `view` on each call: a
      // destroyed web contents still answers `isDestroyed()` honestly, and it
      // is the only part of a torn-down surface that can be asked anything.
      const contents = view.webContents;
      artifactWebContents.add(contents);
      confineToArtifactOrigin(contents, new URL(request.url).origin, artifactLinkHandoff(contents));
      // The page's own annotation API, which the serving Worker put there; the
      // isolated world this view used to evaluate a picker in is gone with it.
      const page = artifactPageAnnotations((code) => contents.executeJavaScript(code));
      window.contentView.addChildView(view);
      const handle: ArtifactViewHandle = {
        destroyed: () => contents.isDestroyed(),
        setBounds: (bounds) => view.setBounds(bounds),
        setBorderRadius: (radius) => view.setBorderRadius(radius),
        setVisible: (visible) => view.setVisible(visible),
        load: async (url) => await loadArtifactDocument(contents, url),
        ready: page.ready,
        pick: async () => {
          const pin = await page.pick();
          if (pin === null) return null;
          // The crop is main's own capture of the pane, never bytes the page
          // offered: a pin's `screenshot` is set here or not at all.
          const captured = await contents.capturePage();
          const size = captured.getSize();
          const rect = await page.rect(pin.css);
          const scaleX=size.width/(rect?.viewportWidth || size.width || 1);
          const scaleY=size.height/(rect?.viewportHeight || size.height || 1);
          const x=Math.max(0,Math.min(size.width-1,Math.floor((rect?.x ?? 0)*scaleX)));
          const y=Math.max(0,Math.min(size.height-1,Math.floor((rect?.y ?? 0)*scaleY)));
          const screenshot = captured.isEmpty() ? undefined : 'data:image/png;base64,'+captured.crop({x,y,width:Math.max(1,Math.min(size.width-x,Math.ceil((rect?.width ?? size.width)*scaleX))),height:Math.max(1,Math.min(size.height-y,Math.ceil((rect?.height ?? size.height)*scaleY)))}).toPNG().toString('base64');
          return { ...pin, ...(screenshot ? { screenshot } : {}) };
        },
        comments: page.comments,
        stopPicking: async () => { if (!contents.isDestroyed()) await page.stopPicking(); },
        capture: async () => {
          const captured = await contents.capturePage();
          if (captured.isEmpty()) return null;
          // Down to window points and JPEG rather than device pixels and PNG:
          // this is encoded on the main thread while a menu waits to show, and
          // it only ever sits under that menu, so speed beats exactness.
          const { width, height } = view.getBounds();
          const image = captured.resize({ width, height });
          return `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`;
        },
        close: () => contents.close(),
      };
      // The controller speaks in handles, not Electron objects, so the window
      // needs this to find the child it is removing.
      artifactViews.set(handle, view);
      return handle;
    },
  );
  artifactPreviews.set(window, controller);
  // A window that closes takes its preview with it; leaving the entry behind
  // would keep a destroyed window reachable from this map forever.
  window.once('closed', () => {
    artifactPreviews.get(window)?.destroy();
    artifactPreviews.delete(window);
  });
  return controller;
}

/**
 * One isolated native window for both forms of generated artifact.
 *
 * A live site keeps its own session partition deliberately — a person who
 * authorized the artifact in the rail should not authorize it again to see it
 * bigger. A generated file instead carries the already-authorized preview
 * bytes; a renderer page draws the shared preview and returns pins to its owning composer.
 */
function openArtifactWindow(request: DesktopArtifactWindowRequest, owner?: WebContents): boolean {
  const region = inMemorySession?.workspace?.region;
  const workspaceId = inMemorySession?.workspace?.id;
  const userId = inMemorySession?.user.id;
  if (!workspaceId || !userId || !region) return false;
  const previous = request.restoreId ? artifactWindowStates().find((item) =>
    item.id === request.restoreId && artifactWindowSessionMatches(item, { workspaceId, userId, region })
      && item.resourceId === request.resourceId) : undefined;
  if (request.restoreId && !previous) return false;
  if (previous && [...poppedOutArtifacts.values()].some((item) => item.stateId === previous.id)) return true;
  if (previous) {
    previous.kind = request.kind;
    if (request.kind === 'generated') previous.mimeType = request.mimeType;
    else delete previous.mimeType;
  }
  const display = previous
    ? electronScreen.getAllDisplays().find((item) => item.id === previous.displayId)
      ?? electronScreen.getDisplayMatching(previous.bounds)
    : electronScreen.getPrimaryDisplay();
  const restoredBounds = previous ? clampWindowBounds(previous.bounds, display.workArea, { width: 420, height: 360 }) : null;
  const window = new BrowserWindow({
    width: restoredBounds?.width ?? 1_100,
    height: restoredBounds?.height ?? 800,
    ...(restoredBounds ? { x: restoredBounds.x, y: restoredBounds.y } : {}),
    minWidth: 420,
    minHeight: 360,
    show: false,
    backgroundColor: windowBackgroundColor(),
    title: request.title,
    // Artifact markup owns the whole document and cannot be expected to leave
    // room for native window controls. Keep a compact native title area so the
    // macOS traffic lights never sit on top of model-authored navigation.
    titleBarStyle: 'default',
    ...(process.platform === 'darwin' ? {} : { icon: applicationWindowIconPath() }),
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  const stateId = previous?.id ?? crypto.randomUUID();
  let loadFailed = false;
  const record = (): void => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const states = artifactWindowStates();
    const index = states.findIndex((item) => item.id === stateId);
    const latest = index < 0 ? undefined : states[index];
    const state: ArtifactWindowState = {
      id: stateId, workspaceId, userId, region, kind: latest?.kind ?? request.kind,
      resourceId: request.resourceId, version: poppedOutArtifacts.get(window)?.version ?? request.version,
      title: window.getTitle(),
      ...(request.annotationScope?{annotationScope:request.annotationScope}:{}),
      editable: request.editable === true,
      ...((latest?.kind ?? request.kind) === 'generated'
        ? { mimeType: latest?.mimeType ?? (request.kind === 'generated' ? request.sourceMimeType ?? request.mimeType : undefined) }
        : {}),
      bounds, displayId: electronScreen.getDisplayMatching(bounds).id,
    };
    if (index < 0) states.push(state); else states[index] = state;
  };
  poppedOutArtifacts.set(window, { region, workspaceId, userId, resourceId: request.resourceId, version: request.version, stateId, request, owner });
  record();
  saveArtifactWindowStates();
  window.on('move', record);
  window.on('resize', record);
  window.on('close', () => { record(); saveArtifactWindowStates(); });
  window.once('closed', () => {
    for (const [id, transfer] of annotationTransfers) { if (transfer.window === window) { transfer.resolve(false); annotationTransfers.delete(id); } }
    poppedOutArtifacts.delete(window);
    if (!applicationIsQuitting && !preservedArtifactWindows.has(window) && (!loadFailed || !previous)) {
      savedArtifactWindows = artifactWindowStates().filter((item) => item.id !== stateId);
      saveArtifactWindowStates();
    }
  });
  const url = rendererUrl('artifact-preview');
  window.webContents.on('will-navigate', (event, next) => { if (!rendererNavigationAllowed(next)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The artifact controls document.title, but this strip belongs to Rally's
  // window. Keep the bounded resource title instead of letting remote markup
  // rename the native chrome after it loads.
  window.on('page-title-updated', (event) => event.preventDefault());
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => window.show());
  void loadArtifactInitialUrl(() => window.loadURL(url)).then((loaded) => {
    if (!loaded && !window.isDestroyed()) {
      loadFailed = true;
      window.close();
    }
  });
  return true;
}

function poppedOutArtifactVersions(): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const [window, artifact] of poppedOutArtifacts) {
    if (window.isDestroyed() || artifact.workspaceId !== inMemorySession?.workspace?.id
      || artifact.userId !== inMemorySession?.user.id || artifact.region !== inMemorySession?.workspace?.region) continue;
    const current = versions[artifact.resourceId];
    // Several windows may show one resource. Reporting the oldest makes the
    // renderer refresh the group until every surviving window has caught up.
    versions[artifact.resourceId] = current === undefined
      ? artifact.version
      : Math.min(current, artifact.version);
  }
  return versions;
}

async function updatePoppedOutArtifact(request: DesktopArtifactWindowRequest): Promise<boolean> {
  const windows = [...poppedOutArtifacts.entries()]
    .filter(([window, artifact]) => !window.isDestroyed()
      && artifact.workspaceId === inMemorySession?.workspace?.id
      && artifact.userId === inMemorySession?.user.id && artifact.region === inMemorySession?.workspace?.region
      && artifact.resourceId === request.resourceId
      && artifact.version < request.version);
  if (windows.length === 0) {
    return false;
  }
  const [target, previous] = windows[0]!;
  // The owning renderer supplies a fresh site code for each updated window.
  poppedOutArtifacts.set(target, { ...previous, version: request.version, request: { ...request, editable: previous.request.editable === true, ...(previous.request.annotationScope ? { annotationScope: previous.request.annotationScope } : {}), ...(request.kind==='generated' && !request.sourceMimeType && previous.request.kind==='generated' ? {sourceMimeType:previous.request.sourceMimeType}: {}) } });
  target.setTitle(request.title);
  target.webContents.send('artifact:window-updated');
  const saved = artifactWindowStates().find((item) => item.id === previous.stateId);
  if (saved) {
    saved.kind = request.kind;
    saved.version = request.version;
    saved.title = request.title;
    if (request.kind === 'generated') saved.mimeType = request.sourceMimeType ?? request.mimeType;
    else delete saved.mimeType;
    saveArtifactWindowStates();
  }
  return [...poppedOutArtifacts.entries()].some(([window, artifact]) =>
    !window.isDestroyed() && artifact.resourceId === request.resourceId && artifact.version < request.version);
}

function parseArtifactPreviewBounds(raw: unknown): DesktopArtifactPreviewBounds | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'].map((key) => value[key]);
  if (!numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
  const [x, y, width, height] = numbers as number[];
  return { x: x!, y: y!, width: width!, height: height! };
}

function parseArtifactPreviewRequest(raw: unknown): DesktopArtifactPreviewRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const bounds = parseArtifactPreviewBounds(value.bounds);
  if (!bounds || typeof value.artifactId !== 'string' || typeof value.url !== 'string') return null;
  // A corner the renderer cannot state is no corner: this is presentation, and
  // refusing the whole presentation over it would cost the preview itself.
  const cornerRadius = typeof value.cornerRadius === 'number' && Number.isFinite(value.cornerRadius)
    ? Math.max(0, value.cornerRadius)
    : 0;
  return { artifactId: value.artifactId, url: value.url, bounds, cornerRadius };
}

function parseArtifactWindowRequest(raw: unknown): DesktopArtifactWindowRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const title = typeof value.title === 'string' ? value.title.slice(0, 120) : 'Artifact';
  const version = typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 0
    ? value.version
    : null;
  if (value.kind === 'site' && typeof value.resourceId === 'string' && version !== null
    && typeof value.artifactId === 'string' && typeof value.url === 'string') return {
    kind: 'site',
    ...(typeof value.canonicalUrl === 'string' && isArtifactUrl(value.canonicalUrl, artifactServingDomain()) ? { canonicalUrl: value.canonicalUrl } : {}),
    ...(value.mode === 'static' || value.mode === 'active' ? { mode: value.mode } : {}),
    ...(typeof value.stateful === 'boolean' ? { stateful: value.stateful } : {}),
    ...(typeof value.annotationScope === 'string' ? { annotationScope: value.annotationScope } : {}),
    editable: value.editable === true,
    ...(typeof value.restoreId === 'string' ? { restoreId: value.restoreId } : {}),
    resourceId: value.resourceId,
    version,
    artifactId: value.artifactId,
    url: value.url,
    // A window title comes from a resource title, which is model-authored:
    // bounded here so it cannot become a title bar the length of the screen.
    title,
  };
  if (value.kind !== 'generated' || typeof value.resourceId !== 'string' || version === null
    || typeof value.mimeType !== 'string' || !(value.content instanceof Uint8Array)) return null;
  return {
    kind: 'generated',
    ...(typeof value.annotationScope === 'string' ? { annotationScope: value.annotationScope } : {}),
    editable: value.editable === true,
    ...(typeof value.sourceMimeType === 'string' ? { sourceMimeType: value.sourceMimeType } : {}),
    ...(typeof value.restoreId === 'string' ? { restoreId: value.restoreId } : {}),
    resourceId: value.resourceId,
    version,
    content: value.content,
    mimeType: value.mimeType,
    title,
  };
}

function assertArtifactRenderer(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !poppedOutArtifacts.has(window) || !event.senderFrame || !rendererNavigationAllowed(event.senderFrame.url)) throw new Error('Blocked artifact renderer request');
}
function assertArtifactSurfaceSender(event: IpcMainInvokeEvent): void {
  if ([...poppedOutArtifacts.keys()].some((window) => window.webContents === event.sender)) assertArtifactRenderer(event);
  else assertTrustedIpcSender(event);
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const sender = event.sender;
  const belongsToRallyWindow = sender === mainWindow?.webContents
    || sender === settingsWindow?.webContents
    || sender === deepLinkErrorWindow?.webContents;
  if (!belongsToRallyWindow || !event.senderFrame || !rendererNavigationAllowed(event.senderFrame.url)) {
    throw new Error('Blocked IPC request from untrusted content');
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

/** `operation` names what was refused, in the words "Only the main Rally window can …". */
function assertMainWindowIpcSender(event: IpcMainInvokeEvent, operation: string): void {
  assertTrustedIpcSender(event);
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error(`Only the main Rally window can ${operation}`);
  }
}

function registerIpc(): void {
  const networkRecovery = new NetworkRecovery({
    closeConnections: () => electronSession.defaultSession.closeAllConnections(),
    publish: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(NETWORK_RECOVERY_IPC.changed, state);
        }
      }
    },
    record: (diagnostic) => nativePerformanceLog.writeNetworkRecovery(diagnostic),
  });
  registerNetworkRecoveryIpc({ ipc: ipcMain, assertSender: assertTrustedIpcSender, recovery: networkRecovery });
  registerRealtimeSocketIpc({
    apiBaseUrls: Object.values(runtimeConfig().api),
    assertSender: (event) => {
      assertTrustedIpcSender(event);
      if (event.sender !== mainWindow?.webContents) {
        throw new Error('Only the main Rally window can open realtime sockets');
      }
    },
    broker: realtimeSocketBroker,
    ipc: ipcMain,
  });
  ipcMain.handle('runtime:get-config', (event) => {
    assertTrustedIpcSender(event);
    return runtimeConfig();
  });
  registerWorkspaceSyncRelayIpc({
    assertTrustedSender: assertTrustedIpcSender,
    ipc: ipcMain,
    mainWindowContents: () => mainWindow?.webContents,
    relay: workspaceSyncRelay,
    consumerWindowContents: () => [settingsWindow?.webContents],
  });
  ipcMain.handle('embedded-browser:state', (event) => embeddedBrowserFor(embeddedBrowserHost(event)).state());
  ipcMain.handle('embedded-browser:command', async (event, raw: unknown) => {
    const host = embeddedBrowserHost(event);
    const command = parseBrowserIpc(EmbeddedBrowserCommandSchema, raw, 'embedded_browser_command') as EmbeddedBrowserCommand;
    return await embeddedBrowserFor(host).command(command);
  });
  ipcMain.handle('embedded-browser:bounds', (event, raw: unknown) => {
    embeddedBrowserFor(embeddedBrowserHost(event)).setBounds(parseBrowserIpc(EmbeddedBrowserBoundsSchema, raw, 'embedded_browser_bounds'));
  });
  ipcMain.handle('embedded-browser:visible', (event, raw: unknown) => {
    const host = embeddedBrowserHost(event);
    if (typeof raw !== 'boolean') throw new Error('Browser visibility must be a boolean');
    embeddedBrowserFor(host).setVisible(raw);
  });
  ipcMain.handle('application:foreground-get', (event) => {
    assertTrustedIpcSender(event);
    return applicationForegrounded ?? BrowserWindow.getFocusedWindow() !== null;
  });
  ipcMain.handle('application-settings:set-push-notifications', async (event, enabled: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid notification preference');
    await desktopPush.set(enabled);
    return desktopApplicationSettings();
  });
  ipcMain.handle('dock-badge:set', (event, count: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid dock badge count');
    dockBadgeCount = count;
    if (process.platform === 'darwin') app.setBadgeCount(count);
  });
  ipcMain.handle('application-settings:open-notifications', async (event) => {
    assertTrustedIpcSender(event);
    // `id` opens Rally's own entry rather than the list of apps.
    await shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${APNS_TOPICS.macos}`);
  });
  ipcMain.handle('update:get-status', (event) => {
    assertTrustedIpcSender(event);
    return updateStatus;
  });
  ipcMain.handle('update:install', (event) => {
    assertTrustedIpcSender(event);
    autoUpdateController?.installDownloadedUpdate();
  });
  ipcMain.handle('update:check', (event) => {
    assertTrustedIpcSender(event);
    autoUpdateController?.checkForUpdates();
  });
  ipcMain.handle('application-settings:get', async (event) => {
    assertTrustedIpcSender(event);
    return desktopApplicationSettings(await lockdownModeController.settings());
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
    syncMenuBarDirectory();
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
  ipcMain.handle('application-settings:set-release-channel', async (event, rawChannel: unknown) => {
    assertTrustedIpcSender(event);
    const channel = parseDesktopReleaseChannel(rawChannel);
    if (!channel) throw new Error('Invalid desktop release channel');
    await updateStoredApplicationSettings(userDataDirectory(), { releaseChannel: channel });
    desktopReleaseChannel = channel;
    autoUpdateController?.setReleaseChannel(channel);
    const settings = desktopApplicationSettings();
    broadcastApplicationSettingsChanged(settings);
    return settings;
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
    assertArtifactSurfaceSender(event);
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
    for (const window of [...rallyWindows(),...poppedOutArtifacts.keys()]) {
      if (window.webContents !== event.sender) window.webContents.send('theme:changed', parsed);
    }
    // The documents repaint themselves; the native backgrounds under them do not.
    repaintWindowBackgrounds([...rallyWindows(), ...poppedOutArtifacts.keys()], windowThemeChoice, nativeTheme.shouldUseDarkColors);
    await updateStoredApplicationSettings(userDataDirectory(), { themeChoice: parsed });
  });
  // Under System the Mac's own change moves the appearance with no choice made here.
  nativeTheme.on('updated', () => {
    repaintWindowBackgrounds([...rallyWindows(), ...poppedOutArtifacts.keys()], windowThemeChoice, nativeTheme.shouldUseDarkColors);
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
  ipcMain.handle('onboarding:get-account', async (event) => {
    assertTrustedIpcSender(event);
    const { response } = await onboardingIdentityRequest((credential) => electronFetch(
      `${configuredApiBase('global')}/onboarding/account`,
      { headers: { Authorization: `Bearer ${credential.accessToken}` } },
    ));
    if (!response.ok) throw await responseError(response);
    return AccountOnboardingSchema.parse(await response.json());
  });
  ipcMain.handle('onboarding:get-organization-suggestion', async (event) => {
    assertTrustedIpcSender(event);
    const { response } = await onboardingIdentityRequest((credential) => electronFetch(
      `${configuredApiBase('global')}/onboarding/organization-suggestion`,
      { headers: { Authorization: `Bearer ${credential.accessToken}` } },
    ));
    if (!response.ok) throw await responseError(response);
    return OrganizationNameSuggestionSchema.parse(await response.json());
  });
  ipcMain.handle('onboarding:update-account', async (event, raw: unknown) => {
    assertTrustedIpcSender(event);
    const input = UpdateAccountOnboardingSchema.parse(raw);
    const { response } = await onboardingIdentityRequest((credential) => electronFetch(
      `${configuredApiBase('global')}/onboarding/account`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    ));
    if (!response.ok) throw await responseError(response);
    return AccountOnboardingSchema.parse(await response.json());
  });
  ipcMain.handle('onboarding:get-state', (event) => {
    assertTrustedIpcSender(event);
    return getOnboardingState();
  });
  ipcMain.handle('workspace:get-attention', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return getWorkspaceAttention(input);
  });
  ipcMain.handle('workspace:leave', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return leaveWorkspace(input);
  });
  ipcMain.handle('workspace:surrender-active', (event) => {
    assertTrustedIpcSender(event);
    return surrenderActiveWorkspace();
  });
  ipcMain.handle('support:list-workspaces', (event) => {
    assertTrustedIpcSender(event);
    return listSupportWorkspaces();
  });
  ipcMain.handle('support:list-people', (event, workspaceId: unknown) => {
    assertTrustedIpcSender(event);
    return listSupportPeople(workspaceId);
  });
  ipcMain.handle('support:start', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return startSupportSession(input);
  });
  ipcMain.handle('support:end', (event) => {
    assertTrustedIpcSender(event);
    return endSupportSession();
  });
  ipcMain.handle('onboarding:activate-workspace', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return activateWorkspace(input);
  });
  ipcMain.handle('workspace:reselect-active', (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return reselectActiveWorkspace(input);
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
    assertArtifactSurfaceSender(event);
    if (typeof text !== 'string' || text.length === 0 || text.length > 4_000) {
      throw new Error('Invalid clipboard text');
    }
    clipboard.writeText(text);
  });
  ipcMain.handle('system:show-definition', (event) => {
    assertTrustedIpcSender(event);
    showDefinitionForSelection(process.platform, event.sender);
  });
  ipcMain.handle('system:share-text', (event, text: unknown) => {
    assertTrustedIpcSender(event);
    shareText(process.platform, text, {
      popupShare: (sharingItem, window) => {
        new ShareMenu(sharingItem).popup(window ? { window } : undefined);
      },
      window: BrowserWindow.fromWebContents(event.sender),
    });
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
    // The main renderer is mounted, so a relaunch onto a stored session — which
    // never broadcasts a session change — reaches prewarming here. Started now
    // rather than later because the main window spends its own first second
    // waiting on round trips: the settings renderer is a separate process, and
    // the work it is doing is parse and mount, not anything the window in front
    // of the person is contending with.
    void settingsWindowController.prewarm();
    return pendingDeepLinks.splice(0);
  });
  ipcMain.handle('canva:connect', async (event, rawOperationId: unknown) => {
    assertTrustedIpcSender(event);
    const operationId = rawOperationId === undefined ? undefined : IdSchema.parse(rawOperationId);
    const owner = await loadStoredAuth();
    if (!owner) throw new Error('Sign in to Rally before connecting Canva');
    return startCanvaConnection({
      request: async (path, body) => {
        const pinnedAuth = async () => {
          const current = await loadStoredAuth();
          if (!current || current.binding.userId !== owner.binding.userId || current.binding.workspaceId !== owner.binding.workspaceId
            || current.binding.region !== owner.binding.region) throw new Error('The Rally session changed');
          return current;
        };
        const send = async () => {
          const current = await pinnedAuth();
          return electronFetch(`${apiBaseForAuth(current)}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}`,
              ...(operationId ? { [RALLY_HEADERS.OPERATION_ID]: operationId } : {}) },
            body: JSON.stringify(body), signal: AbortSignal.timeout(MENU_BAR_REQUEST_TIMEOUT_MS),
          });
        };
        let response = await send();
        if (response.status === 401) {
          await response.body?.cancel();
          await pinnedAuth();
          await coalescedRefreshSession();
          response = await send();
        }
        if (!response.ok) throw await responseError(response);
        return readJsonBody(response);
      },
      openExternal: (url) => shell.openExternal(url),
      onClose: (close) => event.sender.once('destroyed', close),
    });
  });
  ipcMain.handle('system:open-external', async (event, rawUrl: unknown) => {
    assertArtifactSurfaceSender(event);
    if (typeof rawUrl !== 'string' || !isAllowedExternalUrl(rawUrl)) {
      throw new Error('Blocked external URL');
    }
    await shell.openExternal(rawUrl);
  });
  // The artifact surfaces. Every argument is parsed here rather than trusted:
  // the renderer supplies a URL and a rectangle, and neither is a capability it
  // is allowed to have — the URL decides what model-authored code gets loaded,
  // and the rectangle decides what it paints over.
  ipcMain.handle('artifact:present-preview', async (event, raw: unknown) => {
    assertArtifactSurfaceSender(event);
    const request = parseArtifactPreviewRequest(raw);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!request || !window) return false;
    return artifactPreviewFor(window).present(request);
  });
  ipcMain.handle('artifact:set-preview-bounds', async (event, raw: unknown) => {
    assertArtifactSurfaceSender(event);
    const bounds = parseArtifactPreviewBounds(raw);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!bounds || !window) return;
    artifactPreviews.get(window)?.setBounds(bounds);
  });
  ipcMain.handle('artifact:preview-ready', async (event) => {
    assertArtifactSurfaceSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    return window ? await artifactPreviews.get(window)?.ready() ?? false : false;
  });
  ipcMain.handle('artifact:pick-preview', async (event) => {
    assertArtifactSurfaceSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    return window ? await artifactPreviews.get(window)?.pick() ?? null : null;
  });
  ipcMain.handle('artifact:preview-comments', async (event, raw: unknown, rawSelected: unknown) => {
    assertArtifactSurfaceSender(event);
    const pins=AnnotationCommentPinsSchema.parse(raw);
    const selected=AnnotationSelectionSchema.nullable().optional().parse(rawSelected) ?? null;
    const window=BrowserWindow.fromWebContents(event.sender);
    return window ? await artifactPreviews.get(window)?.comments(pins, selected) ?? null : null;
  });
  ipcMain.handle('artifact:stop-picking-preview', async (event) => {
    assertArtifactSurfaceSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) await artifactPreviews.get(window)?.stopPicking();
  });
  ipcMain.handle('artifact:snapshot-preview', async (event) => {
    assertArtifactSurfaceSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return null;
    return await artifactPreviews.get(window)?.snapshot() ?? null;
  });
  ipcMain.handle('artifact:set-preview-hidden', async (event, raw: unknown) => {
    assertArtifactSurfaceSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (typeof raw !== 'boolean' || !window) return;
    artifactPreviews.get(window)?.setOverlayOpen(raw);
  });
  ipcMain.handle('artifact:close-preview', async (event) => {
    assertArtifactSurfaceSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    // The controller stays registered. It is reusable once destroyed, and
    // dropping it here would make the next presentation build a second one —
    // and with it a second `closed` listener on the same window, until Node
    // starts warning about the leak.
    artifactPreviews.get(window)?.destroy();
  });
  ipcMain.handle('artifact:window-action', async (event, raw: unknown) => {
    try {
      assertArtifactRenderer(event);
      const window = BrowserWindow.fromWebContents(event.sender)!;
      const record = poppedOutArtifacts.get(window)!;
      const command = artifactWindowActionRequest(record.request, raw);
      const session = inMemorySession;
      if ('canvasId' in command) {
        const workspace = session?.workspace;
        if (!workspace) throw new Error('Sign in before copying a link');
        return canvasCanonicalUrl(runtimeConfig().webBaseUrl, {
          region: workspace.region, workspaceId: workspace.id, canvasId: command.canvasId, artifactId: record.resourceId,
        });
      }
      const assertSession = (): void => {
        assertArtifactRenderer(event);
        if (!session || !artifactWindowSessionMatches(record, { userId: inMemorySession?.user.id ?? null, workspaceId: inMemorySession?.workspace?.id ?? null, region: inMemorySession?.workspace?.region ?? null })) throw new Error('The Rally session changed');
      };
      const send = async () => {
        const auth = await loadStoredAuth();
        assertSession();
        if (!auth || !artifactWindowSessionMatches(record, auth.binding)) throw new Error('The Rally session changed');
        return electronFetch(`${apiBaseForAuth(auth)}${command.path}`, {
          method: command.method,
          headers: { Authorization: `Bearer ${auth.accessToken}`, [RALLY_HEADERS.CLIENT_CONTRACT]: String(CLIENT_CONTRACT_VERSION),
            ...(command.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
        });
      };
      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel();
        assertSession();
        await coalescedRefreshSession();
        response = await send();
      }
      if (!response.ok) throw await responseError(response);
      if (command.binary) {
        const content = new Uint8Array(await response.arrayBuffer());
        assertSession();
        return { content, mimeType: response.headers.get('content-type') ?? 'application/octet-stream' };
      }
      const result = response.status === 204 ? null : await readJsonBody(response);
      assertSession();
      const action = command.action;
      if (action.type === 'rename') {
        window.setTitle(action.title);
        const current = poppedOutArtifacts.get(window)!;
        current.request = { ...current.request, title: action.title };
        const saved = artifactWindowStates().find((item) => item.id === record.stateId);
        if (saved) saved.title = action.title;
        saveArtifactWindowStates();
      }
      if (action.type === 'pin-state') return ArtifactPinListSchema.parse(result).some((pin) => pin.id === record.resourceId);
      return result;
    } catch (error) {
      const diagnostic = zodDiagnosticCode(error, 'artifact_window_response');
      if (diagnostic) throw new Error(diagnostic, { cause: error });
      throw error;
    }
  });
  ipcMain.handle('artifact:read-window', (event) => {
    assertArtifactRenderer(event);
    const window = BrowserWindow.fromWebContents(event.sender)!;
    const record = poppedOutArtifacts.get(window);
    if (!record) return null;
    const scope = record.request.annotationScope;
    const annotationDraftKey = scope ? annotationDraftKeyForScope(record.region, record.workspaceId, scope) : undefined;
    return { ...record.request, ...(annotationDraftKey ? { annotationDraftKey } : {}) };
  });
  ipcMain.handle('artifact:register-composer', (event, scope: unknown, active: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof scope !== 'string' || typeof active !== 'boolean') return;
    const scopes = annotationComposerScopes.get(event.sender) ?? new Set<string>();
    if (active) scopes.add(scope); else { scopes.delete(scope); for(const [id,transfer] of annotationTransfers) {if(transfer.owner===event.sender&&transfer.scope===scope){transfer.resolve(false);annotationTransfers.delete(id);}} }
    annotationComposerScopes.set(event.sender, scopes);
  });
  ipcMain.handle('artifact:complete-transfer', (event, transferId:unknown, accepted:unknown) => {
    assertTrustedIpcSender(event);
    if(typeof transferId!=='string'||typeof accepted!=='boolean')return;
    const transfer=annotationTransfers.get(transferId);
    if(!transfer||transfer.owner!==event.sender)return;
    annotationTransfers.delete(transferId);transfer.resolve(accepted);
  });
  ipcMain.handle('artifact:return-annotations', (event, raw: unknown) => {
    assertArtifactRenderer(event);
    const window = BrowserWindow.fromWebContents(event.sender)!;
    const source = poppedOutArtifacts.get(window);
    if (!source?.owner || source.owner.isDestroyed() || !source.request.annotationScope || !annotationComposerScopes.get(source.owner)?.has(source.request.annotationScope)) return false;
    const pins = z.array(z.strictObject({ id: z.string().uuid().optional(), generation: z.string().uuid().optional(), annotation: AnnotationSchema, image: z.instanceof(Uint8Array).optional() })).parse(raw);
    // A newer preview can arrive while older pins are still in this draft.
    // Keep resource confinement; admission validates each pin's saved version.
    if (pins.some((pin) => pin.annotation.target.resourceId !== source.resourceId)) return false;
    const transferId=crypto.randomUUID();
    const owner=source.owner;
    const scope=source.request.annotationScope;
    return new Promise<boolean>((resolve)=>{
      const gone=():void=>{annotationTransfers.delete(transferId);settle(false);};
      const settle=(accepted:boolean):void=>{
        owner.removeListener('destroyed',gone);owner.removeListener('render-process-gone',gone);
        resolve(accepted);
      };
      owner.once('destroyed',gone);owner.once('render-process-gone',gone);
      annotationTransfers.set(transferId,{owner,scope,window,resolve:settle});
      owner.send('artifact:annotations', {transferId, scope, name: source.request.title, pins });
    });
  });
  ipcMain.handle('artifact:pop-out', async (event, raw: unknown) => {
    assertTrustedIpcSender(event);
    const request = parseArtifactWindowRequest(raw);
    if (!request || (request.kind === 'site' && !isArtifactUrl(request.url, artifactServingDomain()))) return false;
    return openArtifactWindow(request, event.sender);
  });
  ipcMain.handle('artifact:restorable-windows', async (event) => {
    assertTrustedIpcSender(event);
    const workspaceId = inMemorySession?.workspace?.id;
    const userId = inMemorySession?.user.id;
    if (!workspaceId || !userId) return [];
    const open = new Set([...poppedOutArtifacts.values()].map((item) => item.stateId));
    return artifactWindowStates().filter((item) => artifactWindowSessionMatches(item, { workspaceId, userId, region: inMemorySession?.workspace?.region ?? null }) && !open.has(item.id)).map(({ id, kind, resourceId, version, title, mimeType, annotationScope, editable }) =>
      ({ id, kind, resourceId, version, title, editable: editable === true, ...(mimeType ? { mimeType } : {}), ...(annotationScope?{annotationScope}: {}) }));
  });
  ipcMain.handle('artifact:forget-window', async (event, raw: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof raw !== 'string') return;
    const workspaceId = inMemorySession?.workspace?.id;
    const userId = inMemorySession?.user.id;
    if (!workspaceId || !userId) return;
    savedArtifactWindows = artifactWindowStates().filter((item) =>
      item.id !== raw || !artifactWindowSessionMatches(item, { workspaceId, userId, region: inMemorySession?.workspace?.region ?? null }));
    saveArtifactWindowStates();
  });
  ipcMain.handle('artifact:popped-out-versions', async (event) => {
    assertTrustedIpcSender(event);
    return poppedOutArtifactVersions();
  });
  ipcMain.handle('artifact:update-pop-out', async (event, raw: unknown) => {
    assertTrustedIpcSender(event);
    const request = parseArtifactWindowRequest(raw);
    if (!request || (request.kind === 'site' && !isArtifactUrl(request.url, artifactServingDomain()))) return false;
    return await updatePoppedOutArtifact(request);
  });
  ipcMain.handle('system:open-sidekick', (event, rawSidekickId: unknown) => {
    assertTrustedIpcSender(event);
    const sidekickId = parseRouteId(rawSidekickId);
    const workspace = inMemorySession?.workspace;
    if (!sidekickId) throw new Error('Invalid Sidekick id');
    if (!workspace) throw new Error('Sign in before opening a Sidekick');
    // A Sidekick opens in the main window, as a route; this is how a window
    // with no router of its own, such as Settings, asks for one.
    emitDeepLink(sidekickDeepLink({ region: workspace.region, workspaceId: workspace.id, sidekickId }), 'in_app_link');
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
    return deepLinkErrorNotice;
  });
  ipcMain.handle('deep-link-error:dismiss', (event, rawNoticeId: unknown) => {
    assertDeepLinkErrorIpcSender(event);
    if (typeof rawNoticeId !== 'number' || !Number.isSafeInteger(rawNoticeId)) {
      throw new Error('Invalid deep-link failure notice id');
    }
    // Acknowledging is scoped to what was read. A failure reported between the
    // person reading this one and their click arriving has already replaced the
    // text — duplicate reports of one connector completion are the normal case
    // here — and closing on a stale acknowledgement would take that newer notice
    // with it, resolving the report that carried it and leaving nothing on
    // screen. Ignoring the stale click leaves the window up on the newer text,
    // which is the one thing nobody has acknowledged yet.
    if (deepLinkErrorNotice?.id !== rawNoticeId) return;
    deepLinkErrorWindow?.close();
  });
  ipcMain.handle('transcription-audio:start-system-capture', (event) => {
    assertMainWindowIpcSender(event, 'capture system audio');
    return nativeSystemAudioController.start(event.sender);
  });
  ipcMain.handle('transcription-audio:stop-system-capture', (event) => {
    assertMainWindowIpcSender(event, 'capture system audio');
    return nativeSystemAudioController.stop(event.sender);
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
    // Browser pages own their web navigation; sending it through the app-window
    // fence opens sign-in redirects in the system browser instead.
    if (isEmbeddedBrowserWebContents(contents)) return;
    // Artifact surfaces are never decided here. What a model-authored page may
    // do with a URL turns on transient user activation, which this broad fence
    // knows nothing about, and on the artifact's own origin, which it does not
    // hold: `confineToArtifactOrigin` owns both. The global listener must
    // return before preventing anything on those contents.
    applyGlobalNavigationPolicy({
      event,
      url,
      artifactSurface: artifactWebContents.has(contents),
      rendererAllowed: rendererNavigationAllowed,
      externalAllowed: isAllowedExternalUrl,
      openExternal: (target) => { void shell.openExternal(target); },
    });
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
      return electronFetch(pathToFileURL(assetPath).toString());
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
  fetch: (url) => electronFetch(url),
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
  // The drop-down opens from what the main process already holds (the
  // socket's Canvases and Sidekicks lists), so a click costs no request:
  // freshness arrives as socket pushes.
  const openObserver = new MenuBarOpenObserver(() => {
    const content = menuBarContent(sidebarListsWatch.snapshot());
    void telemetryReporter?.menuBarOpened({
      signedIn: Boolean(inMemoryAuthSet),
      recentCount: Math.min(content.recents.length, MENU_BAR_SECTION_LIMIT),
      pinnedCount: 0,
      attentionCount: content.attention.length,
    });
  });
  tray.on('click', () => {
    // Both this and `menu-will-show` observe the open. Which of the two macOS
    // raises for a status item's own menu is not something this repository can
    // check — there is no menu bar in the sandbox — and reporting nothing is
    // the failure being avoided. The observer coalesces the pair into one event.
    openObserver.opened();
  });
  return {
    setContextMenu: (template) => {
      const menu = Menu.buildFromTemplate(template);
      menu.on('menu-will-show', () => openObserver.opened());
      menu.on('menu-will-close', () => openObserver.closed());
      tray.setContextMenu(menu);
    },
    setTitle: (title) => tray.setTitle(title),
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
  surface: 'main' | 'settings' | 'deep-link-error',
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
  surface: 'main' | 'settings' | 'deep-link-error',
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
  surface?: 'settings' | 'deep-link-error' | 'artifact-preview',
  settingsSection?: DesktopSettingsSection,
): string {
  const target = rendererDevelopmentUrl
    ? new URL(rendererDevelopmentUrl)
    : new URL(`${rendererProtocol}://${rendererHost}/index.html`);
  if (surface) target.searchParams.set('surface', surface);
  if (settingsSection) target.searchParams.set('settingsSection', settingsSection);
  if (surface === 'settings') target.hash = '/settings';
  if (surface === 'deep-link-error') target.hash = '/deep-link-error';

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
  deepLinkErrorNotice = { id: deepLinkErrorNoticesShown += 1, message };
  if (deepLinkErrorWindow && !deepLinkErrorWindow.isDestroyed()) {
    deepLinkErrorWindow.webContents.send('deep-link-error:changed', deepLinkErrorNotice);
    // Not while the first load is still in flight, which is the *common* case
    // here rather than a rare one: a connector completion is reported by both
    // renderers microseconds apart, so the second report routinely arrives
    // while the window created by the first is still loading. `show: false`
    // plus `ready-to-show` below exists to keep an unpainted window off the
    // screen, and showing one here would step around it — an empty always-on-top
    // 420x260 rectangle over everything until the renderer paints. The message
    // is not lost by waiting: it is in `deepLinkErrorNotice` above, and the
    // mounting renderer reads that.
    if (!deepLinkErrorWindow.webContents.isLoadingMainFrame()) {
      if (deepLinkErrorWindow.isMinimized()) deepLinkErrorWindow.restore();
      deepLinkErrorWindow.show();
      deepLinkErrorWindow.focus();
    }
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
  // Closing the window *is* the acknowledgement, whether that was the button or
  // the title bar. Leaving the message behind would hand it to the next
  // failure's window as though it had just happened.
  //
  // Bound to `close` as well as `closed`, and that is the important half: a
  // window between the two is still non-destroyed, so a report landing in that
  // gap would take the re-show branch above, hand its message to a renderer that
  // is going away, and *resolve* — and then `closed` would null the message it
  // had just accepted. Releasing on `close` means such a report finds no window
  // and builds a fresh one. `destroy()` skips `close` entirely, which is why
  // both are bound; whichever runs first does the work.
  //
  // Only ever for the window that is still *the* window: a disposed one's event
  // arrives after the singleton has moved on, and clearing then would take the
  // live window's message with it.
  const releaseFailureWindow = (): void => {
    if (deepLinkErrorWindow !== failureWindow) return;
    deepLinkErrorWindow = null;
    deepLinkErrorNotice = null;
  };
  failureWindow.on('close', releaseFailureWindow);
  failureWindow.on('closed', releaseFailureWindow);
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
      deepLinkErrorNotice = null;
    }
    if (!failureWindow.isDestroyed()) failureWindow.destroy();
    throw error;
  }
}

const settingsWindowController = new SettingsWindowController({
  createWindow: (section, callbacks) => {
    const window = new BrowserWindow({
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
    settingsWindow = window;

    installEditableTextMenu(window);

    installWindowDiagnostics(window, 'settings');
    window.setMenuBarVisibility(false);
    // Both wired before the load starts, because both can fire during it:
    // `ready-to-show` regularly beats `loadURL`'s promise, and a window can be
    // closed before it finishes loading. A listener attached after the load is
    // a listener attached after the event.
    window.once('ready-to-show', () => callbacks.onReadyToShow());
    const handleClosed = (): void => {
      if (settingsWindow === window) settingsWindow = null;
      callbacks.onClosed();
    };
    window.on('closed', handleClosed);
    const release = (): void => {
      // Detached first: `destroy()` still emits `closed`, and the controller
      // already knows this window is finished — letting the callback run would
      // have it treat a disposal as somebody closing Settings, and rebuild.
      window.off('closed', handleClosed);
      if (settingsWindow === window) settingsWindow = null;
      if (!window.isDestroyed()) window.destroy();
    };
    return {
      isDestroyed: () => window.isDestroyed(),
      isMinimized: () => window.isMinimized(),
      restore: () => window.restore(),
      show: () => window.show(),
      focus: () => window.focus(),
      deliverSection: (next) => requestSettingsSection(window, next),
      announceRevealed: () => window.webContents.send('settings:revealed'),
      load: () => loadRenderer(window, rendererUrl('settings', section ?? undefined), 'settings'),
      destroy: release,
    };
  },
  // A window is worth having in advance only for somebody who could open it: a
  // signed-out or workspace-less renderer would boot to sign-in, and a sign-out
  // closes this window rather than replacing it. The main window is part of
  // that test rather than an afterthought — with none open there is nobody to
  // open Settings from, and a speculative window would be the only thing left
  // holding a process that should have exited.
  mayPrewarm: () => Boolean(inMemorySession?.workspace) && !loggingOut && Boolean(mainWindow),
  reportError: (error) => logError('rally', 'failed to prepare the settings window', error),
});

async function createSettingsWindow(section?: DesktopSettingsSection): Promise<void> {
  await settingsWindowController.open(section);
}

/**
 * The settings window a person can actually see.
 *
 * `settingsWindow` is now non-null for most of a signed-in session, because one
 * is built hidden ahead of being asked for. Anything that means "settings is
 * where this belongs" — raising it, handing it a callback — has to ask this
 * instead, or a prewarmed window silently becomes the destination for results
 * the person is waiting on in the window they are actually looking at.
 */
function revealedSettingsWindow(): BrowserWindow | null {
  if (!settingsWindow || settingsWindow.isDestroyed()) return null;
  return settingsWindowController.isRevealRequested() ? settingsWindow : null;
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
      // Only the main window has the account menu that lists Organizations.
      refreshOrganizationList: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('organizations:refresh-requested');
      },
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(): Promise<void> {
  // Electron's ready event precedes our async startup. Native notification and
  // URL callbacks can arrive before the renderer protocol and IPC exist.
  await mainWindowStartup;
  if (mainWindowLoading) return mainWindowLoading;
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealWindow(mainWindow);
    return;
  }
  rendererReady = false;
  mainWindowReadyToShow = false;
  const minimum = { width: 860, height: 640 };
  const primaryDisplay = electronScreen.getPrimaryDisplay();
  let savedWindowState = null;
  try {
    savedWindowState = readMainWindowState(
      userDataDirectory(),
      [primaryDisplay, ...electronScreen.getAllDisplays().filter((display) => display.id !== primaryDisplay.id)],
      minimum,
    );
  } catch (error) {
    logWarn('rally', 'could not read main window position', error);
  }
  mainWindow = new BrowserWindow({
    width: savedWindowState?.bounds.width ?? 1180,
    height: savedWindowState?.bounds.height ?? 940,
    ...(savedWindowState ? { x: savedWindowState.bounds.x, y: savedWindowState.bounds.y } : {}),
    minWidth: minimum.width,
    minHeight: minimum.height,
    show: false,
    backgroundColor: windowBackgroundColor(),
    title: 'Rally',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Centered over the 76px section switcher: macOS 26 draws a 60pt group
    // (14pt buttons on a 23pt pitch), earlier versions 52pt (12pt on 20pt).
    trafficLightPosition: { x: macosMajorVersion(process.getSystemVersion()) >= 26 ? 8 : 12, y: 17 },
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

  installEditableTextMenu(mainWindow);

  installWindowDiagnostics(mainWindow, 'main');
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    realtimeSocketBroker.closeOwner(mainWindowWebContentsId);
    workspaceSyncRelay.release();
    rendererReady = false;
    void rendererCrashRecovery.offer(details.reason);
  });
  mainWindow.once('ready-to-show', () => {
    mainWindowReadyToShow = true;
    if (savedWindowState?.maximized) mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on('close', () => {
    if (!mainWindowReadyToShow || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      writeMainWindowState(userDataDirectory(), {
        bounds: mainWindow.getNormalBounds(),
        maximized: mainWindow.isMaximized(),
      });
    } catch (error) {
      logWarn('rally', 'could not save main window position', error);
    }
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    // Hash-router transitions are same-document navigations. Treating them as
    // a renderer restart strands later OAuth/invitation callbacks in the main
    // process queue because React never remounts to consume that queue.
    if (isMainFrame && !isInPlace) {
      realtimeSocketBroker.closeOwner(mainWindowWebContentsId);
      workspaceSyncRelay.release();
      rendererReady = false;
    }
  });
  mainWindow.on('closed', () => {
    realtimeSocketBroker.closeOwner(mainWindowWebContentsId);
    // The Settings window may outlive this one, and dials
    // its own socket the moment it hears there is nothing left to relay.
    workspaceSyncRelay.release();
    rendererReady = false;
    mainWindow = null;
    // A hidden window is still a window, and `window-all-closed` — the only
    // path that quits Rally off macOS — waits for every one of them. Left in
    // place, a settings window nobody opened would keep the process alive with
    // nothing on screen, holding the single-instance lock; the `second-instance`
    // handler above needs a `mainWindow` to raise, so a relaunch would do
    // nothing either and Rally could be neither seen nor quit. A window that was
    // actually opened stays: `releasePrewarmed` gives up only the speculative
    // one, and `mayPrewarm` declines to build another while there is no main
    // window to build it for.
    settingsWindowController.releasePrewarmed();
  });

  mainWindowLoading = loadRenderer(mainWindow, rendererUrl(), 'main');
  try {
    await mainWindowLoading;
  } finally {
    mainWindowLoading = null;
  }
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
          `default-src 'self'; script-src ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data: ${fontScheme}:; connect-src ${connectSources}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`,
        ],
      },
    });
  });

  electronSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trustedRenderer = rendererNavigationAllowed(details.requestingUrl);
    callback(allowsTrustedAudioCapture({
      mainWindowContents: mainWindow?.webContents,
      mediaTypes: 'mediaTypes' in details ? details.mediaTypes ?? [] : [],
      permission,
      requestingContents: webContents,
      trustedRenderer,
    }));
  });
  electronSession.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const trustedRenderer = rendererNavigationAllowed(requestingOrigin);
    return allowsTrustedAudioCapture({
      mainWindowContents: mainWindow?.webContents,
      mediaTypes: details.mediaType ? [details.mediaType] : [],
      permission,
      requestingContents: webContents,
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
      revealWindow(mainWindow);
    }
  });

  app.on('continue-activity', (event, type, _userInfo, details) => {
    if (type !== 'NSUserActivityTypeBrowsingWeb' || !details.webpageURL) return;
    const link = httpsLinkDeepLink(details.webpageURL);
    if (!link) return;
    event.preventDefault();
    observeAcceptedDeepLinkOpen();
    sendDeepLink(link, 'deep_link');
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (emitDeepLink(url)) observeAcceptedDeepLinkOpen();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('ai.rallywith.desktop');
    // `powerMonitor` may not be used before `ready`.
    powerMonitor.on('suspend', () => observePowerState('suspended'));
    powerMonitor.on('resume', () => observePowerState('resumed'));
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
      // The updater also needs its local channel before its first request.
      const applicationSettings = await readStoredApplicationSettings(userDataDirectory());
      windowThemeChoice = applicationSettings.themeChoice;
      desktopReleaseChannel = applicationSettings.releaseChannel;
    } catch (error) {
      logWarn('rally', 'could not read the stored window theme', error);
    }
    // Complete the one-time full-session to split-state migration before any
    // renderer window can issue concurrent session requests.
    const launchAuth = await loadStoredAuth();
    await desktopPush.initialize();
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
    protocol.handle(fontScheme, (request) => themeFontCache.respond(request.url));
    installContentSecurityPolicy();
    registerIpc();
    resolveMainWindowStartup();
    autoUpdateController = initializeAutoUpdate({
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      currentVersion: app.getVersion(),
      // Stamped by electron.vite.config.ts; absent where no build ran (unit tests).
      currentBuildTime: typeof __RALLY_BUILD_TIME__ === 'string' ? Date.parse(__RALLY_BUILD_TIME__) : undefined,
      releaseChannel: desktopReleaseChannel,
      showMessageBox: (options) => dialog.showMessageBox(options),
      openExternal: (url) => shell.openExternal(url),
      beforeInstall: prepareForUpdateInstall,
      onInstallFailed: rollBackFailedUpdateInstall,
      onStatusChange: (status) => {
        updateStatus = status;
        installApplicationMenu();
        for (const window of rallyWindows()) window.webContents.send('update:status-changed', status);
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
      hasPushNotification: prelaunchPushObserved,
    });
    applicationOpenObserver.launched(launchEntrypoint);
    applicationLaunchObserved = true;
    try {
      await menuBarController.initialize();
    } catch (error) {
      logWarn('rally', 'could not add Rally to the menu bar', error);
    }
    if (launchAuth) syncMenuBarDirectory();
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

    app.on('browser-window-focus', () => {
      desktopPush.refreshPermission();
      if (process.platform === 'darwin' && dockBadgeCount !== null) app.setBadgeCount(dockBadgeCount);
    });

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

function reportMainProcessFatal(error: Error, origin: MainProcessFatalOrigin): void {
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
}

installMainProcessNetworkRecovery(process, {
  recovered: (error, code) => {
    // Preserve the payload-free fleet signal this rejection emitted before
    // it became recoverable; a packaged app's local warning is not observable.
    void telemetryReporter?.processHealth('main', 'rejection', 'unknown').catch(() => undefined);
    logWarn('rally', 'recovered a transient main-process network interruption', { code, error });
  },
  reportFatal: reportMainProcessFatal,
  // Throw only after Node has delivered every rejection already pending in
  // this microtask batch. The fatal monitor consumes the marker above so the
  // scheduled throw is not double-counted as an ordinary exception.
  deferFatal: (fatal) => { setImmediate(fatal); },
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

app.on('before-quit', (event) => {
  applicationIsQuitting = true;
  if (savedArtifactWindows !== null) saveArtifactWindowStates();
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
