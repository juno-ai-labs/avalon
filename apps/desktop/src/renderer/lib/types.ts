import type {
  AgentModelOverride,
  AutomationAttentionReason as ContractAutomationAttentionReason,
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
  ResourceDirection,
  ResourceRelationshipType,
} from '@rally/contracts';
import type { PluginGroupIcon } from './plugin-groups';

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
/**
 * Why an automation needs a person to look at it. Absent on the ones nothing is
 * wrong with, which is nearly all of them. `automationAttentionNotice` in
 * `automation-attention.ts` owns the words each reason is shown as.
 */
export type AutomationAttentionReason = ContractAutomationAttentionReason;
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

export interface MessageAuthor {
  id: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  timezone?: string;
  role?: string;
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
  /** Set only when something is wrong that the status cannot say on its own. */
  attention?: AutomationAttentionReason;
  nextRunAt?: string;
  lastRunAt?: string;
  /** Last time the automation itself changed — a draft's only activity. */
  updatedAt: string;
  statusMessage?: string;
}

/**
 * One automation in a work stream's context rail.
 *
 * The sidebar summary without its scope: every row in that rail belongs to the
 * work stream showing it, and `Scope` has no value that could say so.
 */
export type WorkstreamAutomationSummary = Omit<AutomationSummary, 'scope'>;

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
   * people in it. Workspace-scoped rows show a public marker; personal rows
   * show a facepile of the other people in `participantUserIds`.
   */
  scope: VisibilityScope;
  /**
   * People in a personal work stream, newest first, capped for the sidebar
   * facepile. Empty when the row is workspace-scoped. The desktop omits the
   * current viewer when painting, so a pile of only that viewer is not shown.
   */
  participantUserIds: string[];
  /** How many participants sit past the three ids in `participantUserIds`. */
  participantExtraCount: number;
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
  /**
   * The short alias the model reads in its tool results, or null before one is
   * allocated. Citations may name a resource by it; everything else — the
   * rail's detail, every tool argument — uses `id`.
   */
  slug?: string | null;
  title: string;
  resourceType: string;
  provider?: string;
  mimeType?: string;
  canonicalUrl?: string;
  refreshSupported: boolean;
  watchEnabled: boolean;
  watchStatus: 'watching' | 'paused' | 'unsupported' | 'error';
  updatedAt?: string;
  contentAvailable?: boolean;
  sizeBytes?: number;
  currentVersion: number;
  relationshipType: ResourceRelationshipType;
  direction: ResourceDirection;
}

/**
 * Who moved a resource's content into the state a version holds.
 *
 * Null where the version predates provenance or its producer records none;
 * the rail says a version is unattributed rather than naming someone.
 */
export type { ResourceVersionAuthor, ResourceVersionCause } from '@rally/contracts';
import type { ResourceVersionAuthor, ResourceVersionCause } from '@rally/contracts';

