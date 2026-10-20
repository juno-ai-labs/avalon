import type { ArtifactWindowAction } from './artifact-window-actions';
import type { AnnotationCommentPins, AnnotationCommentAction, Annotation, ArtifactPickerPin } from "@rally/contracts";
import type { ClientSession } from "@rally/contracts/client-session";
import type { NetworkRecoveryState, NetworkTicketObservation } from './network-recovery';
import type {
  TelemetryEventProperties,
  WorkspaceAttention,
  WorkspaceDeparture,
  WorkspaceDepartureOutcome,
  AccountOnboarding,
  OrganizationNameSuggestion,
  UpdateAccountOnboarding,
  SupportPerson,
  SupportWorkspace,
} from '@rally/contracts';
import type { Region } from "@rally/contracts/regions";
import type { ApplicationIconId, DesktopApplicationIconState } from './application-icons';
import type { MessageExportRequest, MessageExportResult } from './message-export';
import type { DesktopReleaseChannel } from './release-channels';
import type {
  DesktopRealtimeSocketCloseInput,
  DesktopRealtimeSocketEvent,
  DesktopRealtimeSocketOpenInput,
  DesktopRealtimeSocketSendInput,
} from './realtime-socket';
import type { DesktopSettingsSection } from './settings';
import type { ThemeChoice } from './themes';
import type {
  EmbeddedBrowserBounds,
  EmbeddedBrowserCommand,
  EmbeddedBrowserHostRequest,
  EmbeddedBrowserResult,
  EmbeddedBrowserState,
} from './embedded-browser';
import type { BrowserImportContext, BrowserImportProgress } from './browser-import';
import type {
  WorkspaceSyncPublication,
  WorkspaceConversationViewRelayRequest,
  WorkspaceSyncRelayEvent,
  WorkspaceSyncSourceSnapshot,
} from './workspace-sync-relay';

export type RallyRegion = Region;

/** Stable UI/cache identity for a workspace. Workspace UUIDs are only unique
 * within a region, so desktop state must never key one without its region. */
export function desktopWorkspaceIdentityKey(region: RallyRegion, workspaceId: string): string {
  return `${region}:${workspaceId}`;
}

export type DesktopDeepLinkEntrypoint = 'deep_link' | 'menu_bar' | 'notification' | 'in_app_link';

export interface DesktopDeepLinkNavigation {
  url: string;
  entrypoint: DesktopDeepLinkEntrypoint;
}

export interface RuntimeConfig {
  /** Opaque first-install signup flow; absent after an account was observed. */
  firstSignupFlowId?: string;
  appVersion: string;
  isPackaged: boolean;
  platform: string;
  api: Record<RallyRegion, string>;
  /** Public site origin. Canonical work-stream links are minted against it. */
  webBaseUrl: string;
  devAuthEnabled: boolean;
}

export interface DesktopSession extends ClientSession {
  accessToken: string;
}

export interface DesktopAuthAttempt {
  attemptId: string;
  codeChallenge: string;
}

export interface DesktopLockdownSettings {
  lockdownMode: boolean;
  lockdownAvailable: boolean;
}

