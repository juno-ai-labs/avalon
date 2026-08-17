import {
  AcknowledgeWorkstreamReadRequestSchema,
  AnswerElicitationRequestSchema,
  ClientSocketEventSchema,
  IdSchema,
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  UpdateWorkstreamRequestSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamSocketCommandResultSchema,
  type ClientSocketEvent,
  type PersonalSocketEvent,
  type ServerSocketEvent,
  type User,
  type WorkstreamDetail,
  type WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { z } from "zod";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { workstreamVisibilitySql } from "../lib/workstream-visibility";
import { launchHyperSightRefresh } from "../services/hypersight-service";
import { logWarn } from "../observability/logger";
import { WorkstreamService } from "../services/workstream-service";
import {
  acceptsNewWorkstreamWork,
  permitsLegacyRuntimeDrain,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import {
  WorkstreamAuthorityImporter,
  WorkstreamAuthorityImportRequestSchema,
} from "./workstream-authority-import";
import {
  WorkstreamRegionalEffectAckSchema,
  workstreamRegionalEffectWakeMessage,
} from "./workstream-regional-effect";
import {
  WorkstreamObjectStore,
  type PendingHyperSightRefresh,
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

export { applyActiveStreamCheckpointEvent, splitActiveStreamCheckpointText } from "./workstream-object-storage";

const SocketAttachmentSchema = z.object({
  connectionId: z.string().uuid(),
  workspaceId: IdSchema,
  workstreamId: IdSchema,
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
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 512_000;
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
const HYPERSIGHT_DEBOUNCE_MS = 1_200;
const HYPERSIGHT_MAX_DEBOUNCE_MS = 5_000;
const MAINTENANCE_RECHECK_MS = 5 * 60_000;
const HYPERSIGHT_REFRESH_EVENT_TYPES = new Set([
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
  "hypersight_configuration_updated",
]);

type SocketAttachment = z.infer<typeof SocketAttachmentSchema>;
type CreateMessageSocketCommand = Extract<ClientSocketEvent, { type: "create_message" }>;

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
 * WorkstreamRoom.broadcast} filters on. Closing alone would leave the guarantee
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

export function workstreamRoomName(
  region: "global" | "eu",
  workspaceId: string,
  workstreamId: string
): string {
  return `${region}:${workspaceId}:${workstreamId}`;
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
 * The hibernating realtime and storage authority for one work stream.
 *
 * Before the guarded D1 import opens, the room coordinates live events around
 * the legacy product rows. After it opens, the same object-local SQL database
 * is the product authority; REST remains the recovery surface in both phases.
 */
export class WorkstreamRoom {
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
  private readonly authorityImporter: WorkstreamAuthorityImporter;
  private readonly initialized: Promise<void>;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    this.objectStore = new WorkstreamObjectStore(
      state.storage,
      env.APP_VERSION ?? "unknown",
      env.AVALON_REGION,
    );
    this.product = new WorkstreamObjectProductService(state.storage, this.objectStore, env);
    this.authorityImporter = new WorkstreamAuthorityImporter(state.storage);
    this.initialized = state.blockConcurrencyWhile(async () => {
      await this.objectStore.waitUntilReady();
      const nextEffectAt = this.objectStore.nextRegionalEffectDueAt();
      const nextHyperSightAt = this.objectStore.nextHyperSightDueAt();
      const nextAlarmAt = minimumTimestamp(nextEffectAt, nextHyperSightAt);
      if (nextAlarmAt !== null) await this.ensureAlarmNoLaterThan(nextAlarmAt);
    });
    // Exact text ping/pong frames are answered by the runtime without waking a
    // hibernated object, so keepalives do not accrue Durable Object duration.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/socket" || url.pathname === "/")) {
      return this.connect(request, url);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/internal/events" || url.pathname === "/events")
    ) {
      return this.acceptEvent(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/authority-import") {
      return this.acceptAuthorityImport(request);
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

  private async acceptRuntimeSql(request: Request): Promise<Response> {
    const parsed = WorkstreamRuntimeSqlRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) return jsonResponse({ error: "invalid_workstream_runtime_sql" }, 400);
    try {
      return jsonResponse(await executeWorkstreamRuntimeSql(
        this.state.storage,
        this.product,
        parsed.data,
      ));
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

  private async acceptProductRequest(request: Request): Promise<Response> {
    const parsed = ProductRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_product_request" }, 400);
    const current = await this.socketAuth({
      connectionId: crypto.randomUUID(),
      workspaceId: parsed.data.auth.workspaceId,
      workstreamId: this.objectStore.identity()?.workstreamId ?? "",
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
    const instanceId = `workstream-${runId}`;
    try {
      await this.env.WORKSTREAM_LOOP_WORKFLOW.create({ id: instanceId, params: workflowInput });
    } catch (error) {
      if (!(error instanceof Error) || !/(already exists|duplicate|conflict)/iu.test(error.message)) {
        const safe = { code: "workflow_unavailable", message: "The Avalon harness could not complete this run" };
        await this.product.recordWorkflowFailed(runId, safe);
        await this.publishLocalProductEvent(identity, { type: "harness_status_changed", status: "failed" });
        throw new ApiError(503, "workflow_unavailable", "The Avalon harness could not be started");
      }
    }
    await this.product.recordWorkflowStarted(runId, instanceId);
    await this.publishLocalProductEvent(identity, { type: "harness_status_changed", status: "running" });
  }

  private async acceptAuthorityImport(request: Request): Promise<Response> {
    const parsed = WorkstreamAuthorityImportRequestSchema.safeParse(await request.json());
    if (!parsed.success) return jsonResponse({ error: "invalid_authority_import" }, 400);
    const control = await readWorkstreamAuthorityControl(this.env);
    const requiredPhase = parsed.data.operation === "activate"
      ? "maintenance_verified"
      : "maintenance_importing";
    if (control.phase !== requiredPhase || control.generation !== parsed.data.generation) {
      return jsonResponse({
        error: "authority_import_phase_mismatch",
        phase: control.phase,
        generation: control.generation,
      }, 409);
    }
    try {
      if (parsed.data.operation === "begin") {
        for (const socket of this.state.getWebSockets()) {
          disconnect(socket, 1012, "Work stream maintenance");
        }
        this.objectStore.ensureIdentity({
          workspaceId: parsed.data.workspaceId,
          workstreamId: parsed.data.workstreamId,
        }, this.env.AVALON_REGION);
      }
      return jsonResponse(this.authorityImporter.execute(parsed.data));
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "authority_import_failed",
      }, 409);
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

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialized;
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;

    try {
      decoded = JSON.parse(raw);
    } catch {
      await this.sendError(socket, "invalid_json", "Socket messages must be JSON.");
      return;
    }

    const parsed = ClientSocketEventSchema.safeParse(decoded);
    if (!parsed.success) {
      await this.sendError(socket, "invalid_event", "The socket event is not valid.");
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

    if (parsed.data.type === "create_message") {
      await this.acceptCreateMessage(socket, attachment, parsed.data);
      return;
    }

    // Product mutations are intentionally persisted and authorized through the
    // REST service before their resulting canonical event is published here.
    await this.sendError(
      socket,
      "rest_required",
      "Persist this action through the work-stream API before publishing it."
    );
  }

  private async acceptCreateMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: CreateMessageSocketCommand,
  ): Promise<void> {
    if (!attachment.sessionId) {
      this.sendCommandFailure(socket, command, new ApiError(
        409,
        "socket_reconnect_required",
        "Reconnect before sending this message",
      ));
      disconnect(socket, 1012, "Reconnect before sending messages");
      return;
    }

    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority) || !this.objectStore.isRealtimeWritable()) {
      this.sendCommandFailure(socket, command, new ApiError(
        503,
        "workstream_maintenance",
        "This work stream is temporarily unavailable during maintenance",
      ));
      disconnect(socket, 1012, "Work stream maintenance");
      return;
    }

    const auth = await this.socketAuth(attachment);
    if (!auth) {
      this.sendCommandFailure(socket, command, new ApiError(
        401,
        "session_revoked",
        "The session is no longer active",
      ));
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "Session no longer active");
      return;
    }

    try {
      if (authority.phase !== "durable_object_open") {
        const result = await new WorkstreamService(
          this.env,
          auth,
          (promise) => this.state.waitUntil(promise),
          async (_env, workspaceId, workstreamId, event) => {
            if (workspaceId !== attachment.workspaceId || workstreamId !== attachment.workstreamId) {
              return false;
            }
            return (await this.acceptEvent(new Request("https://room.internal/internal/events", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-avalon-workspace-id": workspaceId,
                "x-avalon-workstream-id": workstreamId,
              },
              body: JSON.stringify(event),
            }))).ok;
          },
        ).createMessage(attachment.workstreamId, {
          ...command.payload,
          telemetryOperationId: command.operationId,
        });
        socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
          type: "client_command_succeeded",
          command: "create_message",
          clientMessageId: command.payload.clientMessageId,
          ...result,
        })));
        return;
      }
      const result = await this.product.createMessage(auth, {
        ...command.payload,
        telemetryOperationId: command.operationId,
      });
      await this.publishLocalProductEvent(attachment, {
        type: "message_created",
        message: result.message,
      });
      await this.startProductWorkflow(attachment, result.harnessRunId, result.workflowInput);
      socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
        type: "client_command_succeeded",
        command: "create_message",
        clientMessageId: command.payload.clientMessageId,
        message: result.message,
        agentInvoked: result.agentInvoked,
        harnessRunId: result.harnessRunId,
      })));
    } catch (error) {
      this.sendCommandFailure(socket, command, error);
      if (!(error instanceof ApiError)) {
        logWarn(this.env, "workstream_socket_create_message_failed", {
          workspace_id: attachment.workspaceId,
          workstream_id: attachment.workstreamId,
          user_id: attachment.userId,
          client_message_id: command.payload.clientMessageId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
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

  private sendCommandFailure(
    socket: WebSocket,
    command: CreateMessageSocketCommand,
    error: unknown,
  ): void {
    const safe = error instanceof ApiError
      ? error
      : new ApiError(500, "message_write_failed", "The message could not be sent");
    socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
      type: "client_command_failed",
      command: "create_message",
      clientMessageId: command.payload.clientMessageId,
      error: {
        status: safe.status,
        code: safe.code,
        message: safe.message,
        ...(safe.details ? { details: safe.details } : {}),
      },
    })));
  }

  async alarm(): Promise<void> {
    await this.initialized;
    const pending = this.objectStore.pendingHyperSightRefresh();
    const nextHyperSightAt = this.objectStore.nextHyperSightDueAt();
    const nextEffectAt = this.objectStore.nextRegionalEffectDueAt();
    if (!pending && nextEffectAt === null) return;
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority)) {
      await this.state.storage.setAlarm(Date.now() + MAINTENANCE_RECHECK_MS);
      return;
    }

    if (nextEffectAt !== null && nextEffectAt <= Date.now()) {
      const effects = this.objectStore.dueRegionalEffects();
      if (effects.length > 0) {
        try {
          await this.env.ACTIVITY_QUEUE.sendBatch(effects.map((effect) => ({
            body: workstreamRegionalEffectWakeMessage(effect),
          })));
          this.objectStore.markRegionalEffectsQueued(effects);
        } catch {
          const retryAt = Date.now() + 5_000;
          this.objectStore.deferRegionalEffects(effects, retryAt);
          await this.ensureAlarmNoLaterThan(retryAt);
        }
      }
    }

    if (!pending || nextHyperSightAt === null || nextHyperSightAt > Date.now()) {
      await this.ensureNextWorkAlarm();
      return;
    }
    this.objectStore.deletePendingHyperSightRefresh();
    try {
      const runs = await launchHyperSightRefresh(
        this.env,
        pending.workspaceId,
        pending.workstreamId,
        pending.triggerSequence,
      );
      for (const run of runs) {
        const event = ServerSocketEventSchema.parse({
          type: "hypersight_block_run_updated",
          sequence: await this.allocateSequence(),
          occurredAt: new Date().toISOString(),
          run,
        });
        this.recordRecentEvent(event);
        this.broadcast(event);
      }
    } catch {
      const retryAt = Date.now() + HYPERSIGHT_DEBOUNCE_MS;
      this.objectStore.failPendingHyperSightRefresh(pending, retryAt);
      await this.ensureAlarmNoLaterThan(retryAt);
    }
    await this.ensureNextWorkAlarm();
  }

  async webSocketClose(
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

  async webSocketError(socket: WebSocket): Promise<void> {
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

  private async connect(request: Request, url: URL): Promise<Response> {
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
      connectionId: crypto.randomUUID(),
      workspaceId: identity.data.workspaceId,
      workstreamId: identity.data.workstreamId,
      userId: identity.data.userId,
      sessionId: identity.data.sessionId,
      connectedAt: new Date().toISOString(),
      afterSequence: identity.data.afterSequence,
      subscribed: false
    };

    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);

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
    if (HYPERSIGHT_REFRESH_EVENT_TYPES.has(event.type)) {
      await this.scheduleHyperSightRefresh(event.sequence);
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

  private async scheduleHyperSightRefresh(triggerSequence: number): Promise<void> {
    const identity = this.objectStore.identity();
    if (!identity) return;
    const now = Date.now();
    const existing = this.objectStore.pendingHyperSightRefresh();
    const pending: PendingHyperSightRefresh = {
      ...identity,
      triggerSequence: Math.max(existing?.triggerSequence ?? 0, triggerSequence),
      firstQueuedAt: existing?.firstQueuedAt ?? now,
    };
    const dueAt = Math.min(
      now + HYPERSIGHT_DEBOUNCE_MS,
      pending.firstQueuedAt + HYPERSIGHT_MAX_DEBOUNCE_MS,
    );
    this.objectStore.putPendingHyperSightRefresh(pending, dueAt);
    await this.ensureAlarmNoLaterThan(dueAt);
  }

  private async ensureAlarmNoLaterThan(dueAt: number): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > dueAt) await this.state.storage.setAlarm(dueAt);
  }

  private async ensureNextWorkAlarm(): Promise<void> {
    const dueAt = minimumTimestamp(
      this.objectStore.nextRegionalEffectDueAt(),
      this.objectStore.nextHyperSightDueAt(),
    );
    if (dueAt !== null) await this.ensureAlarmNoLaterThan(dueAt);
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
      const sequence = knownSequence ?? await this.currentSequence(workstreamId);
      const storedCheckpoints = this.objectStore.activeStreamCheckpoints();
      const event = ServerSocketEventSchema.parse({
        type: "snapshot",
        sequence,
        occurredAt: new Date().toISOString(),
        workstream,
        activeStreams: workstream.harnessStatus === "running"
          ? storedCheckpoints.filter((checkpoint) =>
              checkpoint.harnessRunId === workstream.latestHarnessRunId)
          : [],
      });
      socket.send(JSON.stringify(event));
    } catch {
      await this.sendError(socket, "snapshot_unavailable", "Canonical work-stream state is unavailable.");
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

  private async sendError(socket: WebSocket, code: string, message: string): Promise<void> {
    const event = ServerSocketEventSchema.parse({
      type: "error",
      sequence: await this.allocateSequence(),
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