export interface ResourceVersion {
  version: number;
  capturedAt: string;
  author: ResourceVersionAuthor | null;
  cause: ResourceVersionCause | null;
  contentAvailable: boolean;
  /** The title and type this version held, which a later one may have changed. */
  title: string;
  mimeType: string | null;
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
  /** API states only; `missing` is derived by the renderer from an empty resolved list. */
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
  /**
   * The canonical transcript's own owner id — `rally:memory`,
   * `connection:<uuid>` — which is what decides the row this tool folds into.
   * Absent until the call starts: a planned block does not yet name its owner.
   */
  pluginId?: string;
  /** The owning plugin activity's label, when the transcript carries one. */
  pluginName?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * One plugin's share of an agent loop, as the feed shows it: a name, a glyph,
 * and the time that plugin has been working. It replaces the tool rows it was
 * built from — the tools themselves are detail this audience does not read.
 */
export interface PluginActivityData {
  /** Stable within one agent loop; two plugins that share it share a row. */
  groupKey: string;
  name: string;
  icon: PluginGroupIcon;
  /** True while any tool call in this group is still running. */
  active: boolean;
  /**
   * Completed time accumulated across every turn of this agent loop.
   *
   * Null means the timing could not be established, not that the work was
   * instant. The row renders no duration at all in that case: a transcript
   * that cannot see how long a plugin ran has to say nothing rather than
   * claim `0ms`, which is what it used to do whenever one of the joins behind
   * this number missed.
   */
  durationMs: number | null;
  /**
   * One local monotonic start per contribution still running.
   *
   * Plural because a batch's tool calls run concurrently in Bind, so two
   * first-party plugins in the Rally group are active at the same time and the
   * row's completed total counts both. A single start would advance the live
   * number by one of them and let it jump to the real total at settle.
   */
  monotonicStartedAt?: readonly number[];
  timingAccuracy?: 'observed' | 'upper_bound';
  /** How the row reads; see `PluginGroup` for why a group owns its phrasing. */
  activeVerb: string;
  completedVerb: string;
}

export interface ThoughtEventData {
  status: 'started' | 'completed';
  /**
   * Completed model-inference time accumulated across this turn.
   *
   * Nullable for the same reason a plugin row's is: null is an unknown
   * duration, not a zero one, and a row that cannot prove a time renders
   * without one. Today's producers always supply a number; the type admits the
   * unknown case so a caller cannot quietly turn it into `0ms` later.
   */
  durationMs: number | null;
  /** Client receipt time for the currently streaming inference attempt. */
  startedAt?: number;
  monotonicStartedAt?: number;
  timingAccuracy?: 'observed' | 'upper_bound';
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
  /** Ordered-transcript sequence. Present only on canonical transcript rows. */
  transcriptSequence?: number;
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
  author?: MessageAuthor;
  externalActor?: ExternalActor;
  messageType:
    | 'text'
    | 'thought'
    | 'tool_event'
    | 'plugin_activity'
    | 'elicitation'
    | 'system'
    /**
     * An automation's result, delivered into the work stream that owns it. It
     * renders as an ordinary message authored by "Automation" — the row a
     * colleague's message gets, with a different name in the author slot — so
     * nothing but the author line and this type distinguishes it.
     */
    | 'automation_activation';
  text?: string;
  contextLabel?: string;
  mentions?: MessageMention[];
  attachments?: MessageAttachment[];
  createdAt: string;
  streaming?: boolean;
  deliveryState?: 'sending' | 'steer_pending' | 'queue_pending';
  /**
   * Sequence-owning placeholder for a canonical turn whose blocks exceed the
   * realtime frame budget and are deliberately not delivered.
   */
  blocksOmittedPlaceholder?: boolean;
  statusEvent?: {
    kind: 'assistant_turn_failed' | 'assistant_turn_stopped';
    code: string;
  };
  /**
   * Set on the system row proposing an automation an agent drafted here. The
   * room decides; the row renders as a card with what it would create.
   */
  draftProposed?: {
    automationId: string;
    automationName: string;
    description: string;
    triggerSummaries: string[];
    suggestedScope: 'personal' | 'workspace' | 'workstream';
    ready: boolean;
  };
  /**
   * Set on the system row telling this room that the person an automation runs
   * as has lost access. The row renders as a card with one action rather than
   * as prose, because there is something to do about it.
   */
  principalUnavailable?: {
    automationId: string;
    automationName: string;
    outgoingUserName: string | null;
    unreachableProviders: string[];
  };
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
  pluginActivity?: PluginActivityData;
  /**
   * A settled response's total work, shown beside the author and time.
   *
   * While Rally is still working this is a row of its own, because it is the
   * live progress the reader is watching. Once it settles it stops being
   * progress and becomes a fact about the message it produced, so it moves
   * into that message's header rather than leaving a spent timer sitting in
   * the feed under the answer.
   */
  workSummary?: {
    durationMs: number | null;
    timingAccuracy?: 'observed' | 'upper_bound';
  };
  elicitation?: ElicitationData;
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
  transcriptTurnId?: string;
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
  /** The server has durably recorded a stop for the next safe boundary. */
  stopRequested?: boolean;
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
}

export interface WorkstreamBoot extends WorkstreamDetail {
  transcript: WorkstreamTranscriptSnapshot;
}

export interface WorkstreamDeferredContext {
  backgroundTasks: BackgroundTask[];
  automationRuns: AutomationRunSummary[];
  automationSubscription?: WorkstreamAutomationSubscription;
}

export interface CreatedWorkstream {
  workstream: WorkstreamSummary;
  /** Canonical identity of the opening conversation turn. */
  turnId: string;
  clientMessageId: string;
  createdAt: string;
  /**
   * The run the opening turn started. Seeded into the work stream's detail so
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
  /** The server will send the initial replay or snapshot during the upgrade. */
  subscriptionBootstrap?: boolean;
}

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
