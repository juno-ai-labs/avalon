import {
  AcknowledgeWorkstreamReadRequestSchema,
  AnswerElicitationRequestSchema,
  ClientSocketEventSchema,
  IdSchema,
  PersonalSocketEventSchema,
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
} from "@avalon/contracts";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  contextCompactionCheckpointHash,
  type ContextCompactionCheckpointIdentity,
} from "../lib/context-compaction-fence";
import {
  assertDurableObjectJurisdiction,
  durableObjectStubForWorkspace,
} from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { workstreamVisibilitySql } from "../lib/workstream-visibility";
import {
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
import { logWarn } from "../observability/logger";
import {
  claimHarnessAttempt,
  reapStaleHarnessRuns,
  terminalizeHarnessAttempt,
  terminalizeQueuedHarnessRun,
} from "../runtime/harness-run-runtime";
import { runWorkstreamHarness, type WorkstreamHarnessResult } from "../services/integrations";
import { deliverAutomationResultEmail } from "../services/automation-email-service";
import { settleDigestRun } from "../services/digest-run-settlement";
import { SlackAgentService } from "../services/slack-agent-service";
import { refreshWorkstreamDescription } from "../services/workstream-description-service";
import { refreshWorkstreamName } from "../services/workstream-naming-service";
import { withWorkstreamRuntimeDatabase } from "../services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import {
  fireWorkstreamWakeup,
  WorkstreamService,
} from "../services/workstream-service";
import type { WorkstreamWakeupRow } from "../services/workstream-wakeup-service";
import {
  acceptsNewWorkstreamWork,
  permitsLegacyRuntimeDrain,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import {
  WorkstreamRegionalEffectAckSchema,
  type WorkstreamRegionalEffectEnvelope,
} from "./workstream-regional-effect";
import { workstreamDOName } from "./names";
import {
  BlockDashboardSourceRefreshRequestSchema,
  type BlockDashboardContextFence,
} from "./block-dashboard-protocol";
import {
  WorkstreamObjectStore,
  type PendingBlockDashboardRefresh,
} from "./workstream-object-storage";
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
import { responseToRpcResult, rpcResultBody, type DurableObjectRpcResult } from "./rpc-result";

export { applyActiveStreamCheckpointEvent, splitActiveStreamCheckpointText } from "./workstream-object-storage";

const SocketAttachmentSchema = z.object({
  connectionId: z.string().uuid(),
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  substreamId: z.union([z.literal("0"), IdSchema]),
  userId: IdSchema,
  // Absent only on a socket accepted by a pre-command-gateway deployment. A
  // command on that socket triggers a normal reconnect for a fresh ticket.
  sessionId: z.string().min(1).max(200).optional(),
  connectedAt: z.string().datetime({ offset: true }),
  afterSequence: z.number().int().nonnegative(),
  subscribed: z.boolean().default(false)
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
const RuntimeBootstrapRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
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
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  substreamId: z.union([z.literal("0"), IdSchema]),
}).strict();
const ProductAuthSchema = z.object({
  sessionId: z.string().min(1).max(200),
  userId: IdSchema,
  workspaceId: IdSchema,
  region: z.enum(["global", "eu"]),
  role: z.enum(["owner", "admin", "member"]),
}).strict();
const ProductRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("initialize"), auth: ProductAuthSchema,
    input: InitializeWorkstreamObjectInputSchema }).strict(),
  z.object({ operation: z.literal("get"), auth: ProductAuthSchema }).strict(),
  z.object({ operation: z.literal("context"), auth: ProductAuthSchema }).strict(),
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
const RoomIdentitySchema = z.object({ workspaceId: IdSchema, workstreamId: IdSchema });
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
/**
 * How stale the room lets its picture of who may read this work stream get.
 *
 * The sweep is one indexed query over only the users currently connected, and
 * it is gated on an event actually being delivered, so a quiet room costs
 * nothing and a busy one pays it twice a minute. It is skipped for
 * `stream_delta`, which is the only high-frequency event and is always preceded
 * in the same turn by a `stream_started` that is not skipped.
 */
const AUTHORIZATION_REVALIDATE_MS = 30_000;
const BLOCK_DASHBOARD_DEBOUNCE_MS = 1_200;
const BLOCK_DASHBOARD_MAX_DEBOUNCE_MS = 5_000;
const MAINTENANCE_RECHECK_MS = 5 * 60_000;
// Generous by design — the 10 GB object ceiling is the only hard bound. Spent
// dispatch and wake-up rows this old are consumed intents whose idempotency
// windows closed with their runs; the runs table keeps the durable record.
const OPERATIONAL_FENCE_RETENTION_MS = 180 * 24 * 60 * 60_000;
/** Matches the Agents SDK default, while keeping Avalon independent of it. */
const KEEP_ALIVE_INTERVAL_MS = 30_000;
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

