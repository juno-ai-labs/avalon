import {
  HyperSightBlockRunSchema,
  WorkstreamWorkflowInputSchema,
  type HyperSightBlockRun,
  type WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { assertDurableObjectJurisdiction, durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
import {
  claimHarnessAttempt,
  reapStaleHarnessRuns,
  terminalizeHarnessAttempt,
  terminalizeQueuedHarnessRun,
} from "../runtime/harness-run-runtime";
import { resolveAgentModelRouting } from "../services/agent-model-flags";
import { runWorkstreamHarness, type WorkstreamHarnessResult } from "../services/integrations";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import { workstreamExecutionEnvironment } from "../services/workstream-runtime-database";
import { DurableAgentDrain, DurableAgentKeepAlive, durableAgentRetryDelay } from "./durable-agent-runtime";
import {
  HyperSightBlockDispatchSchema,
  HyperSightControlRequestSchema,
  hyperSightBlockResultHash,
  type HyperSightBlockDispatch,
} from "./hypersight-protocol";
import { workstreamDOName } from "./names";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

const KEEP_ALIVE_INTERVAL_MS = 30_000;
const MAINTENANCE_RECHECK_MS = 5 * 60_000;

const TerminalOutcomeSchema = z.object({
  run: HyperSightBlockRunSchema,
}).strict();
type TerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;

interface DispatchRow extends Record<string, SqlStorageValue> {
  block_run_id: string;
  dispatch_json: string;
  state: "queued" | "running";
  attempt: number;
  terminal_outcome_json: string | null;
  settled_at: number | null;
}

interface RuntimeBlockRow {
  id: string;
  block_id: string;
  configuration_version_id: string;
  trigger_sequence: number;
  status: HyperSightBlockRun["status"];
  markdown: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export const HYPERSIGHT_BLOCK_AGENT_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "stable HyperSight block identity and durable Bind dispatch ledger",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE hypersight_block_identity (
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

function blockRunFromRow(row: RuntimeBlockRow): HyperSightBlockRun {
  return HyperSightBlockRunSchema.parse({
    id: row.id,
    blockId: row.block_id,
    configurationVersionId: row.configuration_version_id,
    triggerSequence: row.trigger_sequence,
    status: row.status,
    markdown: row.markdown,
    error: parseError(row.error_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

/** A stable, SQL-backed owner for one HyperSight block's complete Bind loops. */
export class HyperSightBlockAgent extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;
  private readonly keepAliveLease: DurableAgentKeepAlive;
  private readonly agentDrain = new DurableAgentDrain();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.keepAliveLease = new DurableAgentKeepAlive(() => this.scheduleNextAlarm());
    this.initialized = state.blockConcurrencyWhile(async () => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: HYPERSIGHT_BLOCK_AGENT_SCHEMA_MIGRATIONS,
        component: "hypersight_block_agent",
        workerVersionId: env.APP_VERSION ?? "unknown",
      });
      this.resumeRunDrain();
      await this.scheduleNextAlarm();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/internal/run-dispatch") {
      const parsed = HyperSightBlockDispatchSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid_hypersight_block_dispatch" }, 400);
      try {
        this.ensureIdentity(parsed.data);
        this.enqueue(parsed.data);
        this.resumeRunDrain();
        await this.ensureAlarmNoLaterThan(Date.now() + 1);
        return json({ accepted: true }, 202);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "hypersight_block_dispatch_failed",
        }, 409);
      }
    }
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        role: "hypersight-block-agent",
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    this.resumeRunDrain();
    await this.scheduleNextAlarm();
  }

  private ensureIdentity(dispatch: HyperSightBlockDispatch): void {
    const existing = this.state.storage.sql.exec<{
      workspace_id: string;
      workstream_id: string;
      block_id: string;
      region: string;
    }>(
      `SELECT workspace_id, workstream_id, block_id, region
         FROM hypersight_block_identity WHERE id = 1`,
    ).toArray()[0];
    if (existing) {
      if (existing.workspace_id !== dispatch.workspaceId
        || existing.workstream_id !== dispatch.workstreamId
        || existing.block_id !== dispatch.blockId
        || existing.region !== dispatch.region) {
        throw new Error("hypersight_block_agent_identity_mismatch");
      }
      return;
    }
    this.state.storage.sql.exec(
      `INSERT INTO hypersight_block_identity
         (id, workspace_id, workstream_id, block_id, region, created_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      dispatch.workspaceId,
      dispatch.workstreamId,
      dispatch.blockId,
      dispatch.region,
      Date.now(),
    );
  }

  private enqueue(dispatch: HyperSightBlockDispatch): void {
    const now = Date.now();
    const inserted = this.state.storage.sql.exec<{ block_run_id: string }>(
      `INSERT OR IGNORE INTO agent_run_dispatches
         (block_run_id, dispatch_json, state, attempt, available_at, started_at,
          completed_at, last_error_code, terminal_outcome_json, settled_at,
          last_settlement_error_code, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
       RETURNING block_run_id`,
      dispatch.blockRunId,
      JSON.stringify(dispatch),
      now,
      now,
      now,
    ).toArray()[0];
    if (inserted) return;
    const existing = this.state.storage.sql.exec<{ dispatch_json: string }>(
      `SELECT dispatch_json FROM agent_run_dispatches WHERE block_run_id = ?`,
      dispatch.blockRunId,
    ).toArray()[0];
    if (existing?.dispatch_json !== JSON.stringify(dispatch)) {
      throw new Error("hypersight_block_dispatch_idempotency_conflict");
    }
  }

  private resumeRunDrain(): void {
    if (this.agentDrain.active) return;
    const drain = this.agentDrain.resume(
      () => this.drainRunQueue().catch((error: unknown) => {
        logWarn(this.env, "hypersight_block_agent_drain_failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }),
      () => this.scheduleNextAlarm().catch(() => undefined),
    );
    this.state.waitUntil(drain);
  }

  private async drainRunQueue(): Promise<void> {
    while (true) {
      const row = this.state.storage.sql.exec<DispatchRow>(
        `SELECT block_run_id, dispatch_json, state, attempt, terminal_outcome_json, settled_at
           FROM agent_run_dispatches
          WHERE state IN ('queued', 'running') AND available_at <= ?
          ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, created_at, block_run_id
          LIMIT 1`,
        Date.now(),
      ).toArray()[0];
      if (!row) return;
      const dispatch = HyperSightBlockDispatchSchema.parse(JSON.parse(row.dispatch_json));
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET state = 'running', attempt = attempt + 1,
           started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE block_run_id = ? AND state IN ('queued', 'running')`,
        Date.now(),
        Date.now(),
        row.block_run_id,
      );
      let result: { failed: boolean; errorCode: string | null; retryAt: number | null };
      try {
        result = await this.keepAliveLease.while(() => this.execute(dispatch, row));
      } catch (error) {
        const code = error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "hypersight_block_execution_failed";
        this.state.storage.sql.exec(
          `UPDATE agent_run_dispatches SET state = 'running', available_at = ?,
             last_error_code = ?, updated_at = ? WHERE block_run_id = ?`,
          Date.now() + durableAgentRetryDelay(row.attempt + 1),
          code,
          Date.now(),
          row.block_run_id,
        );
        logWarn(this.env, "hypersight_block_agent_run_deferred", {
          workspace_id: dispatch.workspaceId,
          workstream_id: dispatch.workstreamId,
          block_id: dispatch.blockId,
          block_run_id: dispatch.blockRunId,
          reason: error instanceof Error ? error.message : "unknown",
        });
        return;
      }
      if (result.retryAt !== null) {
        this.state.storage.sql.exec(
          `UPDATE agent_run_dispatches SET state = 'running', available_at = ?,
             last_error_code = ?, updated_at = ? WHERE block_run_id = ?`,
          result.retryAt,
          result.errorCode,
          Date.now(),
          row.block_run_id,
        );
        return;
      }
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET state = ?, completed_at = ?,
           last_error_code = ?, updated_at = ? WHERE block_run_id = ?`,
        result.failed ? "failed" : "completed",
        Date.now(),
        result.errorCode,
        Date.now(),
        row.block_run_id,
      );
    }
  }

  private async execute(
    dispatch: HyperSightBlockDispatch,
    row: DispatchRow,
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
      workspaceId: dispatch.workspaceId,
      workstreamId: dispatch.workstreamId,
      limit: 25,
    });
    const attemptId = crypto.randomUUID();
    const owner = `hypersight-block-agent:${dispatch.blockId}:${dispatch.blockRunId}:${attemptId}`;
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
      return this.persistAndSettle(dispatch, { run: terminal });
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
      return this.persistAndSettle(dispatch, { run: stopped });
    }

    const running = await this.updateRuntimeBlockRun(executionEnv, dispatch, "running");
    await this.sendResult(dispatch, running, 1).catch(() => undefined);
    let outcome: WorkstreamHarnessResult;
    try {
      outcome = await runWorkstreamHarness(executionEnv, input, undefined, {
        lease: claim.lease,
        publishRealtime: false,
      });
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
      ? { code: "hypersight_input_unavailable", message: "HyperSight cannot pause for input" }
      : undefined);
    await terminalizeHarnessAttempt(executionEnv.DB, input, claim.lease, {
      status,
      ...(error ? { error } : {}),
      memberSafePayload: error ? { code: error.code } : {},
    });
    const terminal = await this.updateRuntimeBlockRun(executionEnv, dispatch, status, error);
    return this.persistAndSettle(dispatch, { run: terminal });
  }

  private async initializeRuntimeRun(env: Env, dispatch: HyperSightBlockDispatch): Promise<WorkstreamWorkflowInput> {
    const fence = dispatch.contextFence.throughSequence > 0
      ? await env.DB.prepare(
        `SELECT id FROM messages WHERE workspace_id = ? AND workstream_id = ?
          AND sequence_number = ? LIMIT 1`,
      ).bind(dispatch.workspaceId, dispatch.workstreamId, dispatch.contextFence.throughSequence)
        .first<{ id: string }>()
      : null;
    if (dispatch.contextFence.throughSequence > 0 && !fence) {
      throw Object.assign(new Error("The frozen HyperSight transcript boundary is unavailable"), {
        code: "hypersight_context_fence_not_found",
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
      reason: "hypersight_block",
    });
    const { model } = await resolveAgentModelRouting(env, "hypersight", {
      workspaceId: dispatch.workspaceId,
      workstreamId: dispatch.workstreamId,
    });
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO hypersight_configuration_versions
             (id, workspace_id, workstream_id, version_number, blocks_json,
              created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          dispatch.configurationVersionId,
          dispatch.workspaceId,
          dispatch.workstreamId,
          dispatch.configurationVersionNumber,
          JSON.stringify([{ id: dispatch.blockId, prompt: dispatch.prompt }]),
          dispatch.workspaceId,
          dispatch.createdAt,
        ),
        env.DB.prepare(
          `INSERT INTO harness_runs
             (id, workspace_id, workstream_id, origin, execution_principal_json,
              status, model, created_at)
           VALUES (?, ?, ?, 'hypersight_block', ?, 'scheduled', ?, ?)`,
        ).bind(
          dispatch.harnessRunId,
          dispatch.workspaceId,
          dispatch.workstreamId,
          JSON.stringify(input.executionPrincipal),
          model,
          dispatch.createdAt,
        ),
        env.DB.prepare(
          `INSERT INTO hypersight_block_runs
             (id, workspace_id, workstream_id, configuration_version_id, block_id, prompt,
              trigger_sequence, harness_run_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        ).bind(
          dispatch.blockRunId,
          dispatch.workspaceId,
          dispatch.workstreamId,
          dispatch.configurationVersionId,
          dispatch.blockId,
          dispatch.prompt,
          dispatch.triggerSequence,
          dispatch.harnessRunId,
          dispatch.createdAt,
        ),
      ]);
    } catch (error) {
      if (!(error instanceof Error) || !/UNIQUE|constraint/iu.test(error.message)) throw error;
      const existing = await env.DB.prepare(
        `SELECT id FROM hypersight_block_runs WHERE id = ? AND harness_run_id = ?
          AND workspace_id = ? AND workstream_id = ? AND block_id = ?`,
      ).bind(
        dispatch.blockRunId,
        dispatch.harnessRunId,
        dispatch.workspaceId,
        dispatch.workstreamId,
        dispatch.blockId,
      ).first<{ id: string }>();
      if (!existing) throw new Error("hypersight_runtime_initialization_conflict", { cause: error });
    }
    return input;
  }

  private async updateRuntimeBlockRun(
    env: Env,
    dispatch: HyperSightBlockDispatch,
    status: HyperSightBlockRun["status"],
    error?: { code: string; message: string },
  ): Promise<HyperSightBlockRun> {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE hypersight_block_runs SET status = ?, error_json = ?,
         started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
         completed_at = CASE WHEN ? IN ('completed', 'failed', 'stopped') THEN ? ELSE completed_at END
       WHERE id = ? AND harness_run_id = ? AND workspace_id = ? AND workstream_id = ?`,
    ).bind(
      status,
      error ? JSON.stringify(error) : null,
      status,
      now,
      status,
      now,
      dispatch.blockRunId,
      dispatch.harnessRunId,
      dispatch.workspaceId,
      dispatch.workstreamId,
    ).run();
    return this.readRuntimeBlockRun(env, dispatch);
  }

  private async readRuntimeBlockRun(env: Env, dispatch: HyperSightBlockDispatch): Promise<HyperSightBlockRun> {
    const row = await env.DB.prepare(
      `SELECT id, block_id, configuration_version_id, trigger_sequence, status,
              markdown, error_json, created_at, started_at, completed_at
         FROM hypersight_block_runs WHERE id = ? AND harness_run_id = ?
          AND workspace_id = ? AND workstream_id = ?`,
    ).bind(
      dispatch.blockRunId,
      dispatch.harnessRunId,
      dispatch.workspaceId,
      dispatch.workstreamId,
    ).first<RuntimeBlockRow>();
    if (!row) throw new Error("hypersight_runtime_block_run_missing");
    return blockRunFromRow(row);
  }

  private persistAndSettle(
    dispatch: HyperSightBlockDispatch,
    outcome: TerminalOutcome,
  ): Promise<{ failed: boolean; errorCode: string | null; retryAt: number | null }> {
    const parsed = TerminalOutcomeSchema.parse(outcome);
    this.state.storage.sql.exec(
      `UPDATE agent_run_dispatches SET terminal_outcome_json = ?, settled_at = NULL,
         last_settlement_error_code = NULL, updated_at = ? WHERE block_run_id = ?`,
      JSON.stringify(parsed),
      Date.now(),
      dispatch.blockRunId,
    );
    return this.settleWithRetry(dispatch, parsed);
  }

  private async settleWithRetry(
    dispatch: HyperSightBlockDispatch,
    outcome: TerminalOutcome,
  ): Promise<{ failed: boolean; errorCode: string | null; retryAt: number | null }> {
    try {
      await this.sendResult(dispatch, outcome.run, 2);
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET settled_at = ?, last_settlement_error_code = NULL,
           updated_at = ? WHERE block_run_id = ? AND terminal_outcome_json IS NOT NULL`,
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
      const code = error instanceof Error ? error.message : "hypersight_result_settlement_failed";
      this.state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET last_settlement_error_code = ?, updated_at = ?
          WHERE block_run_id = ?`,
        code,
        Date.now(),
        dispatch.blockRunId,
      );
      return {
        failed: outcome.run.status === "failed",
        errorCode: code,
        retryAt: Date.now() + durableAgentRetryDelay(attempt),
      };
    }
  }

  private async sendResult(
    dispatch: HyperSightBlockDispatch,
    run: HyperSightBlockRun,
    sourceVersion: number,
  ): Promise<void> {
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      dispatch.workspaceId,
      workstreamDOName(dispatch.region, dispatch.workspaceId, dispatch.workstreamId),
    );
    const response = await stub.fetch("https://workstream.internal/internal/hypersight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(HyperSightControlRequestSchema.parse({
        operation: "block_result",
        workspaceId: dispatch.workspaceId,
        workstreamId: dispatch.workstreamId,
        blockId: dispatch.blockId,
        sourceVersion,
        payloadHash: hyperSightBlockResultHash(run),
        run,
      })),
    });
    if (!response.ok) throw new Error(`hypersight_result_rejected:${response.status}`);
  }

  private nextRunAt(): number | null {
    return this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(available_at) AS due_at FROM agent_run_dispatches
        WHERE state = 'queued' ${this.agentDrain.active ? "" : "OR state = 'running'"}`,
    ).toArray()[0]?.due_at ?? null;
  }

  private async ensureAlarmNoLaterThan(dueAt: number): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > dueAt) await this.state.storage.setAlarm(dueAt);
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
