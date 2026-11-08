import type { ImportedMessageProvenance } from "@rally/contracts";
import type { ConnectorConnectionCardInput, WorkstreamAppearance } from '@rally/contracts';
import type {
  AgentModelOverride,
  AutomationDraft as ContractAutomationDraft,
  SidekickDelegationAttentionCode,
  AutomationLifecycleState as ContractAutomationLifecycleState,
  AutomationPluginActivity,
  AutomationRunStatus as ContractAutomationRunStatus,
  Scope as ContractScope,
  GitHubRepositoryAccessSettings as ContractGitHubRepositoryAccessSettings,
  TerminalWorkspaceSettings as ContractTerminalWorkspaceSettings,
  TerminalNetworkPolicyPreview as ContractTerminalNetworkPolicyPreview,
  TerminalWorkstreamState as ContractTerminalWorkstreamState,
  WorkstreamTranscriptSnapshot,
  ResourceDirection,
  ResourceRelationshipType,
  CanvasSummary,
  SidekickAudience,
} from '@rally/contracts';
import type { PluginGroupIcon } from './plugin-groups';

/** The OpenRouter model ids a composer may pin work to. Re-exported so the
 *  renderer keeps one import site for the shapes it speaks to the API in. */
export type { AgentModelOverride };
export type TerminalWorkspaceSettings = ContractTerminalWorkspaceSettings;
export type TerminalNetworkPolicyPreview = ContractTerminalNetworkPolicyPreview;
export type TerminalWorkstreamState = ContractTerminalWorkstreamState;
export type GitHubRepositoryAccessSettings = ContractGitHubRepositoryAccessSettings;

export type { Region } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts/regions";
/** How a connection or automation is owned, in the words the UI uses for it. */
export type Scope = 'you' | 'workspace';
/**
 * Who may read an object — `personal` is the people in it, `workspace` is
 * everyone. Work streams use this vocabulary, which is the
 * server's, so "private" means the same thing on both.
 */
export type VisibilityScope = ContractScope;
export type AutomationStatus = 'active' | 'paused' | 'draft';
export type AutomationLifecycleState = ContractAutomationLifecycleState;
export type AutomationRunStatus = ContractAutomationRunStatus;
/** The definition an automation's conversation has submitted, as the wire carries it. */
export type AutomationDefinition = ContractAutomationDraft;

export type { HarnessStatus, WorkspaceMember } from '@rally/ui/lib/types';
import type { HarnessStatus, WorkspaceMember } from '@rally/ui/lib/types';

