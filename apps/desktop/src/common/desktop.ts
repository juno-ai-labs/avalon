import type { DesktopSettingsSection } from './settings';
import type { ApplicationIconId, DesktopApplicationIconState } from './application-icons';
import type { ThemeChoice } from './themes';
import type { MessageExportRequest, MessageExportResult } from './message-export';
import type {
  ClientFeatureFlags,
  TelemetryEventProperties,
  WorkspaceAttention,
  WorkspaceDeparture,
  WorkspaceDepartureOutcome,
} from '@rally/contracts';
import type {
  DesktopRealtimeSocketCloseInput,
  DesktopRealtimeSocketEvent,
  DesktopRealtimeSocketOpenInput,
  DesktopRealtimeSocketSendInput,
} from './realtime-socket';

export type RallyRegion = 'global' | 'eu';

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
  appVersion: string;
  isPackaged: boolean;
  platform: string;
  api: Record<RallyRegion, string>;
  /** Public site origin. Canonical work-stream links are minted against it. */
  webBaseUrl: string;
  devAuthEnabled: boolean;
}

export interface DesktopSession {
  accessToken: string;
  expiresAt: string;
  apiBaseUrl: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl?: string;
    timezone?: string;
  };
  workspace: {
    id: string;
    name: string;
    region: RallyRegion;
    role: 'owner' | 'admin' | 'member';
    timezone?: string;
  } | null;
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
  /** The **effective** Developer → Debug enabled preference: the stored choice
   * and the service's flag. A device whose flag is off reads `false` here
   * however `application-settings.json` reads. */
  debugEnabled: boolean;
  /** Whether the service allows this account the Developer section at all.
   * Off until a poll says otherwise, and off again on sign-out. */
  developerSettingsAvailable: boolean;
  /** Whether the Rally status item is in the macOS menu bar. On by default. */
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
  | 'hypersight_opened'
  | 'workstream_resource_action_completed'
  | 'recording_start_completed'
  | 'recording_terminal'
  | 'note_opened_v2'
  | 'realtime_socket_state';

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
    kind: 'message_sent';
    workstreamId: string;
    messageId?: string;
    visibility: 'private' | 'public';
    workstreamOrigin: 'ad_hoc' | 'automation';
    messageKind: 'message' | 'elicitation_response';
    attachmentCount: number;
    mentionCount: number;
    participantAddedCount: number;
  }
  | {
    kind: 'content_copied';
    contentType: 'workstream_link' | 'workstream_email' | 'workstream_id' | 'message_response' | 'code_block'
      | 'note_summary' | 'note_transcript' | 'note_id' | 'automation_email' | 'automation_id';
    resourceType: 'workstream' | 'message' | 'note' | 'automation';
    resourceId: string;
    workstreamId?: string;
  }
  | {
    kind: 'note_opened';
    noteId: string;
    visibility: 'private' | 'public';
    recordingState: 'idle' | 'recording' | 'complete';
    navigation: 'opened' | 'reopened';
  }
  | {
    kind: 'note_created';
    noteId: string;
    visibility: 'private' | 'public';
    noteType: 'meeting_or_voice';
    entrypoint: 'sidebar' | 'menu_bar' | 'unknown';
  }
  | {
    kind: 'note_action_completed';
    noteId: string;
    action: 'make_public' | 'make_private' | 'archive';
    visibility: 'private' | 'public';
    recordingState: 'idle' | 'recording' | 'complete';
  }
  | {
    kind: 'transcription_state_changed';
    noteId: string;
    state: 'started' | 'paused' | 'resumed' | 'completed';
    visibility: 'private' | 'public';
    audioSource: 'microphone_and_system' | 'microphone_only' | 'system_only' | 'unknown';
  }
  | DesktopTelemetrySemanticIntent;

export interface DesktopTelemetryInspectorEntry {
  name: string;
  schemaVersion: number;
  policyClass: 'essential' | 'product' | 'diagnostic';
  propertyNames: string[];
  route: RallyRegion;
  validation: 'accepted' | 'suppressed' | 'rejected' | 'delivered' | 'retrying' | 'terminal';
  queueState: 'none' | 'queued' | 'delivered' | 'retrying' | 'removed';
}

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
  role: 'owner' | 'admin' | 'member';
  createdAt: string;
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

export interface DesktopWorkspaceOnboardingState {
  workspace: DesktopWorkspaceSummary | null;
  workspaces: DesktopWorkspaceSummary[];
  invitations: DesktopPendingWorkspaceInvitation[];
}

export type DesktopMediaPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export type MeetingAudioPermissionKind = 'microphone' | 'system-audio';

/**
 * Who asked a meeting window to close, which decides whether the recording
 * screen may stop and ask first.
 *
 * `user` is a close the person performed on that window — its traffic light or
 * Command-W — and a recording in progress is worth a confirmation, because the
 * window is the only place the meeting exists until finalization lands.
 * `quit` is the application shutting down, where a window that stops to ask is
 * a window that refuses to close, and a quit vetoed that way leaves Rally
 * running with no way to finish. That path finalizes and closes as it always
 * has.
 */