function minimumTimestamp(...timestamps: Array<number | null>): number | null {
  const present = timestamps.filter((timestamp): timestamp is number => timestamp !== null);
  return present.length === 0 ? null : Math.min(...present);
}


/**
 * Whether this event can have taken somebody's read access away.
 *
 * A work stream becoming `personal` narrows it to its participants, and losing
 * a participant narrows it again — the second only matters while it is already
 * `personal`, but the sweep answers that itself rather than guessing here.
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

export { substreamAgentName } from "./names";

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
  | { type: "snapshot" }
  | { type: "replay"; events: ServerSocketEvent[] }
  | { type: "resync_required"; reason: "history_unavailable" | "sequence_ahead" };

/**
 * The replay window intentionally lives only in object memory. Persisting every
 * token event would turn an ephemeral optimization into storage write cost.
 * After hibernation, clients receive an explicit resync instruction and use
 * the canonical REST surface for the current authority generation.
 */
export function planSocketReplay(
  afterSequence: number,
  currentSequence: number,
  replayFloorSequence: number | null,
  recentEvents: readonly ServerSocketEvent[],
  allowInitialSnapshot = true,
): SocketReplayPlan {
  if (afterSequence === 0 && allowInitialSnapshot) return { type: "snapshot" };
  if (afterSequence > currentSequence) {
    return { type: "resync_required", reason: "sequence_ahead" };
  }
  if (afterSequence === currentSequence) return { type: "replay", events: [] };
  if (replayFloorSequence === null || afterSequence < replayFloorSequence) {
    return { type: "resync_required", reason: "history_unavailable" };
  }
  const events = recentEvents.filter((event) => event.sequence > afterSequence);
  if (events.length === 0 || events.at(-1)?.sequence !== currentSequence) {
    return { type: "resync_required", reason: "history_unavailable" };
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
export class SubstreamAgent extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly recentEvents: ServerSocketEvent[] = [];
  private recentEventBytes = 0;
  private replayFloorSequence: number | null = null;
  /**
   * When the connected set was last checked against D1, in memory only. A
   * hibernated room wakes at zero and re-checks on its next event, which is the
   * conservative direction.
   */
  private lastRevalidatedAt = 0;
  private readonly objectStore: WorkstreamObjectStore;
  private readonly product: WorkstreamObjectProductService;
  private readonly initialized: Promise<void>;
  private readonly keepAliveLease: DurableAgentKeepAlive;
  private readonly agentDrain = new DurableAgentDrain();

  constructor(
    state: DurableObjectState,
    env: Env
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.objectStore = new WorkstreamObjectStore(
      state.storage,
      env.APP_VERSION ?? "unknown",
      env.AVALON_REGION,
    );
    this.product = new WorkstreamObjectProductService(state.storage, this.objectStore, env);
    this.keepAliveLease = new DurableAgentKeepAlive(() => this.scheduleNextAlarm());
    this.initialized = state.blockConcurrencyWhile(async () => {
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
      await this.scheduleNextAlarm();
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

  private externalSubstreamId(): string {
    return this.state.storage.sql.exec<{ external_substream_id: string }>(
      `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
    ).toArray()[0]?.external_substream_id ?? "0";
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
        await this.scheduleNextAlarm();
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

  async handleProductRequest(input: SubstreamProductRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptProductRequest(this.rpcRequest(input)));
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

  async createRuntimeSuggestion(input: SubstreamRuntimeSuggestionRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeSuggestion(this.rpcRequest(input)));
  }

  async bootstrapRuntime(input: SubstreamRuntimeBootstrapRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeBootstrap(this.rpcRequest(input)));
  }

  async dispatchRun(input: WorkstreamWorkflowInput): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRunDispatch(this.rpcRequest(input)));
  }

  async publishEvent(input: SubstreamPublishedEvent): Promise<DurableObjectRpcResult> {
    await this.initialized;
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-avalon-workspace-id", input.workspaceId);
    headers.set("x-avalon-workstream-id", input.workstreamId);
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
    await this.scheduleNextAlarm();
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
    try {
      const result = await executeWorkstreamRuntimeSql(
        this.state.storage,
        this.product,
        parsed.data,
      );
      await this.scheduleNextAlarm();
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "workstream_runtime_sql_failed",
      }, 409);
    }
  }

  private async acceptRuntimeResource(request: Request): Promise<Response> {
    const parsed = RuntimeResourceRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_runtime_resource" }, 400);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== parsed.data.workspaceId
      || identity.workstreamId !== parsed.data.workstreamId) {
      return jsonResponse({ error: "workstream_runtime_identity_mismatch" }, 409);
    }
    try {
      await this.product.attachRuntimeResource(
        parsed.data.workspaceId,
        parsed.data.resourceId,
        parsed.data.attachedByUserId,
        parsed.data.relationshipType,
      );
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "runtime_resource_attach_failed",
      }, 409);
    }
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
    const substreamId = parsed.data.substreamId ?? "0";
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

  private async acceptProductRequest(request: Request): Promise<Response> {
    const parsed = ProductRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_product_request" }, 400);
    const current = await this.socketAuth({
      connectionId: uuidV7(),
      workspaceId: parsed.data.auth.workspaceId,
      workstreamId: this.objectStore.identity()?.workstreamId ?? "",
      substreamId: this.externalSubstreamId(),
      userId: parsed.data.auth.userId,
      sessionId: parsed.data.auth.sessionId,
      connectedAt: new Date().toISOString(),
      afterSequence: 0,
      subscribed: false,
    });
    if (!current || current.role !== parsed.data.auth.role || current.region !== parsed.data.auth.region) {
      return jsonResponse({ error: "session_revoked" }, 401);
    }
    try {
      if (parsed.data.operation === "initialize") {
        const result = await this.product.initialize(current, parsed.data.input);
        const identity = { workspaceId: parsed.data.input.workspaceId, workstreamId: parsed.data.input.workstreamId };
        const messages = await this.product.messages(current, 1);
        if (messages.items[0]) {
          await this.publishLocalProductEvent(identity, {
            type: "message_created",
            message: messages.items[0],
          });
        }
        await this.startProductWorkflow(identity, result.harnessRunId, result.workflowInput);
        return jsonResponse({
          workstream: result.workstream,
          messageId: result.messageId,
          harnessRunId: result.harnessRunId,
        });
      }
      if (parsed.data.operation === "get") {
        return jsonResponse(await this.product.get(current));
      }
      if (parsed.data.operation === "context") {
        return jsonResponse(await this.product.context(current));
      }
      if (parsed.data.operation === "messages") {
        return jsonResponse(await this.product.messages(
          current,
          parsed.data.limit,
          parsed.data.before,
          parsed.data.after,
          parsed.data.around,
        ));
      }
      const identity = this.objectStore.identity();
      if (!identity) return jsonResponse({ error: "workstream_not_found" }, 404);
      if (parsed.data.operation === "update") {
        const result = await this.product.update(current, parsed.data.input);
        for (const event of result.events) await this.publishLocalProductEvent(identity, event);
        return jsonResponse(result.workstream);
      }
      if (parsed.data.operation === "acknowledge_read") {
        return jsonResponse(await this.product.acknowledgeRead(current, parsed.data.input));
      }
      if (parsed.data.operation === "mark_unread") {
        return jsonResponse(await this.product.markUnread(current));
      }
      if (parsed.data.operation === "create_message") {
        const result = await this.product.createMessage(current, parsed.data.input);
        if (result.inserted) {
          await this.publishLocalProductEvent(identity, { type: "message_created", message: result.message });
        }
        await this.startProductWorkflow(identity, result.harnessRunId, result.workflowInput);
        return jsonResponse({
          message: result.message,
          agentInvoked: result.agentInvoked,
          harnessRunId: result.harnessRunId,
        });
      }
      if (parsed.data.operation === "add_participant") {
        const participant = await this.product.addParticipant(current, parsed.data.userId);
        await this.publishLocalProductEvent(identity, { type: "participant_added", participant });
        return jsonResponse(participant);
      }
      if (parsed.data.operation === "remove_participant") {
        await this.product.removeParticipant(current, parsed.data.userId);
        await this.publishLocalProductEvent(identity, {
          type: "participant_removed",
          userId: parsed.data.userId,
        });
        return jsonResponse({ ok: true });
      }
      if (parsed.data.operation === "attach_resource") {
        const resource = await this.product.attachResource(current, parsed.data.resourceId);
        await this.publishLocalProductEvent(identity, { type: "resource_attached", resource });
        return jsonResponse(resource);
      }
      if (parsed.data.operation === "detach_resource") {
        await this.product.detachResource(current, parsed.data.resourceId);
        return jsonResponse({ ok: true });
      }
      if (parsed.data.operation === "resolve_suggestion") {
        const result = await this.product.resolveSuggestion(
          current,
          parsed.data.suggestionId,
          parsed.data.action,
        );
        if (result.changed && result.suggestion) {
          await this.publishLocalProductEvent(identity, {
            type: "activity_suggestion_resolved",
            suggestion: result.suggestion,
          });
        }
        return jsonResponse({ suggestion: result.suggestion, resourceId: result.resourceId });
      }
      if (parsed.data.operation === "answer_elicitation") {
        const result = await this.product.answerElicitation(
          current,
          parsed.data.elicitationId,
          parsed.data.input,
        );
        if (result.elicitation) {
          await this.publishLocalProductEvent(identity, {
            type: "elicitation_answered",
            elicitation: result.elicitation,
          });
        }
        await this.startProductWorkflow(identity, result.harnessRunId, result.workflowInput);
        return jsonResponse({ elicitation: result.elicitation, harnessRunId: result.harnessRunId });
      }
      if (parsed.data.operation === "stop") {
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
  private async drainRunsToCompletion(): Promise<void> {
    await this.agentDrain.resume(
      () => this.drainRunQueue()
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
  }

  private async drainRunQueue(): Promise<void> {
    while (true) {
      // Only the alarm forwards regional effects, and this loop owns the alarm
      // until it returns. Flushing between runs keeps a queue of runs from
      // holding the parent's view of all of them; effects committed *during* a
      // single long run still wait for it to finish.
      await this.flushDueRegionalEffects();
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
        await this.product.recordWorkflowFailed(claim.id, safe).catch(() => undefined);
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
      }
    }
  }

  private async executeAgentRun(input: WorkstreamWorkflowInput): Promise<{
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
    await reapStaleHarnessRuns(executionEnv.DB, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      limit: 25,
      automationDatabase: withWorkspaceRuntimeDatabase(this.env, input.workspaceId).DB,
    });
    const attemptId = uuidV7();
    const claim = await claimHarnessAttempt(executionEnv.DB, input, {
      attemptId,
      owner: `substream-agent:${input.substreamId ?? "0"}:${input.harnessRunId}:${attemptId}`,
      leaseSeconds: 300,
    });
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
        executionEnv.DB,
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
        { lease: claim.lease, publishRealtime: false },
      );
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "harness_execution_failed";
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
    await terminalizeHarnessAttempt(executionEnv.DB, input, claim.lease, {
      status: effectiveStatus,
      ...(outcome.messageId ? { finalMessageId: outcome.messageId } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      memberSafePayload: outcome.error ? { code: outcome.error.code } : {},
    });
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
            requestId: uuidV7(),
            statements,
          }),
        );
        return result.results;
      },
    );
  }

  private async fireNextAgentTimer(): Promise<void> {
    const identity = this.objectStore.identity();
    if (!identity) return;
    const executionEnv = this.localRuntimeEnvironment(
      identity.workspaceId,
      identity.workstreamId,
      this.externalSubstreamId(),
    );
    const wakeup = await executionEnv.DB.prepare(
      `SELECT id, workspace_id, workstream_id, execution_principal_json, prompt,
              due_at, status, version, created_at
         FROM workstream_wakeups
        WHERE workspace_id = ? AND workstream_id = ? AND status = 'pending'
          AND due_at <= ? ORDER BY due_at, id LIMIT 1`,
    ).bind(identity.workspaceId, identity.workstreamId, new Date().toISOString())
      .first<WorkstreamWakeupRow>();
    if (!wakeup) return;
    await fireWorkstreamWakeup(executionEnv, wakeup);
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
      await this.fulfillSubscription(
        socket,
        attachment.workspaceId,
        attachment.workstreamId,
        parsed.data.afterSequence,
      );
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId);
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
          "x-avalon-workspace-id": attachment.workspaceId,
          "x-avalon-workstream-id": attachment.workstreamId,
        },
        body: JSON.stringify(event),
      },
    ));
    if (!response.ok) throw new Error("workstream_local_event_publish_failed");
  }

  private async socketAuth(attachment: SocketAttachment): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.AVALON_DEV_AUTH === "true"
      && attachment.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role
           FROM workspace_members member
           JOIN workspaces workspace ON workspace.id = member.workspace_id
          WHERE member.workspace_id = ? AND member.user_id = ?
            AND member.status = 'active' AND workspace.region = ?`,
      ).bind(
        attachment.workspaceId,
        attachment.userId,
        this.env.AVALON_REGION,
      ).first<{ role: AuthContext["role"] }>()
      : await this.env.DB.prepare(
        `SELECT member.role
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
      ).first<{ role: AuthContext["role"] }>();
    if (!role) return null;
    return {
      sessionId: attachment.sessionId!,
      userId: attachment.userId,
      workspaceId: attachment.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
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
    await this.scheduleNextAlarm();
    return delivered;
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    // Delivery consumes the alarm, so until this line the object has no wake-up
    // at all. Everything below awaits the network, and a cancelled continuation
    // never settles — it does not throw, so a `finally` would not run either.
    // Re-arming first is what makes the sweep floor a floor rather than
    // something reachable only when the work it guards already succeeded.
    await this.scheduleNextAlarm();
    const pending = this.objectStore.pendingBlockDashboardRefresh();
    const nextBlockDashboardAt = this.objectStore.nextBlockDashboardDueAt();
    const nextEffectAt = this.objectStore.nextRegionalEffectDueAt();
    const nextAgentTimerAt = this.nextAgentTimerAt();
    const hasRunDispatch = this.nextRunDispatchAt() !== null;
    if (!pending && nextEffectAt === null && nextAgentTimerAt === null && !hasRunDispatch) {
      await this.scheduleNextAlarm();
      return;
    }
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority)) {
      await this.state.storage.setAlarm(Date.now() + MAINTENANCE_RECHECK_MS);
      return;
    }

    if (nextEffectAt !== null && nextEffectAt <= Date.now()) {
      const effects = this.objectStore.dueRegionalEffects();
      if (effects.length > 0) {
        try {
          await this.forwardEffectsToWorkstreamDO(effects);
          for (const effect of effects) {
            this.objectStore.acknowledgeRegionalEffect(effect.messageId, effect.payloadHash);
          }
        } catch {
          const retryAt = Date.now() + 5_000;
          this.objectStore.deferRegionalEffects(effects, retryAt);
          await this.ensureAlarmNoLaterThan(retryAt);
        }
      }
    }

    if (nextAgentTimerAt !== null && nextAgentTimerAt <= Date.now()) {
      await this.fireNextAgentTimer();
    }

    if (!pending || nextBlockDashboardAt === null || nextBlockDashboardAt > Date.now()) {
      await this.drainRunsToCompletion();
      await this.scheduleNextAlarm();
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
    await this.drainRunsToCompletion();
    await this.scheduleNextAlarm();
  }

  /** Best-effort forward of due effects; the alarm retries whatever defers. */
  private async flushDueRegionalEffects(): Promise<void> {
    const effects = this.objectStore.dueRegionalEffects();
    if (effects.length === 0) return;
    try {
      await this.forwardEffectsToWorkstreamDO(effects);
      for (const effect of effects) {
        this.objectStore.acknowledgeRegionalEffect(effect.messageId, effect.payloadHash);
      }
    } catch {
      this.objectStore.deferRegionalEffects(effects, Date.now() + 5_000);
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

  private async acceptSocket(request: Request, url: URL): Promise<Response> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority)) {
      return jsonResponse({
        error: "workstream_maintenance",
        phase: authority.phase,
        generation: authority.generation,
      }, 503);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_upgrade_required" }, 426);
    }

    const identity = z
      .object({
        workspaceId: IdSchema,
        workstreamId: IdSchema,
        substreamId: z.union([z.literal("0"), IdSchema]),
        userId: IdSchema,
        sessionId: z.string().min(1).max(200),
        ticketId: z.string().uuid(),
        ticketExpiresAt: z.coerce.number().int().positive(),
        afterSequence: z.coerce.number().int().nonnegative().default(0)
      })
      .safeParse({
        workspaceId:
          request.headers.get("x-avalon-workspace-id") ?? url.searchParams.get("workspaceId"),
        workstreamId:
          request.headers.get("x-avalon-workstream-id") ?? url.searchParams.get("workstreamId"),
        substreamId:
          request.headers.get("x-avalon-substream-id") ?? url.searchParams.get("substreamId"),
        userId: request.headers.get("x-avalon-user-id") ?? url.searchParams.get("userId"),
        sessionId: request.headers.get("x-avalon-session-id"),
        ticketId: request.headers.get("x-avalon-socket-ticket-id"),
        ticketExpiresAt: request.headers.get("x-avalon-socket-ticket-expires-at"),
        afterSequence: url.searchParams.get("afterSequence") ?? 0
      });

    if (!identity.success) return jsonResponse({ error: "invalid_socket_identity" }, 400);

    const currentAuthority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(currentAuthority)) {
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
        return jsonResponse({ error: "room_identity_mismatch" }, 409);
      }
      throw error;
    }
    const authorized = currentAuthority.phase === "durable_object_open"
      ? Boolean(await this.env.DB.prepare(
        `SELECT 1 AS one FROM workspace_members
          WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
      ).bind(identity.data.workspaceId, identity.data.userId).first<{ one: number }>())
        && this.product.canRead(identity.data.userId)
      : Boolean(await this.env.DB.prepare(
        `SELECT 1
           FROM workstreams w
           JOIN workspace_members member ON member.workspace_id = w.workspace_id
          WHERE w.id = ?1 AND w.workspace_id = ?2
            AND member.user_id = ? AND member.status = 'active'
            AND w.archived_at IS NULL
            AND ${workstreamVisibilitySql("?3")}
          LIMIT 1`,
      ).bind(
        identity.data.workstreamId,
        identity.data.workspaceId,
        identity.data.userId,
      ).first());
    if (!authorized) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
    if (!this.objectStore.isRealtimeWritable()) {
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
      return jsonResponse({ error: "socket_ticket_replayed" }, 401);
    }

    const pair = Object.values(new WebSocketPair());
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return jsonResponse({ error: "websocket_unavailable" }, 500);

    const attachment: SocketAttachment = {
      connectionId: uuidV7(),
      workspaceId: identity.data.workspaceId,
      workstreamId: identity.data.workstreamId,
      substreamId: identity.data.substreamId,
      userId: identity.data.userId,
      sessionId: identity.data.sessionId,
      connectedAt: new Date().toISOString(),
      afterSequence: identity.data.afterSequence,
      subscribed: false
    };

    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);
    // Cloudflare's hibernation lifecycle registers the server end first, then
    // persists the connection state that a replacement isolate deserializes.
    // We keep no socket map to rebuild: handlers enumerate getWebSockets() and
    // validate each attachment at the point of use.
    server.serializeAttachment(attachment);

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
      workspaceId: request.headers.get("x-avalon-workspace-id"),
      workstreamId: request.headers.get("x-avalon-workstream-id"),
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
    // Authorization is decided once, when each socket connects, so anything that
    // can retract it has to reach the connections already inside the room.
    // Sweeping before the broadcast means the people this event excluded do not
    // receive it — they are disconnected instead, and their client stops rather
    // than resynchronizing into a work stream it may no longer read.
    let evicted = false;
    if (retractsReadAccess(event)) {
      evicted = await this.evictReadersWhoMayNoLongerRead(true);
    } else if (
      // The publisher that delivers the event above swallows its own failures,
      // because for every other event realtime is an optimization. For a
      // retraction it is enforcement, so the room does not rely on having been
      // told: it re-asks the question on its own, at most once an interval, and
      // a retraction that never arrived is applied before the next thing this
      // room would have sent. That also covers the retractions nothing
      // publishes at all, such as a workspace membership going inactive.
      event.type !== "stream_delta"
      && Date.now() - this.lastRevalidatedAt >= AUTHORIZATION_REVALIDATE_MS
    ) {
      evicted = await this.evictReadersWhoMayNoLongerRead(false);
    }
    this.broadcast(event);
    // After the event, not inside the sweep. Presence allocates a sequence of
    // its own, and this event's was allocated before the sweep ran — sending
    // the roster first would put a higher sequence on the wire ahead of a lower
    // one, and the client drops anything at or below the last sequence it
    // applied. The event that closed the work stream would be the one thrown
    // away. Every other close in this class refreshes the roster too, and this
    // one must: `webSocketClose` fires for a *client*-initiated close, so
    // closing a socket here invokes nothing, and the people who remain would go
    // on seeing the evicted readers listed as present. `disconnect` has already
    // marked those attachments unsubscribed, which is the filter `loadViewers`
    // applies, so they drop out without an exclusion argument.
    if (evicted) {
      const identity = this.objectStore.identity();
      if (identity) {
        await this.broadcastPresence(identity.workspaceId, identity.workstreamId);
      }
    }
    if (BLOCK_DASHBOARD_REFRESH_EVENT_TYPES.has(event.type)) {
      await this.scheduleBlockDashboardRefresh(event.sequence);
    }
    return jsonResponse({ accepted: true, sequence: event.sequence }, 202);
  }

  /**
   * Disconnect every socket whose user may no longer read this work stream.
   *
   * A socket is authorized once, when it connects, and then lives for as long
   * as the window stays open. Narrowing a work stream to its participants, or
   * taking somebody out of a narrowed one, has to reach the connections already
   * inside it, or the change would apply to everyone who opens it next and to
   * nobody who is reading it now.
   *
   * The question is asked of the whole connected set in one query rather than
   * per socket, and it is the same rule the connection itself was checked
   * against.
   *
   * `certain` says whether this sweep is resolving a retraction that just
   * happened, and it decides only what to do when the query itself fails —
   * which is the one case where the room does not know who may stay. See
   * {@link evictEveryReaderPendingReauthorization}.
   */
  private async evictReadersWhoMayNoLongerRead(certain: boolean): Promise<boolean> {
    const sockets = this.state.getWebSockets();
    const byUserId = new Map<string, WebSocket[]>();
    for (const socket of sockets) {
      const attachment = this.readAttachment(socket);
      if (!attachment) continue;
      const existing = byUserId.get(attachment.userId);
      if (existing) existing.push(socket);
      else byUserId.set(attachment.userId, [socket]);
    }
    if (byUserId.size === 0) return false;

    const identity = this.objectStore.identity();
    if (!identity) return false;
    const userIds = [...byUserId.keys()];
    const placeholders = userIds.map(() => "?").join(",");
    let permitted: Set<string>;
    try {
      const authority = await readWorkstreamAuthorityControl(this.env);
      if (authority.phase === "durable_object_open") {
        const result = await this.env.DB.prepare(
          `SELECT member.user_id
             FROM workspace_members member
            WHERE member.workspace_id = ? AND member.status = 'active'
              AND member.user_id IN (${placeholders})`,
        ).bind(identity.workspaceId, ...userIds).all<{ user_id: string }>();
        permitted = new Set((result.results ?? [])
          .map((row) => row.user_id)
          .filter((userId) => this.product.canRead(userId)));
      } else {
        const result = await this.env.DB.prepare(
          `SELECT member.user_id
             FROM workstreams w
             JOIN workspace_members member ON member.workspace_id = w.workspace_id
            WHERE w.id = ? AND w.workspace_id = ?
              AND member.status = 'active' AND member.user_id IN (${placeholders})
              AND ${workstreamVisibilitySql("member.user_id")}`,
        ).bind(identity.workstreamId, identity.workspaceId, ...userIds)
          .all<{ user_id: string }>();
        permitted = new Set((result.results ?? []).map((row) => row.user_id));
      }
    } catch {
      if (certain) {
        this.evictEveryReaderPendingReauthorization(sockets);
        // Either way the sweep is not recorded as having run, so the next event
        // re-asks rather than waiting out the interval.
        return true;
      }
      return false;
    }
    this.lastRevalidatedAt = Date.now();

    let evicted = false;
    for (const [userId, userSockets] of byUserId) {
      if (permitted.has(userId)) continue;
      for (const socket of userSockets) {
        disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        evicted = true;
      }
    }
    return evicted;
  }

  /**
   * The answer when a retraction has definitely happened and the room cannot
   * find out who it applies to.
   *
   * Leaving every socket open would keep serving the work stream to the people
   * it was just closed to, so the room disconnects all of them — but as `1011`,
   * a transient server condition, not as the access-revoked code. That
   * distinction is the whole point: a reconnect is authorized against D1 at
   * connect time, so everyone who may still read it is back within a second,
   * and only those who genuinely lost access fail to return. Closing them all
   * as "access revoked" would instead strand every legitimate reader on an
   * error screen over what may have been one failed query.
   */
  private evictEveryReaderPendingReauthorization(sockets: WebSocket[]): void {
    for (const socket of sockets) disconnect(socket, 1011, "Reconnect to continue reading this work stream");
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

  private async ensureAlarmNoLaterThan(dueAt: number): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > dueAt) await this.state.storage.setAlarm(dueAt);
  }

  private async ensureNextWorkAlarm(): Promise<void> {
    await this.scheduleNextAlarm();
  }

  private nextAgentTimerAt(): number | null {
    return this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(due_at) AS due_at FROM workstream_wakeups WHERE status = 'pending'`,
    ).toArray()[0]?.due_at ?? null;
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
  private nextRunDispatchAt(): number | null {
    return nextAgentRunDispatchWakeUpAt(
      this.state.storage.sql,
      SUBSTREAM_AGENT_RUN_DISPATCHES,
      Date.now(),
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    const durableDueAt = minimumTimestamp(
      this.objectStore.nextRegionalEffectDueAt(),
      this.objectStore.nextBlockDashboardDueAt(),
      this.nextAgentTimerAt(),
      this.nextRunDispatchAt(),
    );
    const dueAt = this.keepAliveLease.alarmDueAt(
      durableDueAt,
      Date.now(),
      KEEP_ALIVE_INTERVAL_MS,
    );
    if (dueAt === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + 1, dueAt));
  }

  private async fulfillSubscription(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    afterSequence: number,
  ): Promise<void> {
    let deliveredThrough = await this.currentSequence(workstreamId);
    await this.deliverReplayPlan(socket, workspaceId, workstreamId, deliveredThrough, planSocketReplay(
      afterSequence,
      deliveredThrough,
      this.replayFloorSequence,
      this.recentEvents,
    ));

    // Loading an initial snapshot awaits D1 and can yield to a concurrently
    // published event. Keep this socket out of broadcasts until a second,
    // in-memory catch-up closes that bootstrap race.
    const catchUpSequence = await this.currentSequence(workstreamId);
    if (catchUpSequence > deliveredThrough) {
      await this.deliverReplayPlan(
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
      );
      deliveredThrough = catchUpSequence;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment) throw new Error("Missing connection identity during subscription");
    socket.serializeAttachment({
      ...attachment,
      afterSequence: deliveredThrough,
      subscribed: true,
    } satisfies SocketAttachment);
  }

  private async deliverReplayPlan(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    currentSequence: number,
    plan: SocketReplayPlan,
  ): Promise<void> {
    if (plan.type === "snapshot") {
      await this.sendSnapshot(socket, workspaceId, workstreamId, currentSequence);
      return;
    }
    if (plan.type === "replay") {
      for (const event of plan.events) socket.send(JSON.stringify(event));
      return;
    }
    const event = ServerSocketEventSchema.parse({
      type: "resync_required",
      sequence: currentSequence,
      occurredAt: new Date().toISOString(),
      reason: plan.reason,
      latestSequence: currentSequence,
      activeStreams: plan.reason === "history_unavailable"
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
    knownSequence?: number,
  ): Promise<void> {
    try {
      const attachment = this.readAttachment(socket);
      if (!attachment) throw new Error("Missing connection identity while loading snapshot");
      const workstream = await this.loadSnapshot(workspaceId, workstreamId, attachment.userId);
      const auth = await this.socketAuth(attachment);
      if (!auth) throw new Error("Snapshot viewer is no longer authorized");
      const canonicalFeed = await this.product.messages(auth, 250);
      const messageFeed = { ...canonicalFeed, items: [...canonicalFeed.items] };
      const sequence = knownSequence ?? await this.currentSequence(workstreamId);
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
          activeStreams,
          activeCompaction,
        });
      let event = buildEvent();
      let encoded = JSON.stringify(event);
      while (textEncoder.encode(encoded).byteLength > MAX_SOCKET_SNAPSHOT_BYTES
        && messageFeed.items.length > 1) {
        messageFeed.items.shift();
        messageFeed.nextCursor = String(messageFeed.items[0]!.sequenceNumber);
        event = buildEvent();
        encoded = JSON.stringify(event);
      }
      if (textEncoder.encode(encoded).byteLength > MAX_SOCKET_SNAPSHOT_BYTES) {
        throw new Error("substream_snapshot_frame_too_large");
      }
      socket.send(encoded);
    } catch {
      this.sendError(socket, "snapshot_unavailable", "Canonical work-stream state is unavailable.");
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
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase !== "durable_object_open") {
      return { ...await new WorkstreamService(this.env, auth).get(workstreamId), viewers };
    }
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

    const authority = await readWorkstreamAuthorityControl(this.env);
    const participantIds = authority.phase === "durable_object_open"
      ? new Set(this.product.activeParticipantIds())
      : new Set((await this.env.DB.prepare(
        `SELECT user_id FROM workstream_participants
          WHERE workstream_id = ? AND removed_at IS NULL`,
      ).bind(workstreamId).all<{ user_id: string }>()).results.map((row) => row.user_id));
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

  private readAttachment(socket: WebSocket): SocketAttachment | null {
    try {
      const parsed = SocketAttachmentSchema.safeParse(socket.deserializeAttachment());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async currentSequence(workstreamId: string): Promise<number> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase === "durable_object_open") return this.objectStore.currentSequence();
    const canonical = await this.env.DB.prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) AS sequence
         FROM messages WHERE workstream_id = ?`,
    ).bind(workstreamId).first<{ sequence: number }>();
    return this.objectStore.currentSequence(canonical?.sequence ?? 0);
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
