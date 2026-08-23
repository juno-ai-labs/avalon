import {
  ActiveStreamCheckpointSchema,
  asBlockId,
  asWorkspaceId,
  asWorkstreamId,
  BlockDashboardBlockSocketClientEventSchema,
  BlockDashboardBlockSocketEventSchema,
  BlockDashboardBlockRunSchema,
  BlockIdSchema,
  RegionSchema,
  UserIdSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  ServerSocketEventSchema,
  WorkstreamWorkflowInputSchema,
  type BlockDashboardBlockRun,
  type ActiveStreamCheckpoint,
  type WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { z } from "zod";

import {
  revocationClosesSocket,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";
import {
  MigratableDurableObject,
  type DurableObjectMigrationPlan,
} from "./migratable-durable-object";

import type { Env } from "../env";
import { assertDurableObjectJurisdiction, durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import {
  claimHarnessAttempt,
  reapStaleHarnessRuns,
  terminalizeHarnessAttempt,
  terminalizeQueuedHarnessRun,
} from "../runtime/harness-run-runtime";
import { createToolReceiptObjectPort, createToolReceiptPortFactory } from "../runtime/tool-receipt-port";
import {
  createBlockDashboardObjectPort,
  createBlockDashboardPortFactory,
} from "../runtime/block-dashboard-port";
import type { BlockRunRow } from "./workstream-block-dashboard-storage";
import { resolveAgentModelRouting } from "../services/agent-model-flags";
import { runWorkstreamHarness, type WorkstreamHarnessResult } from "../services/integrations";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import { workstreamExecutionEnvironment } from "../services/workstream-runtime-database";
import {
  AGENT_RUN_DISPATCH_DUE_AT_SQL,
  AGENT_RUN_DISPATCH_LEASE_MS,
  BLOCK_DASHBOARD_RUN_DISPATCHES,
  applyAgentRunDispatchSweepFloor,
  deferAgentRunDispatch,
  releaseAgentRunDispatchLeases,
  settleAgentRunDispatch,
} from "./agent-run-dispatch-queue";
import {
  DurableAgentDrain,
  DurableAgentKeepAlive,
  DurableAgentPublicationQueue,
  durableAgentRetryDelay,
} from "./durable-agent-runtime";
import {
  BlockDashboardBlockDispatchSchema,
  BlockDashboardControlRequestSchema,
  BlockDashboardSocketRetractionRequestSchema,
  blockDashboardBlockResultHash,
  type BlockDashboardBlockDispatch,
  type BlockDashboardSocketRetractionRequest,
} from "./block-dashboard-protocol";
import { blockDashboardAgentName, workstreamDOName } from "./names";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import { applyActiveStreamCheckpointEvent } from "./workstream-object-storage";

const KEEP_ALIVE_INTERVAL_MS = 30_000;
const MAINTENANCE_RECHECK_MS = 5 * 60_000;
// Generous by design (the 10 GB object ceiling is the only hard bound): a
// settled terminal dispatch this old is pure history whose product-facing
// record lives in the parent's run ledger.
const DISPATCH_LEDGER_RETENTION_MS = 180 * 24 * 60 * 60_000;

const BlockDashboardBlockIdentityInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  blockId: BlockIdSchema,
  region: RegionSchema,
}).strict();
type BlockDashboardBlockIdentityInput = z.infer<typeof BlockDashboardBlockIdentityInputSchema>;

const BlockDashboardSocketIdentitySchema = BlockDashboardBlockIdentityInputSchema.extend({
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
}).strict();
type BlockDashboardSocketIdentity = z.infer<typeof BlockDashboardSocketIdentitySchema>;
const BlockDashboardSocketAttachmentSchema = BlockDashboardSocketIdentitySchema.extend({
  connectionId: z.string().uuid(),
  connectedAt: z.string().datetime({ offset: true }),
  subscribed: z.boolean(),
  /**
   * Vestigial: nothing reads it now that time-based re-authorization is gone —
   * the access-revocation queue closes a socket instead. The field stays in the
   * schema because it is `.strict()`, so an attachment serialized by the
   * previous deploy would fail to parse without it and its socket would be
   * dropped on the first wake after release. Safe to remove once no hibernated
   * attachment predates this change.
   */
  authorizedAt: z.number().int().nonnegative().default(0),
}).strict();
type BlockDashboardSocketAttachment = z.infer<typeof BlockDashboardSocketAttachmentSchema>;

const TerminalOutcomeSchema = z.object({
  run: BlockDashboardBlockRunSchema,
}).strict();
type TerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;

interface DispatchRow extends Record<string, SqlStorageValue> {
  block_run_id: string;
  dispatch_json: string;
  state: "queued" | "running" | "completed" | "failed";
  attempt: number;
  terminal_outcome_json: string | null;
  settled_at: number | null;
}

function compareDispatchFreshness(
  left: BlockDashboardBlockDispatch,
  right: BlockDashboardBlockDispatch,
): number {
  if (left.configurationVersionNumber !== right.configurationVersionNumber) {
    return left.configurationVersionNumber - right.configurationVersionNumber;
  }
  if (left.triggerSequence !== right.triggerSequence) {
    return left.triggerSequence - right.triggerSequence;
  }
  const createdAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAt !== 0) return createdAt;
  return left.blockRunId.localeCompare(right.blockRunId);
}

function supersededOutcome(
  dispatch: BlockDashboardBlockDispatch,
  completedAt: number,
): TerminalOutcome {
  return TerminalOutcomeSchema.parse({
    run: {
      id: dispatch.blockRunId,
      blockId: dispatch.blockId,
      configurationVersionId: dispatch.configurationVersionId,
      triggerSequence: dispatch.triggerSequence,
      status: "stopped",
      markdown: null,
      error: {
        code: "block_dashboard_run_superseded",
        message: "A newer refresh superseded this queued run.",
      },
      createdAt: dispatch.createdAt,
      startedAt: null,
      completedAt: new Date(completedAt).toISOString(),
    },
  });
}

function terminalDispatchState(run: BlockDashboardBlockRun): "completed" | "failed" {
  return run.status === "failed" ? "failed" : "completed";
}