export type MeetingCloseReason = 'user' | 'quit';

export interface DesktopMeetingAudioPermissions {
  microphone: DesktopMediaPermissionStatus;
  systemAudio: DesktopMediaPermissionStatus;
}

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

export interface RallyDesktopBridge {
  getRuntimeConfig: () => Promise<RuntimeConfig>;
  /** Whether any Rally window currently owns application focus. */
  getApplicationForegroundState: () => Promise<boolean>;
  onApplicationForegroundChanged: (listener: (foregrounded: boolean) => void) => () => void;
  getApplicationSettings: () => Promise<DesktopApplicationSettings>;
  setLockdownMode: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setDebugEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setMenuBarEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setLaunchAtLogin: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  setProductAnalyticsEnabled: (enabled: boolean) => Promise<DesktopApplicationSettings>;
  reportTelemetryScreen: (screen: DesktopTelemetryScreen) => Promise<void>;
  reportTelemetryProductIntent: (intent: DesktopTelemetryProductIntent) => Promise<void>;
  getTelemetryInspector: () => Promise<DesktopTelemetryInspectorEntry[]>;
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
  getOnboardingState: () => Promise<DesktopWorkspaceOnboardingState>;
  getWorkspaceAttention: (input: { region: RallyRegion; workspaceId: string }) => Promise<WorkspaceAttention>;
  leaveWorkspace: (input: {
    expectedOutcome: WorkspaceDepartureOutcome;
    region: RallyRegion;
    workspaceId: string;
  }) => Promise<WorkspaceDeparture>;
  activateWorkspace: (input: { region: RallyRegion; workspaceId: string; operationId?: string }) => Promise<DesktopSession>;
  createWorkspace: (input: { region: RallyRegion; name: string; operationId?: string }) => Promise<DesktopSession>;
  acceptInvitation: (input: { region: RallyRegion; invitationId: string; operationId?: string }) => Promise<DesktopSession>;
  declineInvitation: (input: { region: RallyRegion; invitationId: string }) => Promise<void>;
  refreshSession: () => Promise<DesktopSession>;
  /** Pure read of whether a durable credential is still stored. Unlike
   * `getSession`, this never reaches the network, so it can answer "was the
   * credential surrendered?" without a refresh of its own failing the probe. */
  hasStoredCredential: () => Promise<boolean>;
  logout: () => Promise<void>;
  copyText: (text: string) => Promise<void>;
  /**
   * Renders one of Rally's messages as a picture or a PDF and offers to save
   * it. Resolves with `saved: false` when the person dismissed the dialog, and
   * rejects when the card could not be rendered or written.
   */
  exportMessage: (request: MessageExportRequest) => Promise<MessageExportResult>;
  openExternal: (url: string) => Promise<void>;
  openSettings: (section?: DesktopSettingsSection) => Promise<void>;
  openMeetingNotes: (noteId?: string) => Promise<void>;
  /**
   * Closes the meeting window. Given a note id, the main window is raised and
   * taken to that note on the way out — the meeting is over, and the note is
   * the thing the person is left with.
   */
  closeMeetingNotes: (noteId?: string) => Promise<void>;
  setMeetingRecordingState: (input: {
    region: RallyRegion;
    workspaceId: string;
    recording: boolean;
  }) => Promise<void>;
  getMeetingAudioPermissions: () => Promise<DesktopMeetingAudioPermissions>;
  prepareMeetingAudioPermissions: () => Promise<DesktopMeetingAudioPermissions>;
  startMeetingSystemAudioCapture: () => Promise<DesktopSystemAudioCaptureInfo>;
  stopMeetingSystemAudioCapture: () => Promise<void>;
  onMeetingSystemAudioData: (listener: (data: ArrayBuffer, sampleRate: number) => void) => () => void;
  openMeetingAudioSettings: (permission: MeetingAudioPermissionKind) => Promise<void>;
  onMeetingCloseRequested: (listener: (reason: MeetingCloseReason) => void) => () => void;
  onSettingsSectionRequested: (listener: (section: DesktopSettingsSection) => void) => () => void;
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
  openRealtimeSocket: (input: DesktopRealtimeSocketOpenInput) => Promise<void>;
  sendRealtimeSocket: (input: DesktopRealtimeSocketSendInput) => Promise<void>;
  closeRealtimeSocket: (input: DesktopRealtimeSocketCloseInput) => Promise<void>;
  onRealtimeSocketEvent: (listener: (event: DesktopRealtimeSocketEvent) => void) => () => void;
  /** Mirrors a signed server answer into main-process-only surfaces such as the menu bar. */
  observeClientFeatureFlags: (flags: ClientFeatureFlags) => Promise<void>;
}