export interface DesktopApplicationSettings extends DesktopLockdownSettings {
  /** Per-device update feed choice. Stable is the default. */
  releaseChannel: DesktopReleaseChannel;
  /** False for browser fallback surfaces that cannot configure Electron. */
  releaseChannelAvailable: boolean;
  /** The **effective** Developer → Debug enabled preference: the stored choice
   * and the service's flag. A device whose flag is off reads `false` here
   * however `application-settings.json` reads. */
  debugEnabled: boolean;
  /** Whether the service allows this account the Developer section at all.
   * Off until a poll says otherwise, and off again on sign-out. */
  developerSettingsAvailable: boolean;
  /** Whether the Rally status item is in the macOS menu bar. On by default. */
  pushNotificationsEnabled: boolean;
  pushNotificationStatus: string;
  /** macOS's "Badge application icon" switch for Rally; `unknown` until read. */
  notificationBadgeStatus: 'enabled' | 'disabled' | 'unknown';
  menuBarEnabled: boolean;
  /** Whether this platform has a menu bar Rally can live in at all. The
   * preference is still stored where it is not, so moving the same profile to a
   * Mac restores the choice rather than the default. */
  menuBarAvailable: boolean;
  /** Whether a status item is actually in the menu bar. Creating one can fail,
   * and the preference says nothing about that — so this is what lets Settings
   * tell someone their choice did not take rather than showing a switch that is
   * on beside a menu bar that is empty. */
  menuBarPresent: boolean;
  /** Whether Rally is registered to open at login. Read back from the
   * operating system, which owns it — not from Rally's preference file — so
   * this reports what macOS actually holds, including a registration it is
   * still waiting for the person to approve. */
  launchAtLogin: boolean;
  /** Whether this platform has login items at all. */
  launchAtLoginAvailable: boolean;
  /** The account choice shown in Settings. */
  productAnalyticsEnabled: boolean;
  /** False on the browser fallback, which can display but cannot persist the
   * account preference. Older desktop bridges omit it and remain writable. */
  productAnalyticsAvailable?: boolean;
  /** Collection is off while an enable is awaiting server acknowledgement. */
  productAnalyticsEffective: boolean;
  /** A durable offline account mutation waiting to synchronize. */
  productAnalyticsPreferencePending: boolean;
  /** Stopping the already-running Crashpad handler requires the next launch. */
  nativeCrashRestartRequired: boolean;
}

export type DesktopTelemetryScreen =
  | 'onboarding_welcome'
  | 'onboarding_region'
  | 'onboarding_workspace'
  | 'workspace_home'
  | 'workstream'
  | 'application_settings'
  | 'developer_settings';

export type DesktopTelemetrySemanticEventName =
  | 'surface_viewed'
  | 'automation_builder_started'
  | 'automation_opened'
  | 'workstream_resource_action_completed'
  | 'realtime_socket_state'
  | 'desktop_action_phase'
  | 'workspace_socket_handshake';

export type DesktopTelemetrySemanticIntent = {
  [Name in DesktopTelemetrySemanticEventName]: { kind: Name } & TelemetryEventProperties<Name>;
}[DesktopTelemetrySemanticEventName];

export type DesktopTelemetryConnectorSetupIntent = {
  kind: 'connector_setup_requested_v2';
  operationId?: string;
} & TelemetryEventProperties<'connector_setup_requested_v2'>;

export type DesktopTelemetryWorkstreamFeedVisibleIntent = {
  kind: 'workstream_feed_visible';
  operationId: string;
} & TelemetryEventProperties<'workstream_feed_visible'>;

export type DesktopTelemetryWorkstreamSendReadyIntent = {
  kind: 'workstream_send_ready';
  operationId: string;
} & TelemetryEventProperties<'workstream_send_ready'>;

export type DesktopTelemetryWorkstreamSocketStartedIntent = {
  kind: 'workstream_socket_started';
  operationId: string;
} & TelemetryEventProperties<'workstream_socket_started'>;

export type DesktopTelemetryRendererPerfFlowIntent = {
  kind: 'renderer_perf_flow';
  operationId: string;
} & TelemetryEventProperties<'renderer_perf_flow'>;

export type DesktopTelemetryWorkstreamOpenLifecycleIntent = {
  [Name in 'workstream_open_started' | 'workstream_open_outcome']:
  { kind: Name; operationId: string } & TelemetryEventProperties<Name>;
}['workstream_open_started' | 'workstream_open_outcome'];

