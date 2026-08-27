import type {
  AgentModelOverride,
  AutomationPluginActivity,
  NoteDetail as ContractNoteDetail,
  NoteSummary as ContractNoteSummary,
  NoteTranscriptSegment as ContractNoteTranscriptSegment,
  Scope as ContractScope,
  GitHubRepositoryAccessSettings as ContractGitHubRepositoryAccessSettings,
  TerminalWorkspaceSettings as ContractTerminalWorkspaceSettings,
  TerminalNetworkPolicyPreview as ContractTerminalNetworkPolicyPreview,
  TerminalWorkstreamState as ContractTerminalWorkstreamState,
  WorkstreamTranscriptSnapshot,
} from '@rally/contracts';

/** The OpenRouter model ids a composer may pin work to. Re-exported so the
 *  renderer keeps one import site for the shapes it speaks to the API in. */
export type { AgentModelOverride };
export type TerminalWorkspaceSettings = ContractTerminalWorkspaceSettings;
export type TerminalNetworkPolicyPreview = ContractTerminalNetworkPolicyPreview;
export type TerminalWorkstreamState = ContractTerminalWorkstreamState;
export type GitHubRepositoryAccessSettings = ContractGitHubRepositoryAccessSettings;

export type Region = 'global' | 'eu';
/** How a connection or automation is owned, in the words the UI uses for it. */
export type Scope = 'you' | 'workspace';
/**
 * Who may read an object — `personal` is the people in it, `workspace` is
 * everyone. Notes and work streams share this one vocabulary, which is the
 * server's, so "private" means the same thing on both.
 */
export type VisibilityScope = ContractScope;
export type HarnessStatus = 'scheduled' | 'running' | 'needs_input' | 'completed' | 'failed' | 'stopped';
export type AutomationStatus = 'active' | 'paused' | 'draft' | 'error';
export type NoteSummary = ContractNoteSummary;
export type NoteDetail = ContractNoteDetail;
export type NoteTranscriptSegment = ContractNoteTranscriptSegment;

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  timezone: string;
  role?: string;
  /**
   * Present only on people read from the workspace roster, which is the one
   * place a membership that is not yet active can appear. Participants and
   * viewers are members by construction and carry no status.
   */
  status?: 'active' | 'invited' | 'suspended';
}

