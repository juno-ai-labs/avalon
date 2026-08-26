import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  AcknowledgeWorkstreamReadRequestSchema,
  AnswerElicitationRequestSchema,
  ClientSocketEventSchema,
  IdSchema,
  PersonalSocketEventSchema,
  SubstreamIdSchema,
  UserIdSchema,
  type Region,
  type SubstreamId,
  type UserId,
  type WorkspaceId,
  type WorkstreamId,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  ServerSocketEventSchema,
  SubstreamDirectSocketEventSchema,
  UpdateWorkstreamRequestSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamWorkflowInputSchema,
  type PersonalSocketEvent,
  type ServerSocketEvent,
  type User,
  type WorkstreamDetail,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { z } from "zod";

import {
  revocationClosesSocket,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  WorkstreamReaderAudienceSchema,
  type WorkstreamReaderAudience,
} from "../lib/audience-containment";
import {
  contextCompactionCheckpointHash,
  type ContextCompactionCheckpointIdentity,
} from "../lib/context-compaction-fence";
import {
  assertDurableObjectJurisdiction,
  durableObjectStubForWorkspace,
} from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { uuidV7 } from "../lib/uuid-v7";
import {
  AGENT_RUN_DISPATCH_LEASE_MS,
  SUBSTREAM_AGENT_RUN_DISPATCHES,
  claimAgentRunDispatch,
  deferAgentRunDispatch,
  nextAgentRunDispatchWakeUpAt,
  releaseAgentRunDispatchLeases,
  settleAgentRunDispatch,
} from "./agent-run-dispatch-queue";
import {
  HarnessRunMetricsSchema,
  recordHarnessRunObservation,
} from "../observability/harness-run-observability";
import {
  launchBlockDashboardRefresh,
} from "../services/block-dashboard-service";
import { diagnosticErrorCode, logError, logInfo, logWarn } from "../observability/logger";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  identityAttributes,
  inFlowSpan,
  noFlowSpan,
  type FlowSpan,
  type PerfFlow,
} from "../observability/tracing";
import {
  claimHarnessAttempt,
  reapStaleHarnessRuns,
  RunOwnershipLostError,
  terminalizeHarnessAttempt,
  terminalizeQueuedHarnessRun,
} from "../runtime/harness-run-runtime";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { createToolReceiptObjectPort, createToolReceiptPortFactory } from "../runtime/tool-receipt-port";
import {
  createBlockDashboardObjectPort,
  createBlockDashboardPortFactory,
} from "../runtime/block-dashboard-port";
import { runWorkstreamHarness, type WorkstreamHarnessResult } from "../services/integrations";
import { deliverAutomationResultEmail } from "../services/automation-email-service";
import { settleDigestRun } from "../services/digest-run-settlement";
import { SlackAgentService } from "../services/slack-agent-service";
import { refreshWorkstreamDescription } from "../services/workstream-description-service";
import { refreshWorkstreamName } from "../services/workstream-naming-service";
import {
  objectOwnsWorkstreamAuthorities,
  withLocalWorkstreamAuthorities,
  type LocalAuthorityExecutor,
} from "../runtime/local-authorities";
import { withWorkstreamRuntimeDatabase } from "../services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { TerminalObjectPortError } from "../services/terminal/object-port";
import { fireWorkstreamWakeup } from "../services/workstream-service";
import { loadWorkstreamWakeup } from "../services/workstream-wakeup-service";
import {
  WorkstreamBatchUpdateQueueMessageSchema,
  type WorkstreamBatchUpdateQueueMessage,
} from "../services/workstream-batch-update";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";
import type { WorkstreamRuntimeResourceAttacher } from "../services/workstream-object-client";
import {
  acceptsNewWorkstreamWork,
  permitsLegacyRuntimeDrain,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import {
  WorkstreamRegionalEffectAckSchema,
  type WorkstreamRegionalEffectEnvelope,
} from "./workstream-regional-effect";
import { substreamAgentName, workstreamDOName } from "./names";
import {
  BlockDashboardSourceRefreshRequestSchema,
  type BlockDashboardContextFence,
} from "./block-dashboard-protocol";
import {
  WorkstreamObjectStore,
  type PendingBlockDashboardRefresh,
} from "./workstream-object-storage";
import { WorkstreamTerminalStorage } from "./workstream-terminal-storage";
import { WorkstreamToolReceiptStorage } from "./workstream-tool-receipt-storage";
import {
  type ToolReceiptOperationRequest,
  ToolReceiptOperationRequestSchema,
} from "./workstream-tool-receipt-protocol";
import { WorkstreamBlockDashboardStorage } from "./workstream-block-dashboard-storage";
import { WorkstreamMessageStorage } from "./workstream-message-storage";
import {
  type MessageOperationRequest,
  MessageOperationRequestSchema,
  mutatesTranscript,
} from "./workstream-message-protocol";
import { WorkstreamHarnessRunStorage } from "./workstream-harness-run-storage";
import {
  type HarnessRunOperationRequest,
  HarnessRunOperationRequestSchema,
  mutatesRunState,
} from "./workstream-harness-run-protocol";
import { WorkstreamIdentityStorage } from "./workstream-identity-storage";
import {
  type IdentityOperationRequest,
  IdentityOperationRequestSchema,
  mutatesIdentity,
} from "./workstream-identity-protocol";
import { WorkstreamResourceStorage } from "./workstream-resource-storage";
import {
  type ResourceOperationRequest,
  ResourceOperationRequestSchema,
  mutatesInventory,
} from "./workstream-resource-protocol";
import { WorkstreamSchedulingStorage } from "./workstream-scheduling-storage";
import {
  type SchedulingOperationRequest,
  mutatesWakeups,
  SchedulingOperationRequestSchema,
} from "./workstream-scheduling-protocol";
import {
  type BlockDashboardOperationRequest,
  BlockDashboardOperationRequestSchema,
} from "./workstream-block-dashboard-protocol";
import {
  TerminalOperationRequestSchema,
  terminalOperationAffectsDirectory,
  type TerminalOperationRequest,
} from "./workstream-terminal-protocol";
import {
  WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
} from "./workstream-object-schema";
import {
  ScheduledDurableObject,
  type ScheduledAlarm,
} from "./scheduled-alarms";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  InitializeWorkstreamObjectInputSchema,
  WorkstreamObjectCreateMessageInputSchema,
  WorkstreamObjectCreateSuggestionInputSchema,
  WorkstreamObjectProductService,
} from "./workstream-object-product";
import {
  executeWorkstreamRuntimeSql,
  WorkstreamRuntimeSqlRequestSchema,
} from "./workstream-runtime-sql";
import { emitCorrelatedRunOutcome } from "../telemetry/run-outcome";
import { DurableAgentDrain, DurableAgentKeepAlive } from "./durable-agent-runtime";
import {
  objectPortRpcResult,
  responseToRpcResult,
  rpcResultBody,
  type DurableObjectRpcResult,
  type ObjectPortOutcome,
} from "./rpc-result";

export { applyActiveStreamCheckpointEvent, splitActiveStreamCheckpointText } from "./workstream-object-storage";

const SocketAttachmentSchema = z.object({
  connectionId: z.string().uuid(),
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
  userId: UserIdSchema,
  // Absent only on a socket accepted by a pre-command-gateway deployment. A
  // command on that socket triggers a normal reconnect for a fresh ticket.
  sessionId: z.string().min(1).max(200).optional(),
  connectedAt: z.string().datetime({ offset: true }),
  afterSequence: z.number().int().nonnegative(),
  subscribed: z.boolean().default(false),
  /** A `request_snapshot` from this socket is assembling; broadcasts skip it. */
  snapshotInFlight: z.boolean().default(false)
});

const BroadcastRequestSchema = z.object({
  event: z.unknown(),
  audienceUserId: IdSchema.optional(),
}).strict();
const RuntimeResourceRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  resourceId: IdSchema,
  attachedByUserId: IdSchema.nullable(),
  relationshipType: z.string().min(1).max(80).optional(),
}).strict();
const RuntimeSuggestionRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  input: WorkstreamObjectCreateSuggestionInputSchema,
}).strict();
const RuntimeReaderAudienceRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
}).strict();
const RuntimeBootstrapRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  generation: z.number().int().positive(),
}).strict();
const RuntimeDispatchRequestSchema = WorkstreamWorkflowInputSchema;
const AgentTerminalOutcomeSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed", "stopped"]),
  messageId: IdSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  metrics: HarnessRunMetricsSchema.optional(),
  cancellationReason: z.string().nullable().optional(),
}).strict();
type AgentTerminalOutcome = z.infer<typeof AgentTerminalOutcomeSchema>;
const AgentTimerRefreshRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
}).strict();
const ProductAuthSchema = z.object({
  sessionId: z.string().min(1).max(200),
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  region: z.enum(["global", "eu"]),
  role: z.enum(["owner", "admin", "member"]),
  // Absent: `sessionId` names a `sessions` row and is verified there.
  // `"connector"`: a connector ingress already verified the link that binds
  // this member on the message being delivered, `sessionId` is correlation
  // only, and the object verifies current membership instead — see
  // `connectorPrincipalAuth`.
  principal: z.literal("connector").optional(),
}).strict();
const ProductRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("initialize"), auth: ProductAuthSchema,
    input: InitializeWorkstreamObjectInputSchema }).strict(),
  z.object({ operation: z.literal("get"), auth: ProductAuthSchema }).strict(),
  z.object({ operation: z.literal("boot"), auth: ProductAuthSchema }).strict(),
  z.object({
    operation: z.literal("messages"),
    auth: ProductAuthSchema,
    limit: z.number().int().min(1).max(250),
    before: z.number().int().positive().optional(),
    after: z.number().int().nonnegative().optional(),
    around: z.number().int().positive().optional(),
  }).strict(),
  z.object({ operation: z.literal("update"), auth: ProductAuthSchema, input: UpdateWorkstreamRequestSchema }).strict(),
  z.object({ operation: z.literal("acknowledge_read"), auth: ProductAuthSchema, input: AcknowledgeWorkstreamReadRequestSchema }).strict(),
  z.object({ operation: z.literal("mark_unread"), auth: ProductAuthSchema }).strict(),
  z.object({ operation: z.literal("create_message"), auth: ProductAuthSchema,
    input: WorkstreamObjectCreateMessageInputSchema }).strict(),
  z.object({ operation: z.literal("add_participant"), auth: ProductAuthSchema, userId: IdSchema }).strict(),
  z.object({ operation: z.literal("remove_participant"), auth: ProductAuthSchema, userId: IdSchema }).strict(),
  z.object({ operation: z.literal("attach_resource"), auth: ProductAuthSchema, resourceId: IdSchema }).strict(),
  z.object({ operation: z.literal("detach_resource"), auth: ProductAuthSchema, resourceId: IdSchema }).strict(),
  z.object({ operation: z.literal("resolve_suggestion"), auth: ProductAuthSchema,
    suggestionId: IdSchema, action: z.enum(["accepted", "dismissed"]) }).strict(),
  z.object({ operation: z.literal("answer_elicitation"), auth: ProductAuthSchema,
    elicitationId: IdSchema, input: AnswerElicitationRequestSchema }).strict(),
  z.object({ operation: z.literal("stop"), auth: ProductAuthSchema }).strict(),
  z.object({ operation: z.literal("retry"), auth: ProductAuthSchema }).strict(),
]).superRefine((value, context) => {
  if (value.operation !== "messages") return;
  if ([value.before, value.after, value.around].filter((entry) => entry !== undefined).length > 1) {
    context.addIssue({ code: "custom", message: "Use only one transcript cursor" });
  }
});
/**
 * The flow a product operation belongs to. An operation outside the three
 * traced flows returns null and opens no spans, rather than being counted under
 * a flow it is not part of.
 */
function productRequestFlow(operation: SubstreamProductRequest["operation"]): PerfFlow | null {
  switch (operation) {
    case "initialize": return "workstream_create";
    case "create_message": return "workstream_message_send";
    case "get": case "boot": case "messages": return "workstream_open";
    default: return null;
  }
}

/**
 * What a socket's authorization query answers with. The analytics column is
 * absent on the development path, which selects only the role — optional here
 * rather than nullable so that shape stays legal.
 */
interface AuthRoleRow {
  role: AuthContext["role"];
  analytics_workspace_id?: string | null;
}

const RoomIdentitySchema = z.object({ workspaceId: WorkspaceIdSchema, workstreamId: WorkstreamIdSchema });
export type SubstreamProductRequest = z.infer<typeof ProductRequestSchema>;
export type SubstreamRuntimeResourceRequest = z.infer<typeof RuntimeResourceRequestSchema>;
export type SubstreamRuntimeSuggestionRequest = z.infer<typeof RuntimeSuggestionRequestSchema>;
export type SubstreamRuntimeBootstrapRequest = z.infer<typeof RuntimeBootstrapRequestSchema>;
export type SubstreamTimerRefreshRequest = z.infer<typeof AgentTimerRefreshRequestSchema>;
export type SubstreamPublishedEvent = z.infer<typeof RoomIdentitySchema> & {
  event: unknown;
  audienceUserId?: string;
};
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 512_000;
const MAX_SOCKET_SNAPSHOT_BYTES = 900_000;

const MAX_SOCKET_MESSAGE_PAGE_BYTES = 900_000;
const BLOCK_DASHBOARD_DEBOUNCE_MS = 1_200;
const BLOCK_DASHBOARD_MAX_DEBOUNCE_MS = 5_000;
const MAINTENANCE_RECHECK_MS = 5 * 60_000;
// Generous by design — the 10 GB object ceiling is the only hard bound. Spent
// dispatch and wake-up rows this old are consumed intents whose idempotency
// windows closed with their runs; the runs table keeps the durable record.
const OPERATIONAL_FENCE_RETENTION_MS = 180 * 24 * 60 * 60_000;
/** Matches the Agents SDK default, while keeping Avalon independent of it. */
const KEEP_ALIVE_INTERVAL_MS = 30_000;
/** `_internal_durable_alarms.kind` for a wake-up an agent run scheduled for itself. */
const AGENT_TIMER_ALARM_KIND = "agent_timer";
/**
 * Bound on the entries one sync writes.
 *
 * Comfortably above `MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM`, which is the real
 * cap: this exists so a table that somehow outgrew that limit costs a bounded
 * reconcile rather than an unbounded one.
 */
const AGENT_TIMER_ALARM_LIMIT = 100;
const BLOCK_DASHBOARD_REFRESH_EVENT_TYPES = new Set([
  "message_created",
  "stream_completed",
  "participant_added",
  "participant_removed",
  "resource_attached",
  "resource_updated",
  "elicitation_created",
  "elicitation_answered",
  "activity_suggestion_created",
  "activity_suggestion_resolved",
  "block_dashboard_configuration_updated",
]);

type SocketAttachment = z.infer<typeof SocketAttachmentSchema>;

export function isPersonalEventAudience(socketUserId: string, audienceUserId: string): boolean {
  return socketUserId === audienceUserId;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  timezone: string;
  created_at: string;
}

interface CompactionCheckpointRow extends Record<string, SqlStorageValue> {
  execution_principal_key: string;
  resource_visibility_fingerprint: string;
  checkpoint_template_version: number;
  run_id: string;
  compacted_through_sequence: number;
  messages_json: string;
  summary: string;
  model: string;
}

const textEncoder = new TextEncoder();

/**
 * Whether this event can have taken somebody's read access away.
 *
 * A work stream becoming `personal` narrows it to its participants, and losing
 * a participant narrows it again. Both are facts this object already holds in
 * its own SQL, which is what makes acting on them here different from the D1
 * membership read that was removed from this path: that one asked a question
 * only the revocation queue can answer, this one asks a question only this
 * object can.
 */
function retractsReadAccess(event: ServerSocketEvent): boolean {
  if (event.type === "workstream_scope_changed") return event.scope === "personal";
  return event.type === "participant_removed";
}

/**
 * Take a socket out of the room and close it.
 *
 * The attachment is marked unsubscribed first, which is what {@link
 * SubstreamAgent.broadcast} filters on. Closing alone would leave the guarantee
 * to the runtime — `send` on a closed socket throws, and that throw is caught —
 * so a disconnected reader would be spared the next frame by accident rather
 * than on purpose. On a privacy path that is the wrong place for the rule to
 * live.
 */
function disconnect(socket: WebSocket, code: number, reason: string): void {
  try {
    const attachment = SocketAttachmentSchema.safeParse(socket.deserializeAttachment());
    if (attachment.success) {
      socket.serializeAttachment({ ...attachment.data, subscribed: false } satisfies SocketAttachment);
    }
  } catch {
    // An unreadable attachment already fails the broadcast filter.
  }
  try {
    socket.close(code, reason);
  } catch {
    // Already gone; the runtime delivers the close separately.
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    createdAt: row.created_at
  };
}

export { substreamAgentName };

/**
 * This object's own name, or `null` while its identity is not yet fully its own.
 *
 * Split out from the object so the rule can be proved rather than reasoned
 * about. A `SubstreamAgent` is named by *two* durable facts — which work stream
 * it belongs to, and which external substream it is — and both have to be
 * present. An object holding only the first would otherwise take the main
 * child's name and answer self-calls addressed to a sibling out of its own
 * storage. `externalSubstreamId`'s `"0"` default is right where it is used as
 * *am I the main child?* and wrong here, which is why this takes the raw row.
 */
export function substreamSelfObjectName(
  region: Region,
  identity: { workspaceId: WorkspaceId; workstreamId: WorkstreamId } | null,
  externalSubstreamId: string | null,
): string | null {
  if (!identity || externalSubstreamId === null) return null;
  return substreamAgentName(
    region,
    identity.workspaceId,
    identity.workstreamId,
    asSubstreamId(externalSubstreamId),
  );
}

export function distinctNonParticipantViewers<T extends { userId: string; connectedAt: string }>(
  attachments: T[],
  participantIds: ReadonlySet<string>,
): T[] {
  const firstByUser = new Map<string, T>();
  for (const attachment of attachments) {
    if (participantIds.has(attachment.userId)) continue;
    const existing = firstByUser.get(attachment.userId);
    if (!existing || attachment.connectedAt < existing.connectedAt) {
      firstByUser.set(attachment.userId, attachment);
    }
  }
  return [...firstByUser.values()];
}

export type SocketReplayPlan =
  | { type: "snapshot"; reason: "initial" | "history_unavailable" }
  | { type: "replay"; events: ServerSocketEvent[] }
  | { type: "resync_required"; reason: "history_unavailable" | "sequence_ahead" };

/**
 * The replay window intentionally lives only in object memory. Persisting every
 * token event would turn an ephemeral optimization into storage write cost.
 * After hibernation, a stale client receives the current canonical snapshot on
 * the same socket. Only a client cursor ahead of the object's durable sequence
 * requires an out-of-band resync because a lower-sequence snapshot would be
 * rejected by the client's ordinary cursor guard.
 */