export type DesktopTelemetryProductIntent =
  | { kind: 'onboarding_region_selected'; selectedRegion: RallyRegion; entrypoint: 'first_run' | 'settings' | 'invitation' }
  | { kind: 'workspace_create_requested'; selectedRegion: RallyRegion; entrypoint: 'first_run' | 'settings'; operationId: string }
  | { kind: 'workspace_activation_requested'; selectedRegion: RallyRegion; entrypoint: 'invitation' | 'workspace_switcher'; operationId: string }
  | { kind: 'workstream_create_requested'; entrypoint: 'composer'; operationId: string }
  | { kind: 'run_requested'; entrypoint: 'composer'; operationId: string }
  | DesktopTelemetryConnectorSetupIntent
  | DesktopTelemetryWorkstreamFeedVisibleIntent
  | DesktopTelemetryWorkstreamSendReadyIntent
  | DesktopTelemetryWorkstreamSocketStartedIntent
  | DesktopTelemetryRendererPerfFlowIntent
  | DesktopTelemetryWorkstreamOpenLifecycleIntent
  | { kind: 'command_shortcuts_revealed'; availableCount: number }
  | {
    kind: 'command_shortcut_used';
    shortcutNumber: number;
    destinationType: 'pinned_workstream' | 'recent_workstream' | 'recent_note';
  }
  | {
    kind: 'workstream_opened';
    workstreamId: string;
    visibility: 'private' | 'public';
    navigation: 'opened' | 'switched' | 'reopened';
    origin: 'ad_hoc' | 'automation' | 'system';
    pinned: boolean;
  }
  | {
    kind: 'workstream_action_completed';
    workstreamId: string;
    action: 'pin' | 'unpin' | 'make_public' | 'make_private' | 'mark_unread' | 'rename' | 'archive';
    visibility: 'private' | 'public';
    origin: 'ad_hoc' | 'automation' | 'system';
    pinned: boolean;
  }
  | {
    kind: 'automation_created';
    automationId: string;
    visibility: 'private' | 'public';
    creationMethod: 'custom' | 'template';
    pluginCount: number;
    activityTriggerEnabled: boolean;
    deliveryEnabled: boolean;
  }
  | {
    kind: 'automation_action_completed';
    automationId: string;
    action: 'run_now' | 'archive_draft' | 'delete';
    visibility: 'private' | 'public';
    status: 'draft' | 'active' | 'paused' | 'error';
  }
  | {
    kind: 'content_copied';
    contentType: 'workstream_link' | 'workstream_email' | 'workstream_id' | 'message_response' | 'code_block'
      | 'note_summary' | 'note_transcript' | 'note_id' | 'automation_email' | 'automation_id';
    resourceType: 'workstream' | 'message' | 'note' | 'automation';
    resourceId: string;
    workstreamId?: string;
  }
  | DesktopTelemetrySemanticIntent;

export interface DesktopJavascriptErrorCandidate {
  process: 'preload' | 'renderer';
  errorCode: 'type_error' | 'range_error' | 'unhandled_rejection' | 'react_boundary' | 'network_error' | 'unknown';
  frames: string[];
}

export interface DesktopWorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  region: RallyRegion;
  role: 'owner' | 'admin' | 'member' | null;
  accessClass?: 'member' | 'guest';
  createdAt: string;
  /** Whether this device holds a regional credential for the workspace — the
   * only thing that can read its background attention. Absent from a row the
   * browser bridge relays straight from the API. */
  credentialStored?: boolean;
}

export interface DesktopPendingWorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  region: RallyRegion;
  email: string;
  role: 'admin' | 'member';
  invitedByName: string;
  expiresAt: string;
}

/**
 * Whether Global discovery answered, and if not, why.
 *
 * - `connected`: discovery answered; `workspaces` is the account's complete
 *   membership merged with what this device has stored.
 * - `reconnect_required`: no identity credential is stored, so nothing can be
 *   discovered or activated until the account is reconnected. `workspaces` is
 *   what this device has stored plus the last answer this run received.
 * - `unavailable`: discovery failed for another reason — no network, a
 *   regional outage, an unexpected answer. `workspaces` is assembled as above.
 */
export type DesktopAccountIdentityState = 'connected' | 'reconnect_required' | 'unavailable';

export interface DesktopWorkspaceOnboardingState {
  workspace: DesktopWorkspaceSummary | null;
  workspaces: DesktopWorkspaceSummary[];
  invitations: DesktopPendingWorkspaceInvitation[];
  identity: DesktopAccountIdentityState;
  /** The failure behind a state other than `connected`, in the words the
   * renderer may show. */
  identityError?: string;
}