export interface Workspace {
  id: string;
  name: string;
  region: Region;
  timezone: string;
  currentUser: WorkspaceMember;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedByName: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface WorkspaceInvitationPreview {
  workspaceId: string;
  workspaceName: string;
  region: Region;
  email: string;
  role: 'admin' | 'member';
  expiresAt: string;
}

export interface PendingWorkspaceInvitation extends WorkspaceInvitationPreview {
  id: string;
  invitedByName: string;
}

export interface AutomationSummary {
  id: string;
  name: string;
  emailAddress?: string;
  scope: Scope;
  status: AutomationStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  /** Last time the automation itself changed — a draft's only activity. */
  updatedAt: string;
  statusMessage?: string;
}

export interface WorkstreamSummary {
  id: string;
  title: string;
  /** `naming` while Rally is choosing the title; the title is a placeholder. */
  titleStatus: 'naming' | 'automatic' | 'settled';
  objective?: string;
  emailAddress?: string;
  origin: 'ad_hoc' | 'automation';
  createdByUserId?: string;
  automationName?: string;
  /**
   * Set when an automation generated this work stream. Generated execution
   * records are fixed private work streams, so this identifies their origin;
   * their own scope, creator, and participants still decide who may read them.
   */
  automationSubscriptionId?: string;
  automationRunId?: string;
  harnessStatus: HarnessStatus;
  latestAttentionSequenceNumber: number;
  readThroughSequenceNumber: number;
  manualUnreadFromSequenceNumber: number | null;
  manualUnreadGeneration: number;
  hasUnread: boolean;
  /** A person mention exists above this viewer's read waterline. */
  youAreMentioned?: boolean;
  /**
   * This viewer was put in the work stream and has not opened it once. It
   * outranks every run state on the sidebar marker: whatever the agent is
   * doing, the first thing to know about a room you have never been in is
   * that you have never been in it. Cleared by opening it.
   */
  unseen?: boolean;
  firstUnreadSequenceNumber: number | null;
  lastActivityAt: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  plannedFor?: string;
  preview?: string;
  /**
   * Who may read it, the same way a note says it. `personal` means only the
   * people in it, and is what the private marker renders from.
   */
  scope: VisibilityScope;
  /**
   * Set on a work stream that exists so a subsystem can use the agent loop —
   * a digest run's transcript, for instance. A different question from `scope`:
   * this decides whether it is listed, that decides who may read it.
   */
  systemKind?: 'digest';
  /** The first one-shot wake-up still waiting to fire for this work stream. */
  nextPendingWakeup: { dueAt: string; promptPreview: string } | null;
  /**
   * Where this work stream sits in *this viewer's* pinned list, or `null` when
   * they have not pinned it. Per-person like the read-state fields above: the
   * same work stream is pinned for one member and not for another.
   */
  pinPosition: number | null;
}

export interface Participant extends WorkspaceMember {
  accent?: string;
  viewing?: boolean;
}

export interface WorkstreamResource {
  id: string;
  title: string;
  resourceType: string;
  provider?: string;
  mimeType?: string;
  canonicalUrl?: string;
  watchEnabled: boolean;
  watchStatus: 'watching' | 'paused' | 'unsupported' | 'error';
  updatedAt?: string;
  contentAvailable?: boolean;
  sizeBytes?: number;
  currentVersion: number;
  relationshipType: 'attachment' | 'message_attachment' | 'origin' | 'generated' | 'suggested_activity' | 'inbound_email' | 'context';
  direction: 'source' | 'artifact';
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentAvailable: boolean;
  createdAt: string;
}

export interface ResourcePage {
  items: WorkstreamResource[];
  nextCursor: string | null;
}

export interface WorkstreamConnection {
  id: string;
  modelPluginId: string;
  connectorType: string;
  displayName: string;
  scope: Scope;
  ownerName?: string;
  status: 'healthy' | 'reconnect_required' | 'disabled';
  capabilities?: string[];
  settingsKind?: 'github_repository_access';
  /** Set when this connection can hand automation results to the signed-in user. */
  userDelivery?: AutomationUserDelivery;
}

export interface AutomationUserDelivery {
  targetType: AutomationDeliveryTargetType;
  label: string;
  description: string;
}

export interface ToolEventData {
  id: string;
  /** Stable provider/Bind call identity shared by live and canonical rows. */
  toolCallId?: string;
  name: string;
  summary?: string;
  status: 'started' | 'completed' | 'failed' | 'ambiguous';
  durationMs?: number;
  toolType?: string;
  /** The single plugin that owns this tool; absent for Rally-owned tools. */
  plugin?: AutomationPluginActivity;
  input?: unknown;
  output?: unknown;
}

export interface ThoughtEventData {
  status: 'started' | 'completed';
  /** Completed model-inference time accumulated across this turn. */
  durationMs: number;
  /** Client receipt time for the currently streaming inference attempt. */
  startedAt?: number;
  monotonicStartedAt?: number;
  activeVerb?: string;
  completedVerb?: string;
}

export interface ElicitationData {
  id: string;
  prompt: string;
  responseType: 'text' | 'radio' | 'single_select' | 'multi_select';
  options?: Array<{ label: string; value: string; description?: string }>;
  minimumSelections?: number;
  maximumSelections?: number;
  allowOther?: boolean;
  targetUserId?: string;
  status: 'open' | 'answered';
  answer?: unknown;
  answeredByName?: string;
  createdAt?: string;
}

export interface ActivitySuggestionData {
  id: string;
  title: string;
  source?: string;
  occurredAt?: string;
  reason: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

export interface BlockDashboardBlockRun {
  id: string;
  blockId: string;
  configurationVersionId: string;
  triggerSequence: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  markdown: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BlockDashboardBlock {
  id: string;
  prompt: string;
  latestRun: BlockDashboardBlockRun | null;
}

export interface BlockDashboard {
  versionId: string | null;
  versionNumber: number;
  blocks: BlockDashboardBlock[];
  updatedAt: string | null;
}

export interface BlockDashboardPreference {
  visible: boolean;
  updatedAt: string | null;
}

export interface MessageMention {
  type: 'person' | 'connector';
  personId?: string;
  connectorType?: string;
  displayName?: string;
  avatarUrl?: string;
  startOffset: number;
  endOffset: number;
}

export interface ExternalActor {
  provider: string;
  providerAccountId: string;
  providerUserId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Message {
  id: string;
  /** Canonical Bind turn identity used to replace its transient stream overlay. */
  transcriptTurnId?: string;
  /**
   * Stable identity supplied by the client for idempotent message creation.
   * The persisted message receives a different database `id`, so this value
   * is also used to reconcile optimistic, REST, and realtime copies.
   */
  clientMessageId?: string;
  workstreamId: string;
  sequenceNumber: number;
  /** Main-substream people-visible ordinal used only for unread attention. */
  attentionSequenceNumber?: number | null;
  authorType: 'human' | 'external' | 'agent' | 'system';
  author?: WorkspaceMember;
  externalActor?: ExternalActor;
  messageType:
    | 'text'
    | 'thought'
    | 'tool_event'
    | 'elicitation'
    | 'activity_suggestion'
    | 'system';
  text?: string;
  contextLabel?: string;
  mentions?: MessageMention[];
  attachments?: MessageAttachment[];
  createdAt: string;
  streaming?: boolean;
  deliveryState?: 'sending';
  /**
   * Durable Object events and D1 transcript rows have independent sequence
   * counters. Realtime-only blocks use this anchor so their observed order can
   * be retained without treating an event sequence as a persisted message
   * sequence.
   */
  realtimeOrder?: {
    anchorSequenceNumber: number;
    eventSequence: number;
    placement: 'before_anchor' | 'at_anchor' | 'after_anchor';
  };
  toolEvent?: ToolEventData;
  thoughtEvent?: ThoughtEventData;
  elicitation?: ElicitationData;
  activitySuggestion?: ActivitySuggestionData;
}

export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
  newerCursor: string | null;
}

export interface BackgroundTask {
  id: string;
  harnessRunId?: string;
  title: string;
  type: 'agent' | 'tool' | 'connector';
  status: 'running' | 'needs_input' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenCount?: number;
  toolUses?: number;
  transcriptMessageId?: string;
}

export interface AutomationRunSummary {
  id: string;
  workstreamId: string;
  title: string;
  status: HarnessStatus;
  triggerType: string;
  triggerTime: string;
  resultSummary?: string;
  durationMs?: number;
  participants?: Participant[];
}

export interface AutomationTemplateUpdate {
  versionId: string;
  versionNumber: number;
  overview: string;
  instructions: string;
  triggerSummary: string;
  capabilities: string[];
  expectedOutputs: string[];
  recommendedPlugins: Array<{ pluginId: string; recommendedTools: string[]; reason: string }>;
  activitySources: AutomationActivitySource[];
}

export interface AutomationActivitySource {
  bindingKey: string;
  connectorType: string;
  suggestedPluginId?: string;
}

export interface HarnessRunMetadata {
  id: string;
  origin: string;
  status: 'scheduled' | 'running' | 'needs_input' | 'completed' | 'failed' | 'stopped';
  model?: string;
  error?: { code: string; message: string };
  requestId?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface WorkstreamAutomationSubscription {
  id: string;
  name: string;
  scope: Scope;
  status: AutomationStatus;
  triggerSummary: string;
  executionScope: string;
}

export interface WorkstreamDetail extends WorkstreamSummary {
  createdAt: string;
  /**
   * The model this work stream is pinned to, or absent for the unpinned case
   * the flag decides. Read by the composer's model pill as the answer of last
   * resort — the latest run's model is what it prefers, because that is what
   * actually ran — so that a pinned work stream whose only run failed before it
   * streamed is never described as following the flag.
   */
  modelOverride?: AgentModelOverride | null;
  createdBy?: WorkspaceMember;
  participants: Participant[];
  viewers: Participant[];
  resources: WorkstreamResource[];
  connections: WorkstreamConnection[];
  backgroundTasks: BackgroundTask[];
  automationRuns: AutomationRunSummary[];
  automationSubscriptionId?: string;
  automationSubscription?: WorkstreamAutomationSubscription;
  automationRunId?: string;
  latestHarnessRunId?: string;
  latestHarnessRun?: HarnessRunMetadata;
  openElicitations?: ElicitationData[];
  suggestions?: ActivitySuggestionData[];
}

/**
 * The REST recovery twin of the socket snapshot.
 *
 * `resumeFeed` is the window around where this viewer stopped reading, and is
 * null when that is already inside `messageFeed`. Render one of the two; they
 * are not contiguous, and the transcript is a single ordered run.
 */
export interface WorkstreamBoot extends WorkstreamDetail {
  transcript: WorkstreamTranscriptSnapshot;
  /** Undefined from a Worker that predates the field; absent is not empty. */
  messageFeed?: MessagePage;
  resumeFeed: MessagePage | null;
}

export interface WorkstreamDeferredContext {
  backgroundTasks: BackgroundTask[];
  automationRuns: AutomationRunSummary[];
  automationSubscription?: WorkstreamAutomationSubscription;
}

export interface CreatedWorkstream {
  workstream: WorkstreamSummary;
  messageId: string;
  clientMessageId: string;
  createdAt: string;
  /**
   * The run the opening message started. Seeded into the work stream's detail so
   * the work timer the launch surface started keeps counting across the
   * navigation instead of disappearing until the first refetch answers.
   */
  harnessRunId: string | null;
}

export interface WorkOpportunity {
  id: string;
  version: number;
  displayPrompt: string;
  icon: 'brand-github' | 'brand-google' | 'brand-google-drive' | 'brand-notion' | 'brand-slack' | 'linear' | 'plug' | 'webhook' | 'world-search';
  sourceLabel: string;
}

/** Every run always lands in Rally; these are the extra frozen destinations. */
export type AutomationDeliveryTargetType = 'slack_agent_dm' | 'email';

export interface AutomationDeliveryChoice {
  /** A connector-declared personal destination, with the type it declared. */
  connection?: { id: string; targetType: AutomationDeliveryTargetType };
  email?: boolean;
}

export interface AutomationCreateOptions {
  /** Overrides the scope Rally suggested for the draft. */
  scope?: AutomationScope;
  delivery?: AutomationDeliveryChoice;
  /**
   * Pins the work stream each run of this automation creates to one OpenRouter
   * model, ahead of the `agent-model-workstream` flag.
   */
  modelOverride?: AgentModelOverride;
}

export type AutomationScope = 'you' | 'workspace';

export interface AutomationDetail extends AutomationSummary {
  description: string;
  versionNumber: number;
  overview: string;
  instructions: string;
  triggerSummary: string;
  scheduleSummary?: string;
  capabilities: string[];
  expectedOutputs: string[];
  recommendedPlugins: Array<{ pluginId: string; recommendedTools: string[]; reason: string }>;
  defaultPluginIds: string[];
  activitySourcePluginIds: Record<string, string>;
  activitySources: AutomationActivitySource[];
  deliveryTargets?: Array<{
    type: AutomationDeliveryTargetType;
    connectionId: string | null;
    displayName: string;
    status: 'active' | 'needs_input' | 'disabled';
  }>;
  executionScope: 'You' | 'Workspace';
  owner?: WorkspaceMember;
  runs: AutomationRunSummary[];
  nextRun?: AutomationRunSummary;
  templateUpdate?: AutomationTemplateUpdate;
}

export interface AutomationDraftQuestion {
  id: string;
  presentedAt: string;
  prompt: string;
  placeholder?: string;
  responseType: 'free_text' | 'single_select' | 'multi_select';
  options: Array<{ label: string; value: string; description?: string }>;
  minimumSelections?: number;
  maximumSelections?: number;
  allowOther: boolean;
}

export interface AutomationDraftSummary {
  name: string;
  description: string;
  overview: string;
  recommendedPlugins: Array<{ pluginId: string; recommendedTools: string[]; reason: string }>;
  activitySources: AutomationActivitySource[];
  scope: Scope;
  triggerSummary: string;
  capabilities: string[];
  requiresSlackDelivery: boolean;
  requiresEmailDelivery: boolean;
}

export interface AutomationDraftResponse {
  draftId: string;
  assistantMessage?: string;
  question?: AutomationDraftQuestion;
  summary?: AutomationDraftSummary;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  authorName: string;
  description: string;
  usageCount: number;
  capabilities: string[];
  latestVersion: number;
  activitySources: AutomationActivitySource[];
}

export interface SocketTicket {
  /**
   * The handshake URL with the deprecated `?ticket=` stripped: the credential
   * travels in `protocols` instead, because Cloudflare captures request URLs
   * into stores no redaction here can reach.
   */
  url: string;
  ticket: string;
  /** Pass as the `WebSocket` constructor's second argument. */
  protocols: [string, string];
  /**
   * The ticket's own id, which the room reports consuming. It is the trace id
   * every server-side row for this socket carries, so printing it is what makes
   * a slow open findable; see `docs/performance-tracing.md`.
   */
  ticketId?: string;
}

export type WorkstreamSocketEvent =
  | { type: 'snapshot'; workstream: WorkstreamDetail; messages: Message[]; sequence: number }
  | { type: 'presence_changed'; viewers: Participant[]; sequence: number }
  | { type: 'message_created'; message: Message; sequence: number }
  | {
      type: 'stream_started';
      messageId: string;
      harnessRunId: string;
      turnId: string;
      epoch: number;
      streamSeq: number;
      reset: false;
      sequence: number;
    }
  | {
      type: 'stream_delta';
      messageId: string;
      delta: string;
      turnId: string;
      epoch: number;
      streamSeq: number;
      reset: boolean;
      sequence: number;
    }
  | { type: 'stream_completed'; message: Message; sequence: number }
  | { type: 'harness_status_changed'; status: HarnessStatus; sequence: number }
  | { type: 'resource_updated'; resource: WorkstreamResource; sequence: number }
  | { type: 'resync_required'; reason: 'history_unavailable' | 'sequence_ahead'; latestSequence: number; sequence: number }
  | { type: 'error'; message: string; sequence?: number };

/** One person's scheduled digest: which days, what times, and where it goes. */
export interface DigestSchedule {
  id: string;
  enabled: boolean;
  /** Sunday is 0, matching `Date#getDay`. */
  days: number[];
  /** Local wall-clock minutes past midnight in `timezone`. */
  times: number[];
  timezone: string;
  deliveryTargets: DigestDeliveryTarget[];
  nextRunAt: string | null;
  lastDeliveredAt: string | null;
}

export interface DigestDeliveryTarget {
  type: AutomationDeliveryTargetType;
  connectionId: string | null;
  displayName: string;
  status: 'active' | 'needs_input' | 'disabled';
  lastDeliveredAt: string | null;
}