export function planSocketReplay(
  afterSequence: number,
  currentSequence: number,
  replayFloorSequence: number | null,
  recentEvents: readonly ServerSocketEvent[],
  allowSnapshot = true,
): SocketReplayPlan {
  if (afterSequence === 0 && allowSnapshot) {
    return { type: "snapshot", reason: "initial" };
  }
  if (afterSequence > currentSequence) {
    return { type: "resync_required", reason: "sequence_ahead" };
  }
  if (afterSequence === currentSequence) return { type: "replay", events: [] };
  if (replayFloorSequence === null || afterSequence < replayFloorSequence) {
    return allowSnapshot
      ? { type: "snapshot", reason: "history_unavailable" }
      : { type: "resync_required", reason: "history_unavailable" };
  }
  const events = recentEvents.filter((event) => event.sequence > afterSequence);
  if (events.length === 0 || events.at(-1)?.sequence !== currentSequence) {
    return allowSnapshot
      ? { type: "snapshot", reason: "history_unavailable" }
      : { type: "resync_required", reason: "history_unavailable" };
  }
  return { type: "replay", events };
}

/**
 * The hibernating realtime, loop, and storage authority for one substream.
 *
 * Main child `0` receives the guarded maintenance import from the historical
 * one-room-per-workstream object. After activation, every child's local SQL is
 * authoritative for its own transcript and loop state; REST is a recovery
 * surface, never a second writer.
 */