export type DesktopMediaPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export interface DesktopSystemAudioCaptureInfo {
  channels: 1;
  sampleRate: number;
}

/**
 * One refused deep link, with the identity its acknowledgement is matched
 * against. The id rises with every failure the main process is asked to show.
 */
export interface DesktopDeepLinkErrorNotice {
  id: number;
  message: string;
}

export interface DesktopArtifactPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopArtifactPreviewRequest {
  artifactId: string;
  /** The one-shot access URL. Its code is the fragment. */
  url: string;
  bounds: DesktopArtifactPreviewBounds;
  /**
   * The corner the renderer drew on the pane this view covers, in CSS pixels.
   *
   * Sent rather than assumed because it belongs to the surface hosting the
   * pane: the lightbox rounds where the page meets its outside edge, and a
   * pane in the plain rail rounds nothing. A view rounded on a host that drew
   * no corner shows four notches against a square pane.
   */
  cornerRadius: number;
}

export interface DesktopSiteArtifactWindowRequest {
  canonicalUrl?: string;
  mode?: 'static' | 'active';
  stateful?: boolean;
  /** Whether the owning surface exposes Main thread artifact actions. */
  editable?: boolean;
  annotationScope?: string;
  kind: 'site';
  restoreId?: string;
  resourceId: string;
  version: number;
  artifactId: string;
  url: string;
  /** Shown in the window's title bar, so a person knows what they popped out. */
  title: string;
}

export interface DesktopGeneratedArtifactWindowRequest {
  /** Whether the owning surface exposes Main thread artifact actions. */
  editable?: boolean;
  annotationScope?: string;
  sourceMimeType?: string;
  kind: 'generated';
  restoreId?: string;
  resourceId: string;
  version: number;
  /** The authorized preview bytes, not the stored source file. */
  content: Uint8Array;
  mimeType: string;
  /** Shown in the window's title bar, so a person knows what they popped out. */
  title: string;
}

export type DesktopArtifactWindowRequest =
  | DesktopSiteArtifactWindowRequest
  | DesktopGeneratedArtifactWindowRequest;

export interface DesktopRestorableArtifactWindow {
  /** Whether the owning surface exposes Main thread artifact actions. */
  editable?: boolean;
  annotationScope?: string;
  id: string;
  kind: 'site' | 'generated';
  resourceId: string;
  version: number;
  title: string;
  mimeType?: string;
}

/** The machine is about to sleep, or has woken from sleep. */
export type DesktopPowerState = 'suspended' | 'resumed';

/** The auto-updater's state, relayed to every Rally window. */
export type DesktopUpdateStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'downloading'; readonly percent?: number }
  | { readonly kind: 'downloaded'; readonly version: string };