export interface MessageAuthor {
  id: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  timezone?: string;
  role?: string | null;
  accessClass?: "member" | "guest";
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

/** Who can see an automation and who may change it, in the words the UI uses. */
export type AutomationScope = 'you' | 'workspace';

export interface AutomationSummary {
  loadable?: boolean;
  /**
   * The chosen icon and colour, from the same catalog a work stream picks
   * from. Absent until somebody chooses, which is when the glyph falls back to
   * the mark derived from the Sidekick's id.
   */
  appearance?: WorkstreamAppearance;
  id: string;
  name: string;
  description: string;
  emailAddress?: string;
  scope: AutomationScope;
  status: AutomationStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  /** Last time the automation itself changed — a draft's only activity. */
  updatedAt: string;
  /** Sidebar rows only: unread in its shared conversation, waiting on input, and its place in the Pinned group. */
  unread?: boolean;
  needsInput?: boolean;
  pinnedPosition?: number | null;
  /** Who it is shared with; absent from a server that predates it. */
  audience?: SidekickAudience;
  /** Its newest run's live state, when one is live; absent from a server that predates it. */
  runState?: 'working' | 'needs_input' | null;
  /** Any of its runs is working now, whichever is newest; absent from a server that predates it. */
  running?: boolean;
  /** The question a run waiting on input asked; absent when none waits. */
  pendingQuestion?: string | null;
  /** What wakes it, each kind once in definition order; absent from a server that predates it. */
  triggerKinds?: Array<'manual' | 'schedule' | 'external_event' | 'inbound_email'>;
  /** The IANA zone `nextRunAt` is read in (its schedule's); absent for an interval, no schedule, or an older server. */
  scheduleTimeZone?: string;
}

export interface WorkstreamSummary {
  resolved?: boolean;
  appearance?: WorkstreamAppearance;
  id: string;
  /** Workspace-owned visit; undefined means legacy metadata, null means unvisited. */
  lastAccessedAt?: string | null;
  title: string;
  /** `naming` while Rally is choosing the title; the title is a placeholder. */
  titleStatus: 'naming' | 'automatic' | 'settled';
  objective?: string;
  emailAddress?: string;
  createdByUserId?: string;
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
  /** See `WorkstreamSchema.isParticipant`. */
  isParticipant?: boolean;
  firstUnreadSequenceNumber: number | null;
  lastActivityAt: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
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
  /**
   * Client only, never sent by the server: this window has asked for this
   * Channel under its final id and the create has not answered yet. The row
   * is drawn and cannot be acted on. See `addPendingWorkstream`.
   */
  pending?: true;
  /**
   * Client only: what is creating this pending row when it is not the
   * launcher. An import's row opens on an "Importing" screen until it lands.
   */
  pendingOrigin?: 'import';
  /**
   * Client only: the opening message as the transcript will draw it, with its
   * mention chips and attachments, so the pending screen shows the message
   * the person sent rather than its bare text.
   */
  pendingOpening?: PendingOpening;
  /**
   * Client only: the server has described this pending row, so its fields are
   * the server's and newer than the create's own answer. See
   * `confirmPendingWorkstream`.
   */
  pendingListed?: true;
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
  /** The name the server resolved for a member or a connector author, when it has one. */
  authorName: string | null;
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
  complete?: boolean;
  items: WorkstreamResource[];
  nextCursor: string | null;
}

export interface WorkstreamConnection {
  id: string;
  modelPluginId: string;
  connectorType: string;
  displayName: string;
  scope: Scope;
  ownerUserId?: string;
  ownerName?: string;
  /** API states only; `missing` is derived by the renderer from an empty resolved list. */
  status: 'healthy' | 'reconnect_required' | 'disabled';
  capabilities?: string[];
  settingsKind?: 'github_repository_access' | 'custom_mcp_tools';
  /** Set when this connection can hand automation results to the signed-in user. */
  userDelivery?: AutomationUserDelivery;
  /**
   * Agent tools this connection exposes, as `GET /connections` reported it.
   * Absent when the server has no count to give, which is never the same as
   * zero; `toolCountMissing` then says why, when the region reports it.
   */
  toolCount?: number;
  toolCountMissing?: 'disabled' | 'connector_unavailable' | 'counting' | 'not_counted';
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
  /**
   * The tool's own wire name, when the row can say it.
   *
   * `name` is what the row would *display*, and a live invocation carries the
   * activity's prose there — "Messaging a teammate", not `send_message`. Any
   * decision keyed on which tool ran has to read this instead, or it works
   * only after canonical reconciliation replaces the row: the counted
   * agent-message rows did exactly that, appearing a beat late while the live
   * row sat on the generic plugin row and then jumped.
   */
  wireName?: string;
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
  connectorType?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * One strand of an agent loop, as the feed shows it: a name, a glyph, and how
 * much of it there was. It replaces the rows it was built from — the tool calls
 * themselves are detail this audience does not read.
 *
 * Named for the plugin rows it was introduced for, and since widened: a strand
 * is any run of adjacent rows a reader has one question about. Messages to and
 * from a background agent are two more, and they answer that question with a
 * count rather than a duration — see `count` and `PluginGroup.countPhrase`.
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
  /**
   * How many contributions this row stands for, on a group that is counted
   * rather than timed.
   *
   * Absent on a timed row, which is every plugin: a count of Slack calls is the
   * mechanism the row exists to hide, and printing one would put the tool
   * names' own detail back in the feed under a different spelling. Present only
   * where the count *is* the fact — a message either happened or it did not —
   * and there `durationMs` is null, so the row prints the phrase alone.
   */
  count?: number;
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
  /**
   * One local monotonic start per still-running segment this row stands for.
   *
   * A projected row has exactly one. A collapsed run of thinking rows has as
   * many as it summed, for the same reason a plugin group does: its total
   * counts every segment, so the live number has to advance by every one of
   * them or it jumps to the real figure the moment they settle.
   */
  monotonicStartedAt?: number | readonly number[];
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
  status: 'open' | 'answered' | 'cancelled';
  answer?: unknown;
  answeredByName?: string;
  createdAt?: string;
  /** A question a connection answers: the panel shows the card that makes it. */
  connection?: ConnectorConnectionCardInput;
}

/** A thread's opening message before the room has it; see `pendingOpening`. */
export interface PendingOpening {
  text: string;
  mentions: MessageMention[];
  attachments: MessageAttachment[];
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

/**
 * A settled stretch of work, and how well its duration is known.
 *
 * One shape rather than two identical ones, because the total genuinely moves
 * between the two places it can be printed — a message header (`workSummary`)
 * and the accordion over the run that produced it (`workAccordion`) — and
 * `workSummaryLabel` renders either from the same fields. Two structurally
 * identical literals would let a field added to one drift away from the other
 * while still type-checking at that call, which is the accident this name
 * exists to prevent.
 *
 * `durationMs` is null where there is no honest total: one the transcript could
 * not establish, or a stretch holding a row that cannot say *when* it worked,
 * which is what a stretch's own total is unioned from — the rows inside
 * overlap, so summing their durations would overstate it. Both read as a plain
 * "Worked".
 */
export interface WorkTotal {
  durationMs: number | null;
  timingAccuracy?: 'observed' | 'upper_bound';
}

/**
 * One settled stretch of wall clock a row's work occupied.
 *
 * A duration says how long a row worked; this says *when*, which is the one
 * thing a set of rows can be added up by without counting the same second
 * twice. Two plugins in a batch run at the same time, and a plugin row covers
 * the gaps between its own calls that the thinking row beside it is filling —
 * so a drawer holding both of them is worth the union of these, never the sum
 * of their durations. `workSpans` on a row is what that union is taken over.
 *
 * Milliseconds since the epoch, on the authority's clock rather than this
 * machine's: only the difference between two of them is ever read, and both
 * come from the same transcript.
 */
export interface WorkSpan {
  startedAtMs: number;
  endedAtMs: number;
  /**
   * Set where the interval's boundary was recovered rather than observed.
   *
   * It rides on the span because a span can outlive the row's own aggregate:
   * a plugin group assembled from tool rows alone — the fallback for a run
   * whose plugin activity never arrived — has no aggregate accuracy to read,
   * and a stretch holding it would otherwise print a recovered duration as an
   * exact one.
   */
  timingAccuracy?: 'observed' | 'upper_bound';
}

export interface Message {
  annotationContent?: Record<string, unknown> | undefined;
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
    | 'automation_activation'
    /**
     * One finished stretch of a run's machinery, folded behind the answer it
     * produced. Carries no work of its own: `workAccordion.rows` holds the
     * plugin and thinking rows it swallowed, and the reader opens it to see
     * them.
     */
    | 'work_accordion';
  text?: string;
  contextLabel?: string;
  importProvenance?: ImportedMessageProvenance;
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
  /**
   * Set on the first row after a stretch of transcript this client has not
   * loaded.
   *
   * A snapshot's coverage is not one interval: the opening one commonly holds
   * an unread island and a separate latest island, and the projection flattens
   * both into one list. Two rows either side of that seam look adjacent and are
   * not — anything between them, a sentence from Rally included, is simply
   * absent. Every pass that reasons about a *run* of adjacent rows has to stop
   * at this flag, or it will join work across turns nobody has seen.
   */
  precededByTranscriptGap?: boolean;
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
    suggestedScope: 'personal' | 'workspace';
    ready: boolean;
  };
  /**
   * Set on an activation row: which Sidekick delivered this result, under the
   * name frozen at delivery. The author slot reads it instead of the generic
   * 'Sidekick' label.
   */
  automationActivation?: {
    automationId: string;
    automationName: string;
    /** The run behind it, which is also its substream under the Sidekick. */
    runId?: string;
    trigger?: 'manual' | 'schedule' | 'external_event' | 'inbound_email';
    /** Present on a run's own row in its Sidekick's shared conversation: the run as it stands. */
    run?: {
      state: 'pending' | 'running' | 'needs_input' | 'completed' | 'failed' | 'stopped';
      stepCount: number;
      reply: string | null;
    };
    /**
     * Who started the run (null for a trigger's) and its ordinal among its
     * Sidekick's runs (null until numbered), from the row's block
     * (`sidekickRun`); absent from a server that predates them.
     */
    requesterUserId?: string | null;
    runNumber?: number | null;
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
   *
   * It is printed there when the run left no machinery above the answer to fold,
   * and when the run narrated itself into several stretches — several
   * accordions, no one of which is the whole of what this total measured. Where
   * the run produced exactly one accordion, that accordion *is* the whole run,
   * and `collapseSettledWorkIntoAccordion` moves this total onto it so the
   * header carries nothing.
   */
  workSummary?: WorkTotal;
  /**
   * When this row's work happened, where the transcript can prove it.
   *
   * Set on the machinery rows — thinking, plugin activity, and the tool rows a
   * plugin group is built from — and carried through the grouping passes, so a
   * grouped row holds every span it swallowed. Absent means the timing of this
   * row could not be established, not that it took no time: the activity it
   * would come from never reached this snapshot, or is still running. A folded
   * stretch holding one such row therefore reports no total at all rather than
   * a number missing however long that row took.
   *
   * The response's own timer deliberately has none. Its span covers the whole
   * response, so a drawer that swallowed it would union to the entire run and
   * claim it for one stretch of it — the same overstatement `workAccordion`
   * exists to avoid, arrived at from the other direction.
   */
  workSpans?: readonly WorkSpan[];
  /**
   * The finished run's machinery, and the total that stands for it.
   *
   * Set on a `work_accordion` row, which sits where the stretch's first row sat
   * — directly above the answer that stretch produced. Where the stretch is the
   * response's only one, the total is that answer's `workSummary`, moved here
   * rather than copied: a duration printed twice, once on the accordion and
   * once in the header a line below it, is the same fact competing with itself.
   *
   * The rows it swallowed are nested rather than left in the feed, because the
   * transcript is virtualized: a collapse that only hid its rows would still
   * cost one measured item each, and an opened one would grow N items whose
   * heights the cache has to be told about individually. One row, one
   * measurement, one thing to remember about it.
   */
  workAccordion?: WorkTotal & { rows: Message[] };
  elicitation?: ElicitationData;
  /**
   * On an answered question's own row (the asker's turn): the person's answer
   * has its own row after it, so this row draws the question alone. Without
   * it, until the answer's turn lands, the row draws the answer under the
   * question.
   */
  elicitationAnswerFollows?: boolean;
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

/**
 * One run of an automation. Its id is also the run's substream under the
 * automation, which is where its transcript lives.
 */
export interface AutomationRun {
  id: string;
  automationId: string;
  coordinatorUserId?: string | null;
  triggerType: 'manual' | 'schedule' | 'external_event' | 'inbound_email';
  status: AutomationRunStatus;
  plannedFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resultSummary: string | null;
  createdAt: string;
  durationMs?: number;
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
  latestHarnessRunId?: string;
  latestHarnessRun?: HarnessRunMetadata;
  openElicitations?: ElicitationData[];
}

export interface WorkstreamBoot extends WorkstreamDetail {
  transcript: WorkstreamTranscriptSnapshot;
}

/** Every run always lands in Rally; these are the extra frozen destinations. */
export type AutomationDeliveryTargetType = 'slack_agent_dm' | 'email';
export interface AutomationDetail extends AutomationSummary {
  lifecycle: AutomationLifecycleState;
  authorUserId: string;
  runAsUserId: string;
  delegationAttention?: { code: SidekickDelegationAttentionCode; message: string } | null;
  /** The latest submitted definition, or null before the chat has submitted one. */
  currentDefinition: AutomationDefinition | null;
  currentDefinitionRevision: number;
  /** The revision that is running, or null while still a draft. */
  acceptedDefinitionRevision: number | null;
  runnable?: boolean;
  connectorBindings: Record<string, string>;
  /** One line per trigger of the current definition, or empty before one exists. */
  triggerSummaries: string[];
  recentRuns: AutomationRun[];
  /** The people a `people` Sidekick is shared with besides its author; empty otherwise. */
  sharedWithUserIds?: string[];
  /** The Canvases it writes that this reader may open, most recently active first. */
  canvases?: CanvasSummary[];
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