export class SubstreamAgent extends ScheduledDurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly recentEvents: ServerSocketEvent[] = [];
  private recentEventBytes = 0;
  private replayFloorSequence: number | null = null;
  /**
   * Not `readonly`, and not assigned in the constructor body: the store applies
   * this object's schema when it is constructed, and reporting a failed
   * migration needs an `await` before the throw escapes. All three are assigned
   * in the first, synchronous, statements of the `blockConcurrencyWhile`
   * callback below, which runs before the constructor returns and before any
   * handler can observe any of them — every one of them waits on `initialized`
   * first.
   */
  private objectStore!: WorkstreamObjectStore;
  /** This object's own `SUBSTREAM_AGENTS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  private product!: WorkstreamObjectProductService;
  private terminal!: WorkstreamTerminalStorage;
  private toolReceipts!: WorkstreamToolReceiptStorage;
  private blockDashboard!: WorkstreamBlockDashboardStorage;
  private scheduling!: WorkstreamSchedulingStorage;

  private messages!: WorkstreamMessageStorage;
  private resources!: WorkstreamResourceStorage;
  private identityRows!: WorkstreamIdentityStorage;
  private harnessRuns!: WorkstreamHarnessRunStorage;
  private readonly initialized: Promise<void>;
  private readonly keepAliveLease: DurableAgentKeepAlive;
  private readonly agentDrain = new DurableAgentDrain();
  /**
   * Whether the drain this alarm just ran left a run in someone else's hands.
   *
   * Read only by `armAlarmAfterDueWork`, and reset at the top of every alarm's
   * work: a deferral means the dispatch row is still due and still owned, so
   * re-deriving off it would arm for an instant already past.
   */
  private runDrainDeferred = false;
  private activeRunDispatch: { runId: string; leaseToken: string } | null = null;

  constructor(
    state: DurableObjectState,
    env: Env
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    // Everything downstream is handed this environment or one derived from it,
    // so a helper that addresses "the agent that owns this work stream" reaches
    // the object it is already running in rather than the namespace. See
    // `lib/durable-object-self.ts`.
    //
    // The parameter is rebound as well as the field, so the rest of this
    // constructor cannot hand the unregistered environment to something
    // long-lived. That is not hypothetical: `WorkstreamObjectProductService`
    // below keeps its environment for the object's whole life, and resolves
    // this work stream's own model routing through it.
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.SUBSTREAM_AGENTS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    this.keepAliveLease = new DurableAgentKeepAlive(async () => { await this.armNextAlarm(); });
    this.initialized = state.blockConcurrencyWhile(async () => {
      // The store applies this object's schema in its own constructor, so the
      // report wrapper goes around the construction rather than around a
      // migration call this class makes itself. It happens here rather than in
      // the constructor body only so that a failed migration can be reported
      // before the throw leaves this callback — the throw breaks the object's
      // input gate, and a report still in flight dies with it. The construction
      // itself is unchanged and still synchronous: this is the first statement
      // of a callback that `blockConcurrencyWhile` invokes immediately.
      this.objectStore = await this.applyMigrations(() => new WorkstreamObjectStore(
        state.storage,
        env.APP_VERSION ?? "unknown",
        env.AVALON_REGION,
      ));
      this.product = new WorkstreamObjectProductService(state.storage, this.objectStore, env);
      this.terminal = new WorkstreamTerminalStorage(state.storage);
      this.toolReceipts = new WorkstreamToolReceiptStorage(state.storage);
      this.blockDashboard = new WorkstreamBlockDashboardStorage(state.storage);
      this.scheduling = new WorkstreamSchedulingStorage(state.storage);
      this.messages = new WorkstreamMessageStorage(state.storage);
      this.resources = new WorkstreamResourceStorage(state.storage);
      this.identityRows = new WorkstreamIdentityStorage(state.storage);
      this.harnessRuns = new WorkstreamHarnessRunStorage(state.storage);
      await this.objectStore.waitUntilReady();
      // Existing one-room-per-workstream objects become the main child during
      // the maintenance cutover. A non-main child records its external id on
      // its first scoped request and may never change it afterward.
      if (this.objectStore.identity()) this.ensureSubstreamIdentity("0");
      // Whatever leases survive belong to the isolate this one replaced, so
      // the runs they cover are recoverable now rather than at expiry.
      releaseAgentRunDispatchLeases(
        this.state.storage.sql,
        SUBSTREAM_AGENT_RUN_DISPATCHES,
        Date.now(),
      );
      // A run left behind by a previous isolate is rediscovered here, by
      // arming the alarm rather than by starting a drain this constructor
      // cannot stay alive to finish. The full derivation runs rather than an
      // arm-only helper because the keep-alive lease is in-memory: a new
      // instance inherits none of it, so a heartbeat alarm left behind by the
      // evicted one has to be cleared when no durable work remains.
      this.syncAgentTimerAlarms();
      await this.armNextAlarm();
    });
    // Exact text ping/pong frames are answered by the runtime without waking a
    // hibernated object, so keepalives do not accrue Durable Object duration.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private ensureSubstreamIdentity(substreamId: string): void {
    const existing = this.state.storage.sql.exec<{ external_substream_id: string }>(
      `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
    ).toArray()[0];
    if (existing && existing.external_substream_id !== substreamId) {
      throw new Error("substream_agent_identity_mismatch");
    }
    if (existing) return;
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO substream_agent_identity
         (id, external_substream_id, created_at, updated_at)
       VALUES (1, ?, ?, ?)`,
      substreamId,
      now,
      now,
    );
  }

  /**
   * This object's own name in `SUBSTREAM_AGENTS`, or `null` before it has one.
   *
   * Memoized only once a name exists. Both durable facts are write-once — a
   * root identity is never rewritten, and `ensureSubstreamIdentity` refuses a
   * second external id — so a derived name cannot change, while a `null` has to
   * stay re-derivable because the facts arrive on the object's first scoped
   * request. Freezing a `null` would leave the object permanently unable to
   * recognize itself.
   *
   * The substream row is read here rather than through
   * {@link externalSubstreamId}, whose `"0"` default is right for its own
   * callers — they ask it *am I the main child?*, and an unwritten row reads as
   * yes — and wrong as a name. See {@link substreamSelfObjectName}.
   */
  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    // Genuinely absent, definite-assignment notwithstanding: the environment
    // carrying this object's self-registration exists from the first statement
    // of the constructor, and the store is built inside the callback below it.
    if (!this.objectStore) return null;
    // Guarded like every other object's name read. A throw here would not stay
    // local: the thunk runs inside `durableObjectSelfForId`, so a missing table would
    // take down *every* `SUBSTREAM_AGENTS` resolution this object makes,
    // including the sibling calls that have nothing to do with self-recognition.
    try {
      const substream = this.state.storage.sql.exec<{ external_substream_id: string }>(
        `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
      ).toArray()[0];
      this.objectName = substreamSelfObjectName(
        this.env.AVALON_REGION,
        this.objectStore.identity(),
        substream?.external_substream_id ?? null,
      );
    } catch {
      return null;
    }
    return this.objectName;
  }

  private externalSubstreamId(): SubstreamId {
    return asSubstreamId(this.state.storage.sql.exec<{ external_substream_id: string }>(
      `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
    ).toArray()[0]?.external_substream_id ?? "0");
  }

  /**
   * Keep this isolate warm while in-memory Bind work is active.
   *
   * This is the narrow, reference-counted mechanism used by the Agents SDK:
   * the first lease caps the shared alarm at 30 seconds, nested leases share
   * it, and the final idempotent disposer recomputes the alarm exclusively
   * from durable work. The count is intentionally in memory; an evicted
   * isolate also lost the computation it protected, and the durable dispatch
   * ledger is what restarts that computation.
   */
  /**
   * Bring this object up, and nothing else.
   *
   * Awaiting `initialized` is the whole point: it runs the migrations and the
   * schema work that make the first real call slow. WorkstreamDO fires this as
   * it wakes so the two cold starts overlap instead of queueing, because a
   * person opening a work stream needs both objects and today pays for them one
   * after the other. Deliberately without side effects — it must stay something
   * that is free to call on an object nobody has asked for yet.
   */
  async wake(): Promise<void> {
    await this.initialized;
  }

  async keepAlive(): Promise<() => void> {
    return this.keepAliveLease.keepAlive();
  }

  async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    return this.keepAliveLease.while(fn);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/socket" || url.pathname === "/")) {
      return this.acceptSocket(request, url);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/internal/events" || url.pathname === "/events")
    ) {
      return this.acceptEvent(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/regional-effect-ack") {
      return this.acceptRegionalEffectAck(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/regional-effect-delivery") {
      return this.readRegionalEffect(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/product") {
      return this.acceptProductRequest(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/runtime-sql") {
      return this.acceptRuntimeSql(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/tool-receipt") {
      return this.acceptToolReceiptOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/scheduling") {
      return this.acceptSchedulingOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/messages") {
      return this.acceptMessageOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/resources") {
      return this.acceptResourceOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/harness-runs") {
      return this.acceptHarnessRunOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/identity") {
      return this.acceptIdentityOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/block-dashboard") {
      return this.acceptBlockDashboardOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/terminal") {
      return this.acceptTerminalOperation(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/runtime-resource") {
      return this.acceptRuntimeResource(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/runtime-suggestion") {
      return this.acceptRuntimeSuggestion(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/runtime-bootstrap") {
      return this.acceptRuntimeBootstrap(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/run-dispatch") {
      return this.acceptRunDispatch(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/block-dashboard-refresh-request") {
      const parsed = BlockDashboardSourceRefreshRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      const identity = this.objectStore.identity();
      if (!parsed.success || !identity
        || identity.workspaceId !== parsed.data.workspaceId
        || identity.workstreamId !== parsed.data.workstreamId
        || this.externalSubstreamId() !== "0") {
        return jsonResponse({ error: "block_dashboard_source_identity_mismatch" }, 409);
      }
      await this.scheduleBlockDashboardRefresh(parsed.data.triggerSequence);
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/refresh-agent-alarm") {
      const parsed = AgentTimerRefreshRequestSchema.safeParse(await request.json().catch(() => null));
      const identity = this.objectStore.identity();
      if (!parsed.success || !identity
        || identity.workspaceId !== parsed.data.workspaceId
        || identity.workstreamId !== parsed.data.workstreamId) {
        return jsonResponse({ error: "substream_timer_identity_mismatch" }, 409);
      }
      try {
        this.ensureSubstreamIdentity(parsed.data.substreamId);
        this.syncAgentTimerAlarms();
        await this.armNextAlarm();
        return jsonResponse({ ok: true });
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : "substream_timer_refresh_failed",
        }, 409);
      }
    }

    if (request.method === "GET" && url.pathname === "/presence") {
      const identity = this.objectStore.identity();
      if (!identity) return jsonResponse({ viewers: [] });
      return jsonResponse({
        viewers: await this.loadViewers(identity.workspaceId, identity.workstreamId),
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        sockets: this.state.getWebSockets().length,
        schema: "workstream-do-v2",
        databaseBytes: this.objectStore.databaseSize(),
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  /**
   * `traced` says whether the caller is inside one of the three work-stream
   * flows. Nothing about the trace itself is passed: a Durable Object call is a
   * traced binding call, so the spans this opens are already children of the
   * caller's by async context. The flag only decides whether to open them.
   */
  async handleProductRequest(
    input: SubstreamProductRequest,
    traced = false,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptProductRequest(this.rpcRequest(input), traced));
  }

  /**
   * Trusted regional Queue delivery for one member-initiated batch mutation.
   * The HTTP request authenticated the person before enqueue; delivery rechecks
   * active workspace membership, but deliberately does not depend on the login
   * session still being alive after the durable handoff.
   */
  async applyQueuedBatchUpdate(input: WorkstreamBatchUpdateQueueMessage) {
    await this.initialized;
    const request = WorkstreamBatchUpdateQueueMessageSchema.parse(input);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.workstreamId !== request.workstreamId
      || this.externalSubstreamId() !== "0"
      || request.region !== this.env.AVALON_REGION) {
      return { outcome: "skipped" as const, reason: "workstream_identity_mismatch" };
    }
    const membership = await this.activeMembership(
      asWorkspaceId(request.workspaceId),
      asUserId(request.userId),
    );
    if (!membership) return { outcome: "skipped" as const, reason: "member_revoked" };
    const auth: AuthContext = {
      sessionId: `batch:${request.operationId}`,
      userId: asUserId(request.userId),
      workspaceId: asWorkspaceId(request.workspaceId),
      region: this.env.AVALON_REGION,
      role: membership.role,
      analyticsWorkspaceId: membership.analytics_workspace_id ?? null,
    };
    try {
      const outcome = await this.product.applyQueuedBatchUpdate(auth, request);
      return { outcome, reason: null };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return { outcome: "skipped" as const, reason: error.code };
      }
      throw error;
    }
  }

  async executeRuntimeSql(
    input: z.input<typeof WorkstreamRuntimeSqlRequestSchema>,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeSql(this.rpcRequest(input)));
  }

  async attachRuntimeResource(input: SubstreamRuntimeResourceRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeResource(this.rpcRequest(input)));
  }

  /** Authoritative current readers for privacy decisions made outside this object. */
  async readerAudience(input: z.input<typeof RuntimeReaderAudienceRequestSchema>): Promise<WorkstreamReaderAudience | null> {
    await this.initialized;
    const request = RuntimeReaderAudienceRequestSchema.parse(input);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.workstreamId !== request.workstreamId
      || this.externalSubstreamId() !== "0") return null;
    return WorkstreamReaderAudienceSchema.parse(this.product.readerAudience());
  }

  async executeToolReceiptOperation(
    input: ToolReceiptOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptToolReceiptOperation(this.rpcRequest(input)));
  }

  async executeMessageOperation(input: MessageOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.messageOperationOutcome(input));
  }

  async executeResourceOperation(input: ResourceOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.resourceOperationOutcome(input));
  }

  async executeHarnessRunOperation(
    input: HarnessRunOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.harnessRunOperationOutcome(input));
  }

  async executeSchedulingOperation(
    input: SchedulingOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptSchedulingOperation(this.rpcRequest(input)));
  }

  async executeBlockDashboardOperation(
    input: BlockDashboardOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptBlockDashboardOperation(this.rpcRequest(input)));
  }

  async executeTerminalOperation(input: TerminalOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptTerminalOperation(this.rpcRequest(input)));
  }

  async createRuntimeSuggestion(input: SubstreamRuntimeSuggestionRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeSuggestion(this.rpcRequest(input)));
  }

  async bootstrapRuntime(input: SubstreamRuntimeBootstrapRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeBootstrap(this.rpcRequest(input)));
  }

  async executeIdentityOperation(input: IdentityOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.identityOperationOutcome(input));
  }

  async dispatchRun(input: WorkstreamWorkflowInput): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRunDispatch(this.rpcRequest(input)));
  }

  async publishEvent(input: SubstreamPublishedEvent): Promise<DurableObjectRpcResult> {
    await this.initialized;
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(RALLY_HEADERS.WORKSPACE_ID, input.workspaceId);
    headers.set(RALLY_HEADERS.WORKSTREAM_ID, input.workstreamId);
    return responseToRpcResult(await this.acceptEvent(new Request(
      "https://substream.internal/internal/events",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          event: input.event,
          ...(input.audienceUserId ? { audienceUserId: input.audienceUserId } : {}),
        }),
      },
    )));
  }

  async requestBlockDashboardRefresh(
    input: z.input<typeof BlockDashboardSourceRefreshRequestSchema>,
  ): Promise<{ accepted: boolean; error?: string }> {
    await this.initialized;
    const parsed = BlockDashboardSourceRefreshRequestSchema.parse(input);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== parsed.workspaceId
      || identity.workstreamId !== parsed.workstreamId
      || this.externalSubstreamId() !== "0") {
      return { accepted: false, error: "block_dashboard_source_identity_mismatch" };
    }
    await this.scheduleBlockDashboardRefresh(parsed.triggerSequence);
    return { accepted: true };
  }

  async refreshTimerAlarm(input: SubstreamTimerRefreshRequest): Promise<void> {
    await this.initialized;
    const parsed = AgentTimerRefreshRequestSchema.parse(input);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== parsed.workspaceId
      || identity.workstreamId !== parsed.workstreamId) {
      throw new Error("substream_timer_identity_mismatch");
    }
    this.ensureSubstreamIdentity(parsed.substreamId);
    this.syncAgentTimerAlarms();
    await this.armNextAlarm();
  }

  private rpcRequest(body: unknown): Request {
    return new Request("https://substream.internal/internal-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async acceptRuntimeSql(request: Request): Promise<Response> {
    const parsed = WorkstreamRuntimeSqlRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) return jsonResponse({ error: "invalid_workstream_runtime_sql" }, 400);
    let result: Awaited<ReturnType<typeof executeWorkstreamRuntimeSql>>;
    try {
      result = await executeWorkstreamRuntimeSql(
        this.state.storage,
        this.product,
        parsed.data,
      );
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error
        ? error.cause
        : error;
      logError(this.env, "workstream_runtime_sql_commit_failed", {
        workspace_id: parsed.data.workspaceId,
        workstream_id: parsed.data.workstreamId,
        harness_run_id: parsed.data.harnessRunId ?? null,
        request_id: parsed.data.requestId,
        statement_count: parsed.data.statements.length,
        code: "workstream_runtime_sql_not_committed",
        // `executeWorkstreamRuntimeSql` wraps a failed statement with its SQL
        // for the internal caller. Logs retain only the underlying SQLite
        // reason: statement text can contain tool input or participant data.
        reason: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack?.split("\n").slice(0, 6).join("\n") ?? null : null,
      });
      return jsonResponse({
        error: "workstream_runtime_sql_not_committed",
      }, 409);
    }
    // The SQL transaction is already durable. Returning an alarm failure would
    // tell the harness to repeat a receipt write that did commit. The active
    // run's dispatch sweep, a later request, and any committed directory effect
    // are the recovery paths for re-deriving the object's next alarm.
    try {
      // Wake-ups no longer arrive here — `/internal/scheduling` re-derives the
      // timer index off its own writes — so there is nothing to detect in this
      // statement text. Arming still happens, because other routed writes can
      // move an alarm this object owes.
      await this.armNextAlarm();
    } catch (error) {
      logError(this.env, "workstream_runtime_sql_alarm_schedule_failed", {
        workspace_id: parsed.data.workspaceId,
        workstream_id: parsed.data.workstreamId,
        harness_run_id: parsed.data.harnessRunId ?? null,
        request_id: parsed.data.requestId,
        statement_count: parsed.data.statements.length,
        code: "workstream_runtime_sql_alarm_failed_after_commit",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return jsonResponse(result);
  }

  /**
   * Run one Terminal operation against this work stream's own tables.
   *
   * Every storage method is synchronous — the object's SQLite API is — so the
   * whole operation runs inside this call with no interleaving. That is the
   * property the previous routed-SQL path could not offer: a load-then-claim
   * sequence crossed the Worker boundary between its two statements, so the
   * lease it took could be decided on state that had already moved.
   */
  /**
   * Settle one durable tool receipt inside the event that owns this object.
   *
   * No `commitRuntimeMutation` wrapper, unlike the Terminal endpoint: receipts
   * move no deadline `workspace_workstream_directory` projects, so there is no
   * `directory_common` effect to enqueue. That is asserted rather than assumed,
   * against this object's real outbox, in `test-workers/tool-receipt-authority.test.ts`
   * — with a publishing Terminal operation beside it as the control, because
   * inference is what let the Terminal port silently stop publishing once
   * already.
   */
  private async acceptToolReceiptOperation(request: Request): Promise<Response> {
    const outcome = await this.toolReceiptOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  private async toolReceiptOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = ToolReceiptOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_tool_receipt_operation" } };
    }
    const refusal = this.objectPortRefusal(
      parsed.data,
      "workstream_tool_receipt_identity_mismatch",
    );
    if (refusal) return refusal;
    const method = this.toolReceipts[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = method.apply(this.toolReceipts, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  /**
   * Refuse an object-port request the routed path would have refused.
   *
   * `executeWorkstreamRuntimeSql` checked two things before running a
   * statement: that this object is the one addressed, and that it is still the
   * work stream's authority. The typed endpoints kept the first and dropped the
   * second, so a write against a `preparing` or `quarantined` object now
   * commits where the routed statement was refused — which is the window that
   * fence exists for. The wake-up mutations kept an equivalent check by
   * accident, through `commitWithRegionalEffects`; nothing else did.
   *
   * `"0"` because every one of these ports addresses the main child: the rows
   * they own live there, and a non-main substream would answer from an empty
   * table rather than fail.
   */
  private objectPortRefusal(
    request: { workspaceId: string; workstreamId: string },
    identityMismatchCode: string,
  ): ObjectPortOutcome | null {
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.workstreamId !== request.workstreamId
      || this.externalSubstreamId() !== "0") {
      return { status: 409, payload: { ok: false, error: identityMismatchCode } };
    }
    if (!this.objectStore.isAuthoritative()) {
      return { status: 409, payload: { ok: false, error: "workstream_runtime_authority_fenced" } };
    }
    return null;
  }

  /**
   * Dispatch one scheduling operation against this object's own storage.
   *
   * `objectPortRefusal` runs first, so this endpoint refuses three things the
   * routed path refused: another work stream's identity, a non-main substream,
   * and an object whose `authority_mode` is not `authoritative`. The last one
   * matters most here. `persistCompactionCheckpoint`, `recordPluginActivation`
   * and the two description-evaluation writes are the first writes moved off
   * the routed path whose *only* fence was `executeWorkstreamRuntimeSql`
   * refusing every statement against a `preparing` or `quarantined` object —
   * the wake-up mutations keep an equivalent one through
   * `commitRuntimeMutation`, and these four would have had none.
   *
   * The non-main refusal is why the port names the main child and nothing
   * carries a substream id: these rows live on the main object, so a child
   * substream must be told so rather than served from an empty table.
   *
   * An operation that can change which wake-ups are pending runs through
   * `commitRuntimeMutation`, re-derives the timer index, and arms the next
   * alarm before answering — so a caller never has to remember to do any of it.
   *
   * All three used to be consequences of the routing. A wake-up write arrived
   * as SQL, and the object matched `workstream_wakeups` in the statement text
   * to decide both that the sidebar's next-wake-up marker had to be
   * republished and that the alarm index had to be re-derived. Naming the
   * operations replaces the regex; running the mutation inside
   * `commitRuntimeMutation` is what keeps the directory effect in the same
   * commit as the write, rather than a second write that could be lost after
   * the first one landed.
   */
  private async acceptSchedulingOperation(request: Request): Promise<Response> {
    const outcome = await this.schedulingOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  private async schedulingOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = SchedulingOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_scheduling_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_scheduling_identity_mismatch");
    if (refusal) return refusal;
    const method = this.scheduling[parsed.data.operation] as (...args: unknown[]) => unknown;
    const mutates = mutatesWakeups(parsed.data.operation);
    const value = mutates
      ? await this.product.commitRuntimeMutation(
        () => method.apply(this.scheduling, parsed.data.args),
        true,
      )
      : method.apply(this.scheduling, parsed.data.args);
    if (mutates) {
      this.syncAgentTimerAlarms();
      // Arming is best-effort, as it is in `acceptRuntimeSql` and
      // `runTerminalOperation`, and for the reason those two give: the
      // operation is already durable, so raising here would tell a caller its
      // committed write failed. The wake-up tool's own rollback would then
      // delete a row that was legitimately cancelled. The run's dispatch sweep,
      // any later request and the committed directory effect all re-derive the
      // alarm.
      try {
        await this.armNextAlarm();
      } catch (error) {
        logError(this.env, "workstream_scheduling_alarm_schedule_failed", {
          workspace_id: parsed.data.workspaceId,
          workstream_id: parsed.data.workstreamId,
          operation: parsed.data.operation,
          code: "workstream_scheduling_alarm_failed_after_commit",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  /**
   * Dispatch one transcript operation against this object's own storage.
   *
   * Every write here appends to the transcript a member reads, so it runs
   * inside `commitRuntimeMutation`: the row and the directory projection that
   * shows its preview are one commit. The routed path reached the same place by
   * matching `messages` in statement text, which is the rule this replaces.
   */
  private async acceptMessageOperation(request: Request): Promise<Response> {
    const outcome = await this.messageOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * The endpoint's body, with no `Request` or `Response` in the middle.
   *
   * Every port call made from inside this object resolves to itself through the
   * self-registration, and the RPC entry point marshalled its already-parsed
   * input into a `Request` so it could share the `fetch` handler, then read a
   * `Response` body back out. For a local call that is six serializations of
   * one value to move it nowhere — and the drain runs the description refresh
   * through this path at the end of every harness run, where it cost enough to
   * leave a dispatch queued past the end of the run.
   *
   * The module that hands out the self-registration says the point of it is
   * "the same object with the boundary removed". This is the rest of that.
   */
  private async messageOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = MessageOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_message_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_message_identity_mismatch");
    if (refusal) return refusal;
    const method = this.messages[parsed.data.operation] as (...args: unknown[]) => unknown;
    const mutates = mutatesTranscript(parsed.data.operation);
    const value = mutates
      ? await this.product.commitRuntimeMutation(
        () => method.apply(this.messages, parsed.data.args),
        true,
      )
      : method.apply(this.messages, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptHarnessRunOperation(request: Request): Promise<Response> {
    const outcome = await this.harnessRunOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * Dispatch one harness-run operation against this object's own rows.
   *
   * A claim runs inside `commitRuntimeMutation` because the sidebar renders a
   * work stream's harness status, and the routed claim batch wrote that as a
   * third statement guarded on the first having landed. Committing the
   * projection with the claim is what replaces the guard.
   */
  private async harnessRunOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = HarnessRunOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_harness_run_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_harness_run_identity_mismatch");
    if (refusal) return refusal;
    const method = this.harnessRuns[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = mutatesRunState(parsed.data.operation)
      ? await this.product.commitRuntimeMutation(
        () => method.apply(this.harnessRuns, parsed.data.args),
        true,
      )
      : method.apply(this.harnessRuns, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptResourceOperation(request: Request): Promise<Response> {
    const outcome = await this.resourceOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * Dispatch one resource-attachment operation against this object's own rows.
   *
   * The watch toggle runs inside `commitRuntimeMutation` for the reason the
   * transcript's appends do: the sidebar renders what a work stream is watching,
   * and a write whose directory projection is a second commit can lose it.
   *
   * The inventory revision is *not* advanced here, and that is deliberate:
   * `watch_enabled` does not change which resources a run is authorized to see,
   * which is what `inventory:<revision>` fences. The retired
   * `_runtime_workstream_resources` update trigger bumped it on every column it
   * could write, including this one — so this stops invalidating compaction
   * checkpoints that were never affected. The paths that do change the
   * authorized set are the product service's, and they still bump it.
   */
  private async resourceOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = ResourceOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_resource_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_resource_identity_mismatch");
    if (refusal) return refusal;
    const method = this.resources[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = mutatesInventory(parsed.data.operation)
      ? await this.product.commitRuntimeMutation(
        () => method.apply(this.resources, parsed.data.args),
        true,
      )
      : method.apply(this.resources, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  /**
   * Dispatch one block-dashboard operation against this object's own storage.
   *
   * Identity is re-checked against the object's own before anything executes,
   * for the reason `acceptToolReceiptOperation` gives: a misrouted stub must
   * fail rather than settle another work stream's blocks. The main child holds
   * these rows, so a non-main substream is refused here rather than answering
   * from an empty table.
   */
  private async acceptBlockDashboardOperation(request: Request): Promise<Response> {
    const outcome = await this.blockDashboardOperationOutcome(
      await request.json().catch(() => null),
    );
    return jsonResponse(outcome.payload, outcome.status);
  }

  private async blockDashboardOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = BlockDashboardOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_block_dashboard_operation" } };
    }
    const refusal = this.objectPortRefusal(
      parsed.data,
      "workstream_block_dashboard_identity_mismatch",
    );
    if (refusal) return refusal;
    const method = this.blockDashboard[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = method.apply(this.blockDashboard, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptTerminalOperation(request: Request): Promise<Response> {
    const parsed = TerminalOperationRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse({
        ok: false,
        error: "invalid_terminal_operation",
        failure: {
          code: "invalid_terminal_operation",
          message: "Avalon's Terminal authority rejected an internal request because its protocol was invalid. Retry after the application and service versions are aligned.",
          outcome: "rejected",
          retryable: false,
        },
      }, 400);
    }
    try {
      const value = await this.runTerminalOperation(parsed.data);
      return jsonResponse({ ok: true, value: value ?? null });
    } catch (error) {
      if (!(error instanceof TerminalObjectPortError)) throw error;
      return jsonResponse({
        ok: false,
        error: error.code,
        failure: {
          code: error.code,
          message: error.message,
          outcome: error.details.outcome,
          retryable: error.details.retryable,
        },
      }, 409);
    }
  }

  /**
   * Execute Terminal authority inside the event that already owns this object.
   *
   * Worker callers still arrive through RPC. The resident agent loop must not
   * RPC back into itself: those nested events hand later D1/provider work back
   * to the alarm's outer request context, which production rejects after the
   * first command. Both paths share this transaction and alarm boundary.
   */
  private async runTerminalOperation(input: TerminalOperationRequest): Promise<unknown> {
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== input.workspaceId
      || identity.workstreamId !== input.workstreamId
      || this.externalSubstreamId() !== "0") {
      throw new TerminalObjectPortError(input.operation, {
        code: "workstream_terminal_identity_mismatch",
        message: "Avalon's Terminal authority rejected an internal request because it was routed to the wrong work stream. Retrying the same operation will not repair the route.",
        outcome: "rejected",
        retryable: false,
      });
    }
    const operation = input.operation;
    const method = this.terminal[operation] as (...args: unknown[]) => unknown;
    const operationInput = input.args[0];
    const operationRunId = (): string | null => {
      if (operationInput !== undefined && operationInput !== null) {
        return typeof operationInput === "object"
          && "runId" in operationInput
          && typeof operationInput.runId === "string"
          ? operationInput.runId
          : null;
      }
      try {
        return this.terminal.sandbox()?.operationRunId ?? null;
      } catch {
        // Correlation must never replace the typed operation failure that the
        // log is explaining. A broken sandbox read stays secondary evidence.
        return null;
      }
    };
    let value: unknown;
    try {
      // Through `commitRuntimeMutation`, not directly, for the same reason
      // `acceptRuntimeSql` does: a write that moves a Terminal deadline has to
      // enqueue the `directory_common` effect, because
      // `workspace_workstream_directory.next_terminal_action_at` is the only
      // thing the workspace's alarm reads to decide a sandbox is due, and that
      // effect is its only writer. Calling the storage method on its own
      // committed the row and told nobody.
      value = await this.product.commitRuntimeMutation(
        () => method.apply(this.terminal, input.args),
        terminalOperationAffectsDirectory(operation),
      );
    } catch (error) {
      // `commitRuntimeMutation` is one synchronous SQLite transaction. If it
      // throws, no Terminal row or regional effect committed, so retrying the
      // exact operation is safe. Keep the raw reason only in operator logs;
      // the RPC carries a stable category and participant-safe instruction.
      logError(this.env, "terminal_operation_commit_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        harness_run_id: operationRunId(),
        operation,
        code: "terminal_operation_not_committed",
        reason: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6).join("\n") ?? null : null,
      });
      throw new TerminalObjectPortError(operation, {
        code: "terminal_operation_not_committed",
        message: "Avalon could not commit an internal Terminal state change. Resume the run so the durable tool receipt can reconcile it; do not manually repeat a write.",
        outcome: "not_committed",
        retryable: true,
      });
    }
    // Alarm scheduling happens after the transaction. A failure here cannot be
    // returned as an operation failure: the mutation already committed, and a
    // retry could duplicate it. Directory-affecting operations committed their
    // regional effect with the row; otherwise the active dispatch sweep or a
    // later request re-derives the local alarm.
    try {
      // The deadline this operation just wrote is also this object's own next
      // alarm, so re-derive it here rather than waiting for the next request.
      await this.armNextAlarm();
    } catch (error) {
      logError(this.env, "terminal_operation_alarm_schedule_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        harness_run_id: operationRunId(),
        operation,
        code: "terminal_alarm_schedule_failed_after_commit",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return value ?? null;
  }

  /** Resource-link writer for a harness already executing in this object. */
  private localRuntimeResourceAttacher(
    workspaceId: string,
    workstreamId: string,
  ): WorkstreamRuntimeResourceAttacher {
    return (input) => {
      if (input.workspaceId !== workspaceId || input.workstreamId !== workstreamId) {
        throw new Error("workstream_runtime_identity_mismatch");
      }
      return this.runRuntimeResourceAttachment(input);
    };
  }

  private async acceptRuntimeResource(request: Request): Promise<Response> {
    const parsed = RuntimeResourceRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_runtime_resource" }, 400);
    try {
      await this.runRuntimeResourceAttachment(parsed.data);
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "runtime_resource_attach_failed",
      }, 409);
    }
  }

  /** Attach a generated resource without re-entering the resident object. */
  private async runRuntimeResourceAttachment(input: SubstreamRuntimeResourceRequest): Promise<void> {
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== input.workspaceId
      || identity.workstreamId !== input.workstreamId
      || this.externalSubstreamId() !== "0") {
      throw new Error("workstream_runtime_identity_mismatch");
    }
    await this.product.attachRuntimeResource(
      input.workspaceId,
      input.resourceId,
      input.attachedByUserId,
      input.relationshipType,
    );
  }

  private async acceptRuntimeSuggestion(request: Request): Promise<Response> {
    const parsed = RuntimeSuggestionRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_runtime_suggestion" }, 400);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== parsed.data.workspaceId
      || identity.workstreamId !== parsed.data.workstreamId) {
      return jsonResponse({ error: "workstream_runtime_identity_mismatch" }, 409);
    }
    try {
      const result = await this.product.createSuggestion(parsed.data.workspaceId, parsed.data.input);
      if (result.inserted) {
        await this.publishLocalProductEvent(identity, {
          type: "activity_suggestion_created",
          suggestion: result.suggestion,
        });
      }
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "runtime_suggestion_create_failed",
      }, 409);
    }
  }

  private async acceptRuntimeBootstrap(request: Request): Promise<Response> {
    const parsed = RuntimeBootstrapRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_runtime_bootstrap" }, 400);
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase !== "durable_object_open" || authority.generation !== parsed.data.generation) {
      return jsonResponse({ error: "workstream_runtime_bootstrap_fenced" }, 409);
    }
    try {
      this.product.bootstrapRuntimeAuthority(parsed.data);
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "workstream_runtime_bootstrap_failed",
      }, 409);
    }
  }

  /**
   * Write what a system-provisioned work stream is, once its object is open.
   *
   * The identity check is `objectPortRefusal`'s, for its reasons: a misrouted
   * stub must not name another work stream, and a non-authoritative object is
   * not the one whose writes count. The provision itself is idempotent, so a
   * producer retrying the bootstrap-then-provision pair is safe.
   */
  private async acceptIdentityOperation(request: Request): Promise<Response> {
    const outcome = await this.identityOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * Dispatch one identity operation against this object's own root row.
   *
   * The provision runs inside `commitRuntimeMutation` with the directory flag
   * because it is what makes a system-created work stream appear in a sidebar:
   * a row whose listing projection is a second commit can be created and never
   * shown. The reads do not, for the reason every other authority's reads do
   * not — there is nothing to publish.
   *
   * This replaces a bespoke `provisionRuntime` RPC that validated its own body
   * and re-checked identity inside the product service. Both checks are what
   * `objectPortRefusal` and this dispatcher already do for the five authorities
   * beside it, and having them twice meant a provision could be refused by two
   * different mismatch codes depending on which layer noticed.
   */
  private async identityOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = IdentityOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_identity_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_identity_mismatch");
    if (refusal) return refusal;
    const method = this.identityRows[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = mutatesIdentity(parsed.data.operation)
      ? await this.product.commitRuntimeMutation(
        () => method.apply(this.identityRows, parsed.data.args),
        true,
      )
      : method.apply(this.identityRows, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptRunDispatch(request: Request): Promise<Response> {
    const parsed = RuntimeDispatchRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_substream_run_dispatch" }, 400);
    if (parsed.data.reason === "block_dashboard_block") {
      return jsonResponse({ error: "block_dashboard_runs_require_block_agent" }, 409);
    }
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== parsed.data.workspaceId
      || identity.workstreamId !== parsed.data.workstreamId) {
      return jsonResponse({ error: "substream_run_identity_mismatch" }, 409);
    }
    const substreamId = parsed.data.substreamId ?? asSubstreamId("0");
    try {
      this.ensureSubstreamIdentity(substreamId);
      await this.enqueueAgentRun(parsed.data.harnessRunId, {
        ...parsed.data,
        substreamId,
      });
      return jsonResponse({ accepted: true }, 202);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "substream_run_dispatch_failed",
      }, 409);
    }
  }

  private async acceptProductRequest(request: Request, traced = false): Promise<Response> {
    const parsed = ProductRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_product_request" }, 400);
    const flow = traced ? productRequestFlow(parsed.data.operation) : null;
    if (flow === null) return this.runProductRequest(parsed.data, noFlowSpan);
    const workstreamId = parsed.data.operation === "initialize"
      ? parsed.data.input.workstreamId
      : this.objectStore.identity()?.workstreamId;
    return inFlowSpan(this.env, `workstream.room.${parsed.data.operation}`, {
      flow,
      component: "substream_do",
      identity: {
        workspaceId: parsed.data.auth.workspaceId,
        userId: parsed.data.auth.userId,
        sessionId: parsed.data.auth.sessionId,
        substreamId: this.externalSubstreamId(),
        ...(workstreamId === undefined ? {} : { workstreamId }),
      },
      attributes: { "rally.room.operation": parsed.data.operation },
    }, (span) => this.runProductRequest(parsed.data, span));
  }

  private async runProductRequest(
    request: SubstreamProductRequest,
    span: FlowSpan,
  ): Promise<Response> {
    // Two principals, two verifications. A login session is re-verified against
    // its `sessions` row, which is what makes a revoked or expired login stop
    // working mid-flight. A connector principal has no `sessions` row to check
    // — its standing authority is the connector link, which the Worker verified
    // on the very message being delivered — so the object re-checks the D1 fact
    // that *is* its to check: current active membership in this workspace, in
    // this region. Before this branch existed, connector ingress synthesized a
    // session id that no `sessions` row could ever match, and every linked
    // member's Slack message died here as `session_revoked` (2026-08-22).
    const connectorPrincipal = request.auth.principal === "connector";
    const current = connectorPrincipal
      ? await span.step("workstream.room.connector_auth", () => this.connectorPrincipalAuth(request.auth))
      : await span.step("workstream.room.session_auth", () => this.socketAuth({
        workspaceId: request.auth.workspaceId,
        userId: request.auth.userId,
        sessionId: request.auth.sessionId,
      }));
    if (!current || current.role !== request.auth.role || current.region !== request.auth.region) {
      const refusal = connectorPrincipal ? "connector_member_revoked" : "session_revoked";
      span.setError(refusal);
      // The message rides to `WorkstreamObjectClient.decode`, whose fallback
      // ("The work stream could not be loaded") misdescribes a refused send.
      return jsonResponse({
        error: refusal,
        message: connectorPrincipal
          ? "You are no longer an active member of this workspace"
          : "Sign in again to continue",
      }, 401);
    }
    // Set once the object's own authorization query — session or connector
    // membership — has answered, rather than taken
    // from the caller: a correlation value that arrives from outside is one the
    // object would have to decide whether to trust, for something it resolves
    // anyway. Only the workspace surrogate — see `socketAuth` for why the
    // person surrogate stays on the Worker's side of the boundary.
    span.setAttributes(identityAttributes({
      analyticsWorkspaceId: current.analyticsWorkspaceId,
    }));
    try {
      if (request.operation === "initialize") {
        const input = request.input;
        const result = await span.step("workstream.room.product.initialize", () =>
          this.product.initialize(current, input));
        const identity = { workspaceId: request.input.workspaceId, workstreamId: request.input.workstreamId };
        // The dispatch is durable state and must land before anything that can
        // fail for cosmetic reasons: a refused broadcast used to abort this
        // handler after the run was committed, leaving a run with no executor,
        // no alarm, and a member-facing 500 over a work stream that exists.
        await span.step("workstream.room.run.dispatch", () =>
          this.startProductWorkflow(identity, result.harnessRunId, result.workflowInput));
        const messages = await span.step("workstream.room.opening_message.read", () =>
          this.product.messages(current, 1));
        if (messages.items[0]) {
          const opening = messages.items[0];
          await span.step("workstream.room.event.publish_message_created", () =>
            this.publishLocalProductEvent(identity, {
              type: "message_created",
              message: opening,
            }));
        }
        return jsonResponse({
          workstream: result.workstream,
          messageId: result.messageId,
          harnessRunId: result.harnessRunId,
        });
      }
      if (request.operation === "get") {
        return jsonResponse(await span.step("workstream.room.product.get", () => this.product.get(current)));
      }
      if (request.operation === "boot") {
        return jsonResponse(await span.step("workstream.room.product.boot", () => this.product.boot(current)));
      }
      if (request.operation === "messages") {
        const query = request;
        const page = await span.step("workstream.room.product.messages", () => this.product.messages(
          current,
          query.limit,
          query.before,
          query.after,
          query.around,
        ));
        span.setAttributes({ "rally.transcript.message_count": page.items.length });
        return jsonResponse(page);
      }
      const identity = this.objectStore.identity();
      if (!identity) return jsonResponse({ error: "workstream_not_found" }, 404);
      if (request.operation === "update") {
        const result = await this.product.update(current, request.input);
        for (const event of result.events) await this.publishLocalProductEvent(identity, event);
        return jsonResponse(result.workstream);
      }
      if (request.operation === "acknowledge_read") {
        return jsonResponse(await this.product.acknowledgeRead(current, request.input));
      }
      if (request.operation === "mark_unread") {
        return jsonResponse(await this.product.markUnread(current));
      }
      if (request.operation === "create_message") {
        const input = request.input;
        const result = await span.step("workstream.room.product.create_message", () =>
          this.product.createMessage(current, input));
        await span.step("workstream.room.run.dispatch", () =>
          this.startProductWorkflow(identity, result.harnessRunId, result.workflowInput));
        if (result.inserted) {
          await span.step("workstream.room.event.publish_message_created", () =>
            this.publishLocalProductEvent(identity, { type: "message_created", message: result.message }));
        }
        span.setAttributes({
          "rally.agent.invoked": result.agentInvoked,
          "rally.harness_run.id": result.harnessRunId,
          "rally.message.deduplicated": !result.inserted,
        });
        return jsonResponse({
          message: result.message,
          agentInvoked: result.agentInvoked,
          harnessRunId: result.harnessRunId,
        });
      }
      if (request.operation === "add_participant") {
        const participant = await this.product.addParticipant(current, request.userId);
        await this.publishLocalProductEvent(identity, { type: "participant_added", participant });
        return jsonResponse(participant);
      }
      if (request.operation === "remove_participant") {
        await this.product.removeParticipant(current, request.userId);
        await this.publishLocalProductEvent(identity, {
          type: "participant_removed",
          userId: request.userId,
        });
        return jsonResponse({ ok: true });
      }
      if (request.operation === "attach_resource") {
        const resource = await this.product.attachResource(current, request.resourceId);
        await this.publishLocalProductEvent(identity, { type: "resource_attached", resource });
        return jsonResponse(resource);
      }
      if (request.operation === "detach_resource") {
        await this.product.detachResource(current, request.resourceId);
        return jsonResponse({ ok: true });
      }
      if (request.operation === "resolve_suggestion") {
        const result = await this.product.resolveSuggestion(
          current,
          request.suggestionId,
          request.action,
        );
        if (result.changed && result.suggestion) {
          await this.publishLocalProductEvent(identity, {
            type: "activity_suggestion_resolved",
            suggestion: result.suggestion,
          });
        }
        return jsonResponse({ suggestion: result.suggestion, resourceId: result.resourceId });
      }
      if (request.operation === "answer_elicitation") {
        const result = await this.product.answerElicitation(
          current,
          request.elicitationId,
          request.input,
        );
        await this.startProductWorkflow(identity, result.harnessRunId, result.workflowInput);
        if (result.elicitation) {
          await this.publishLocalProductEvent(identity, {
            type: "elicitation_answered",
            elicitation: result.elicitation,
          });
        }
        return jsonResponse({ elicitation: result.elicitation, harnessRunId: result.harnessRunId });
      }
      if (request.operation === "stop") {
        await this.product.stop(current);
        return jsonResponse({ ok: true });
      }
      const result = await this.product.retry(current);
      await this.startProductWorkflow(identity, result.harnessRunId, result.workflowInput);
      return jsonResponse({ harnessRunId: result.harnessRunId });
    } catch (error) {
      const safe = error instanceof ApiError
        ? error
        : new ApiError(500, "workstream_object_request_failed", "The work stream could not be loaded");
      if (!(error instanceof ApiError)) {
        // The member-facing body stays generic, but an internal failure that
        // reaches here with no record is undiagnosable — this same anonymous
        // 500 cost a debugging round during the dispatch outage.
        logError(this.env, "workstream_product_request_failed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.workstreamId,
          substream_id: this.externalSubstreamId(),
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
      span.setError(safe.code, safe.message);
      span.setAttributes({ "http.response.status_code": safe.status });
      return jsonResponse({ error: safe.code, message: safe.message, details: safe.details }, safe.status);
    }
  }

  private async startProductWorkflow(
    identity: { workspaceId: string; workstreamId: string },
    runId: string | null,
    workflowInput: WorkstreamWorkflowInput | null,
  ): Promise<void> {
    if (!runId || !workflowInput) return;
    const input = WorkstreamWorkflowInputSchema.parse({
      ...workflowInput,
      substreamId: this.externalSubstreamId(),
    });
    await this.enqueueAgentRun(runId, input);
  }

  private async enqueueAgentRun(runId: string, input: WorkstreamWorkflowInput): Promise<void> {
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO agent_run_dispatches
         (run_id, input_json, state, attempt, available_at, started_at,
          completed_at, last_error_code, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(run_id) DO NOTHING`,
      runId,
      JSON.stringify(input),
      now,
      now,
      now,
    );
    // Generous operational-fence retention (the 10 GB object ceiling is the
    // only hard bound): a terminal dispatch is a consumed execution intent —
    // the run row itself is the durable record — and a fired or cancelled
    // wake-up is a spent one-shot whose idempotency window has long closed.
    this.state.storage.sql.exec(
      `DELETE FROM agent_run_dispatches
        WHERE run_id IN (
          SELECT run_id FROM agent_run_dispatches
           WHERE state IN ('completed', 'failed') AND updated_at < ?
           ORDER BY updated_at LIMIT 100
        )`,
      now - OPERATIONAL_FENCE_RETENTION_MS,
    );
    this.state.storage.sql.exec(
      `DELETE FROM workstream_wakeups
        WHERE wakeup_id IN (
          SELECT wakeup_id FROM workstream_wakeups
           WHERE status IN ('fired', 'cancelled') AND updated_at < ?
           ORDER BY updated_at LIMIT 100
        )`,
      now - OPERATIONAL_FENCE_RETENTION_MS,
    );
    // Armed unconditionally rather than through `ensureAlarmNoLaterThan`: that
    // helper reads the current alarm first, and an invocation that died in the
    // gap between the insert above and the write below would leave a queued row
    // with nothing scheduled to reach it. Nothing can be sooner than now + 1,
    // so there is no alarm worth preserving.
    await this.state.storage.setAlarm(now + 1);
  }

  /**
   * Runs the queue to completion in the caller's invocation.
   *
   * Durable work is never handed to a promise the caller then abandons. The
   * previous implementation dropped the drain into `waitUntil` and returned,
   * which invited the runtime to cancel it mid-run — and because cancellation
   * is not a thrown error, it did so silently, with no failure logged anywhere.
   */
  private async drainRunsToCompletion(): Promise<"drained" | "deferred"> {
    // A keep-alive heartbeat is a separate Durable Object event. It must not
    // await a promise created by the run's request context. A healthy long run
    // proves ownership through the object-local harness lease it renews every
    // five seconds. If the previous continuation was cancelled, that lease and
    // this drain's progress horizon both lapse; only then may a later alarm
    // forget the stranded promise and reclaim the durably fenced dispatch.
    if (this.agentDrain.active) {
      const now = Date.now();
      const lastProgressAt = this.agentDrain.lastProgress;
      const activeRun = this.activeRunDispatch;
      const runLease = activeRun
        ? this.state.storage.sql.exec<{ lease_expires_at: number | null }>(
            `SELECT lease_expires_at FROM runs WHERE run_id = ?`,
            activeRun.runId,
          ).toArray()[0]?.lease_expires_at ?? null
        : null;
      const recentProgress = lastProgressAt !== null
        && now - lastProgressAt < AGENT_RUN_DISPATCH_LEASE_MS;
      if (recentProgress || (runLease !== null && runLease > now)) return "deferred";
      if (this.agentDrain.abandonActive()) {
        logWarn(this.env, "substream_agent_stale_drain_reclaimed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.workstreamId,
          substream_id: this.externalSubstreamId(),
          harness_run_id: activeRun?.runId ?? null,
          last_progress_at: lastProgressAt,
          harness_lease_expires_at: runLease,
        });
      }
    }
    await this.agentDrain.resume(
      (ownsDrain) => this.drainRunQueue(ownsDrain)
      .catch((error: unknown) => {
        logWarn(this.env, "substream_agent_drain_failed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.workstreamId,
          substream_id: this.externalSubstreamId(),
          reason: error instanceof Error ? error.message : "unknown",
        });
      }),
      () => undefined,
    );
    return "drained";
  }

  private async drainRunQueue(ownsDrain: () => boolean): Promise<void> {
    while (ownsDrain()) {
      this.agentDrain.touch();
      // Only the alarm forwards regional effects, and this loop owns the alarm
      // until it returns. Flushing between runs keeps a queue of runs from
      // holding the parent's view of all of them; effects committed *during* a
      // single long run still wait for it to finish.
      await this.flushDueRegionalEffects();
      // `abandonActive()` cannot cancel the promise that is inside the await.
      // Recheck before the synchronous claim or that obsolete continuation can
      // still lease a row beside the replacement drain.
      if (!ownsDrain()) return;
      const now = Date.now();
      // The claim leases the row, so an invocation that dies mid-run leaves a
      // deadline behind rather than an indefinite "running" that only a live
      // process could explain.
      const claim = claimAgentRunDispatch(
        this.state.storage.sql,
        SUBSTREAM_AGENT_RUN_DISPATCHES,
        { now, leaseToken: uuidV7(now) },
      );
      if (!claim) return;
      this.agentDrain.touch();

      // Parsed inside the guard, not before it. A payload this build cannot
      // validate — an older shape, a truncated write — used to throw straight
      // out of the drain, leaving the row claimed and settling nothing: the
      // lease lapses, the next alarm reclaims it, and it throws again forever.
      // A dispatch nothing can decode is a failed run, not a reason to stop.
      let input: WorkstreamWorkflowInput;
      try {
        input = WorkstreamWorkflowInputSchema.parse(JSON.parse(claim.payload));
      } catch (error) {
        logWarn(this.env, "agent_run_dispatch_undecodable", {
          substream_id: this.externalSubstreamId(),
          harness_run_id: claim.id,
          reason: error instanceof Error ? error.message : "unknown",
        });
        settleAgentRunDispatch(
          this.state.storage.sql,
          SUBSTREAM_AGENT_RUN_DISPATCHES,
          claim.id,
          claim.leaseToken,
          "failed",
          "agent_run_dispatch_undecodable",
          Date.now(),
        );
        continue;
      }
      const identity = { workspaceId: input.workspaceId, workstreamId: input.workstreamId };
      this.activeRunDispatch = { runId: claim.id, leaseToken: claim.leaseToken };
      try {
        if (claim.started) {
          // A run whose executor is gone still holds the substream's single
          // mutating slot, and the start below would fail against it — as the
          // *new* run's failure, leaving the work stream permanently busy. Only
          // a run reaches this code, so nothing else would ever clear it.
          const abandoned = this.product.reapAbandonedSubstreamRuns(
            input.substreamId ?? "0",
            Date.now(),
          );
          if (abandoned.length > 0) {
            logWarn(this.env, "workstream_abandoned_runs_reaped", {
              workspace_id: input.workspaceId,
              workstream_id: input.workstreamId,
              substream_id: input.substreamId ?? "0",
              harness_run_id: claim.id,
              reaped_run_ids: abandoned,
            });
          }
          await this.product.recordWorkflowStarted(claim.id, `substream-agent:${claim.id}`);
          await this.publishLocalProductEvent(identity, {
            type: "harness_status_changed",
            status: "running",
          });
        }
        const result = await this.keepAliveWhile(() => this.executeAgentRun(input));
        if (result.retryAt !== null) {
          deferAgentRunDispatch(
            this.state.storage.sql,
            SUBSTREAM_AGENT_RUN_DISPATCHES,
            claim.id,
            claim.leaseToken,
            result.retryAt,
            result.errorCode,
            Date.now(),
          );
          return;
        }
        settleAgentRunDispatch(
          this.state.storage.sql,
          SUBSTREAM_AGENT_RUN_DISPATCHES,
          claim.id,
          claim.leaseToken,
          result.status === "failed" ? "failed" : "completed",
          result.errorCode,
          Date.now(),
        );
      } catch (error) {
        if (error instanceof RunOwnershipLostError) {
          logWarn(this.env, "agent_run_executor_lost_ownership", {
            workspace_id: input.workspaceId,
            workstream_id: input.workstreamId,
            substream_id: input.substreamId ?? "0",
            harness_run_id: claim.id,
            attempt: claim.attempt,
          });
          // The successor owns the authoritative outcome. Retrying this local
          // dispatch lets it adopt that terminal result; marking the product
          // failed here would be an unfenced stale-executor write.
          deferAgentRunDispatch(
            this.state.storage.sql,
            SUBSTREAM_AGENT_RUN_DISPATCHES,
            claim.id,
            claim.leaseToken,
            Date.now() + 1_000,
            "run_ownership_lost",
            Date.now(),
          );
          // This drain may itself have been abandoned and replaced after its
          // keep-alive stranded. It must not claim another row alongside the
          // successor drain after losing the authority that fenced this one.
          return;
        }
        const safe = {
          code: error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "agent_loop_failed",
          message: "The Avalon harness could not complete this run",
        };
        // Every way a run can fail arrives here, and until now none of them
        // said anything: the run was marked failed, the dispatch settled, and
        // the only trace was a status the member could not act on. A run that
        // dies for a reason nobody records is indistinguishable from one that
        // was never dispatched, which is most of why this took so long to find.
        logWarn(this.env, "agent_run_execution_failed", {
          workspace_id: input.workspaceId,
          workstream_id: input.workstreamId,
          substream_id: input.substreamId ?? "0",
          harness_run_id: claim.id,
          attempt: claim.attempt,
          error_code: safe.code,
          reason: error instanceof Error ? error.message : "unknown",
        });
        if (!ownsDrain()) {
          logWarn(this.env, "agent_run_failure_abandoned_before_product_settlement", {
            workspace_id: input.workspaceId,
            workstream_id: input.workstreamId,
            substream_id: input.substreamId ?? "0",
            harness_run_id: claim.id,
            attempt: claim.attempt,
          });
          return;
        }
        try {
          // Product failure and work-stream status change are atomically
          // conditional on this dispatch's exact token. The check above avoids
          // a known-obsolete call; this fence closes the await/interleaving race.
          await this.product.recordWorkflowFailed(claim.id, safe, claim.leaseToken);
        } catch (settlementError) {
          deferAgentRunDispatch(
            this.state.storage.sql,
            SUBSTREAM_AGENT_RUN_DISPATCHES,
            claim.id,
            claim.leaseToken,
            Date.now() + 1_000,
            "run_failure_settlement_deferred",
            Date.now(),
          );
          logWarn(this.env, "agent_run_failure_settlement_deferred", {
            workspace_id: input.workspaceId,
            workstream_id: input.workstreamId,
            substream_id: input.substreamId ?? "0",
            harness_run_id: claim.id,
            attempt: claim.attempt,
            reason: settlementError instanceof Error ? settlementError.message : "unknown",
          });
          return;
        }
        settleAgentRunDispatch(
          this.state.storage.sql,
          SUBSTREAM_AGENT_RUN_DISPATCHES,
          claim.id,
          claim.leaseToken,
          "failed",
          safe.code,
          Date.now(),
        );
        await this.publishLocalProductEvent(identity, {
          type: "harness_status_changed",
          status: "failed",
        }).catch(() => undefined);
      } finally {
        if (this.activeRunDispatch?.leaseToken === claim.leaseToken) {
          this.activeRunDispatch = null;
        }
        if (ownsDrain()) this.agentDrain.touch();
      }
    }
  }

  /**
   * Wraps the run so no outcome is silent.
   *
   * Every branch below already decides something a member can see — an early
   * settle, a recovered terminal outcome, a backoff — and until now most of
   * them returned without a word. Twice during this incident the telemetry
   * showed a run executing in a second and producing nothing, and there was no
   * way to tell which branch had done it.
   */
  private async executeAgentRun(input: WorkstreamWorkflowInput): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    const startedAt = Date.now();
    const result = await this.runAgentExecution(input);
    logInfo(this.env, "agent_run_outcome", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      substream_id: input.substreamId ?? "0",
      harness_run_id: input.harnessRunId,
      status: result.status,
      error_code: result.errorCode,
      retry_at: result.retryAt,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  }

  private async runAgentExecution(input: WorkstreamWorkflowInput): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority)) {
      // Say so. A run that backs off here does it every few minutes for as long
      // as the phase holds, and the member sees only a spinner — during the
      // Global cutover that was eighteen hours of silence.
      logWarn(this.env, "agent_run_deferred_for_maintenance", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        harness_run_id: input.harnessRunId,
        phase: authority.phase,
        generation: authority.generation,
      });
      return { status: "failed", errorCode: null, retryAt: Date.now() + MAINTENANCE_RECHECK_MS };
    }
    const executionEnv = this.localRuntimeEnvironment(
      input.workspaceId,
      input.workstreamId,
      input.substreamId ?? "0",
    );
    const terminalReceipt = this.state.storage.sql.exec<{
      terminal_outcome_json: string | null;
      settled_at: number | null;
    }>(
      `SELECT terminal_outcome_json, settled_at
         FROM agent_run_dispatches WHERE run_id = ?`,
      input.harnessRunId,
    ).toArray()[0];
    if (terminalReceipt?.terminal_outcome_json) {
      const terminalOutcome = AgentTerminalOutcomeSchema.parse(
        JSON.parse(terminalReceipt.terminal_outcome_json),
      );
      if (terminalReceipt.settled_at !== null) {
        return {
          status: terminalOutcome.status,
          errorCode: terminalOutcome.error?.code ?? null,
          retryAt: null,
        };
      }
      return this.settleAgentRunWithRetry(executionEnv, input, terminalOutcome);
    }
    const runs = createHarnessRunObjectPort(executionEnv, input.workspaceId, input.workstreamId);
    await reapStaleHarnessRuns(runs, {
      receipts: createToolReceiptPortFactory(executionEnv),
      blocks: createBlockDashboardPortFactory(executionEnv),
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      limit: 25,
      automationDatabase: withWorkspaceRuntimeDatabase(this.env, input.workspaceId).DB,
      onReceiptRepairFailure: (failure) => logWarn(this.env, "harness_residual_receipt_repair_failed", {
        workspace_id: failure.workspaceId,
        workstream_id: failure.workstreamId,
        harness_run_id: failure.runId,
        attempt_id: failure.attemptId,
        repair_phase: failure.phase,
        reason: failure.reason,
      }),
    });
    const attemptId = uuidV7();
    const claim = await claimHarnessAttempt(
      runs,
      input,
      {
        attemptId,
        owner: `substream-agent:${input.substreamId ?? "0"}:${input.harnessRunId}:${attemptId}`,
        leaseSeconds: 300,
      },
    );
    if (claim.state === "busy") {
      const leaseAt = claim.leaseExpiresAt ? Date.parse(claim.leaseExpiresAt) : Number.NaN;
      // A lease nobody will release leaves the run "running" forever, and this
      // branch is the only place that knows it.
      logWarn(this.env, "agent_run_attempt_busy", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        harness_run_id: input.harnessRunId,
        lease_expires_at: claim.leaseExpiresAt ?? null,
      });
      return {
        status: "failed",
        errorCode: null,
        retryAt: Number.isFinite(leaseAt) ? Math.max(Date.now() + 1_000, leaseAt + 1) : Date.now() + 5_000,
      };
    }
    if (claim.state === "terminal") {
      try {
        const recovered = await this.loadTerminalOutcome(executionEnv, input, claim.status);
        logWarn(this.env, "agent_run_adopted_terminal_attempt", {
          workspace_id: input.workspaceId,
          workstream_id: input.workstreamId,
          harness_run_id: input.harnessRunId,
          claim_status: claim.status,
          recovered_status: recovered.status,
        });
        return this.persistAndSettleAgentRun(executionEnv, input, recovered);
      } catch (error) {
        logWarn(this.env, "substream_agent_terminal_recovery_failed", {
          workspace_id: input.workspaceId,
          workstream_id: input.workstreamId,
          substream_id: input.substreamId ?? "0",
          harness_run_id: input.harnessRunId,
          reason: error instanceof Error ? error.message : "unknown",
        });
        return {
          status: claim.status,
          errorCode: "agent_terminal_recovery_failed",
          retryAt: Date.now() + 30_000,
        };
      }
    }
    if (claim.state === "cancelled") {
      await terminalizeQueuedHarnessRun(
        runs,
        input,
        { attemptId, owner: `substream-agent:${input.substreamId ?? "0"}:${input.harnessRunId}:${attemptId}` },
        { code: "run_cancelled", message: "The run was stopped before it started" },
        "stopped",
      );
      return this.persistAndSettleAgentRun(executionEnv, input, {
        status: "stopped",
        error: { code: "run_cancelled", message: "The run was stopped before it started" },
        cancellationReason: "run_cancelled",
      });
    }

    let outcome: WorkstreamHarnessResult;
    try {
      outcome = await runWorkstreamHarness(
        executionEnv,
        input,
        (event) => this.publishAgentRuntimeEvent(event),
        {
          lease: claim.lease,
          publishRealtime: false,
          // Terminal reaches this object through the authorities installed on
          // `executionEnv`, so it is not threaded here any more. The resource
          // attacher still is, and deliberately: it carries a *scope* rather
          // than a location — it refuses an attachment addressed to another
          // work stream, which a port resolved by ids would happily deliver.
          ...(this.externalSubstreamId() === "0" ? {
            runtimeResourceAttacher: this.localRuntimeResourceAttacher(
              input.workspaceId,
              input.workstreamId,
            ),
          } : {}),
        },
      );
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "harness_execution_failed";
      // A bare `harness_execution_failed` is an uncoded exception, and the
      // member-safe outcome keeps none of it. Without this line the only fact
      // production retains is the catch-all code — which is precisely what an
      // incident hands back when asked what went wrong.
      logError(this.env, "workstream_harness_threw", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        substream_id: input.substreamId ?? "0",
        harness_run_id: input.harnessRunId,
        error_code: code,
        reason: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6).join("\n") ?? null : null,
      });
      outcome = {
        status: code === "run_cancelled" ? "stopped" : "failed",
        error: { code, message: "The Avalon harness could not complete this run" },
      };
    }
    const stopState = await executionEnv.DB.prepare(
      `SELECT status, cancellation_requested_at, cancellation_reason
         FROM harness_runs WHERE id = ? AND workspace_id = ? AND workstream_id = ?`,
    ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{
      status: string;
      cancellation_requested_at: string | null;
      cancellation_reason: string | null;
    }>();
    const effectiveStatus = stopState?.status === "stopped" || stopState?.cancellation_requested_at
      ? "stopped"
      : outcome.status;
    await terminalizeHarnessAttempt(
      runs,
      createMessageObjectPort(executionEnv, input.workspaceId, input.workstreamId),
      input,
      claim.lease,
      {
        status: effectiveStatus,
        ...(outcome.messageId ? { finalMessageId: outcome.messageId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        memberSafePayload: outcome.error ? { code: outcome.error.code } : {},
      },
      createToolReceiptObjectPort(executionEnv, input.workspaceId, input.workstreamId),
      createBlockDashboardObjectPort(executionEnv, input.workspaceId, input.workstreamId),
    );
    if (outcome.messageId) {
      const messages = await this.product.messagesForRuntime(250);
      const message = messages.items.find((candidate) => candidate.id === outcome.messageId);
      if (message) await this.publishAgentRuntimeEvent({ type: "stream_completed", message });
    }
    const root = this.product.runtimeStatus();
    await this.publishAgentRuntimeEvent({
      type: "harness_status_changed",
      status: root,
    });
    return this.persistAndSettleAgentRun(executionEnv, input, {
      ...outcome,
      status: effectiveStatus,
      cancellationReason: stopState?.cancellation_reason ?? null,
    });
  }

  private async persistAndSettleAgentRun(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    rawOutcome: AgentTerminalOutcome,
  ): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    const outcome = AgentTerminalOutcomeSchema.parse(rawOutcome);
    this.state.storage.sql.exec(
      `UPDATE agent_run_dispatches
          SET terminal_outcome_json = ?, settled_at = NULL,
              last_settlement_error_code = NULL, updated_at = ?
        WHERE run_id = ?`,
      JSON.stringify(outcome),
      Date.now(),
      input.harnessRunId,
    );
    return this.settleAgentRunWithRetry(executionEnv, input, outcome);
  }

  private async settleAgentRunWithRetry(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    outcome: AgentTerminalOutcome,
  ): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    try {
      await this.settleAgentRun(executionEnv, input, outcome);
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches
            SET settled_at = ?, last_settlement_error_code = NULL, updated_at = ?
          WHERE run_id = ? AND terminal_outcome_json IS NOT NULL`,
        Date.now(),
        Date.now(),
        input.harnessRunId,
      );
      return {
        status: outcome.status,
        errorCode: outcome.error?.code ?? null,
        retryAt: null,
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "agent_run_settlement_failed";
      const attempt = this.state.storage.sql.exec<{ attempt: number }>(
        `SELECT attempt FROM agent_run_dispatches WHERE run_id = ?`,
        input.harnessRunId,
      ).toArray()[0]?.attempt ?? 1;
      const delay = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches
            SET last_settlement_error_code = ?, updated_at = ? WHERE run_id = ?`,
        code,
        Date.now(),
        input.harnessRunId,
      );
      logWarn(this.env, "substream_agent_settlement_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        substream_id: input.substreamId ?? "0",
        harness_run_id: input.harnessRunId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return { status: outcome.status, errorCode: code, retryAt: Date.now() + delay };
    }
  }

  private async loadTerminalOutcome(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    status: WorkstreamHarnessResult["status"],
  ): Promise<AgentTerminalOutcome> {
    const row = await executionEnv.DB.prepare(
      `SELECT status, final_message_id, error_json, cancellation_reason
         FROM harness_runs
        WHERE id = ? AND workspace_id = ? AND workstream_id = ?
          AND terminalized_at IS NOT NULL`,
    ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{
      status: string;
      final_message_id: string | null;
      error_json: string | null;
      cancellation_reason: string | null;
    }>();
    if (!row || row.status !== status) throw new Error("agent_terminal_outcome_missing");
    let error: { code: string; message: string } | undefined;
    if (row.error_json) {
      try {
        const parsed = z.object({ code: z.string(), message: z.string() }).safeParse(
          JSON.parse(row.error_json),
        );
        if (parsed.success) error = parsed.data;
      } catch {
        // Old terminal rows may carry a different member-safe shape. Status and
        // final message remain sufficient to resume idempotent settlement.
      }
    }
    return AgentTerminalOutcomeSchema.parse({
      status,
      ...(row.final_message_id ? { messageId: row.final_message_id } : {}),
      ...(error ? { error } : {}),
      cancellationReason: row.cancellation_reason,
    });
  }

  private async settleAgentRun(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    outcome: AgentTerminalOutcome,
  ): Promise<void> {
    await emitCorrelatedRunOutcome(executionEnv, input).catch(() => undefined);
    if (outcome.metrics) {
      recordHarnessRunObservation(this.env, {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        harnessRunId: input.harnessRunId,
        source: input.reason === "block_dashboard_block" ? "block_dashboard" : "workstream",
        status: outcome.status,
        ...(outcome.error ? { failureCode: outcome.error.code } : {}),
        metrics: outcome.metrics,
      });
    }

    await this.finalizeAutomation(executionEnv, input, outcome);
    if (outcome.cancellationReason !== "superseded_by_follow_up") {
      await this.deliverAgentRunResult(input, outcome);
    }
    await refreshWorkstreamName(executionEnv, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
    });
    await refreshWorkstreamDescription(executionEnv, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
    });
  }

  private async deliverAgentRunResult(
    input: WorkstreamWorkflowInput,
    outcome: AgentTerminalOutcome,
  ): Promise<void> {
    const workspaceEnv = withWorkspaceRuntimeDatabase(this.env, input.workspaceId);
    const messages = outcome.messageId
      ? (await this.product.messagesForRuntime(250)).items
      : [];
    const message = outcome.messageId
      ? messages.find((candidate) => candidate.id === outcome.messageId)
      : undefined;
    const text = message?.textContent
      ?? (outcome.status === "stopped"
        ? "Avalon stopped this task."
        : outcome.status === "needs_input"
          ? "Avalon needs more information before it can continue this task."
          : outcome.status === "failed"
            ? outcome.error?.message ?? "Avalon could not complete this task."
            : "Avalon completed the task without a text response.");
    if (input.digestDeliveryId) {
      await settleDigestRun(
        this.env,
        input.workspaceId,
        input.digestDeliveryId,
        outcome.status,
        message?.textContent ?? null,
      );
      return;
    }

    const slack = new SlackAgentService(this.env);
    await slack.deliverWorkstreamOutcome(
      input.workspaceId,
      input.workstreamId,
      text,
      `${input.harnessRunId}:${outcome.status}`,
      outcome.status,
    );
    if (!input.automationSubscriptionId) return;
    const automation = await workspaceEnv.DB.prepare(
      `SELECT template.name FROM automation_subscriptions subscription
        JOIN automation_templates template ON template.id = subscription.template_id
       WHERE subscription.id = ? AND subscription.workspace_id = ?`,
    ).bind(input.automationSubscriptionId, input.workspaceId).first<{ name: string }>();
    const result = {
      workspaceId: input.workspaceId,
      automationSubscriptionId: input.automationSubscriptionId,
      workstreamId: input.workstreamId,
      title: automation?.name ?? "Avalon automation result",
      text,
      outcomeStatus: outcome.status,
    };
    const failures = (await Promise.allSettled([
      slack.deliverAutomationResult(result),
      deliverAutomationResultEmail(workspaceEnv, result),
    ])).flatMap((settled) => settled.status === "rejected" ? [settled.reason as unknown] : []);
    for (const failure of failures) {
      logWarn(this.env, "automation_result_delivery_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        reason: failure instanceof Error ? failure.message : "unknown",
      });
    }
    if (failures.length > 0) throw failures[0];
  }

  private async finalizeAutomation(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    outcome: AgentTerminalOutcome,
  ): Promise<void> {
    if (!input.automationSubscriptionId) return;
    const owned = await executionEnv.DB.prepare(
      `SELECT 1 AS owned FROM harness_runs
        WHERE id = ? AND workspace_id = ? AND workstream_id = ?
          AND terminalized_at IS NOT NULL`,
    ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{ owned: number }>();
    if (!owned) throw new Error("automation_run_terminal_fence_missing");
    const automationStatus = outcome.status === "stopped" ? "failed" : outcome.status;
    const workspaceEnv = withWorkspaceRuntimeDatabase(this.env, input.workspaceId);
    await workspaceEnv.DB.prepare(
      `UPDATE automation_runs
          SET status = ?1,
              completed_at = CASE WHEN ?1 IN ('completed', 'failed') THEN ?2 ELSE completed_at END,
              result_summary = COALESCE(result_summary, ?3)
        WHERE workstream_id = ?4 AND automation_subscription_id = ?5 AND workspace_id = ?6`,
    ).bind(
      automationStatus,
      new Date().toISOString(),
      outcome.error?.message.slice(0, 500) ?? null,
      input.workstreamId,
      input.automationSubscriptionId,
      input.workspaceId,
    ).run();
  }

  private localRuntimeEnvironment(
    workspaceId: string,
    workstreamId: string,
    substreamId: string,
  ): Env {
    const routed = this.routedRuntimeEnvironment(workspaceId, workstreamId, substreamId);
    // Everything this object owns about this work stream, declared in one
    // place. A run executing here reaches each authority by holding it rather
    // than by resolving a name, and the next authority to move into an object
    // is added to `LocalWorkstreamAuthorities` instead of being given its own
    // mechanism — which is how the receipt authority came to be the one that
    // had none on 2026-08-24.
    if (!objectOwnsWorkstreamAuthorities(
      this.objectStore.identity(),
      this.externalSubstreamId(),
      { workspaceId, workstreamId, substreamId },
    )) return routed;
    // Each authority is installed as its *endpoint*, never as its storage: the
    // endpoint is what refuses a fenced object, commits the directory
    // projection with the row, and re-arms the alarm a wake-up write moved.
    // Handing down the tables would drop all three for the caller running
    // closest to them.
    const resident = (
      outcome: (body: unknown) => Promise<ObjectPortOutcome>,
    ): LocalAuthorityExecutor => async (operation, args) => (
      await outcome({ workspaceId, workstreamId, operation, args })
    ).payload as { ok?: boolean; value?: unknown; error?: string };
    return withLocalWorkstreamAuthorities(routed, workspaceId, workstreamId, {
      blockDashboard: resident((body) => this.blockDashboardOperationOutcome(body)),
      harnessRun: resident((body) => this.harnessRunOperationOutcome(body)),
      identity: resident((body) => this.identityOperationOutcome(body)),
      message: resident((body) => this.messageOperationOutcome(body)),
      resource: resident((body) => this.resourceOperationOutcome(body)),
      scheduling: resident((body) => this.schedulingOperationOutcome(body)),
      toolReceipt: resident((body) => this.toolReceiptOperationOutcome(body)),
      terminal: (operation, args) => this.runTerminalOperation({
        workspaceId,
        workstreamId,
        operation,
        args,
      } as TerminalOperationRequest) as Promise<unknown>,
    });
  }

  private routedRuntimeEnvironment(
    workspaceId: string,
    workstreamId: string,
    substreamId: string,
  ): Env {
    return withWorkstreamRuntimeDatabase(
      this.env,
      workspaceId,
      workstreamId,
      substreamId,
      async (statements) => {
        const result = await executeWorkstreamRuntimeSql(
          this.state.storage,
          this.product,
          WorkstreamRuntimeSqlRequestSchema.parse({
            workspaceId,
            workstreamId,
            harnessRunId: this.activeRunDispatch?.runId ?? null,
            requestId: uuidV7(),
            statements,
          }),
        );
        // Nothing here can move a wake-up any more: the local executor serves
        // a run's own statements, and every wake-up write goes through
        // `/internal/scheduling`, which re-derives the index itself. Re-deriving
        // it for a transcript write would have put a `getAlarm` in the
        // streaming path for no reason even when it could.
        return result.results;
      },
    );
  }

  private async publishAgentRuntimeEvent(event: Record<string, unknown>): Promise<void> {
    const parsed = ServerSocketEventSchema.parse({
      ...event,
      sequence: 0,
      occurredAt: new Date().toISOString(),
    });
    const sequenced = await this.commitRealtimeEvent(parsed);
    this.recordRecentEvent(sequenced);
    this.broadcast(sequenced);
    if (BLOCK_DASHBOARD_REFRESH_EVENT_TYPES.has(sequenced.type)) {
      await this.scheduleBlockDashboardRefresh(sequenced.sequence);
    }
  }

  private async acceptRegionalEffectAck(request: Request): Promise<Response> {
    const parsed = WorkstreamRegionalEffectAckSchema.safeParse(await request.json());
    if (!parsed.success) return jsonResponse({ error: "invalid_regional_effect_ack" }, 400);
    return jsonResponse({
      ok: true,
      removed: this.objectStore.acknowledgeRegionalEffect(
        parsed.data.messageId,
        parsed.data.payloadHash,
      ),
    });
  }

  private async readRegionalEffect(request: Request): Promise<Response> {
    const parsed = WorkstreamRegionalEffectAckSchema.safeParse(await request.json());
    if (!parsed.success) return jsonResponse({ error: "invalid_regional_effect_request" }, 400);
    const effect = this.objectStore.regionalEffect(parsed.data.messageId, parsed.data.payloadHash);
    return effect
      ? jsonResponse(effect)
      : jsonResponse({ error: "regional_effect_not_found" }, 404);
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialized;
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;

    try {
      decoded = JSON.parse(raw);
    } catch {
      this.sendError(socket, "invalid_json", "Socket messages must be JSON.");
      return;
    }

    const parsed = ClientSocketEventSchema.safeParse(decoded);
    if (!parsed.success) {
      this.sendError(socket, "invalid_event", "The socket event is not valid.");
      return;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Missing connection identity");
      return;
    }

    if (parsed.data.type === "subscribe") {
      const authority = await readWorkstreamAuthorityControl(this.env);
      if (!acceptsNewWorkstreamWork(authority) || !this.objectStore.isRealtimeWritable()) {
        disconnect(socket, 1012, "Work stream maintenance");
        return;
      }
      // The subscription is the half of opening a work stream that a person
      // actually waits on, and it arrives on its own invocation — hence its own
      // trace, joined to the upgrade's by `rally.socket.connection_id`.
      const afterSequence = parsed.data.afterSequence;
      await inFlowSpan(this.env, "workstream.room.socket.subscribe", {
        flow: "workstream_open",
        component: "substream_do",
        identity: {
          workspaceId: attachment.workspaceId,
          workstreamId: attachment.workstreamId,
          userId: attachment.userId,
          substreamId: attachment.substreamId,
        },
        attributes: {
          "rally.socket.connection_id": attachment.connectionId,
          "rally.socket.after_sequence": afterSequence,
        },
      }, async (span) => {
        const subscribed = await this.fulfillSubscription(
          socket,
          attachment.workspaceId,
          attachment.workstreamId,
          afterSequence,
          span,
        );
        if (subscribed) {
          await span.step("workstream.room.socket.broadcast_presence", () =>
            this.broadcastPresence(attachment.workspaceId, attachment.workstreamId));
        }
      });
      return;
    }

    if (parsed.data.type === "request_snapshot") {
      await this.fulfillSnapshotRequest(socket, attachment);
      return;
    }

    if (parsed.data.type === "load_message_page") {
      await this.fulfillMessagePage(socket, attachment, parsed.data);
      return;
    }

    if (parsed.data.type === "create_message") {
      this.sendError(
        socket,
        "workspace_socket_required",
        "Send new user messages through the workspace command socket.",
      );
      return;
    }

    // Product mutations are intentionally persisted and authorized through the
    // REST service before their resulting canonical event is published here.
    this.sendError(
      socket,
      "rest_required",
      "Persist this action through the work-stream API before publishing it."
    );
  }

  /**
   * Re-serve canonical state to a viewer that is already subscribed.
   *
   * This is `fulfillSubscription` at sequence zero, and deliberately nothing
   * more: assembling a snapshot awaits D1, so asking for one mid-connection has
   * exactly the bootstrap race an initial subscription has — an event published
   * inside that window would reach the viewer *before* the snapshot that
   * precedes it, and land as a duplicate or a gap. The initial path closes the
   * race by holding the socket out of broadcasts until an in-memory catch-up
   * runs, so a socket that is already in the room has to be put back into that
   * state to get the same guarantee; `fulfillSubscription` re-marks it
   * subscribed once the catch-up has closed the window.
   *
   * The reply is the ordinary sequenced `snapshot` frame rather than a
   * correlated direct one. That is what makes a stale answer a non-question:
   * the client already drops any frame at or below its cursor, so the room does
   * not have to reason about which of two concurrent answers is newer.
   */
  private async fulfillSnapshotRequest(
    socket: WebSocket,
    attachment: SocketAttachment,
  ): Promise<void> {
    if (!attachment.subscribed) {
      // Two ways to get here, and they are not the same thing. A socket that
      // never subscribed has no feed to refresh. A socket whose own earlier
      // request is still assembling is subscribed — it is only flagged
      // otherwise to keep broadcasts out of the window below — and telling that
      // reader to subscribe first would be a lie it cannot act on.
      const assembling = attachment.snapshotInFlight === true;
      this.sendError(
        socket,
        assembling ? "snapshot_in_flight" : "subscription_required",
        assembling
          ? "A snapshot for this socket is already being assembled."
          : "Subscribe to the message feed before requesting a snapshot.",
      );
      return;
    }
    socket.serializeAttachment({
      ...attachment,
      subscribed: false,
      snapshotInFlight: true,
    } satisfies SocketAttachment);
    try {
      const subscribed = await this.fulfillSubscription(
        socket,
        attachment.workspaceId,
        attachment.workstreamId,
        0,
      );
      if (!subscribed) {
        const current = this.readAttachment(socket);
        if (current) {
          socket.serializeAttachment({
            ...current,
            snapshotInFlight: false,
          } satisfies SocketAttachment);
        }
        return;
      }
      // `fulfillSubscription` re-marks the socket subscribed; only the
      // in-flight flag is this method's to clear.
      const current = this.readAttachment(socket);
      if (current) {
        socket.serializeAttachment({ ...current, snapshotInFlight: false } satisfies SocketAttachment);
      }
    } catch (error) {
      // Put the viewer back in the room rather than leaving it silently out of
      // every future broadcast. It still holds usable state, and a reader that
      // stops receiving frames has no way to tell that from a quiet work
      // stream. An ordinary delivery exception is different from the handled
      // snapshot fallback, which returns above after sending `resync_required`.
      //
      // Restored from the attachment as it stands, not the copy captured before
      // the call: `fulfillSubscription` may have recorded progress before
      // throwing, and rolling that back would discard it.
      const current = this.readAttachment(socket) ?? attachment;
      socket.serializeAttachment({
        ...current,
        subscribed: true,
        snapshotInFlight: false,
      } satisfies SocketAttachment);
      throw error;
    }
  }

  private async fulfillMessagePage(
    socket: WebSocket,
    attachment: SocketAttachment,
    request: Extract<z.infer<typeof ClientSocketEventSchema>, { type: "load_message_page" }>,
  ): Promise<void> {
    const sendFailure = (code: string, message: string): void => socket.send(JSON.stringify(
      SubstreamDirectSocketEventSchema.parse({
        type: "message_page_error",
        requestId: request.requestId,
        occurredAt: new Date().toISOString(),
        code,
        message,
      }),
    ));
    if (!attachment.subscribed) {
      sendFailure("subscription_required", "Subscribe to the message feed before loading a page.");
      return;
    }
    const auth = await this.socketAuth(attachment);
    if (!auth) {
      sendFailure("socket_access_revoked", "The work stream is no longer available.");
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "Work stream access revoked");
      return;
    }
    const value = Number(request.cursor.value);
    if (!Number.isSafeInteger(value)) {
      sendFailure("invalid_message_cursor", "The message cursor is not valid.");
      return;
    }
    try {
      const loadedPage = await this.product.messages(
        auth,
        request.limit,
        request.cursor.direction === "before" ? value : undefined,
        request.cursor.direction === "after" ? value : undefined,
      );
      const page = { ...loadedPage, items: [...loadedPage.items] };
      const buildEvent = () => SubstreamDirectSocketEventSchema.parse({
          type: "message_page",
          requestId: request.requestId,
          occurredAt: new Date().toISOString(),
          page,
        });
      let event = buildEvent();
      let encoded = JSON.stringify(event);
      while (textEncoder.encode(encoded).byteLength > MAX_SOCKET_MESSAGE_PAGE_BYTES
        && page.items.length > 1) {
        if (request.cursor.direction === "after") {
          page.items.pop();
          page.newerCursor = String(page.items.at(-1)!.sequenceNumber);
        } else {
          page.items.shift();
          page.nextCursor = String(page.items[0]!.sequenceNumber);
        }
        event = buildEvent();
        encoded = JSON.stringify(event);
      }
      if (textEncoder.encode(encoded).byteLength > MAX_SOCKET_MESSAGE_PAGE_BYTES) {
        sendFailure("message_page_too_large", "The next message is too large to load over the live feed.");
        return;
      }
      socket.send(encoded);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        sendFailure("socket_access_revoked", "The work stream is no longer available.");
        disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "Work stream access revoked");
        return;
      }
      sendFailure("message_page_unavailable", "Messages could not be loaded.");
    }
  }

  private async publishLocalProductEvent(
    attachment: Pick<SocketAttachment, "workspaceId" | "workstreamId">,
    event: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.acceptEvent(new Request(
      "https://room.internal/internal/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [RALLY_HEADERS.WORKSPACE_ID]: attachment.workspaceId,
          [RALLY_HEADERS.WORKSTREAM_ID]: attachment.workstreamId,
        },
        body: JSON.stringify(event),
      },
    ));
    if (!response.ok) throw new Error("workstream_local_event_publish_failed");
  }

  /**
   * Verification for a product request whose principal is a connector link
   * rather than a login session. Only the product path uses it: a socket can
   * never present a connector principal, because socket tickets are issued to
   * login sessions alone.
   *
   * The link itself — the standing authorization that a Slack identity acts as
   * this member — is a WorkspaceDO fact, and the Worker's ingress verifies it
   * per delivered message (`linkedAccount`), fresher than any token this
   * object could re-check. What remains this object's to verify is the same
   * D1 fact every admission re-checks: that the person is an active member of
   * this workspace, in this region, right now. That is exactly the sessions
   * query minus the `sessions` join, so a member removed from the workspace is
   * refused here with no new revocation machinery.
   *
   * `principal.sessionId` is a correlation value (`slack:{team}:{user}`), kept
   * on the returned context for tracing; nothing looks it up. The parameter is
   * typed off the product auth rather than a socket attachment on purpose —
   * a socket can never present a connector principal, and the product schema
   * is what guarantees the fields are present.
   */
  private async connectorPrincipalAuth(
    principal: Pick<SubstreamProductRequest["auth"], "sessionId" | "userId" | "workspaceId">,
  ): Promise<AuthContext | null> {
    const role = await this.activeMembership(principal.workspaceId, principal.userId);
    if (!role) return null;
    return {
      sessionId: principal.sessionId,
      userId: principal.userId,
      workspaceId: principal.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
      analyticsWorkspaceId: role.analytics_workspace_id ?? null,
    };
  }

  /**
   * The membership fact every non-session verification shares: an active
   * `workspace_members` row for this person, in a `workspaces` row this
   * region owns. `connectorPrincipalAuth` and `socketAuth`'s development
   * branch differ only in what they layer on top — auth SQL that is
   * copy-pasted is auth SQL that drifts, so there is one copy.
   */
  private async activeMembership(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<AuthRoleRow | null> {
    return await this.env.DB.prepare(
      `SELECT member.role, workspace.analytics_workspace_id
         FROM workspace_members member
         JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = ? AND member.user_id = ?
          AND member.status = 'active' AND workspace.region = ?`,
    ).bind(workspaceId, userId, this.env.AVALON_REGION).first<AuthRoleRow>();
  }

  private async socketAuth(attachment: Pick<SocketAttachment, "sessionId" | "userId" | "workspaceId">): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && attachment.sessionId === "development"
      ? await this.activeMembership(attachment.workspaceId, attachment.userId)
      : await this.env.DB.prepare(
        // The workspace surrogate rides this query because `workspaces` is
        // already joined — a socket that authorizes itself also learns what
        // PostHog knows the workspace as, at no extra round trip. The *person*
        // surrogate is deliberately not fetched here: it would mean joining
        // `users` from a Durable Object, and no diagnostic is worth widening
        // what a socket's authorization depends on.
        `SELECT member.role, workspace.analytics_workspace_id
           FROM sessions session
           JOIN workspace_members member
             ON member.workspace_id = session.workspace_id
            AND member.user_id = session.user_id
            AND member.status = 'active'
           JOIN workspaces workspace ON workspace.id = session.workspace_id
          WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
            AND session.region = ? AND session.revoked_at IS NULL
            AND session.expires_at > ? AND workspace.region = ?`,
      ).bind(
        attachment.sessionId,
        attachment.userId,
        attachment.workspaceId,
        this.env.AVALON_REGION,
        new Date().toISOString(),
        this.env.AVALON_REGION,
      ).first<AuthRoleRow>();
    if (!role) return null;
    return {
      sessionId: attachment.sessionId!,
      userId: attachment.userId,
      workspaceId: attachment.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
      analyticsWorkspaceId: role.analytics_workspace_id ?? null,
    };
  }

  /**
   * Synchronous creation/maintenance fence for effects already committed by
   * this child. Normal mutations use the alarm; callers that are about to make
   * a route discoverable must prove the parent has accepted every older fact.
   */
  async flushEffectsToWorkstreamDO(): Promise<number> {
    await this.initialized;
    let delivered = 0;
    for (let batch = 0; batch < 400; batch += 1) {
      // An explicit route fence overrides alarm backoff: a previous ambiguous
      // RPC may have deferred the exact snapshot this caller has to prove.
      const effects = this.objectStore.dueRegionalEffects(Number.MAX_SAFE_INTEGER, 100);
      if (effects.length === 0) break;
      await this.forwardEffectsToWorkstreamDO(effects);
      for (const effect of effects) {
        if (this.objectStore.acknowledgeRegionalEffect(effect.messageId, effect.payloadHash)) {
          delivered += 1;
        }
      }
    }
    if (this.objectStore.dueRegionalEffects(Number.MAX_SAFE_INTEGER, 1).length > 0) {
      throw new Error("substream_parent_effect_flush_limit");
    }
    await this.armNextAlarm();
    logInfo(this.env, "substream_outbox_fence_terminal", {
      substream_id: this.externalSubstreamId(),
      delivered_count: delivered,
      outcome: "forwarded",
      reason: "parent_outbox_fence_complete",
    });
    return delivered;
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
      className: "SubstreamAgent",
      migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  /**
   * Hold every due wake reason while this work stream's region is closed.
   *
   * Read only when there is work to hold: a keep-alive wake during a streaming
   * run has nothing to defer, and a D1 round trip every thirty seconds to
   * establish that would be paid by every active run in the fleet.
   */
  protected override async scheduledAlarmDeferral(now: number): Promise<number | null> {
    if (!this.hasDueAlarmWork(now)) return null;
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (acceptsNewWorkstreamWork(authority)) return null;
    return now + MAINTENANCE_RECHECK_MS;
  }

  protected override onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void {
    const identity = this.objectStore.identity();
    reportScheduledAlarmAttempt(this.env, (promise) => this.ctx.waitUntil(promise), {
      event: "substream_scheduled_alarm_failed",
      summary: "An agent object's alarm entry keeps throwing; `code` is the handler's error, and `alarm_kind` and `alarm_key` name the entry.",
      attempt,
      fields: {
        workspace_id: identity?.workspaceId ?? null,
        workstream_id: identity?.workstreamId ?? null,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
      },
      error,
    });
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    const identity = this.objectStore.identity();
    reportScheduledAlarmAttempt(this.env, (promise) => this.ctx.waitUntil(promise), {
      event: "substream_scheduled_alarm_stalled",
      summary: "An agent object's alarm entry keeps coming back due at the same instant after running: the source row behind `alarm_kind` and `alarm_key` is not moving. Find why.",
      attempt,
      fields: {
        workspace_id: identity?.workspaceId ?? null,
        workstream_id: identity?.workstreamId ?? null,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
        due_at: new Date(alarm.dueAt).toISOString(),
      },
    });
  }

  private hasDueAlarmWork(now: number): boolean {
    return this.objectStore.pendingBlockDashboardRefresh() !== null
      || this.objectStore.nextRegionalEffectDueAt() !== null
      || this.nextRunDispatchAt() !== null
      || this.scheduledAlarms.due(now, 1).length > 0;
  }

  /**
   * Fire one agent-created timer.
   *
   * The entry is the index, never the record: `workstream_wakeups` still owns
   * status, principal, and prompt, and this reloads the row so a wake-up
   * cancelled since the entry was written is a no-op rather than a run nobody
   * asked for. Throwing puts this timer — and only this timer — behind the
   * shared retry gate.
   *
   * The port is built without the in-isolate storage seam, so the claim goes
   * through `/internal/scheduling` like every other wake-up write. That is not
   * a round trip: `this.env` was rebound through `withDurableObjectSelf` in the
   * constructor, so the stub resolves to this instance and the endpoint runs
   * here. Taking the seam instead would skip the endpoint — and with it the
   * commit that republishes the sidebar's next-wake-up marker, which after a
   * claim still advertises a wake-up that has already fired.
   */
  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<void> {
    if (alarm.kind !== AGENT_TIMER_ALARM_KIND) {
      throw new Error(`substream_unknown_alarm_kind:${alarm.kind}`);
    }
    const identity = this.objectStore.identity();
    if (!identity) return;
    const executionEnv = this.localRuntimeEnvironment(
      identity.workspaceId,
      identity.workstreamId,
      this.externalSubstreamId(),
    );
    const scheduling = createSchedulingObjectPort(
      this.env,
      identity.workspaceId,
      identity.workstreamId,
    );
    const wakeup = await loadWorkstreamWakeup(
      scheduling,
      identity.workspaceId,
      identity.workstreamId,
      alarm.key,
    );
    if (!wakeup || wakeup.status !== "pending") return;
    await fireWorkstreamWakeup(executionEnv, wakeup, scheduling);
  }

  /**
   * Make the `agent_timer` entries match this object's pending wake-ups.
   *
   * Called wherever `workstream_wakeups` can have changed — every mutating
   * scheduling operation, the timer refresh port, and after a timer fires.
   * Reconciling rather than patching is what makes a wake-up scheduled *before*
   * the armed alarm pull that alarm in, and a cancelled one push it back out,
   * without either writer having to know an index exists.
   */
  private syncAgentTimerAlarms(): void {
    const pending = this.state.storage.sql.exec<{ wakeup_id: string; due_at: number }>(
      `SELECT wakeup_id, due_at FROM workstream_wakeups
        WHERE status = 'pending' ORDER BY due_at, wakeup_id LIMIT ?`,
      AGENT_TIMER_ALARM_LIMIT,
    ).toArray();
    this.state.storage.transactionSync(() => {
      this.scheduledAlarms.reconcile(
        AGENT_TIMER_ALARM_KIND,
        pending.map((row) => ({ key: row.wakeup_id, dueAt: row.due_at })),
      );
    });
  }

  protected override async runDueAlarmWork(): Promise<void> {
    this.runDrainDeferred = false;
    const pending = this.objectStore.pendingBlockDashboardRefresh();
    const nextBlockDashboardAt = this.objectStore.nextBlockDashboardDueAt();
    const nextEffectAt = this.objectStore.nextRegionalEffectDueAt();
    const hasRunDispatch = this.nextRunDispatchAt() !== null;
    // A timer that fired above may have left the index behind the table.
    this.syncAgentTimerAlarms();
    if (!pending && nextEffectAt === null && !hasRunDispatch) return;

    if (nextEffectAt !== null && nextEffectAt <= Date.now()) {
      const effects = this.objectStore.dueRegionalEffects();
      if (effects.length > 0) {
        try {
          await this.forwardEffectsToWorkstreamDO(effects);
          let removed = 0;
          for (const effect of effects) {
            if (this.objectStore.acknowledgeRegionalEffect(effect.messageId, effect.payloadHash)) {
              removed += 1;
            }
          }
          logInfo(this.env, "substream_outbox_batch_terminal", {
            workspace_id: effects[0]?.workspaceId ?? null,
            workstream_id: effects[0]?.workstreamId ?? null,
            substream_id: this.externalSubstreamId(),
            message_ids: effects.map((effect) => effect.messageId),
            effect_kinds: effects.map((effect) => effect.effect.kind),
            effect_count: effects.length,
            removed_count: removed,
            outcome: "forwarded",
            reason: "parent_outbox_accepted",
          });
        } catch (error) {
          const retryAt = Date.now() + 5_000;
          this.objectStore.deferRegionalEffects(effects, retryAt);
          logWarn(this.env, "substream_outbox_batch_deferred", {
            workspace_id: effects[0]?.workspaceId ?? null,
            workstream_id: effects[0]?.workstreamId ?? null,
            substream_id: this.externalSubstreamId(),
            message_ids: effects.map((effect) => effect.messageId),
            effect_kinds: effects.map((effect) => effect.effect.kind),
            effect_count: effects.length,
            retry_at: new Date(retryAt).toISOString(),
            outcome: "deferred",
            reason: diagnosticErrorCode(error, "parent_forward_failed"),
            error_name: error instanceof Error ? error.name : typeof error,
          });
          await this.ensureAlarmNoLaterThan(retryAt);
        }
      }
    }

    if (!pending || nextBlockDashboardAt === null || nextBlockDashboardAt > Date.now()) {
      this.runDrainDeferred = await this.drainRunsToCompletion() === "deferred";
      return;
    }
    this.objectStore.deletePendingBlockDashboardRefresh();
    try {
      await launchBlockDashboardRefresh(
        this.env,
        pending.workspaceId,
        pending.workstreamId,
        pending.triggerSequence,
        pending.contextFence,
      );
    } catch {
      const retryAt = Date.now() + BLOCK_DASHBOARD_DEBOUNCE_MS;
      this.objectStore.failPendingBlockDashboardRefresh(pending, retryAt);
      await this.ensureAlarmNoLaterThan(retryAt);
    }
    this.runDrainDeferred = await this.drainRunsToCompletion() === "deferred";
  }

  /** Best-effort forward of due effects; the alarm retries whatever defers. */
  private async flushDueRegionalEffects(): Promise<void> {
    const effects = this.objectStore.dueRegionalEffects();
    if (effects.length === 0) return;
    try {
      await this.forwardEffectsToWorkstreamDO(effects);
      let removed = 0;
      for (const effect of effects) {
        if (this.objectStore.acknowledgeRegionalEffect(effect.messageId, effect.payloadHash)) {
          removed += 1;
        }
      }
      logInfo(this.env, "substream_outbox_flush_terminal", {
        workspace_id: effects[0]?.workspaceId ?? null,
        workstream_id: effects[0]?.workstreamId ?? null,
        substream_id: this.externalSubstreamId(),
        message_ids: effects.map((effect) => effect.messageId),
        effect_kinds: effects.map((effect) => effect.effect.kind),
        effect_count: effects.length,
        removed_count: removed,
        outcome: "forwarded",
      });
    } catch (error) {
      const retryAt = Date.now() + 5_000;
      this.objectStore.deferRegionalEffects(effects, retryAt);
      logWarn(this.env, "substream_outbox_flush_deferred", {
        workspace_id: effects[0]?.workspaceId ?? null,
        workstream_id: effects[0]?.workstreamId ?? null,
        substream_id: this.externalSubstreamId(),
        message_ids: effects.map((effect) => effect.messageId),
        effect_kinds: effects.map((effect) => effect.effect.kind),
        effect_count: effects.length,
        retry_at: new Date(retryAt).toISOString(),
        outcome: "deferred",
        reason: diagnosticErrorCode(error, "parent_forward_failed"),
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async forwardEffectsToWorkstreamDO(
    effects: readonly WorkstreamRegionalEffectEnvelope[],
  ): Promise<void> {
    const firstEffect = effects[0];
    if (!firstEffect) return;
    if (effects.some((effect) => (
      effect.region !== firstEffect.region
      || effect.workspaceId !== firstEffect.workspaceId
      || effect.workstreamId !== firstEffect.workstreamId
      || effect.generation !== firstEffect.generation
    ))) throw new Error("substream_effect_batch_identity_mismatch");
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      firstEffect.workspaceId,
      workstreamDOName(
        firstEffect.region,
        firstEffect.workspaceId,
        firstEffect.workstreamId,
      ),
    );
    for (let offset = 0; offset < effects.length; offset += 25) {
      const response = await stub.receiveSubstreamEffects({
        substreamId: this.externalSubstreamId(),
        envelopes: effects.slice(offset, offset + 25),
      });
      if (response.status < 200 || response.status >= 300) {
        const body = rpcResultBody(response) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : "workstream_parent_effect_failed");
      }
    }
  }


  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    const attachment = this.readAttachment(socket);
    if (attachment?.subscribed) {
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId, socket);
    }
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = this.readAttachment(socket);
    try {
      socket.close(1011, "Realtime connection failed");
    } catch {
      // The peer may already be gone; presence cleanup still needs to run.
    }
    if (attachment?.subscribed) {
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId, socket);
    }
  }

  /**
   * The upgrade and the `subscribe` that follows it are separate invocations —
   * `subscribe` arrives over an already-open socket, possibly on a woken
   * isolate — so the platform traces them as two traces. `rally.socket.*`
   * attributes are what join them: the ticket id back to the route that issued
   * it, and the connection id forward to the subscription.
   */
  private async acceptSocket(request: Request, url: URL): Promise<Response> {
    return inFlowSpan(this.env, "workstream.room.socket.accept", {
      flow: "workstream_open",
      component: "substream_do",
    }, (span) => this.acceptSocketInSpan(request, url, span));
  }

  private async acceptSocketInSpan(request: Request, url: URL, span: FlowSpan): Promise<Response> {
    // The authority control is read once, below, after the identity is parsed.
    // It used to be read here as well, to refuse a socket during maintenance
    // before parsing anything — but the read is an uncached D1 round trip and
    // the second one repeats the same check milliseconds later, so the pair
    // cost every socket accept an extra round trip to save header parsing on
    // the rare maintenance path. It also charged that first wait to whichever
    // step closed next, which is how it was found.
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_upgrade_required" }, 426);
    }

    const identity = z
      .object({
        workspaceId: WorkspaceIdSchema,
        workstreamId: WorkstreamIdSchema,
        substreamId: SubstreamIdSchema,
        userId: UserIdSchema,
        sessionId: z.string().min(1).max(200),
        ticketId: z.string().uuid(),
        ticketExpiresAt: z.coerce.number().int().positive(),
        afterSequence: z.coerce.number().int().nonnegative().default(0)
      })
      .safeParse({
        workspaceId:
          readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? url.searchParams.get("workspaceId"),
        workstreamId:
          readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID) ?? url.searchParams.get("workstreamId"),
        substreamId:
          readRallyHeader(request.headers, RALLY_HEADERS.SUBSTREAM_ID) ?? url.searchParams.get("substreamId"),
        userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? url.searchParams.get("userId"),
        sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
        ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
        ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
        afterSequence: url.searchParams.get("afterSequence") ?? 0
      });

    if (!identity.success) return jsonResponse({ error: "invalid_socket_identity" }, 400);

    span.setAttributes({
      "rally.workspace.id": identity.data.workspaceId,
      "rally.workstream.id": identity.data.workstreamId,
      "user.id": identity.data.userId,
      "rally.substream.id": identity.data.substreamId,
      "rally.socket.ticket_id": identity.data.ticketId,
      "rally.socket.after_sequence": identity.data.afterSequence,
    });

    const currentAuthority = await span.step("workstream.room.socket.authority_read", () =>
      readWorkstreamAuthorityControl(this.env));
    if (!acceptsNewWorkstreamWork(currentAuthority)) {
      span.setError("workstream_maintenance");
      return jsonResponse({
        error: "workstream_maintenance",
        phase: currentAuthority.phase,
        generation: currentAuthority.generation,
      }, 503);
    }

    try {
      this.ensureSubstreamIdentity(identity.data.substreamId);
      this.objectStore.ensureIdentity({
        workspaceId: identity.data.workspaceId,
        workstreamId: identity.data.workstreamId,
      }, this.env.AVALON_REGION);
    } catch (error) {
      if (error instanceof Error && error.message === "workstream_object_identity_mismatch") {
        span.setError("room_identity_mismatch");
        return jsonResponse({ error: "room_identity_mismatch" }, 409);
      }
      span.setError("socket_identity_failed");
      throw error;
    }
    const authorized = Boolean(await span.step(
      "workstream.room.socket.member_authorize",
      () => this.env.DB.prepare(
        `SELECT 1 AS one FROM workspace_members
          WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
      ).bind(identity.data.workspaceId, identity.data.userId).first<{ one: number }>(),
    )) && this.product.canRead(identity.data.userId);
    if (!authorized) {
      span.setError("forbidden");
      return jsonResponse({ error: "forbidden" }, 403);
    }
    if (!this.objectStore.isRealtimeWritable()) {
      span.setError("workstream_maintenance");
      return jsonResponse({
        error: "workstream_maintenance",
        phase: currentAuthority.phase,
        generation: currentAuthority.generation,
      }, 503);
    }

    if (!this.objectStore.consumeSocketTicket(
      identity.data.ticketId,
      identity.data.ticketExpiresAt,
    )) {
      span.setError("socket_ticket_replayed");
      return jsonResponse({ error: "socket_ticket_replayed" }, 401);
    }

    const pair = Object.values(new WebSocketPair());
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) {
      span.setError("websocket_unavailable");
      return jsonResponse({ error: "websocket_unavailable" }, 500);
    }

    const attachment: SocketAttachment = {
      connectionId: uuidV7(),
      workspaceId: identity.data.workspaceId,
      workstreamId: identity.data.workstreamId,
      substreamId: identity.data.substreamId,
      userId: identity.data.userId,
      sessionId: identity.data.sessionId,
      connectedAt: new Date().toISOString(),
      afterSequence: identity.data.afterSequence,
      subscribed: false,
      snapshotInFlight: false
    };

    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);
    // Cloudflare's hibernation lifecycle registers the server end first, then
    // persists the connection state that a replacement isolate deserializes.
    // We keep no socket map to rebuild: handlers enumerate getWebSockets() and
    // validate each attachment at the point of use.
    server.serializeAttachment(attachment);

    span.mark("workstream.room.socket.accept_connection");
    span.setAttributes({
      "rally.socket.outcome": "accepted",
      "rally.socket.connection_id": attachment.connectionId,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptEvent(request: Request): Promise<Response> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority) && !permitsLegacyRuntimeDrain(authority)) {
      return jsonResponse({
        error: "workstream_maintenance",
        phase: authority.phase,
        generation: authority.generation,
      }, 503);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const wrapped = BroadcastRequestSchema.safeParse(body);
    const unvalidatedEvent = wrapped.success ? wrapped.data.event : body;
    if (typeof unvalidatedEvent !== "object" || unvalidatedEvent === null) {
      return jsonResponse({ error: "invalid_event" }, 400);
    }

    const requestIdentity = RoomIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      workstreamId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID) ?? null,
    });
    if (!requestIdentity.success) {
      return jsonResponse({ error: "invalid_room_identity" }, 400);
    }
    try {
      this.objectStore.ensureIdentity(requestIdentity.data, this.env.AVALON_REGION);
    } catch (error) {
      if (error instanceof Error && error.message === "workstream_object_identity_mismatch") {
        return jsonResponse({ error: "room_identity_mismatch" }, 409);
      }
      throw error;
    }

    const rawEvent = unvalidatedEvent as Record<string, unknown>;
    if (wrapped.success && wrapped.data.audienceUserId) {
      const personalEvent = PersonalSocketEventSchema.safeParse({
        ...rawEvent,
        occurredAt:
          typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : new Date().toISOString(),
      });
      if (!personalEvent.success) {
        return jsonResponse(
          { error: "invalid_event", details: personalEvent.error.flatten().fieldErrors },
          400,
        );
      }
      this.broadcast(personalEvent.data, undefined, wrapped.data.audienceUserId);
      return jsonResponse({ accepted: true }, 202);
    }

    const requestedSequence =
      typeof rawEvent.sequence === "number" && Number.isSafeInteger(rawEvent.sequence)
        ? rawEvent.sequence
        : undefined;
    const candidate = {
      ...rawEvent,
      // Validate before consuming a room sequence. The committed event is
      // assigned its real sequence atomically with any stream checkpoint.
      sequence: 0,
      occurredAt:
        typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : new Date().toISOString()
    };
    const unsequencedEvent = ServerSocketEventSchema.safeParse(candidate);

    if (!unsequencedEvent.success) {
      return jsonResponse(
        { error: "invalid_event", details: unsequencedEvent.error.flatten().fieldErrors },
        400
      );
    }
    const event = await this.commitRealtimeEvent(unsequencedEvent.data, requestedSequence);

    this.recordRecentEvent(event);
    // Before the broadcast, so the event that excluded them is not the last
    // thing they are sent. This is the transcript feed — the highest-frequency
    // socket in the product — so it is gated on an event that can actually
    // narrow visibility, and it reads only this object's own SQL. The D1
    // membership query that used to sit here is gone for good; losing workspace
    // membership is the revocation queue's job. See docs/access-revocation.md.
    const evicted = retractsReadAccess(event) ? this.evictReadersWhoLostLocalAccess() : false;
    this.broadcast(event);
    // After the event, not before: presence allocates a sequence of its own and
    // this event's was allocated first, so sending the roster ahead of it would
    // put a higher sequence on the wire before a lower one and the client would
    // drop the event that closed the work stream. `webSocketClose` fires only
    // for a client-initiated close, so closing here invokes nothing and the
    // people who remain would otherwise keep seeing an evicted reader present.
    if (evicted) {
      const identity = this.objectStore.identity();
      if (identity) await this.broadcastPresence(identity.workspaceId, identity.workstreamId);
    }
    if (BLOCK_DASHBOARD_REFRESH_EVENT_TYPES.has(event.type)) {
      await this.scheduleBlockDashboardRefresh(event.sequence);
    }
    return jsonResponse({ accepted: true, sequence: event.sequence }, 202);
  }

  private async scheduleBlockDashboardRefresh(triggerSequence: number): Promise<void> {
    const identity = this.objectStore.identity();
    if (!identity) return;
    const now = Date.now();
    const existing = this.objectStore.pendingBlockDashboardRefresh();
    const contextFence = this.blockDashboardContextFence(identity.workspaceId);
    const pending: PendingBlockDashboardRefresh = {
      ...identity,
      triggerSequence: Math.max(existing?.triggerSequence ?? 0, triggerSequence),
      contextFence: existing && existing.contextFence.throughSequence > contextFence.throughSequence
        ? existing.contextFence
        : contextFence,
      firstQueuedAt: existing?.firstQueuedAt ?? now,
    };
    const dueAt = Math.min(
      now + BLOCK_DASHBOARD_DEBOUNCE_MS,
      pending.firstQueuedAt + BLOCK_DASHBOARD_MAX_DEBOUNCE_MS,
    );
    this.objectStore.putPendingBlockDashboardRefresh(pending, dueAt);
    await this.ensureAlarmNoLaterThan(dueAt);
  }

  /**
   * Freeze a provider-valid main-feed window for every block in one refresh.
   *
   * A pending tool call is mutable operational state: its result can settle
   * after the call's sequence was allocated. The upper waterline therefore
   * stops before the earliest pending call. A completed tool row is a legal
   * boundary because model projection recreates the assistant call and its
   * tool result as one inseparable provider-valid pair.
   */
  private blockDashboardContextFence(workspaceId: string): BlockDashboardContextFence {
    const pendingTool = this.state.storage.sql.exec<{ sequence_number: number | null }>(
      `SELECT MIN(sequence_number) AS sequence_number
         FROM parts
        WHERE substream_id = '0' AND kind = 'tool_call' AND tool_status = 'pending'`,
    ).toArray()[0]?.sequence_number ?? null;
    const throughSequence = this.state.storage.sql.exec<{ sequence_number: number | null }>(
      `SELECT MAX(sequence_number) AS sequence_number
         FROM parts
        WHERE substream_id = '0'
          AND kind IN ('text', 'tool_call', 'tool_result', 'attachment', 'terminal')
          AND (? IS NULL OR sequence_number < ?)`,
      pendingTool,
      pendingTool,
    ).toArray()[0]?.sequence_number ?? 0;
    const revision = this.state.storage.sql.exec<{ revision: number }>(
      `SELECT revision FROM resource_inventory_revision WHERE id = 1`,
    ).toArray()[0]?.revision ?? 0;
    const principalKey = `workspace:${workspaceId}`;
    const fingerprint = `inventory:${revision}`;
    const checkpoint = this.state.storage.sql.exec<CompactionCheckpointRow>(
      `SELECT execution_principal_key, resource_visibility_fingerprint,
              checkpoint_template_version, run_id, compacted_through_sequence,
              messages_json, summary, model
         FROM compaction_checkpoints
        WHERE execution_principal_key = ?
          AND resource_visibility_fingerprint = ?
          AND compacted_through_sequence <= ?
        ORDER BY compacted_through_sequence DESC, updated_at DESC LIMIT 1`,
      principalKey,
      fingerprint,
      throughSequence,
    ).toArray()[0];
    if (!checkpoint) return { throughSequence, compaction: null };
    const identity: ContextCompactionCheckpointIdentity = {
      executionPrincipalKey: checkpoint.execution_principal_key,
      resourceVisibilityFingerprint: checkpoint.resource_visibility_fingerprint,
      checkpointTemplateVersion: checkpoint.checkpoint_template_version,
      checkpointRunId: checkpoint.run_id,
      compactedThroughSequence: checkpoint.compacted_through_sequence,
      messagesJson: checkpoint.messages_json,
      summary: checkpoint.summary,
      model: checkpoint.model,
    };
    return {
      throughSequence,
      compaction: {
        checkpointRunId: checkpoint.run_id,
        compactedThroughSequence: checkpoint.compacted_through_sequence,
        checkpointHash: contextCompactionCheckpointHash(identity),
      },
    };
  }

  protected override armAlarmBeforeDueWork(now: number): Promise<unknown> {
    // Delivery consumes the alarm, so until this returns the object has no
    // wake-up at all. Everything below it awaits the network, and a cancelled
    // continuation never settles — it does not throw, so a `finally` would not
    // run either. Arming first is what makes the sweep floor a floor rather
    // than something reachable only when the work it guards already succeeded.
    return this.armAlarmDuringRunDrain(now);
  }

  protected override armAlarmAfterDueWork(): Promise<unknown> {
    return this.runDrainDeferred ? this.armAlarmDuringRunDrain() : this.armNextAlarm();
  }

  /**
   * Re-arm without redelivering the dispatch this invocation is responsible for.
   *
   * Everything else this object waits on keeps its own deadline, so only the
   * run lane is held back, and only to one heartbeat horizon: that bounds
   * recovery if this invocation is cancelled without turning a live drain into
   * an alarm that fires the instant it returns. Pending wake-ups are read from
   * the entry index rather than `workstream_wakeups` so this and the base agree
   * on when the next timer is due.
   */
  private async armAlarmDuringRunDrain(now: number = Date.now()): Promise<void> {
    await this.armNextAlarm({
      now,
      overdueAt: now + KEEP_ALIVE_INTERVAL_MS,
      derivedCandidates: [
        this.objectStore.nextRegionalEffectDueAt(),
        this.objectStore.nextBlockDashboardDueAt(),
        now + KEEP_ALIVE_INTERVAL_MS,
      ],
    });
  }

  /**
   * Derived from the dispatch rows alone.
   *
   * This deliberately does not consult `agentDrain.active`. It used to, and an
   * invocation cancelled between claiming a run and finishing it then left the
   * row `running` with the alarm already deleted — nothing was left to
   * rediscover it, and the member watched a spinner that would never resolve.
   * In-memory knowledge that a drain is running belongs to deduplication, not
   * to scheduling.
   */
  private nextRunDispatchAt(now: number = Date.now()): number | null {
    return nextAgentRunDispatchWakeUpAt(
      this.state.storage.sql,
      SUBSTREAM_AGENT_RUN_DISPATCHES,
      now,
    );
  }

  /**
   * The wake reasons this object derives from its own tables.
   *
   * Agent timers are deliberately absent: they live in `_internal_durable_alarms` as
   * `agent_timer` entries, so every wake-up due at one instant fires in one
   * alarm and a failing one is gated on its own rather than blocking the
   * queue behind it. The keep-alive is not a row at all — it is an in-memory
   * lease held only while a run is streaming — so it stays derived.
   */
  protected override nextDerivedAlarmCandidates(now: number): readonly number[] {
    const candidates: Array<number | null> = [
      this.objectStore.nextRegionalEffectDueAt(),
      this.objectStore.nextBlockDashboardDueAt(),
      this.nextRunDispatchAt(now),
    ];
    if (this.keepAliveLease.active) candidates.push(now + KEEP_ALIVE_INTERVAL_MS);
    return candidates.filter((candidate): candidate is number => candidate !== null);
  }

  private async fulfillSubscription(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    afterSequence: number,
    span: FlowSpan = noFlowSpan,
  ): Promise<boolean> {
    let deliveredThrough = await span.step("workstream.room.subscribe.current_sequence", () =>
      this.currentSequence());
    const plan = planSocketReplay(
      afterSequence,
      deliveredThrough,
      this.replayFloorSequence,
      this.recentEvents,
    );
    // Which of the three plans a subscription takes is the first question
    // asked of a slow open: a snapshot reads canonical state, a replay sends
    // what is already in memory, and a sequence-ahead resync makes the client
    // fetch canonical state over HTTP instead.
    span.setAttributes({
      "rally.subscribe.replay_plan": plan.type,
      ...(plan.type === "snapshot" ? { "rally.subscribe.snapshot_reason": plan.reason } : {}),
      ...(plan.type === "replay" ? { "rally.subscribe.replay_event_count": plan.events.length } : {}),
    });
    const delivered = await span.step("workstream.room.subscribe.deliver", () =>
      this.deliverReplayPlan(socket, workspaceId, workstreamId, deliveredThrough, plan, span));
    if (!delivered) return false;

    // Loading a snapshot awaits object storage and can yield to a concurrently
    // published event. Keep this socket out of broadcasts until one in-memory
    // catch-up closes that race. The catch-up may replay or resync, but never
    // assemble a second snapshot whose own wait would need a third stage.
    const catchUpSequence = await span.step("workstream.room.subscribe.catch_up_sequence", () =>
      this.currentSequence());
    if (catchUpSequence > deliveredThrough) {
      span.setAttributes({ "rally.subscribe.catch_up_events": catchUpSequence - deliveredThrough });
      const caughtUp = await span.step("workstream.room.subscribe.deliver_catch_up", () =>
        this.deliverReplayPlan(
          socket,
          workspaceId,
          workstreamId,
          catchUpSequence,
          planSocketReplay(
            deliveredThrough,
            catchUpSequence,
            this.replayFloorSequence,
            this.recentEvents,
            false,
          ),
        ));
      if (!caughtUp) return false;
      deliveredThrough = catchUpSequence;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment) throw new Error("Missing connection identity during subscription");
    socket.serializeAttachment({
      ...attachment,
      afterSequence: deliveredThrough,
      subscribed: true,
    } satisfies SocketAttachment);
    return true;
  }

  private async deliverReplayPlan(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    currentSequence: number,
    plan: SocketReplayPlan,
    span: FlowSpan = noFlowSpan,
  ): Promise<boolean> {
    if (plan.type === "snapshot") {
      const delivered = await this.sendSnapshot(
        socket,
        workspaceId,
        workstreamId,
        plan.reason,
        currentSequence,
        span,
      );
      if (delivered) return true;
      this.sendResyncRequired(socket, currentSequence, "history_unavailable");
      return false;
    }
    if (plan.type === "replay") {
      for (const event of plan.events) socket.send(JSON.stringify(event));
      return true;
    }
    this.sendResyncRequired(socket, currentSequence, plan.reason);
    return false;
  }

  private sendResyncRequired(
    socket: WebSocket,
    currentSequence: number,
    reason: "history_unavailable" | "sequence_ahead",
  ): void {
    const event = ServerSocketEventSchema.parse({
      type: "resync_required",
      sequence: currentSequence,
      occurredAt: new Date().toISOString(),
      reason,
      latestSequence: currentSequence,
      activeStreams: reason === "history_unavailable"
        ? this.objectStore.activeStreamCheckpoints()
        : [],
      activeCompaction: this.objectStore.activeCompaction(),
    });
    socket.send(JSON.stringify(event));
  }

  private async sendSnapshot(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    reason: "initial" | "history_unavailable",
    knownSequence?: number,
    span: FlowSpan = noFlowSpan,
  ): Promise<boolean> {
    try {
      const attachment = this.readAttachment(socket);
      if (!attachment) throw new Error("Missing connection identity while loading snapshot");
      const workstream = await span.step("workstream.room.snapshot.detail", () =>
        this.loadSnapshot(workspaceId, workstreamId, attachment.userId));
      // Its own step: this is an awaited D1 round trip, and a step's duration is
      // measured from the end of the previous one, so leaving it unstepped
      // charged the authorization wait to the transcript read below and made
      // `slowest_step` name the wrong thing.
      const auth = await span.step("workstream.room.snapshot.session_auth", () =>
        this.socketAuth(attachment));
      if (!auth) throw new Error("Snapshot viewer is no longer authorized");
      // Both transcript windows, from the assembler `GET /workstreams/:id` also
      // uses. The detail above already carries presence, which `boot` cannot
      // know about, so its own copy is discarded rather than re-read here.
      const boot = await span.step("workstream.room.snapshot.transcript", () =>
        this.product.bootFeeds(
          auth,
          reason === "initial" ? workstream.firstUnreadSequenceNumber : null,
        ));
      const messageFeed = { ...boot.messageFeed, items: [...boot.messageFeed.items] };
      // Copied, not aliased: the cap below has to be able to shrink this one too.
      const resumeFeed = boot.resumeFeed
        ? { ...boot.resumeFeed, items: [...boot.resumeFeed.items] }
        : null;
      const sequence = knownSequence ?? await this.currentSequence();
      const storedCheckpoints = this.objectStore.activeStreamCheckpoints();
      const activeStreams = workstream.harnessStatus === "running"
        ? storedCheckpoints.filter((checkpoint) =>
            checkpoint.harnessRunId === workstream.latestHarnessRunId)
        : [];
      const storedCompaction = this.objectStore.activeCompaction();
      const activeCompaction = workstream.harnessStatus === "running"
        && storedCompaction?.harnessRunId === workstream.latestHarnessRunId
        ? storedCompaction
        : null;
      const buildEvent = () => ServerSocketEventSchema.parse({
          type: "snapshot",
          sequence,
          occurredAt: new Date().toISOString(),
          workstream,
          messageFeed,
          resumeFeed,
          activeStreams,
          activeCompaction,
        });
      let event = buildEvent();
      let encoded = JSON.stringify(event);
      // Carried rather than recomputed: the cap, the trim loop, and the
      // reported size are all about UTF-8 bytes, and encoding once per
      // iteration replaces the two full encodes the loop used to do per trim.
      let encodedBytes = textEncoder.encode(encoded).byteLength;
      let trims = 0;
      /**
       * Drop the oldest message from one window, or report that it cannot.
       *
       * The cap covers the whole frame, so every window in it has to be
       * reducible. When only the newest page could shrink, a large enough
       * resume window put the frame over the limit with nothing left to trim
       * and the open failed outright with `snapshot_unavailable`.
       */
      const trimOldest = (feed: typeof messageFeed): boolean => {
        if (feed.items.length <= 1) return false;
        feed.items.shift();
        feed.nextCursor = String(feed.items[0]!.sequenceNumber);
        return true;
      };
      while (
        encodedBytes > MAX_SOCKET_SNAPSHOT_BYTES
        // Newest page first. When a resume window exists it is the one being
        // rendered — the reader is at their unread mark, not at the end — so
        // the page they are not looking at gives up its messages first.
        && (trimOldest(messageFeed) || (resumeFeed !== null && trimOldest(resumeFeed)))
      ) {
        event = buildEvent();
        encoded = JSON.stringify(event);
        encodedBytes = textEncoder.encode(encoded).byteLength;
        trims += 1;
      }
      if (encodedBytes > MAX_SOCKET_SNAPSHOT_BYTES) {
        throw new Error("substream_snapshot_frame_too_large");
      }
      span.mark("workstream.room.snapshot.encode");
      // The trim loop re-serializes the whole frame per dropped message, so a
      // transcript that overshoots the cap is a cost that only shows up as this
      // count beside the byte size.
      span.setAttributes({
        // Bytes, not `encoded.length`: that counts UTF-16 code units, so any
        // non-ASCII transcript under-reported against a cap measured in UTF-8.
        "rally.snapshot.bytes": encodedBytes,
        "rally.snapshot.message_count": messageFeed.items.length + (resumeFeed?.items.length ?? 0),
        "rally.snapshot.trims": trims,
      });
      socket.send(encoded);
      return true;
    } catch {
      span.setError("snapshot_unavailable");
      return false;
    }
  }

  private async loadSnapshot(
    workspaceId: string,
    workstreamId: string,
    viewerUserId: string,
  ): Promise<WorkstreamDetail> {
    const attachment = this.state.getWebSockets().map((socket) => this.readAttachment(socket))
      .find((candidate) => candidate?.userId === viewerUserId);
    if (!attachment) throw new Error("Snapshot viewer socket is unavailable");
    const auth = await this.socketAuth(attachment);
    if (!auth) throw new Error("Snapshot viewer is no longer authorized");
    const viewers = await this.loadViewers(workspaceId, workstreamId);
    return this.product.get(auth, viewers);
  }

  private async loadViewers(
    workspaceId: string,
    workstreamId: string,
    excluding?: WebSocket
  ): Promise<WorkstreamDetail["viewers"]> {
    const attachments = this.state
      .getWebSockets()
      .filter((socket) => socket !== excluding)
      .map((socket) => this.readAttachment(socket))
      .filter((attachment): attachment is SocketAttachment =>
        Boolean(
          attachment
          && attachment.subscribed
          && attachment.workspaceId === workspaceId
          && attachment.workstreamId === workstreamId
        )
      );

    const participantIds = new Set(this.product.activeParticipantIds());
    const viewers = distinctNonParticipantViewers(attachments, participantIds);

    return Promise.all(
      viewers.map(async (attachment) => {
        const user = await this.env.DB.prepare(`SELECT * FROM users WHERE id = ?1 LIMIT 1`)
          .bind(attachment.userId)
          .first<UserRow>();
        if (!user) throw new Error("Viewer no longer exists");
        return { user: userFromRow(user), connectedAt: attachment.connectedAt };
      })
    );
  }

  private async broadcastPresence(
    workspaceId: string,
    workstreamId: string,
    excluding?: WebSocket,
  ): Promise<void> {
    try {
      const viewers = await this.loadViewers(workspaceId, workstreamId, excluding);
      const sequence = await this.allocateSequence();
      const event = ServerSocketEventSchema.parse({
        type: "presence_changed",
        sequence,
        occurredAt: new Date().toISOString(),
        viewers
      });
      this.recordRecentEvent(event);
      this.broadcast(event, excluding);
    } catch {
      // Presence is deliberately ephemeral. A failed presence refresh must not
      // break the canonical work-stream connection.
    }
  }

  private broadcast(
    event: ServerSocketEvent | PersonalSocketEvent,
    excluding?: WebSocket,
    audienceUserId?: string,
  ): void {
    const payload = JSON.stringify(event);
    if (textEncoder.encode(payload).byteLength > 1_000_000) {
      throw new Error("Realtime event exceeds the bounded frame size");
    }

    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      const attachment = this.readAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (audienceUserId && !isPersonalEventAudience(attachment.userId, audienceUserId)) continue;
      try {
        socket.send(payload);
      } catch {
        // The runtime will deliver close/error separately; one stale socket must
        // not prevent delivery to healthy clients.
      }
    }
  }

  private recordRecentEvent(event: ServerSocketEvent): void {
    if (event.type === "snapshot" || event.type === "error" || event.type === "resync_required") return;
    const bytes = textEncoder.encode(JSON.stringify(event)).byteLength;
    if (this.replayFloorSequence === null) this.replayFloorSequence = Math.max(0, event.sequence - 1);
    this.recentEvents.push(event);
    this.recentEventBytes += bytes;
    while (this.recentEvents.length > MAX_REPLAY_EVENTS || this.recentEventBytes > MAX_REPLAY_BYTES) {
      const removed = this.recentEvents.shift();
      if (!removed) break;
      this.recentEventBytes -= textEncoder.encode(JSON.stringify(removed)).byteLength;
      this.replayFloorSequence = removed.sequence;
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    const event = ServerSocketEventSchema.parse({
      type: "error",
      // A private protocol error is not part of the canonical feed. Reusing
      // the current cursor avoids creating a transcript gap merely because a
      // client sent a malformed or misrouted frame.
      sequence: this.objectStore.currentSequence(),
      occurredAt: new Date().toISOString(),
      code,
      message
    });
    socket.send(JSON.stringify(event));
  }

  /**
   * Drop every socket this agent holds for a person whose access ended.
   *
   * The only way a socket here is closed for lost access; see
   * `docs/access-revocation.md`. This agent has no view of D1 membership or
   * sessions on its own, and deliberately does not acquire one — the transcript
   * feed is the highest-frequency socket in the product, and an authorization
   * question on that path would be asked per token frame.
   */
  /**
   * Close the sockets of readers this work stream itself no longer admits.
   *
   * Object-local and synchronous: `product.canRead` reads this object's own
   * root and participant rows. It answers "may this person read *this work
   * stream*", which no queue message carries and no other object knows. Losing
   * workspace membership is the separate question that {@link revokeSocketAccess}
   * answers, and the two must not be confused for each other.
   */
  private evictReadersWhoLostLocalAccess(): boolean {
    let evicted = false;
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      if (!attachment || this.product.canRead(attachment.userId)) continue;
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      evicted = true;
    }
    return evicted;
  }

  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<void> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    let evicted = false;
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      // This schema alone makes `sessionId` optional, which is why the rule is
      // shared rather than written out at each of the four roles — see
      // `revocationClosesSocket`.
      if (!attachment || !revocationClosesSocket(request, attachment)) continue;
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      evicted = true;
    }
    // The people still here would otherwise go on seeing an evicted reader
    // listed as present: `webSocketClose` fires for a *client*-initiated close,
    // so closing one here invokes nothing.
    if (evicted) {
      const identity = this.objectStore.identity();
      if (identity) await this.broadcastPresence(identity.workspaceId, identity.workstreamId);
    }
  }

  private readAttachment(socket: WebSocket): SocketAttachment | null {
    try {
      const parsed = SocketAttachmentSchema.safeParse(socket.deserializeAttachment());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async currentSequence(): Promise<number> {
    return this.objectStore.currentSequence();
  }

  private async allocateSequence(requested?: number): Promise<number> {
    return this.objectStore.allocateSequence(requested);
  }

  /**
   * The event sequence and accumulated active text are one durable commit. A
   * snapshot can therefore be older than a concurrently arriving event (the
   * subscription catch-up handles that), but can never skip a stream frame
   * whose sequence it already claims to include.
   */
  private async commitRealtimeEvent(
    unsequencedEvent: ServerSocketEvent,
    requestedSequence?: number,
  ): Promise<ServerSocketEvent> {
    return this.objectStore.commitRealtimeEvent(unsequencedEvent, requestedSequence);
  }
}