export interface RallyDesktopBridge {
  /** Desktop session recovery; absent from browser bridges. */
  waitForNetworkRecoveryState?: () => Promise<void>;
  getNetworkRecoveryState?: () => NetworkRecoveryState;
  reportNetworkTicket?: (observation: NetworkTicketObservation) => Promise<void>;
  onNetworkRecoveryState?: (listener: (state: NetworkRecoveryState) => void) => () => void;
  getRuntimeConfig: () => Promise<RuntimeConfig>;
  /** Whether any Rally window currently owns application focus. */
  getApplicationForegroundState: () => Promise<boolean>;
  onApplicationForegroundChanged: (listener: (foregrounded: boolean) => void) => () => void;
  /** Main's `powerMonitor` suspend and resume, relayed to every Rally window. */
  onPowerStateChanged: (listener: (state: DesktopPowerState) => void) => () => void;
  getUpdateStatus: () => Promise<DesktopUpdateStatus>;
  /** Starts the same manual update check as the application menu. */
  checkForUpdates: () => Promise<void>;
  onUpdateStatusChanged: (listener: (status: DesktopUpdateStatus) => void) => () => void;
  /** Quits and installs a downloaded update; does nothing when none is ready. */
  installDownloadedUpdate: () => Promise<void>;
  getApplicationSettings: () => Promise<DesktopApplicationSettings>;
  setLockdownMode: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setDebugEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setPushNotificationsEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  openNotificationSettings: () => Promise<void>;
  /**
   * The dock icon's badge: the sidebar attention menu's count, `0` to clear.
   * macOS shows it only while notifications, with badges, are allowed.
   */
  setDockBadgeCount: (count: number) => Promise<void>;
  setMenuBarEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setLaunchAtLogin: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setProductAnalyticsEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setReleaseChannel: (channel: DesktopReleaseChannel) => Promise<DesktopApplicationSettings>;
  reportTelemetryScreen: (screen: DesktopTelemetryScreen) => Promise<void>;
  reportTelemetryProductIntent: (intent: DesktopTelemetryProductIntent) => Promise<void>;
  reportJavascriptError: (candidate: DesktopJavascriptErrorCandidate) => Promise<void>;
  onApplicationSettingsChanged: (listener: (settings: DesktopApplicationSettings) => void) => () => void;
  getApplicationIcon: () => Promise<DesktopApplicationIconState>;
  setApplicationIcon: (iconId: ApplicationIconId) => Promise<DesktopApplicationIconState>;
  resetApplicationIcon: () => Promise<DesktopApplicationIconState>;
  onApplicationIconChanged: (listener: (state: DesktopApplicationIconState) => void) => () => void;
  /**
   * Records the *choice* the renderer is drawing — both axes, not the
   * appearance they resolve to — so that the next window the main process
   * constructs is given a matching `backgroundColor`, and so that every other
   * open window can follow. The renderer is still the authority on which theme
   * is active; main only re-resolves and relays.
   *
   * The choice rather than the appearance, because the appearance is not enough
   * to reconstruct it. Under `system` it depends on what the Mac is set to *at
   * the moment it is read*, which is not the same moment across a quit and a
   * relaunch — and two different choices can resolve to the same appearance, so
   * an appearance cannot tell main that anything changed.
   */
  setWindowTheme: (choice: ThemeChoice) => Promise<void>;
  /**
   * Fires when *another* window changed the theme.
   *
   * A theme is one device preference, not one window's — choosing it in the
   * Settings window and having the work stream behind it stay as it was is the
   * behaviour this removes. The payload is the choice now in force, but a
   * listener should re-read the stored choice rather than trust it: the store is
   * what every window resolves from.
   */
  onThemeChanged: (listener: (choice: ThemeChoice) => void) => () => void;
  getSession: () => Promise<DesktopSession | null>;
  createDesktopAuthAttempt: (input: { apiBaseUrl: string; region: RallyRegion }) => Promise<DesktopAuthAttempt>;
  cancelDesktopAuthAttempt: (attemptId: string) => Promise<void>;
  exchangeDesktopTicket: (input: {
    apiBaseUrl: string;
    region: RallyRegion;
    ticket: string;
    attemptId: string;
  }) => Promise<DesktopSession>;
  createDevelopmentSession: (apiBaseUrl: string, workspaceName: string) => Promise<DesktopSession>;
  getAccountOnboarding: () => Promise<AccountOnboarding>;
  updateAccountOnboarding: (input: UpdateAccountOnboarding) => Promise<AccountOnboarding>;
  /** A name to prefill on the create-organization step, read from the email domain's homepage. */
  getOrganizationNameSuggestion: () => Promise<OrganizationNameSuggestion>;
  getOnboardingState: () => Promise<DesktopWorkspaceOnboardingState>;
  getWorkspaceAttention: (input: { region: RallyRegion; workspaceId: string }) => Promise<WorkspaceAttention>;
  leaveWorkspace: (input: {
    expectedOutcome: WorkspaceDepartureOutcome;
    region: RallyRegion;
    workspaceId: string;
  }) => Promise<WorkspaceDeparture>;
  activateWorkspace: (input: { region: RallyRegion; workspaceId: string; operationId?: string }) => Promise<DesktopSession>;
  /**
   * Rally staff support access (`docs/impersonation.md`). The Organization
   * list is `null` for anybody who is not Rally staff, and rejects only on a
   * failure worth retrying. Starting a session makes it the active one;
   * ending it returns to the Organization used before.
   */
  listSupportWorkspaces: () => Promise<SupportWorkspace[] | null>;
  listSupportPeople: (workspaceId: string) => Promise<SupportPerson[]>;
  startSupportSession: (input: { workspaceId: string; userId: string }) => Promise<DesktopSession>;
  endSupportSession: () => Promise<DesktopSession | null>;
  /**
   * Answers a link that names the active workspace with the session already
   * in use, taking a selection intent so the link is the newest selection and
   * an activation still in flight cannot take over the window. Resolves `null`
   * for any other workspace, which `activateWorkspace` must then enter. No
   * network, no write: membership for the active workspace is what the
   * regional API re-checks on every request the credential makes.
   */
  reselectActiveWorkspace: (input: { region: RallyRegion; workspaceId: string }) => Promise<DesktopSession | null>;
  createWorkspace: (input: { region: RallyRegion; name: string; operationId?: string }) => Promise<DesktopSession>;
  acceptInvitation: (input: { region: RallyRegion; invitationId: string; operationId?: string }) => Promise<DesktopSession>;
  declineInvitation: (input: { region: RallyRegion; invitationId: string }) => Promise<void>;
  refreshSession: () => Promise<DesktopSession>;
  surrenderActiveWorkspace: () => Promise<DesktopSession | null>;
  /** Pure read of whether a durable credential is still stored. Unlike
   * `getSession`, this never reaches the network, so it can answer "was the
   * credential surrendered?" without a refresh of its own failing the probe. */
  hasStoredCredential: () => Promise<boolean>;
  logout: () => Promise<void>;
  copyText: (text: string) => Promise<void>;
  /** Show the macOS Dictionary popover for the current renderer selection. */
  showDefinitionForSelection: () => Promise<void>;
  /** Open the macOS share sheet for the given plain text. */
  shareText: (text: string) => Promise<void>;
  /** Local Chromium browser; visited pages never receive the Rally preload. */
  getEmbeddedBrowserState: () => Promise<EmbeddedBrowserState>;
  commandEmbeddedBrowser: (command: EmbeddedBrowserCommand) => Promise<EmbeddedBrowserResult>;
  setEmbeddedBrowserBounds: (bounds: EmbeddedBrowserBounds) => Promise<void>;
  setEmbeddedBrowserVisible: (visible: boolean) => Promise<void>;
  onEmbeddedBrowserState: (listener: (state: EmbeddedBrowserState) => void) => () => void;
  /** A browser shortcut pressed inside a visited page that the host's controls handle. */
  onEmbeddedBrowserHostRequest: (listener: (request: EmbeddedBrowserHostRequest) => void) => () => void;
  /** Opens, or raises, the window for importing a signed-in Claude or ChatGPT conversation. */
  openBrowserImport: (context: BrowserImportContext) => Promise<void>;
  /** The import window's Spaces, as the main window last offered them. */
  getBrowserImportContext: () => Promise<BrowserImportContext | null>;
  onBrowserImportContextChanged: (listener: () => void) => () => void;
  /** View → Refresh Organization List: reread the account menu's Organizations. */
  onOrganizationListRefreshRequested: (listener: () => void) => () => void;
  /**
   * The import window's hand-off: the main window opens the Channel, or the
   * Breakout `substreamId` names in it, and this window closes.
   */
  completeBrowserImport: (workstreamId: string, substreamId?: string) => Promise<void>;
  /**
   * The import window's create starting or failing, relayed to the main
   * window. `completeBrowserImport` relays its success and opens the Channel;
   * `imported` here only settles the row when that hand-off failed.
   */
  reportBrowserImport: (progress: BrowserImportProgress) => Promise<void>;
  /** The main window's view of an import in the other window. */
  onBrowserImportProgress: (listener: (progress: BrowserImportProgress) => void) => () => void;
  /**
   * Renders one of Rally's messages as a picture or a PDF and offers to save
   * it. Resolves with `saved: false` when the person dismissed the dialog, and
   * rejects when the card could not be rendered or written.
   */
  exportMessage: (request: MessageExportRequest) => Promise<MessageExportResult>;
  connectCanva?: (operationId?: string) => Promise<{ url: string; attemptId: string }>;
  openExternal: (url: string) => Promise<void>;
  /**
   * Show a live artifact in the rail's preview region.
   *
   * The renderer never embeds artifact content: it hands over an artifact id, a
   * one-shot access URL, and the rectangle it measured, and the main process
   * owns everything else — the view, its isolation, and whether that URL is one
   * it will load at all. Resolves `false` when the URL is refused.
   */
  presentArtifactPreview: (request: DesktopArtifactPreviewRequest) => Promise<boolean>;
  /** Move the preview when the rail's layout changes. Layout only, not scroll. */
  setArtifactPreviewBounds: (bounds: DesktopArtifactPreviewBounds) => Promise<void>;
  /**
   * Hide the preview while an app surface that can overlap the rail is open.
   *
   * A composited view paints *above* the renderer's DOM, so a dialog, the
   * command palette, or a lightbox would otherwise have artifact content drawn
   * over it. The view collapses rather than closing, so state survives.
   */
  setArtifactPreviewHidden: (hidden: boolean) => Promise<void>;
  /** A still of the live preview as an image data URL, or `null` when none is showing. */
  pickArtifactPreview?: () => Promise<ArtifactPickerPin | null>;
  showArtifactPreviewComments?: (pins: AnnotationCommentPins) => Promise<AnnotationCommentAction | null>;
  stopPickingArtifactPreview?: () => Promise<void>;
  snapshotArtifactPreview: () => Promise<string | null>;
  /** Tear the preview down: the detail closed, or the work stream changed. */
  closeArtifactPreview: () => Promise<void>;
  /** Resource-confined operations for the registered detached window. Never accepts a resource id or API path. */
  artifactWindowAction?: (action: ArtifactWindowAction) => Promise<unknown>;
  readArtifactWindow?: () => Promise<DesktopArtifactWindowRequest | null>;
  registerAnnotationComposer?: (scope: string, active: boolean) => Promise<void>;
  returnArtifactAnnotations?: (pins: { annotation: Annotation; image?: Uint8Array }[]) => Promise<boolean>;
  completeArtifactAnnotationTransfer?: (transferId:string, accepted:boolean) => Promise<void>;
  onArtifactAnnotations?: (listener: (value: { transferId:string; scope: string; name: string; pins: { annotation: Annotation; image?: Uint8Array }[] }) => void) => () => void;
  onArtifactWindowUpdated?: (listener: () => void) => () => void;
  popOutArtifact: (request: DesktopArtifactWindowRequest) => Promise<boolean>;
  getRestorableArtifactWindows: () => Promise<DesktopRestorableArtifactWindow[]>;
  forgetRestorableArtifactWindow: (id: string) => Promise<void>;
  /** Versions currently shown by detached artifact windows, keyed by resource. */
  getPoppedOutArtifactVersions: () => Promise<Record<string, number>>;
  /** Replace one detached window; resolves true while another stale window remains. */
  updatePoppedOutArtifact: (request: DesktopArtifactWindowRequest) => Promise<boolean>;
  /**
   * Raise the singleton Sidekicks window, on its library or on one target.
   *
   * A target is a stored Sidekick's id, or `NEW_SIDEKICK_TARGET` for the
   * composer that creates one — main parses it through
   * `parseSidekicksWindowTarget` rather than routing on it directly.
   */
  openSidekicks: (target?: string) => Promise<void>;
  /**
   * Open a Thread in the main window and bring it forward, from a window that
   * cannot route there itself, such as the Sidekicks window. Main checks the id
   * and hands it to the same deep link an in-app link takes.
   */
  openThread: (workstreamId: string) => Promise<void>;
  openSettings: (section?: DesktopSettingsSection) => Promise<void>;
  startSystemAudioCapture: () => Promise<DesktopSystemAudioCaptureInfo>;
  stopSystemAudioCapture: () => Promise<void>;
  onSystemAudioData: (listener: (data: ArrayBuffer, sampleRate: number) => void) => () => void;
  onSettingsSectionRequested: (listener: (section: DesktopSettingsSection) => void) => () => void;
  /**
   * The settings window has been put on screen for the first time.
   *
   * Only main knows this: a prewarmed window is built, loaded and mounted long
   * before anybody asks to see it, and the renderer cannot tell the difference —
   * `document.visibilityState` reports `visible` for a `show: false` window on
   * at least one platform. Anything in the settings surface that should happen
   * when a person actually looks at it waits for this.
   */
  onSettingsWindowRevealed: (listener: () => void) => () => void;
  /**
   * Raise the deep-link failure window in front of whatever is on screen.
   *
   * A refused deep link is reported by whichever renderer was handed it, and
   * for a connector completion that is the settings window — which raises and
   * focuses itself, and renders no shell to put a message in. Anything drawn
   * inside a single renderer is therefore either in a window nobody is looking
   * at or in one with nowhere to draw it, which is why this leaves the renderer
   * entirely and asks main for a window of its own.
   *
   * Both renderers are handed the same connector completion and both report it.
   * The window is a singleton keyed on nothing: the second report re-shows the
   * same window with the same message, so a duplicate costs a redundant focus
   * rather than a second dialog.
   */
  showDeepLinkError: (message: string) => Promise<void>;
  /** The notice to show, read by the failure window once it has mounted. */
  getDeepLinkError: () => Promise<DesktopDeepLinkErrorNotice | null>;
  /** A later failure replacing the one already on screen in that window. */
  onDeepLinkErrorChanged: (listener: (notice: DesktopDeepLinkErrorNotice | null) => void) => () => void;
  /**
   * Acknowledged: close the failure window. Only that window may call this.
   *
   * Takes the id of the notice being acknowledged rather than closing whatever
   * is open. A newer failure can replace the text between the person reading it
   * and their click landing — duplicate reports are the normal case here — and
   * a bare close would then discard a notice nobody has seen.
   */
  dismissDeepLinkError: (noticeId: number) => Promise<void>;
  consumePendingDeepLinks: () => Promise<DesktopDeepLinkNavigation[]>;
  onDeepLink: (listener: (navigation: DesktopDeepLinkNavigation) => void) => () => void;
  onSessionChanged: (listener: (session: DesktopSession | null) => void) => () => void;
  /**
   * The main window's Organization socket, told to main so it can relay it to
   * the Settings and Sidekicks windows. Main refuses it from any other window.
   */
  publishWorkspaceSync: (publication: WorkspaceSyncPublication) => Promise<void>;
  requestWorkspaceConversationView: (request: WorkspaceConversationViewRelayRequest) => Promise<void>;
  /** Settings and Sidekicks windows only: whose socket is being relayed right now, if anyone's. */
  getWorkspaceSyncSource: () => Promise<WorkspaceSyncSourceSnapshot>;
  /**
   * Settings and Sidekicks windows only: every relayed event. News that arrived before the
   * first listener is held, folded, and delivered to it.
   */
  onWorkspaceSyncRelayed: (listener: (event: WorkspaceSyncRelayEvent) => void) => () => void;
  openRealtimeSocket: (input: DesktopRealtimeSocketOpenInput) => Promise<void>;
  sendRealtimeSocket: (input: DesktopRealtimeSocketSendInput) => Promise<void>;
  closeRealtimeSocket: (input: DesktopRealtimeSocketCloseInput) => Promise<void>;
  onRealtimeSocketEvent: (listener: (event: DesktopRealtimeSocketEvent) => void) => () => void;
}