export const BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "HyperSight block execution, resumable streaming, and causal dispatch authority",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE block_dashboard_block_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      created_at INTEGER NOT NULL,
      UNIQUE (workspace_id, workstream_id, block_id)
    ) STRICT`,
    `CREATE TABLE agent_run_dispatches (
      block_run_id TEXT PRIMARY KEY,
      dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json)),
      configuration_version_number INTEGER NOT NULL CHECK (configuration_version_number > 0),
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      source_created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      available_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      last_error_code TEXT,
      terminal_outcome_json TEXT CHECK (terminal_outcome_json IS NULL OR json_valid(terminal_outcome_json)),
      settled_at INTEGER,
      last_settlement_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX agent_run_dispatches_ready_idx
      ON agent_run_dispatches(state, available_at, created_at, block_run_id)`,
    `CREATE INDEX agent_run_dispatches_settlement_idx
      ON agent_run_dispatches(available_at, block_run_id)
      WHERE terminal_outcome_json IS NOT NULL AND settled_at IS NULL`,
    `CREATE TABLE block_dashboard_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX block_dashboard_socket_ticket_receipts_expiry_idx
      ON block_dashboard_socket_ticket_receipts(expires_at)`,
    `CREATE TABLE agent_stream_checkpoint (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      block_run_id TEXT NOT NULL REFERENCES agent_run_dispatches(block_run_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE latest_dispatch_freshness (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      configuration_version_number INTEGER NOT NULL CHECK (configuration_version_number > 0),
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      source_created_at INTEGER NOT NULL,
      block_run_id TEXT NOT NULL UNIQUE
        REFERENCES agent_run_dispatches(block_run_id) ON DELETE RESTRICT
    ) STRICT`,
  ],
}, {
  version: 2,
  description: "lease block run dispatches so an abandoned run stays discoverable",
  statements: [
    // Same defect as the substream agent's queue: a claim with no deadline is
    // indistinguishable from an abandoned one, and this object's scheduler
    // additionally returned no due time at all while a drain was in flight.
    `ALTER TABLE agent_run_dispatches ADD COLUMN lease_token TEXT`,
    `ALTER TABLE agent_run_dispatches ADD COLUMN lease_expires_at INTEGER`,
    `CREATE INDEX IF NOT EXISTS agent_run_dispatches_lease_idx
       ON agent_run_dispatches(state, lease_expires_at, available_at)`,
  ],
}];

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function parseError(value: string | null): { code: string; message: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { code?: unknown; message?: unknown };
    return typeof parsed.code === "string" && typeof parsed.message === "string"
      ? { code: parsed.code, message: parsed.message }
      : null;
  } catch {
    return null;
  }
}

/**
 * The object's row, in the contract's vocabulary.
 *
 * The translation the retired compatibility view used to perform, now done once
 * at the wire boundary where it is visible: the object stores unix milliseconds
 * and calls the key `block_run_id`, while `BlockDashboardBlockRunSchema`
 * publishes ISO-8601 and `id`. Neither is wrong — one is what a client reads,
 * the other is what SQLite sorts and compares on.
 */
function blockRunFromObjectRow(row: BlockRunRow): BlockDashboardBlockRun {
  const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
  return BlockDashboardBlockRunSchema.parse({
    id: row.block_run_id,
    blockId: row.block_id,
    configurationVersionId: row.configuration_version_id,
    triggerSequence: row.trigger_sequence,
    status: row.status,
    markdown: row.markdown,
    error: parseError(row.error_json),
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  });
}

/** A stable, SQL-backed owner for one HyperSight block's complete Bind loops. */
/**
 * The migration runner's component key for this class.
 *
 * One constant because two call sites need the identical value: the runner
 * keys the object's schema ledger by it, and the migration report keys the
 * tracker's component rollup by it. Two literals that drift put an object
 * under a component its own ledger does not use, which shows up as a silent
 * miscount rather than an error.
 */
const MIGRATION_COMPONENT = "block_dashboard_block_agent";

export class BlockDashboardAgent extends MigratableDurableObject<Env> {
  private readonly state: DurableObjectState;
  /** This object's own `BLOCK_DASHBOARD_AGENTS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  private readonly initialized: Promise<void>;
  private readonly keepAliveLease: DurableAgentKeepAlive;
  private readonly agentDrain = new DurableAgentDrain();
  private activeRunDispatch: {
    dispatch: BlockDashboardBlockDispatch;
    leaseToken: string;
  } | null = null;
  private readonly publicationQueue: DurableAgentPublicationQueue;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    // Everything downstream is handed this environment or one derived from it,
    // so a helper that addresses "the agent that owns this block" reaches the
    // object it is already running in rather than the namespace. See
    // `lib/durable-object-self.ts`.
    //
    // The parameter is rebound as well as the field, so the rest of this
    // constructor cannot hand the unregistered environment to something
    // long-lived.
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.BLOCK_DASHBOARD_AGENTS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    this.keepAliveLease = new DurableAgentKeepAlive(() => this.scheduleNextAlarm());
    this.publicationQueue = new DurableAgentPublicationQueue(
      (phase, error) => {
        logWarn(this.env, "block_dashboard_block_agent_broadcast_failed", {
          phase,
          reason: error instanceof Error ? error.message : "unknown",
        });
      },
      (drain) => this.state.waitUntil(drain),
    );
    this.initialized = state.blockConcurrencyWhile(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
      // Whatever leases survive belong to the isolate this one replaced, so
      // the runs they cover are recoverable now rather than at expiry.
      releaseAgentRunDispatchLeases(
        state.storage.sql,
        BLOCK_DASHBOARD_RUN_DISPATCHES,
        Date.now(),
      );
      // Any run left behind by a previous isolate is rediscovered by the alarm
      // this schedules, not by a drain the constructor cannot outlive.
      await this.scheduleNextAlarm();
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: MIGRATION_COMPONENT,
      className: "BlockDashboardAgent",
      migrations: BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/socket") {
      return this.acceptSocket(request);
    }
    if (request.method === "POST" && path === "/internal/run-dispatch") {
      const parsed = BlockDashboardBlockDispatchSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid_block_dashboard_block_dispatch" }, 400);
      try {
        await this.dispatchRun(parsed.data);
        return json({ accepted: true }, 202);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "block_dashboard_block_dispatch_failed",
        }, 409);
      }
    }
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        role: "block-dashboard-agent",
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  async initializeBlock(input: BlockDashboardBlockIdentityInput): Promise<void> {
    await this.initialized;
    this.ensureIdentity(BlockDashboardBlockIdentityInputSchema.parse(input));
  }

  async dispatchRun(input: BlockDashboardBlockDispatch): Promise<void> {
    await this.initialized;
    const dispatch = BlockDashboardBlockDispatchSchema.parse(input);
    this.ensureIdentity(dispatch);
    this.enqueue(dispatch);
    this.queueBroadcast(() => this.broadcastLatestRun(dispatch.blockRunId), "dispatch");
    // Arm unconditionally: reading the current alarm first would leave a window
    // in which the row above is durable and nothing is scheduled to reach it.
    await this.state.storage.setAlarm(Date.now() + 1);
  }

  /** Applies an explicit parent access/configuration retraction to live sockets. */
  async revalidateViewerAccess(input: BlockDashboardSocketRetractionRequest): Promise<void> {
    await this.initialized;
    const request = BlockDashboardSocketRetractionRequestSchema.parse(input);
    this.ensureIdentity(request);
    await this.revalidateSockets();
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialized;
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Missing HyperSight block connection identity");
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      socket.close(1008, "HyperSight block events must be JSON");
      return;
    }
    if (!BlockDashboardBlockSocketClientEventSchema.safeParse(decoded).success
      || !await this.authorizeViewer(attachment)) {
      socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this HyperSight block");
      return;
    }
    socket.serializeAttachment({ ...attachment, subscribed: true });
    const run = this.latestRun();
    socket.send(JSON.stringify(BlockDashboardBlockSocketEventSchema.parse({
      type: "block_dashboard_block_snapshot",
      occurredAt: new Date().toISOString(),
      blockId: attachment.blockId,
      run,
      streamCheckpoint: run ? this.streamCheckpoint(run.id) : null,
    })));
  }

  override webSocketClose(): void {
    // Hibernating sockets restore all state from their serialized attachment.
  }

  override webSocketError(): void {
    // The desktop reconnects with a new one-time ticket.
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    // Delivery consumes the alarm. Re-arm from the rows before the drain, so a
    // cancelled or wedged run still leaves a wake-up behind; see the same
    // comment in SubstreamAgent.alarm.
    await this.armAlarmDuringRunDrain();
    const disposition = await this.drainRunsToCompletion();
    if (disposition === "deferred") await this.armAlarmDuringRunDrain();
    else await this.scheduleNextAlarm();
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = BlockDashboardSocketIdentitySchema.safeParse({
      workspaceId: request.headers.get("x-avalon-workspace-id"),
      workstreamId: request.headers.get("x-avalon-workstream-id"),
      blockId: request.headers.get("x-avalon-block-dashboard-block-id"),
      region: request.headers.get("x-avalon-region"),
      userId: request.headers.get("x-avalon-user-id"),
      sessionId: request.headers.get("x-avalon-session-id"),
      ticketId: request.headers.get("x-avalon-socket-ticket-id"),
      ticketExpiresAt: request.headers.get("x-avalon-socket-ticket-expires-at"),
    });
    if (!identity.success) return json({ error: "invalid_socket_identity" }, 400);
    try {
      this.ensureIdentity(identity.data);
    } catch {
      return json({ error: "block_dashboard_block_agent_identity_mismatch" }, 409);
    }
    if (!this.consumeSocketTicket(identity.data)) return json({ error: "socket_ticket_replayed" }, 401);
    if (!await this.authorizeViewer(identity.data)) return json({ error: "forbidden" }, 403);

    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) return json({ error: "websocket_unavailable" }, 500);
    const attachment: BlockDashboardSocketAttachment = {
      ...identity.data,
      connectionId: uuidV7(),
      connectedAt: new Date().toISOString(),
      subscribed: false,
      authorizedAt: 0,
    };
    this.state.acceptWebSocket(server, [
      attachment.workspaceId,
      attachment.workstreamId,
      attachment.blockId,
      attachment.userId,
    ]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private consumeSocketTicket(identity: BlockDashboardSocketIdentity): boolean {
    // Ticket claims carry epoch seconds; object SQL stores unix-ms
    // (data-model invariant 7), so convert once at this boundary.
    const now = Date.now();
    const expiresAtMs = identity.ticketExpiresAt * 1_000;
    if (expiresAtMs <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM block_dashboard_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300_000,
      );
      return this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO block_dashboard_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?) RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        expiresAtMs,
        now,
      ).toArray().length === 1;
    });
  }

  private readSocketAttachment(socket: WebSocket): BlockDashboardSocketAttachment | null {
    try {
      const parsed = BlockDashboardSocketAttachmentSchema.safeParse(socket.deserializeAttachment());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async authorizeViewer(
    identity: Pick<BlockDashboardSocketIdentity, "sessionId" | "userId" | "workspaceId" | "workstreamId" | "blockId">,
  ): Promise<boolean> {
    const session = await this.env.DB.prepare(
      `SELECT 1 FROM sessions session
        JOIN workspace_members member
          ON member.workspace_id = session.workspace_id
         AND member.user_id = session.user_id AND member.status = 'active'
       WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
         AND session.region = ? AND session.revoked_at IS NULL
         AND session.expires_at > ?`,
    ).bind(
      identity.sessionId,
      identity.userId,
      identity.workspaceId,
      this.env.AVALON_REGION,
      new Date().toISOString(),
    ).first();
    const developmentSession = this.env.APP_ENV === "development"
      && this.env.AVALON_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT 1 FROM workspace_members
          WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
      ).bind(identity.workspaceId, identity.userId).first()
      : null;
    if (!session && !developmentSession) return false;
    const parent = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      identity.workspaceId,
      workstreamDOName(this.env.AVALON_REGION, identity.workspaceId, identity.workstreamId),
    );
    return parent.authorizeBlockDashboardBlockViewer({
      workspaceId: identity.workspaceId,
      workstreamId: identity.workstreamId,
      blockId: identity.blockId,
      userId: identity.userId,
    });
  }

  private latestRun(): BlockDashboardBlockRun | null {
    const row = this.state.storage.sql.exec<{
      dispatch_json: string;
      state: "queued" | "running" | "completed" | "failed";
      started_at: number | null;
      completed_at: number | null;
      terminal_outcome_json: string | null;
    }>(
      `SELECT dispatch_json, state, started_at, completed_at, terminal_outcome_json
         FROM agent_run_dispatches ORDER BY created_at DESC, block_run_id DESC LIMIT 1`,
    ).toArray()[0];
    if (!row) return null;
    if (row.terminal_outcome_json) {
      return TerminalOutcomeSchema.parse(JSON.parse(row.terminal_outcome_json)).run;
    }
    const dispatch = BlockDashboardBlockDispatchSchema.parse(JSON.parse(row.dispatch_json));
    const checkpoint = this.streamCheckpoint(dispatch.blockRunId);
    return BlockDashboardBlockRunSchema.parse({
      id: dispatch.blockRunId,
      blockId: dispatch.blockId,
      configurationVersionId: dispatch.configurationVersionId,
      triggerSequence: dispatch.triggerSequence,
      status: row.state === "queued" ? "queued" : "running",
      markdown: checkpoint?.harnessRunId === dispatch.harnessRunId ? checkpoint.text : null,
      error: null,
      createdAt: dispatch.createdAt,
      startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
      completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    });
  }

  private streamCheckpoint(expectedBlockRunId?: string): ActiveStreamCheckpoint | null {
    const row = this.state.storage.sql.exec<{ block_run_id: string; checkpoint_json: string }>(
      `SELECT block_run_id, checkpoint_json FROM agent_stream_checkpoint WHERE id = 1`,
    ).toArray()[0];
    if (expectedBlockRunId && row?.block_run_id !== expectedBlockRunId) return null;
    return row ? ActiveStreamCheckpointSchema.parse(JSON.parse(row.checkpoint_json)) : null;
  }

  private async recordStreamEvent(
    dispatch: BlockDashboardBlockDispatch,
    rawEvent: Record<string, unknown>,
  ): Promise<void> {
    const current = this.streamCheckpoint(dispatch.blockRunId);
    const revision = (current?.roomSequence ?? 0) + 1;
    const event = ServerSocketEventSchema.safeParse({
      ...rawEvent,
      sequence: revision,
      occurredAt: typeof rawEvent.occurredAt === "string"
        ? rawEvent.occurredAt
        : new Date().toISOString(),
    });
    if (!event.success) return;
    const next = applyActiveStreamCheckpointEvent(current ? [current] : [], event.data)[0] ?? null;
    if (next === current) return;
    this.state.storage.transactionSync(() => {
      if (!next) {
        this.state.storage.sql.exec(`DELETE FROM agent_stream_checkpoint WHERE id = 1`);
        return;
      }
      this.state.storage.sql.exec(
        `INSERT INTO agent_stream_checkpoint
           (id, block_run_id, revision, checkpoint_json, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET block_run_id = excluded.block_run_id,
           revision = excluded.revision, checkpoint_json = excluded.checkpoint_json,
           updated_at = excluded.updated_at
         WHERE excluded.block_run_id != agent_stream_checkpoint.block_run_id
            OR excluded.revision >= agent_stream_checkpoint.revision`,
        dispatch.blockRunId,
        next.roomSequence,
        JSON.stringify(next),
        Date.now(),
      );
    });
    this.queueCheckpointBroadcast(
      () => this.broadcastStreamCheckpoint(dispatch, next),
      "checkpoint",
    );
  }

  private async broadcastStreamCheckpoint(
    dispatch: BlockDashboardBlockDispatch,
    checkpoint: ActiveStreamCheckpoint | null,
  ): Promise<void> {
    const payload = JSON.stringify(BlockDashboardBlockSocketEventSchema.parse({
      type: "block_dashboard_block_stream_checkpoint",
      occurredAt: new Date().toISOString(),
      blockId: dispatch.blockId,
      blockRunId: dispatch.blockRunId,
      streamCheckpoint: checkpoint,
    }));
    for (const socket of await this.authorizedSubscribedSockets()) {
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, "HyperSight block stream delivery failed");
      }
    }
  }

  private async broadcastLatestRun(expectedBlockRunId?: string): Promise<void> {
    const run = this.latestRun();
    if (!run || (expectedBlockRunId && run.id !== expectedBlockRunId)) return;
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;
    const event = JSON.stringify(BlockDashboardBlockSocketEventSchema.parse({
      type: "block_dashboard_block_run_updated",
      occurredAt: new Date().toISOString(),
      blockId: run.blockId,
      run,
    }));
    for (const socket of await this.authorizedSubscribedSockets()) {
      try {
        socket.send(event);
      } catch {
        socket.close(1011, "HyperSight block delivery failed");
      }
    }
  }

  /**
   * Drop every socket this block holds for a person whose access ended.
   *
   * The only way a socket here is closed for lost access; see
   * `docs/access-revocation.md`.
   */
  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<void> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.readSocketAttachment(socket);
      if (!attachment || !revocationClosesSocket(request, attachment)) continue;
      try {
        socket.serializeAttachment({ ...attachment, subscribed: false });
      } catch {
        // An unreadable attachment already fails the publication filter.
      }
      try {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this block");
      } catch {
        // Already closing; the runtime owns the rest of the teardown.
      }
    }
  }

  private async authorizedSubscribedSockets(force = false): Promise<WebSocket[]> {
    const authorization = new Map<string, boolean>();
    const permitted: WebSocket[] = [];
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.readSocketAttachment(socket);
      if (!attachment?.subscribed) continue;
      let allowed = true;
      // Only when the caller forces it, which is the block-lifecycle sweep: a
      // block that stopped existing closes its sockets. Time no longer triggers
      // this. Somebody losing access is the access-revocation queue's business,
      // and this object must not hold a second answer to that question — see
      // docs/access-revocation.md.
      if (force) {
        const key = `${attachment.userId}\u0000${attachment.sessionId}`;
        const cached = authorization.get(key);
        allowed = cached ?? await this.authorizeViewer(attachment);
        authorization.set(key, allowed);
      }
      if (!allowed) {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this HyperSight block");
        continue;
      }
      permitted.push(socket);
    }
    return permitted;
  }

  private async revalidateSockets(): Promise<void> {
    await this.authorizedSubscribedSockets(true);
  }

  private queueBroadcast(broadcast: () => Promise<void>, phase: string): void {
    this.publicationQueue.enqueueBarrier(phase, broadcast);
  }

  private queueCheckpointBroadcast(broadcast: () => Promise<void>, phase: string): void {
    this.publicationQueue.enqueueCheckpoint(phase, broadcast);
  }

  /**
   * This object's own name in `BLOCK_DASHBOARD_AGENTS`, or `null` before it has
   * one.
   *
   * Memoized: a block agent's identity is written once, on its first dispatch,
   * and is refused if it ever disagrees. The read is guarded because a first
   * wake reaches here before the schema exists.
   */
  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    let identity: { workspace_id: string; workstream_id: string; block_id: string } | undefined;
    try {
      identity = this.state.storage.sql.exec<{
        workspace_id: string;
        workstream_id: string;
        block_id: string;
      }>(
        `SELECT workspace_id, workstream_id, block_id
           FROM block_dashboard_block_identity WHERE id = 1`,
      ).toArray()[0];
    } catch {
      return null;
    }
    if (!identity) return null;
    this.objectName = blockDashboardAgentName(
      this.env.AVALON_REGION,
      asWorkspaceId(identity.workspace_id),
      asWorkstreamId(identity.workstream_id),
      asBlockId(identity.block_id),
    );
    return this.objectName;
  }

  private ensureIdentity(dispatch: BlockDashboardBlockIdentityInput): void {
    const existing = this.state.storage.sql.exec<{
      workspace_id: string;
      workstream_id: string;
      block_id: string;
      region: string;
    }>(
      `SELECT workspace_id, workstream_id, block_id, region
         FROM block_dashboard_block_identity WHERE id = 1`,
    ).toArray()[0];
    if (existing) {
      if (existing.workspace_id !== dispatch.workspaceId
        || existing.workstream_id !== dispatch.workstreamId
        || existing.block_id !== dispatch.blockId
        || existing.region !== dispatch.region) {
        throw new Error("block_dashboard_block_agent_identity_mismatch");
      }
      return;
    }
    this.state.storage.sql.exec(
      `INSERT INTO block_dashboard_block_identity
         (id, workspace_id, workstream_id, block_id, region, created_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      dispatch.workspaceId,
      dispatch.workstreamId,
      dispatch.blockId,
      dispatch.region,
      Date.now(),
    );
  }

  private enqueue(dispatch: BlockDashboardBlockDispatch): void {
    const now = Date.now();
    const dispatchJson = JSON.stringify(dispatch);
    const existing = this.state.storage.sql.exec<{ dispatch_json: string }>(
      `SELECT dispatch_json FROM agent_run_dispatches WHERE block_run_id = ?`,
      dispatch.blockRunId,
    ).toArray()[0];
    if (existing) {
      if (existing.dispatch_json !== dispatchJson) {
        throw new Error("block_dashboard_block_dispatch_idempotency_conflict");
      }
      return;
    }
    this.state.storage.transactionSync(() => {
      const freshestKnown = this.state.storage.sql.exec<{ dispatch_json: string }>(
        `SELECT dispatch.dispatch_json
           FROM latest_dispatch_freshness AS freshness
           JOIN agent_run_dispatches AS dispatch
             ON dispatch.block_run_id = freshness.block_run_id
          WHERE freshness.id = 1`,
      ).toArray()[0];
      const freshestDispatch = freshestKnown
        ? BlockDashboardBlockDispatchSchema.parse(JSON.parse(freshestKnown.dispatch_json))
        : null;
      if (freshestDispatch && compareDispatchFreshness(dispatch, freshestDispatch) < 0) {
        const outcome = supersededOutcome(dispatch, now);
        this.state.storage.sql.exec(
          `INSERT INTO agent_run_dispatches
             (block_run_id, dispatch_json, configuration_version_number, trigger_sequence,
              source_created_at, state, attempt, available_at, started_at,
              completed_at, last_error_code, terminal_outcome_json, settled_at,
              last_settlement_error_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'completed', 0, ?, NULL, ?, 'block_dashboard_run_superseded', ?,
                   NULL, NULL, ?, ?)`,
          dispatch.blockRunId,
          dispatchJson,
          dispatch.configurationVersionNumber,
          dispatch.triggerSequence,
          Date.parse(dispatch.createdAt),
          now,
          now,
          JSON.stringify(outcome),
          Date.parse(dispatch.createdAt),
          now,
        );
        return;
      }
      const obsolete = this.state.storage.sql.exec<{ block_run_id: string; dispatch_json: string }>(
        `SELECT block_run_id, dispatch_json FROM agent_run_dispatches
          WHERE state = 'queued' AND terminal_outcome_json IS NULL
          ORDER BY created_at, block_run_id`,
      ).toArray();
      for (const row of obsolete) {
        const previous = BlockDashboardBlockDispatchSchema.parse(JSON.parse(row.dispatch_json));
        const outcome = supersededOutcome(previous, now);
        this.state.storage.sql.exec(
          `UPDATE agent_run_dispatches
              SET state = 'completed', terminal_outcome_json = ?, available_at = ?, completed_at = ?,
                  last_error_code = 'block_dashboard_run_superseded', updated_at = ?,
                  lease_token = NULL, lease_expires_at = NULL
            WHERE block_run_id = ? AND state = 'queued' AND terminal_outcome_json IS NULL`,
          JSON.stringify(outcome),
          now,
          now,
          now,
          row.block_run_id,
        );
      }
      this.state.storage.sql.exec(
        `INSERT INTO agent_run_dispatches
           (block_run_id, dispatch_json, configuration_version_number, trigger_sequence,
            source_created_at, state, attempt, available_at, started_at,
            completed_at, last_error_code, terminal_outcome_json, settled_at,
            last_settlement_error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        dispatch.blockRunId,
        dispatchJson,
        dispatch.configurationVersionNumber,
        dispatch.triggerSequence,
        Date.parse(dispatch.createdAt),
        now,
        Date.parse(dispatch.createdAt),
        now,
      );
      this.state.storage.sql.exec(
        `INSERT INTO latest_dispatch_freshness
           (id, configuration_version_number, trigger_sequence, source_created_at, block_run_id)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           configuration_version_number = excluded.configuration_version_number,
           trigger_sequence = excluded.trigger_sequence,
           source_created_at = excluded.source_created_at,
           block_run_id = excluded.block_run_id`,
        dispatch.configurationVersionNumber,
        dispatch.triggerSequence,
        Date.parse(dispatch.createdAt),
        dispatch.blockRunId,
      );
      // The dispatch ledger is a durable state machine, not history: once a
      // row is terminal, settled to the parent, past retention, and not the
      // freshness-pinned run (its RESTRICT reference would reject the delete
      // anyway), nothing reads it again — the parent's run ledger keeps the
      // product-facing record.
      this.state.storage.sql.exec(
        `DELETE FROM agent_run_dispatches
          WHERE block_run_id IN (
            SELECT reapable.block_run_id FROM agent_run_dispatches reapable
             WHERE reapable.settled_at IS NOT NULL
               AND reapable.state IN ('completed', 'failed')
               AND reapable.updated_at < ?
               AND reapable.block_run_id NOT IN (
                 SELECT block_run_id FROM latest_dispatch_freshness
               )
             ORDER BY reapable.updated_at LIMIT 100
          )`,
        now - DISPATCH_LEDGER_RETENTION_MS,
      );
    });
  }

  /**
   * Runs the queue to completion in the caller's invocation. Durable work is
   * never left to a promise the caller abandons: the runtime cancels it, and
   * cancellation raises nothing, so the loss is silent.
   */
  private async drainRunsToCompletion(): Promise<"drained" | "deferred"> {
    if (this.agentDrain.active) {
      const now = Date.now();
      const lastProgressAt = this.agentDrain.lastProgress;
      const recentProgress = lastProgressAt !== null
        && now - lastProgressAt < AGENT_RUN_DISPATCH_LEASE_MS;
      if (recentProgress) return "deferred";

      const activeRun = this.activeRunDispatch;
      let harnessLeaseExpiresAt: number | null = null;
      if (activeRun) {
        try {
          const executionEnv = await workstreamExecutionEnvironment(
            this.env,
            activeRun.dispatch.workspaceId,
            activeRun.dispatch.workstreamId,
          );
          const row = await executionEnv.DB.prepare(
            `SELECT lease_expires_at FROM harness_runs
              WHERE id = ? AND workspace_id = ? AND workstream_id = ?`,
          ).bind(
            activeRun.dispatch.harnessRunId,
            activeRun.dispatch.workspaceId,
            activeRun.dispatch.workstreamId,
          ).first<{ lease_expires_at: string | null }>();
          const parsed = row?.lease_expires_at ? Date.parse(row.lease_expires_at) : Number.NaN;
          harnessLeaseExpiresAt = Number.isFinite(parsed) ? parsed : null;
        } catch (error) {
          // Losing the liveness read is not proof that the prior executor is
          // gone. Fail closed and try again at the next bounded heartbeat.
          logWarn(this.env, "block_dashboard_active_drain_lease_check_failed", {
            workspace_id: activeRun.dispatch.workspaceId,
            workstream_id: activeRun.dispatch.workstreamId,
            block_id: activeRun.dispatch.blockId,
            block_run_id: activeRun.dispatch.blockRunId,
            reason: error instanceof Error ? error.message : "unknown",
          });
          return "deferred";
        }
      }
      if (harnessLeaseExpiresAt !== null && harnessLeaseExpiresAt > now) return "deferred";
      if (this.agentDrain.abandonActive()) {
        logWarn(this.env, "block_dashboard_stale_drain_reclaimed", {
          workspace_id: activeRun?.dispatch.workspaceId ?? null,
          workstream_id: activeRun?.dispatch.workstreamId ?? null,
          block_id: activeRun?.dispatch.blockId ?? null,
          block_run_id: activeRun?.dispatch.blockRunId ?? null,
          harness_run_id: activeRun?.dispatch.harnessRunId ?? null,
          last_progress_at: lastProgressAt,
          harness_lease_expires_at: harnessLeaseExpiresAt,
        });
      }
    }
    await this.agentDrain.resume(
      (ownsDrain) => this.drainRunQueue(ownsDrain).catch((error: unknown) => {
        logWarn(this.env, "block_dashboard_block_agent_drain_failed", {
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
      const row = this.state.storage.sql.exec<DispatchRow>(
        `SELECT block_run_id, dispatch_json, state, attempt, terminal_outcome_json, settled_at
           FROM agent_run_dispatches
          WHERE terminal_outcome_json IS NULL AND state IN ('queued', 'running')
            AND available_at <= ?1
            AND (state = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?1)
            AND (
              state = 'running'
              OR NOT EXISTS (
                -- Any running row blocks queued work, lease or no lease: this
                -- object executes one block run at a time. An abandoned run is
                -- not bypassed but reclaimed — it sorts first below, and the
                -- lease guard above admits it once its claim has lapsed.
                SELECT 1 FROM agent_run_dispatches AS active
                 WHERE active.state = 'running'
                   AND active.terminal_outcome_json IS NULL
              )
            )
          ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,
                   configuration_version_number DESC, trigger_sequence DESC,
                   created_at DESC, block_run_id DESC
          LIMIT 1`,
        Date.now(),
      ).toArray()[0];
      if (row) {
        const dispatch = BlockDashboardBlockDispatchSchema.parse(JSON.parse(row.dispatch_json));
        const claimedAt = Date.now();
        const leaseToken = uuidV7(claimedAt);
        const claimed = this.state.storage.sql.exec(
          `UPDATE agent_run_dispatches SET state = 'running', attempt = attempt + 1,
             started_at = COALESCE(started_at, ?2), lease_token = ?3,
             lease_expires_at = ?4, updated_at = ?2
           WHERE block_run_id = ?1 AND state IN ('queued', 'running')
             AND terminal_outcome_json IS NULL
             AND (state = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?2)`,
          row.block_run_id,
          claimedAt,
          leaseToken,
          claimedAt + AGENT_RUN_DISPATCH_LEASE_MS,
        ).rowsWritten;
        // Another invocation holds it. The alarm derived from the lease will
        // bring this object back when that claim lapses.
        if (claimed === 0) return;
        this.agentDrain.touch();
        this.activeRunDispatch = { dispatch, leaseToken };
        try {
          this.queueBroadcast(() => this.broadcastLatestRun(row.block_run_id), "running");
          let result: { failed: boolean; errorCode: string | null; retryAt: number | null };
          try {
            result = await this.keepAliveLease.while(() => this.execute(dispatch, row, leaseToken));
          } catch (error) {
            const code = error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : "block_dashboard_block_execution_failed";
            const deferredAt = Date.now();
            deferAgentRunDispatch(
              this.state.storage.sql,
              BLOCK_DASHBOARD_RUN_DISPATCHES,
              row.block_run_id,
              leaseToken,
              deferredAt + durableAgentRetryDelay(row.attempt + 1),
              code,
              deferredAt,
            );
            logWarn(this.env, "block_dashboard_block_agent_run_deferred", {
              workspace_id: dispatch.workspaceId,
              workstream_id: dispatch.workstreamId,
              block_id: dispatch.blockId,
              block_run_id: dispatch.blockRunId,
              reason: error instanceof Error ? error.message : "unknown",
            });
            return;
          }
          const terminalized = this.state.storage.sql.exec<{ terminal_outcome_json: string | null }>(
            `SELECT terminal_outcome_json FROM agent_run_dispatches WHERE block_run_id = ?`,
            row.block_run_id,
          ).toArray()[0]?.terminal_outcome_json ?? null;
          if (terminalized) continue;
          if (result.retryAt !== null) {
            deferAgentRunDispatch(
              this.state.storage.sql,
              BLOCK_DASHBOARD_RUN_DISPATCHES,
              row.block_run_id,
              leaseToken,
              result.retryAt,
              result.errorCode,
              Date.now(),
            );
            return;
          }
          settleAgentRunDispatch(
            this.state.storage.sql,
            BLOCK_DASHBOARD_RUN_DISPATCHES,
            row.block_run_id,
            leaseToken,
            result.failed ? "failed" : "completed",
            result.errorCode,
            Date.now(),
          );
          continue;
        } finally {
          if (this.activeRunDispatch?.leaseToken === leaseToken) {
            this.activeRunDispatch = null;
          }
          if (ownsDrain()) this.agentDrain.touch();
        }
      }

      const settlement = this.state.storage.sql.exec<DispatchRow>(
        `SELECT block_run_id, dispatch_json, state, attempt, terminal_outcome_json, settled_at
           FROM agent_run_dispatches
          WHERE terminal_outcome_json IS NOT NULL AND settled_at IS NULL AND available_at <= ?
          ORDER BY available_at, created_at, block_run_id LIMIT 1`,
        Date.now(),
      ).toArray()[0];
      if (!settlement?.terminal_outcome_json) return;
      const dispatch = BlockDashboardBlockDispatchSchema.parse(JSON.parse(settlement.dispatch_json));
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET attempt = attempt + 1, updated_at = ?
          WHERE block_run_id = ? AND terminal_outcome_json IS NOT NULL AND settled_at IS NULL`,
        Date.now(),
        settlement.block_run_id,
      );
      const result = await this.settleWithRetry(
        dispatch,
        TerminalOutcomeSchema.parse(JSON.parse(settlement.terminal_outcome_json)),
      );
      if (result.retryAt !== null) return;
    }
  }

  private async execute(
    dispatch: BlockDashboardBlockDispatch,
    row: DispatchRow,
    leaseToken: string,
  ): Promise<{ failed: boolean; errorCode: string | null; retryAt: number | null }> {
    if (row.terminal_outcome_json) {
      return this.settleWithRetry(dispatch, TerminalOutcomeSchema.parse(JSON.parse(row.terminal_outcome_json)));
    }
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority)) {
      return { failed: false, errorCode: null, retryAt: Date.now() + MAINTENANCE_RECHECK_MS };
    }
    const executionEnv = await workstreamExecutionEnvironment(
      this.env,
      dispatch.workspaceId,
      dispatch.workstreamId,
    );
    const input = await this.initializeRuntimeRun(executionEnv, dispatch);
    await reapStaleHarnessRuns(executionEnv.DB, {
      receipts: createToolReceiptPortFactory(executionEnv),
      blocks: createBlockDashboardPortFactory(executionEnv),
      workspaceId: dispatch.workspaceId,
      workstreamId: dispatch.workstreamId,
      limit: 25,
      automationDatabase: null,
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
    const owner = `block-dashboard-agent:${dispatch.blockId}:${dispatch.blockRunId}:${attemptId}`;
    const claim = await claimHarnessAttempt(executionEnv.DB, input, {
      attemptId,
      owner,
      leaseSeconds: 300,
    });
    if (claim.state === "busy") {
      const leaseAt = claim.leaseExpiresAt ? Date.parse(claim.leaseExpiresAt) : Number.NaN;
      return {
        failed: false,
        errorCode: null,
        retryAt: Number.isFinite(leaseAt) ? Math.max(Date.now() + 1_000, leaseAt + 1) : Date.now() + 5_000,
      };
    }
    if (claim.state === "terminal") {
      const terminal = await this.readRuntimeBlockRun(executionEnv, dispatch);
      return this.persistAndSettle(dispatch, { run: terminal }, leaseToken);
    }
    if (claim.state === "cancelled") {
      await terminalizeQueuedHarnessRun(
        executionEnv.DB,
        input,
        { attemptId, owner },
        { code: "run_cancelled", message: "The HyperSight block was stopped before it started" },
        "stopped",
      );
      const stopped = await this.updateRuntimeBlockRun(executionEnv, dispatch, "stopped", {
        code: "run_cancelled",
        message: "The HyperSight block was stopped before it started",
      });
      return this.persistAndSettle(dispatch, { run: stopped }, leaseToken);
    }

    const running = await this.updateRuntimeBlockRun(executionEnv, dispatch, "running");
    await this.sendResult(dispatch, running, 1).catch(() => undefined);
    let outcome: WorkstreamHarnessResult;
    try {
      outcome = await runWorkstreamHarness(
        executionEnv,
        input,
        (event) => this.recordStreamEvent(dispatch, event),
        {
        lease: claim.lease,
        publishRealtime: false,
        },
      );
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "harness_execution_failed";
      outcome = {
        status: code === "run_cancelled" ? "stopped" : "failed",
        error: { code, message: "The HyperSight block could not complete" },
      };
    }
    const status = outcome.status === "completed"
      ? "completed"
      : outcome.status === "stopped" ? "stopped" : "failed";
    const error = outcome.error ?? (outcome.status === "needs_input"
      ? { code: "block_dashboard_input_unavailable", message: "HyperSight cannot pause for input" }
      : undefined);
    await terminalizeHarnessAttempt(executionEnv.DB, input, claim.lease, {
      status,
      ...(error ? { error } : {}),
      memberSafePayload: error ? { code: error.code } : {},
    },
    createToolReceiptObjectPort(executionEnv, input.workspaceId, input.workstreamId),
    createBlockDashboardObjectPort(executionEnv, input.workspaceId, input.workstreamId));
    const terminal = await this.updateRuntimeBlockRun(executionEnv, dispatch, status, error);
    return this.persistAndSettle(dispatch, { run: terminal }, leaseToken);
  }

  private async initializeRuntimeRun(env: Env, dispatch: BlockDashboardBlockDispatch): Promise<WorkstreamWorkflowInput> {
    const fence = dispatch.contextFence.throughSequence > 0
      ? await env.DB.prepare(
        `SELECT id FROM messages WHERE workspace_id = ? AND workstream_id = ?
          AND sequence_number = ? LIMIT 1`,
      ).bind(dispatch.workspaceId, dispatch.workstreamId, dispatch.contextFence.throughSequence)
        .first<{ id: string }>()
      : null;
    if (dispatch.contextFence.throughSequence > 0 && !fence) {
      throw Object.assign(new Error("The frozen HyperSight transcript boundary is unavailable"), {
        code: "block_dashboard_context_fence_not_found",
      });
    }
    const input = WorkstreamWorkflowInputSchema.parse({
      region: dispatch.region,
      workspaceId: dispatch.workspaceId,
      workstreamId: dispatch.workstreamId,
      substreamId: "0",
      harnessRunId: dispatch.harnessRunId,
      triggerMessageId: null,
      transcriptFenceMessageId: fence?.id ?? null,
      compactionFence: dispatch.contextFence.compaction,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "workspace", workspaceId: dispatch.workspaceId },
      reason: "block_dashboard_block",
    });
    const { model } = await resolveAgentModelRouting(env, "block_dashboard", {
      workspaceId: dispatch.workspaceId,
      workstreamId: dispatch.workstreamId,
    });
    // One operation, not a three-statement batch. The configuration version, the
    // harness run and the block row are one fact, and the object writes them in
    // a single transaction — so the UNIQUE-constraint rescue this needed, which
    // caught an exception and re-read to decide whether a redelivery had already
    // landed, is now the operation's own answer. That re-read compared the
    // block the existing row belongs to, and so does the operation: a dispatch
    // naming an admitted run-and-block-run pair for a *different* block is
    // refused rather than replayed.
    const admitted = await createBlockDashboardObjectPort(
      env,
      dispatch.workspaceId,
      dispatch.workstreamId,
    ).admitDispatch({
      configurationVersionId: dispatch.configurationVersionId,
      versionNumber: dispatch.configurationVersionNumber,
      blocksJson: JSON.stringify([{ id: dispatch.blockId, prompt: dispatch.prompt }]),
      createdByUserId: dispatch.workspaceId,
      configurationCreatedAt: Date.parse(dispatch.createdAt),
      blockRunId: dispatch.blockRunId,
      blockId: dispatch.blockId,
      prompt: dispatch.prompt,
      triggerSequence: dispatch.triggerSequence,
      harnessRunId: dispatch.harnessRunId,
      executionPrincipalJson: JSON.stringify(input.executionPrincipal),
      model,
      createdAt: Date.parse(dispatch.createdAt),
    });
    if (admitted === "dispatch_conflict") {
      throw new Error("block_dashboard_runtime_initialization_conflict");
    }
    return input;
  }

  private async updateRuntimeBlockRun(
    env: Env,
    dispatch: BlockDashboardBlockDispatch,
    status: BlockDashboardBlockRun["status"],
    error?: { code: string; message: string },
  ): Promise<BlockDashboardBlockRun> {
    await createBlockDashboardObjectPort(env, dispatch.workspaceId, dispatch.workstreamId)
      .recordBlockRunProgress({
        blockRunId: dispatch.blockRunId,
        harnessRunId: dispatch.harnessRunId,
        status,
        errorJson: error ? JSON.stringify(error) : null,
        now: Date.now(),
      });
    return this.readRuntimeBlockRun(env, dispatch);
  }

  private async readRuntimeBlockRun(env: Env, dispatch: BlockDashboardBlockDispatch): Promise<BlockDashboardBlockRun> {
    const row = await createBlockDashboardObjectPort(env, dispatch.workspaceId, dispatch.workstreamId)
      .blockRun({ blockRunId: dispatch.blockRunId, harnessRunId: dispatch.harnessRunId });
    if (!row) throw new Error("block_dashboard_runtime_block_run_missing");
    return blockRunFromObjectRow(row);
  }

  private async persistAndSettle(
    dispatch: BlockDashboardBlockDispatch,
    outcome: TerminalOutcome,
    leaseToken: string,
  ): Promise<{ failed: boolean; errorCode: string | null; retryAt: number | null }> {
    const parsed = TerminalOutcomeSchema.parse(outcome);
    const state = terminalDispatchState(parsed.run);
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      const transitioned = this.state.storage.sql.exec<{ block_run_id: string }>(
        `UPDATE agent_run_dispatches SET state = ?, terminal_outcome_json = ?,
           available_at = ?, completed_at = COALESCE(completed_at, ?), settled_at = NULL,
           last_settlement_error_code = NULL, updated_at = ?,
           lease_token = NULL, lease_expires_at = NULL
         WHERE block_run_id = ? AND lease_token = ?
           AND terminal_outcome_json IS NULL
         RETURNING block_run_id`,
        state,
        JSON.stringify(parsed),
        now,
        now,
        now,
        dispatch.blockRunId,
        leaseToken,
      );
      if (transitioned.toArray().length === 0) {
        throw Object.assign(new Error("The BlockDashboard dispatch lease was replaced"), {
          code: "block_dashboard_dispatch_ownership_lost",
        });
      }
      this.state.storage.sql.exec(
        `DELETE FROM agent_stream_checkpoint WHERE id = 1 AND block_run_id = ?`,
        dispatch.blockRunId,
      );
    });
    await this.settleWithRetry(dispatch, parsed);
    this.queueBroadcast(async () => {
      await this.broadcastStreamCheckpoint(dispatch, null);
      await this.broadcastLatestRun(dispatch.blockRunId);
    }, "terminal");
    return {
      failed: parsed.run.status === "failed",
      errorCode: parsed.run.error?.code ?? null,
      retryAt: null,
    };
  }

  private async settleWithRetry(
    dispatch: BlockDashboardBlockDispatch,
    outcome: TerminalOutcome,
  ): Promise<{ failed: boolean; errorCode: string | null; retryAt: number | null }> {
    try {
      await this.sendResult(dispatch, outcome.run, 2);
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET state = ?, completed_at = COALESCE(completed_at, ?),
           settled_at = ?, last_settlement_error_code = NULL, updated_at = ?
         WHERE block_run_id = ? AND terminal_outcome_json IS NOT NULL`,
        terminalDispatchState(outcome.run),
        Date.now(),
        Date.now(),
        Date.now(),
        dispatch.blockRunId,
      );
      return {
        failed: outcome.run.status === "failed",
        errorCode: outcome.run.error?.code ?? null,
        retryAt: null,
      };
    } catch (error) {
      const attempt = this.state.storage.sql.exec<{ attempt: number }>(
        `SELECT attempt FROM agent_run_dispatches WHERE block_run_id = ?`,
        dispatch.blockRunId,
      ).toArray()[0]?.attempt ?? 1;
      const code = error instanceof Error ? error.message : "block_dashboard_result_settlement_failed";
      const retryAt = Date.now() + durableAgentRetryDelay(attempt);
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET state = ?, available_at = ?,
           last_settlement_error_code = ?, updated_at = ?
          WHERE block_run_id = ?`,
        terminalDispatchState(outcome.run),
        retryAt,
        code,
        Date.now(),
        dispatch.blockRunId,
      );
      return {
        failed: outcome.run.status === "failed",
        errorCode: code,
        retryAt,
      };
    }
  }

  private async sendResult(
    dispatch: BlockDashboardBlockDispatch,
    run: BlockDashboardBlockRun,
    sourceVersion: number,
  ): Promise<void> {
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      dispatch.workspaceId,
      workstreamDOName(dispatch.region, dispatch.workspaceId, dispatch.workstreamId),
    );
    const response = await stub.controlBlockDashboard(BlockDashboardControlRequestSchema.parse({
      operation: "block_result",
      workspaceId: dispatch.workspaceId,
      workstreamId: dispatch.workstreamId,
      blockId: dispatch.blockId,
      sourceVersion,
      payloadHash: blockDashboardBlockResultHash(run),
      run,
    }));
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`block_dashboard_result_rejected:${response.status}`);
    }
  }

  /**
   * Derived from the dispatch rows alone.
   *
   * This used to open with `if (this.agentDrain.active) return null`, which
   * meant an invocation cancelled mid-drain left every row unscheduled and the
   * object inert for good. In-memory drain state governs deduplication, never
   * scheduling; see agent-run-dispatch-queue for the full reasoning.
   */
  private nextRunAt(): number | null {
    // Two indexable lanes instead of one OR the planner cannot seek: the
    // ready index serves the queued/running arm, the settlement partial
    // index serves the unsettled-terminal arm. A running row is due at its
    // lease expiry, which is when it becomes reclaimable.
    const dueAt = this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(due_at) AS due_at FROM (
         SELECT MIN(${AGENT_RUN_DISPATCH_DUE_AT_SQL}) AS due_at FROM agent_run_dispatches
          WHERE state IN ('queued', 'running') AND terminal_outcome_json IS NULL
         UNION ALL
         SELECT MIN(available_at) FROM agent_run_dispatches
          WHERE terminal_outcome_json IS NOT NULL AND settled_at IS NULL
       )`,
    ).toArray()[0]?.due_at ?? null;
    return applyAgentRunDispatchSweepFloor(dueAt, Date.now());
  }

  private async ensureAlarmNoLaterThan(dueAt: number): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > dueAt) await this.state.storage.setAlarm(dueAt);
  }

  /** Keep one bounded recovery wake-up without redelivering the owned row. */
  private async armAlarmDuringRunDrain(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + KEEP_ALIVE_INTERVAL_MS);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const dueAt = this.keepAliveLease.alarmDueAt(
      this.nextRunAt(),
      Date.now(),
      KEEP_ALIVE_INTERVAL_MS,
    );
    if (dueAt === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + 1, dueAt));
  }
}
