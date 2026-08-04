import type { WorkstreamWorkflowInput } from "@avalon/contracts";

const TERMINAL_STATUSES = new Set(["completed", "needs_input", "failed", "stopped"]);

export type HarnessTerminalStatus = "completed" | "needs_input" | "failed" | "stopped";

export interface AttemptLease {
  attemptId: string;
  owner: string;
  attemptNumber: number;
  leaseExpiresAt: string;
}

export type AttemptClaim =
  | { state: "claimed"; lease: AttemptLease }
  | { state: "busy"; leaseExpiresAt: string | null }
  | { state: "cancelled" }
  | { state: "terminal"; status: HarnessTerminalStatus };

export interface AttemptIdentity {
  attemptId: string;
  owner: string;
}

export interface ImmutableRunScope {
  executionPrincipal: unknown;
  eligibleConnectionIds: string[];
  eligibleCapabilities: string[];
  eligibleConnectionCapabilities: Record<string, string[]>;
  triggerPolicy: Record<string, unknown>;
  routingPolicyVersion: string;
  promptVersion: string;
  toolSurfaceHash: string;
  limits: Record<string, unknown>;
}

export interface TerminalOutcome {
  status: HarnessTerminalStatus;
  finalMessageId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  error?: { code: string; message: string };
  memberSafePayload?: Record<string, unknown>;
}

export interface InferenceAttemptRecord {
  id?: string;
  harnessRunId: string;
  workspaceId: string;
  workstreamId: string;
  attemptId: string;
  turnId: string;
  endpointAttempt: number;
  fallbackAttempt: number;
  provider: string;
  model: string;
  credentialSourceHash?: string;
  workspaceIdentityHash: string;
  routingDecision?: Record<string, unknown>;
  outcome: "success" | "retry" | "defect" | "fallback" | "failed" | "cancelled";
  failureClassification?: string;
  latencyMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  costMicrousd?: number;
  responseBytes?: number;
  startedAt: string;
  completedAt: string;
}

export interface ToolExecutionPlan {
  invocationId?: string;
  harnessRunId: string;
  workspaceId: string;
  workstreamId: string;
  toolCallId: string;
  toolName: string;
  connectionId?: string;
  inputHash: string;
  input: unknown;
  plan: Record<string, unknown>;
  providerIdempotencyKey?: string;
  mode: "read" | "write";
}

export type ToolPlanClaim =
  | { state: "created"; invocationId: string; executionPlanHash: string }
  | { state: "resume_read"; invocationId: string; executionPlanHash: string }
  | { state: "replay_completed"; invocationId: string; executionPlanHash: string }
  | { state: "ambiguous_external_write"; invocationId: string; executionPlanHash: string };

export interface ToolInvocationFailure {
  harnessRunId: string;
  invocationId: string;
  status: "failed" | "ambiguous";
  phase: string;
  error: { code: string; message: string };
  memberSafePayload?: Record<string, unknown>;
}

export class RunOwnershipLostError extends Error {
  readonly code = "run_ownership_lost";

  constructor() {
    super("The durable attempt lease is no longer owned by this executor");
    this.name = "RunOwnershipLostError";
  }
}

export class RunCancelledError extends Error {
  readonly code = "run_cancelled";

  constructor() {
    super("The harness run was cancelled");
    this.name = "RunCancelledError";
  }
}

function d1Changes(result: D1Result<unknown> | undefined): number {
  return Number((result as D1Result<unknown> | undefined)?.meta?.changes ?? 0);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeErrorJson(error: TerminalOutcome["error"]): string | null {
  if (!error) return null;
  return JSON.stringify({ code: error.code.slice(0, 120), message: error.message.slice(0, 500) });
}

export async function claimHarnessAttempt(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  options: AttemptIdentity & { leaseSeconds?: number },
): Promise<AttemptClaim> {
  const leaseSeconds = Math.max(10, Math.min(300, Math.trunc(options.leaseSeconds ?? 60)));
  const lifecycleId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE harness_runs
          SET status = 'running',
              started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              attempt_number = CASE WHEN attempt_id = ?4 THEN attempt_number ELSE attempt_number + 1 END,
              attempt_id = ?4,
              lease_owner = ?5,
              heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?6))
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND status IN ('scheduled', 'running')
          AND terminalized_at IS NULL
          AND cancellation_requested_at IS NULL
          AND (
            attempt_id IS NULL
            OR (attempt_id = ?4 AND lease_owner = ?5)
            OR lease_expires_at IS NULL
            OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
          AND NOT EXISTS (
            SELECT 1
              FROM harness_runs active
             WHERE active.workspace_id = ?2
               AND active.workstream_id = ?3
               AND active.id != ?1
               AND active.status = 'running'
               AND active.terminalized_at IS NULL
               AND active.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      options.attemptId,
      options.owner,
      leaseSeconds,
    ),
    db.prepare(
      `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
       SELECT ?6, id, workspace_id, workstream_id, ?4, ?7, 'claimed', 'running', '{}',
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         FROM harness_runs
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id = ?4 AND lease_owner = ?5 AND terminalized_at IS NULL
       ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      options.attemptId,
      options.owner,
      lifecycleId,
      `attempt:${options.attemptId}:claimed`,
    ),
    db.prepare(
      `UPDATE workstreams
          SET harness_status = 'running',
              last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND workspace_id = ?2
          AND EXISTS (
            SELECT 1 FROM harness_runs
             WHERE id = ?3 AND workspace_id = ?2 AND workstream_id = ?1
               AND attempt_id = ?4 AND lease_owner = ?5
               AND status = 'running' AND terminalized_at IS NULL
               AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )`,
    ).bind(
      input.workstreamId,
      input.workspaceId,
      input.harnessRunId,
      options.attemptId,
      options.owner,
    ),
  ]);

  if (d1Changes(results[0]) > 0) {
    const row = await db.prepare(
      `SELECT attempt_number, lease_expires_at
         FROM harness_runs
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id = ?4 AND lease_owner = ?5`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      options.attemptId,
      options.owner,
    ).first<{ attempt_number: number; lease_expires_at: string }>();
    if (!row) throw new RunOwnershipLostError();
    return {
      state: "claimed",
      lease: {
        attemptId: options.attemptId,
        owner: options.owner,
        attemptNumber: Number(row.attempt_number),
        leaseExpiresAt: row.lease_expires_at,
      },
    };
  }

  const row = await db.prepare(
    `SELECT status, cancellation_requested_at,
            (SELECT MAX(active.lease_expires_at)
               FROM harness_runs active
              WHERE active.workspace_id = ?2 AND active.workstream_id = ?3
                AND active.status = 'running' AND active.terminalized_at IS NULL)
              AS active_lease_expires_at
       FROM harness_runs
      WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3`,
  ).bind(input.harnessRunId, input.workspaceId, input.workstreamId)
    .first<{ status: string; cancellation_requested_at: string | null; active_lease_expires_at: string | null }>();
  if (!row) throw new Error("harness_run_not_found");
  if (TERMINAL_STATUSES.has(row.status)) {
    return { state: "terminal", status: row.status as HarnessTerminalStatus };
  }
  if (row.cancellation_requested_at) return { state: "cancelled" };
  return { state: "busy", leaseExpiresAt: row.active_lease_expires_at };
}

/**
 * Terminalize a run that never acquired a lease. This is intentionally
 * narrower than normal terminalization: an owned attempt must go through the
 * attempt-fenced terminal path instead.
 */
export async function terminalizeQueuedHarnessRun(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  identity: AttemptIdentity,
  error: { code: string; message: string },
  status: "failed" | "stopped" = "failed",
): Promise<"terminalized" | "already_terminal"> {
  const now = new Date().toISOString();
  const lifecycleId = crypto.randomUUID();
  const memberSafePayload = stableJson({ code: error.code.slice(0, 120) });
  const errorJson = safeErrorJson(error);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
       SELECT ?6, id, workspace_id, workstream_id, ?4, 'terminal', 'terminal',
              ?9, ?7, ?8
         FROM harness_runs
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id IS NULL AND status IN ('scheduled', 'running')
          AND terminalized_at IS NULL
       ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      identity.attemptId,
      identity.owner,
      lifecycleId,
      memberSafePayload,
      now,
      status,
    ),
    db.prepare(
      `UPDATE harness_runs
          SET attempt_id = ?4, attempt_number = attempt_number + 1,
              status = ?8, completed_at = ?6, terminalized_at = ?6,
              error_json = ?7, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id IS NULL AND status IN ('scheduled', 'running')
          AND terminalized_at IS NULL`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      identity.attemptId,
      identity.owner,
      now,
      status === "failed" ? errorJson : null,
      status,
    ),
    db.prepare(
      `UPDATE workstreams
          SET harness_status = ?6, last_activity_at = ?1, updated_at = ?1
        WHERE id = ?2 AND workspace_id = ?3
          AND EXISTS (
            SELECT 1 FROM harness_runs
             WHERE id = ?4 AND attempt_id = ?5 AND terminalized_at = ?1
          )
          AND NOT EXISTS (
            SELECT 1 FROM harness_runs active
             WHERE active.workspace_id = ?3 AND active.workstream_id = ?2
               AND active.id != ?4 AND active.status = 'running'
               AND active.terminalized_at IS NULL
               AND active.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )`,
    ).bind(
      now,
      input.workstreamId,
      input.workspaceId,
      input.harnessRunId,
      identity.attemptId,
      status === "stopped" ? "idle" : "failed",
    ),
  ]);
  if (d1Changes(results[1]) > 0) return "terminalized";
  const existing = await db.prepare(
    "SELECT attempt_id, status, terminalized_at FROM harness_runs WHERE id = ?",
  ).bind(input.harnessRunId)
    .first<{ attempt_id: string | null; status: string; terminalized_at: string | null }>();
  if (
    existing?.attempt_id === identity.attemptId
    && existing.status === status
    && existing.terminalized_at
  ) {
    return "already_terminal";
  }
  throw new RunOwnershipLostError();
}

export async function persistImmutableRunScope(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  scope: ImmutableRunScope,
): Promise<{ scopeHash: string; reused: boolean }> {
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  const canonicalScope = {
    executionPrincipal: scope.executionPrincipal,
    eligibleConnectionIds: [...new Set(scope.eligibleConnectionIds)].sort(),
    eligibleCapabilities: [...new Set(scope.eligibleCapabilities)].sort(),
    eligibleConnectionCapabilities: Object.fromEntries(
      Object.entries(scope.eligibleConnectionCapabilities)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([connectionId, capabilities]) => [
          connectionId,
          [...new Set(capabilities)].sort(),
        ]),
    ),
    triggerPolicy: scope.triggerPolicy,
    routingPolicyVersion: scope.routingPolicyVersion,
    promptVersion: scope.promptVersion,
    toolSurfaceHash: scope.toolSurfaceHash,
    limits: scope.limits,
  };
  const scopeHash = await sha256Hex(stableJson(canonicalScope));
  const now = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO harness_run_scopes
     (harness_run_id, workspace_id, workstream_id, attempt_id, execution_principal_json,
      eligible_connection_ids_json, eligible_capabilities_json, eligible_connection_capabilities_json,
      trigger_policy_json, routing_policy_version, prompt_version, tool_surface_hash, limits_json,
      scope_hash, created_at)
     SELECT ?1, ?2, ?3, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
       FROM harness_runs
      WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
        AND attempt_id = ?4 AND lease_owner = ?5 AND status = 'running'
        AND terminalized_at IS NULL
        AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     ON CONFLICT(harness_run_id) DO NOTHING`,
  ).bind(
    input.harnessRunId,
    input.workspaceId,
    input.workstreamId,
    lease.attemptId,
    lease.owner,
    stableJson(canonicalScope.executionPrincipal),
    stableJson(canonicalScope.eligibleConnectionIds),
    stableJson(canonicalScope.eligibleCapabilities),
    stableJson(canonicalScope.eligibleConnectionCapabilities),
    stableJson(canonicalScope.triggerPolicy),
    canonicalScope.routingPolicyVersion,
    canonicalScope.promptVersion,
    canonicalScope.toolSurfaceHash,
    stableJson(canonicalScope.limits),
    scopeHash,
    now,
  ).run();
  if (d1Changes(result) > 0) return { scopeHash, reused: false };

  const existing = await db.prepare(
    "SELECT attempt_id, scope_hash FROM harness_run_scopes WHERE harness_run_id = ?",
  ).bind(input.harnessRunId).first<{ attempt_id: string; scope_hash: string }>();
  if (!existing) throw new RunOwnershipLostError();
  if (existing.attempt_id !== lease.attemptId || existing.scope_hash !== scopeHash) {
    throw new Error("immutable_run_scope_mismatch");
  }
  return { scopeHash, reused: true };
}

export async function persistRunPluginActivation(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  plugin: { pluginId: string; toolSurfaceHash: string },
): Promise<void> {
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  const now = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO harness_run_plugin_activations
     (harness_run_id, attempt_id, plugin_id, tool_surface_hash, authorized_at, activated_at)
     SELECT ?1, ?4, ?6, ?7, ?8, ?8
       FROM harness_runs
      WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
        AND attempt_id = ?4 AND lease_owner = ?5 AND status = 'running'
        AND terminalized_at IS NULL
        AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     ON CONFLICT(harness_run_id, plugin_id) DO NOTHING`,
  ).bind(
    input.harnessRunId,
    input.workspaceId,
    input.workstreamId,
    lease.attemptId,
    lease.owner,
    plugin.pluginId,
    plugin.toolSurfaceHash,
    now,
  ).run();
  if (d1Changes(result) > 0) return;
  const existing = await db.prepare(
    `SELECT attempt_id, tool_surface_hash FROM harness_run_plugin_activations
      WHERE harness_run_id = ? AND plugin_id = ?`,
  ).bind(input.harnessRunId, plugin.pluginId)
    .first<{ attempt_id: string; tool_surface_hash: string }>();
  if (!existing) throw new RunOwnershipLostError();
  if (existing.attempt_id !== lease.attemptId || existing.tool_surface_hash !== plugin.toolSurfaceHash) {
    throw new Error("plugin_activation_mismatch");
  }
}

export async function heartbeatHarnessAttempt(
  db: D1Database,
  runId: string,
  lease: AttemptLease,
  leaseSeconds = 60,
): Promise<AttemptLease> {
  const boundedSeconds = Math.max(10, Math.min(300, Math.trunc(leaseSeconds)));
  const result = await db.prepare(
    `UPDATE harness_runs
        SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?4))
      WHERE id = ?1 AND attempt_id = ?2 AND lease_owner = ?3
        AND status = 'running' AND terminalized_at IS NULL
        AND cancellation_requested_at IS NULL
        AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(runId, lease.attemptId, lease.owner, boundedSeconds).run();
  if (d1Changes(result) === 0) {
    const state = await db.prepare(
      "SELECT status, cancellation_requested_at FROM harness_runs WHERE id = ?",
    ).bind(runId).first<{ status: string; cancellation_requested_at: string | null }>();
    if (state?.status === "stopped" || state?.cancellation_requested_at) throw new RunCancelledError();
    throw new RunOwnershipLostError();
  }
  const row = await db.prepare(
    "SELECT lease_expires_at FROM harness_runs WHERE id = ? AND attempt_id = ? AND lease_owner = ?",
  ).bind(runId, lease.attemptId, lease.owner).first<{ lease_expires_at: string }>();
  if (!row) throw new RunOwnershipLostError();
  return { ...lease, leaseExpiresAt: row.lease_expires_at };
}

export async function assertHarnessAttemptOwned(
  db: D1Database,
  runId: string,
  lease: AttemptLease,
): Promise<void> {
  const row = await db.prepare(
    `SELECT status, cancellation_requested_at
       FROM harness_runs
      WHERE id = ?1 AND attempt_id = ?2 AND lease_owner = ?3
        AND terminalized_at IS NULL
        AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(runId, lease.attemptId, lease.owner)
    .first<{ status: string; cancellation_requested_at: string | null }>();
  if (!row) throw new RunOwnershipLostError();
  if (row.status === "stopped" || row.cancellation_requested_at) throw new RunCancelledError();
  if (row.status !== "running") throw new RunOwnershipLostError();
}

export async function persistHarnessFinalMessage(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  message: { id: string; sequenceNumber: number; text: string; createdAt: string },
): Promise<void> {
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  const lifecycleId = crypto.randomUUID();
  const eventPayload = stableJson({ finalMessageId: message.id });
  await db.batch([
    db.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type,
        message_type, text_content, sequence_number, created_at,
        harness_run_id, harness_attempt_id)
       SELECT ?6, ?7, ?2, ?3, 'agent', 'text', ?8, ?9, ?10, ?1, ?4
         FROM harness_runs
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id = ?4 AND lease_owner = ?5 AND status = 'running'
          AND terminalized_at IS NULL AND cancellation_requested_at IS NULL
          AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      lease.attemptId,
      lease.owner,
      message.id,
      `harness:${input.harnessRunId}`,
      message.text,
      message.sequenceNumber,
      message.createdAt,
    ),
    db.prepare(
      `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
       SELECT ?6, run.id, run.workspace_id, run.workstream_id, ?4,
              'final_message', 'final_message_persisted', 'completed', ?8, ?9
         FROM harness_runs run
         JOIN messages message
           ON message.id = ?7
          AND message.workspace_id = run.workspace_id
          AND message.workstream_id = run.workstream_id
          AND message.harness_run_id = run.id
          AND message.harness_attempt_id = run.attempt_id
        WHERE run.id = ?1 AND run.workspace_id = ?2 AND run.workstream_id = ?3
          AND run.attempt_id = ?4 AND run.lease_owner = ?5
          AND run.status = 'running' AND run.terminalized_at IS NULL
          AND run.cancellation_requested_at IS NULL
          AND run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      lease.attemptId,
      lease.owner,
      lifecycleId,
      message.id,
      eventPayload,
      message.createdAt,
    ),
  ]);
  const persisted = await db.prepare(
    `SELECT message.id
       FROM messages message
       JOIN harness_run_lifecycle_events lifecycle
         ON lifecycle.harness_run_id = message.harness_run_id
        AND lifecycle.event_key = 'final_message'
        AND lifecycle.event_type = 'final_message_persisted'
      WHERE message.id = ?1 AND message.workspace_id = ?2
        AND message.workstream_id = ?3 AND message.harness_run_id = ?4`,
  ).bind(
    message.id,
    input.workspaceId,
    input.workstreamId,
    input.harnessRunId,
  ).first<{ id: string }>();
  if (!persisted) throw new RunOwnershipLostError();
}

export async function persistToolExecutionPlan(
  db: D1Database,
  lease: AttemptLease,
  plan: ToolExecutionPlan,
): Promise<ToolPlanClaim> {
  await assertHarnessAttemptOwned(db, plan.harnessRunId, lease);
  const invocationId = plan.invocationId ?? crypto.randomUUID();
  const executionPlanJson = stableJson(plan.plan);
  const executionPlanHash = await sha256Hex(executionPlanJson);
  const now = new Date().toISOString();
  const checkpointId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO tool_invocations
       (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
        connection_id, input_hash, input_json, status, started_at, attempt_id,
        execution_plan_hash, execution_plan_json, provider_idempotency_key,
        lease_expires_at, checkpoint_index, last_checkpoint_at)
       SELECT ?6, ?2, ?3, ?1, ?7, ?8, ?9, ?10, ?11, 'started', ?12, ?4,
              ?13, ?14, ?15, lease_expires_at, 0, ?12
         FROM harness_runs
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id = ?4 AND lease_owner = ?5 AND status = 'running'
          AND cancellation_requested_at IS NULL AND terminalized_at IS NULL
          AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(harness_run_id, tool_call_id) DO NOTHING`,
    ).bind(
      plan.harnessRunId,
      plan.workspaceId,
      plan.workstreamId,
      lease.attemptId,
      lease.owner,
      invocationId,
      plan.toolCallId,
      plan.toolName,
      plan.connectionId ?? null,
      plan.inputHash,
      stableJson(plan.input),
      now,
      executionPlanHash,
      executionPlanJson,
      plan.providerIdempotencyKey ?? null,
    ),
    db.prepare(
      `INSERT INTO tool_invocation_checkpoints
       (id, tool_invocation_id, harness_run_id, attempt_id, checkpoint_index,
        phase, member_safe_payload_json, created_at)
       SELECT ?1, id, harness_run_id, ?3, 0, 'execution_planned', '{}', ?4
         FROM tool_invocations
        WHERE id = ?2 AND attempt_id = ?3
       ON CONFLICT(tool_invocation_id, checkpoint_index) DO NOTHING`,
    ).bind(checkpointId, invocationId, lease.attemptId, now),
  ]);
  if (d1Changes(results[0]) > 0) return { state: "created", invocationId, executionPlanHash };

  const existing = await db.prepare(
    `SELECT id, attempt_id, input_hash, execution_plan_hash, status
       FROM tool_invocations
      WHERE harness_run_id = ? AND tool_call_id = ?`,
  ).bind(plan.harnessRunId, plan.toolCallId)
    .first<{
      id: string;
      attempt_id: string | null;
      input_hash: string;
      execution_plan_hash: string | null;
      status: string;
    }>();
  if (!existing) throw new RunOwnershipLostError();
  await assertHarnessAttemptOwned(db, plan.harnessRunId, lease);
  if (existing.attempt_id !== lease.attemptId) {
    return { state: "ambiguous_external_write", invocationId: existing.id, executionPlanHash };
  }
  if (
    existing.input_hash !== plan.inputHash
    || existing.execution_plan_hash !== executionPlanHash
  ) {
    if (existing.status !== "completed" && existing.status !== "ambiguous") {
      await finalizeToolInvocationFailure(db, lease, {
        harnessRunId: plan.harnessRunId,
        invocationId: existing.id,
        status: "ambiguous",
        phase: "ambiguous_external_write",
        error: {
          code: "ambiguous_external_write",
          message: "A tool-call receipt was reused with a different immutable execution plan",
        },
        memberSafePayload: { code: "ambiguous_external_write" },
      });
    }
    return { state: "ambiguous_external_write", invocationId: existing.id, executionPlanHash };
  }
  if (existing.status === "completed") {
    return { state: "replay_completed", invocationId: existing.id, executionPlanHash };
  }
  if (plan.mode === "write") {
    if (existing.status !== "ambiguous") {
      await finalizeToolInvocationFailure(db, lease, {
        harnessRunId: plan.harnessRunId,
        invocationId: existing.id,
        status: "ambiguous",
        phase: "ambiguous_external_write",
        error: {
          code: "ambiguous_external_write",
          message: "A prior write may have reached the provider",
        },
        memberSafePayload: { code: "ambiguous_external_write" },
      });
    }
    return { state: "ambiguous_external_write", invocationId: existing.id, executionPlanHash };
  }
  return { state: "resume_read", invocationId: existing.id, executionPlanHash };
}

export async function checkpointToolInvocation(
  db: D1Database,
  lease: AttemptLease,
  input: {
    harnessRunId: string;
    invocationId: string;
    checkpointIndex: number;
    phase: string;
    memberSafePayload?: Record<string, unknown>;
  },
): Promise<void> {
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  const now = new Date().toISOString();
  const checkpointId = crypto.randomUUID();
  const index = Math.max(1, Math.trunc(input.checkpointIndex));
  const results = await db.batch([
    db.prepare(
      `INSERT INTO tool_invocation_checkpoints
       (id, tool_invocation_id, harness_run_id, attempt_id, checkpoint_index,
        phase, member_safe_payload_json, created_at)
       SELECT ?1, ti.id, ti.harness_run_id, ?4, ?5, ?6, ?7, ?8
         FROM tool_invocations ti
         JOIN harness_runs hr ON hr.id = ti.harness_run_id
        WHERE ti.id = ?2 AND ti.harness_run_id = ?3 AND ti.attempt_id = ?4
          AND hr.attempt_id = ?4 AND hr.lease_owner = ?9 AND hr.status = 'running'
          AND hr.cancellation_requested_at IS NULL AND hr.terminalized_at IS NULL
          AND hr.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(tool_invocation_id, checkpoint_index) DO NOTHING`,
    ).bind(
      checkpointId,
      input.invocationId,
      input.harnessRunId,
      lease.attemptId,
      index,
      input.phase.slice(0, 120),
      stableJson(input.memberSafePayload ?? {}),
      now,
      lease.owner,
    ),
    db.prepare(
      `UPDATE tool_invocations
          SET checkpoint_index = ?1, last_checkpoint_at = ?2
        WHERE id = ?3 AND harness_run_id = ?4 AND attempt_id = ?5
          AND checkpoint_index < ?1
          AND EXISTS (
            SELECT 1 FROM harness_runs
             WHERE id = ?4 AND attempt_id = ?5 AND lease_owner = ?6
               AND status = 'running' AND cancellation_requested_at IS NULL
               AND terminalized_at IS NULL
               AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )`,
    ).bind(index, now, input.invocationId, input.harnessRunId, lease.attemptId, lease.owner),
  ]);
  if (d1Changes(results[0]) === 0 && d1Changes(results[1]) === 0) {
    const existing = await db.prepare(
      `SELECT ti.checkpoint_index
         FROM tool_invocations ti
         JOIN harness_runs hr ON hr.id = ti.harness_run_id
        WHERE ti.id = ?1 AND ti.attempt_id = ?2
          AND hr.attempt_id = ?2 AND hr.lease_owner = ?3 AND hr.status = 'running'
          AND hr.cancellation_requested_at IS NULL AND hr.terminalized_at IS NULL
          AND hr.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(input.invocationId, lease.attemptId, lease.owner).first<{ checkpoint_index: number }>();
    if (!existing || existing.checkpoint_index < index) throw new RunOwnershipLostError();
  }
}

/**
 * Commit a successful provider result before it is returned to Bind. The
 * caller must durably store the bounded replay payload first and pass its
 * reference here; the transaction then makes the result replayable and adds
 * an immutable checkpoint under the live attempt lease.
 */
export async function completeToolInvocation(
  db: D1Database,
  lease: AttemptLease,
  input: {
    harnessRunId: string;
    invocationId: string;
    checkpointIndex: number;
    outputRef: string;
    outputSummary: string;
    providerOperationId?: string;
    memberSafePayload?: Record<string, unknown>;
  },
): Promise<"persisted" | "already_persisted"> {
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  const now = new Date().toISOString();
  const checkpointId = crypto.randomUUID();
  const index = Math.max(1, Math.trunc(input.checkpointIndex));
  const boundedSummary = input.outputSummary.slice(0, 4_000);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO tool_invocation_checkpoints
       (id, tool_invocation_id, harness_run_id, attempt_id, checkpoint_index,
        phase, member_safe_payload_json, created_at)
       SELECT ?1, ti.id, ti.harness_run_id, ?4, ?5, 'result_persisted', ?6, ?7
         FROM tool_invocations ti
         JOIN harness_runs hr ON hr.id = ti.harness_run_id
        WHERE ti.id = ?2 AND ti.harness_run_id = ?3 AND ti.attempt_id = ?4
          AND ti.status IN ('pending', 'started')
          AND hr.attempt_id = ?4 AND hr.lease_owner = ?8 AND hr.status = 'running'
          AND hr.cancellation_requested_at IS NULL AND hr.terminalized_at IS NULL
          AND hr.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(tool_invocation_id, checkpoint_index) DO NOTHING`,
    ).bind(
      checkpointId,
      input.invocationId,
      input.harnessRunId,
      lease.attemptId,
      index,
      stableJson(input.memberSafePayload ?? {}),
      now,
      lease.owner,
    ),
    db.prepare(
      `UPDATE tool_invocations
          SET status = 'completed', output_ref = ?1, output_summary = ?2,
              provider_operation_id = ?3, completed_at = ?4,
              checkpoint_index = ?5, last_checkpoint_at = ?4,
              lease_expires_at = NULL, error_json = NULL
        WHERE id = ?6 AND harness_run_id = ?7 AND attempt_id = ?8
          AND status IN ('pending', 'started')
          AND EXISTS (
            SELECT 1 FROM harness_runs
             WHERE id = ?7 AND attempt_id = ?8 AND lease_owner = ?9
               AND status = 'running' AND cancellation_requested_at IS NULL
               AND terminalized_at IS NULL
               AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
          AND EXISTS (
            SELECT 1 FROM tool_invocation_checkpoints
             WHERE id = ?10 AND tool_invocation_id = ?6
               AND attempt_id = ?8 AND checkpoint_index = ?5
          )`,
    ).bind(
      input.outputRef,
      boundedSummary,
      input.providerOperationId ?? null,
      now,
      index,
      input.invocationId,
      input.harnessRunId,
      lease.attemptId,
      lease.owner,
      checkpointId,
    ),
  ]);
  if (d1Changes(results[1]) > 0) return "persisted";
  const existing = await db.prepare(
    `SELECT ti.status, ti.output_ref, ti.output_summary, ti.provider_operation_id
       FROM tool_invocations ti
       JOIN harness_runs hr ON hr.id = ti.harness_run_id
      WHERE ti.id = ?1 AND ti.harness_run_id = ?2 AND ti.attempt_id = ?3
        AND hr.attempt_id = ?3 AND hr.lease_owner = ?4 AND hr.status = 'running'
        AND hr.cancellation_requested_at IS NULL AND hr.terminalized_at IS NULL
        AND hr.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(input.invocationId, input.harnessRunId, lease.attemptId, lease.owner)
    .first<{
      status: string;
      output_ref: string | null;
      output_summary: string | null;
      provider_operation_id: string | null;
    }>();
  if (
    existing?.status === "completed"
    && existing.output_ref === input.outputRef
    && existing.output_summary === boundedSummary
    && existing.provider_operation_id === (input.providerOperationId ?? null)
  ) {
    return "already_persisted";
  }
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  throw new RunOwnershipLostError();
}

/**
 * Atomically make a failed or ambiguous tool receipt terminal. Every caller
 * goes through the same attempt/owner fence; the appended checkpoint and the
 * terminal mutation commit together or neither commits.
 */
export async function finalizeToolInvocationFailure(
  db: D1Database,
  lease: AttemptLease,
  input: ToolInvocationFailure,
): Promise<"persisted" | "already_persisted"> {
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  const now = new Date().toISOString();
  const checkpointId = crypto.randomUUID();
  const phase = input.phase.slice(0, 120);
  const code = input.error.code.slice(0, 120);
  const message = input.error.message.slice(0, 500);
  const errorJson = JSON.stringify({ code, message });
  const mutableStatuses = input.status === "ambiguous"
    ? "('pending', 'started', 'failed')"
    : "('pending', 'started')";
  const results = await db.batch([
    db.prepare(
      `INSERT INTO tool_invocation_checkpoints
       (id, tool_invocation_id, harness_run_id, attempt_id, checkpoint_index,
        phase, member_safe_payload_json, created_at)
       SELECT ?1, ti.id, ti.harness_run_id, ?4, ti.checkpoint_index + 1, ?5, ?6, ?7
         FROM tool_invocations ti
         JOIN harness_runs hr ON hr.id = ti.harness_run_id
        WHERE ti.id = ?2 AND ti.harness_run_id = ?3 AND ti.attempt_id = ?4
          AND ti.status IN ${mutableStatuses}
          AND hr.attempt_id = ?4 AND hr.lease_owner = ?8 AND hr.status = 'running'
          AND hr.cancellation_requested_at IS NULL AND hr.terminalized_at IS NULL
          AND hr.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(tool_invocation_id, checkpoint_index) DO NOTHING`,
    ).bind(
      checkpointId,
      input.invocationId,
      input.harnessRunId,
      lease.attemptId,
      phase,
      stableJson(input.memberSafePayload ?? { code }),
      now,
      lease.owner,
    ),
    db.prepare(
      `UPDATE tool_invocations
          SET status = ?1, completed_at = ?2, error_json = ?3,
              checkpoint_index = (
                SELECT checkpoint_index FROM tool_invocation_checkpoints WHERE id = ?8
              ),
              last_checkpoint_at = ?2, lease_expires_at = NULL
        WHERE id = ?4 AND harness_run_id = ?5 AND attempt_id = ?6
          AND status IN ${mutableStatuses}
          AND EXISTS (
            SELECT 1 FROM harness_runs
             WHERE id = ?5 AND attempt_id = ?6 AND lease_owner = ?7
               AND status = 'running' AND cancellation_requested_at IS NULL
               AND terminalized_at IS NULL
               AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
          AND EXISTS (
            SELECT 1 FROM tool_invocation_checkpoints
             WHERE id = ?8 AND tool_invocation_id = ?4 AND attempt_id = ?6
          )`,
    ).bind(
      input.status,
      now,
      errorJson,
      input.invocationId,
      input.harnessRunId,
      lease.attemptId,
      lease.owner,
      checkpointId,
    ),
  ]);
  if (d1Changes(results[1]) > 0) return "persisted";

  const existing = await db.prepare(
    `SELECT ti.status, ti.error_json
       FROM tool_invocations ti
       JOIN harness_runs hr ON hr.id = ti.harness_run_id
      WHERE ti.id = ?1 AND ti.harness_run_id = ?2 AND ti.attempt_id = ?3
        AND hr.attempt_id = ?3 AND hr.lease_owner = ?4 AND hr.status = 'running'
        AND hr.cancellation_requested_at IS NULL AND hr.terminalized_at IS NULL
        AND hr.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(input.invocationId, input.harnessRunId, lease.attemptId, lease.owner)
    .first<{ status: string; error_json: string | null }>();
  if (existing?.status === input.status && existing.error_json === errorJson) {
    return "already_persisted";
  }
  await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  throw new RunOwnershipLostError();
}

export async function markToolInvocationTimedOut(
  db: D1Database,
  lease: AttemptLease,
  input: { harnessRunId: string; invocationId: string; mayHaveWritten: boolean },
): Promise<"failed" | "ambiguous"> {
  const status = input.mayHaveWritten ? "ambiguous" : "failed";
  const code = input.mayHaveWritten ? "ambiguous_external_write" : "tool_timeout";
  await finalizeToolInvocationFailure(db, lease, {
    harnessRunId: input.harnessRunId,
    invocationId: input.invocationId,
    status,
    phase: input.mayHaveWritten ? "ambiguous_external_write" : "timed_out",
    error: { code, message: input.mayHaveWritten
      ? "The provider outcome is unknown and the write will not be repeated"
      : "The tool request timed out before producing a result" },
    memberSafePayload: { code },
  });
  return status;
}

export class CoalescedRunLiveness {
  readonly controller = new AbortController();
  private inFlight: Promise<void> | null = null;
  private nextHeartbeatAt = 0;
  private currentLease: AttemptLease;

  constructor(
    private readonly db: D1Database,
    private readonly runId: string,
    lease: AttemptLease,
    private readonly options: { leaseSeconds?: number; minimumIntervalMs?: number } = {},
  ) {
    this.currentLease = lease;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get lease(): AttemptLease {
    return this.currentLease;
  }

  async pulse(_stage: string, force = false): Promise<void> {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (!force && Date.now() < this.nextHeartbeatAt) return;
    if (!this.inFlight) {
      this.inFlight = (async () => {
        try {
          this.currentLease = await heartbeatHarnessAttempt(
            this.db,
            this.runId,
            this.currentLease,
            this.options.leaseSeconds ?? 60,
          );
          this.nextHeartbeatAt = Date.now() + (this.options.minimumIntervalMs ?? 5_000);
        } catch (error) {
          this.controller.abort(error);
          throw error;
        } finally {
          this.inFlight = null;
        }
      })();
    }
    await this.inFlight;
  }

  startMonitor(intervalMs = 5_000): { stop: () => Promise<void> } {
    const monitorController = new AbortController();
    const delay = Math.max(1_000, Math.trunc(intervalMs));
    const done = (async () => {
      while (!monitorController.signal.aborted && !this.controller.signal.aborted) {
        try {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            monitorController.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          if (monitorController.signal.aborted || this.controller.signal.aborted) break;
          await this.pulse("lease_monitor", true);
        } catch {
          // pulse() aborts the shared liveness signal with the durable reason.
          // The harness observes that signal; the monitor must not create an
          // unhandled rejection alongside the authoritative run failure.
          break;
        }
      }
    })();
    return {
      stop: async () => {
        monitorController.abort();
        await done;
      },
    };
  }
}

export async function terminalizeHarnessAttempt(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  outcome: TerminalOutcome,
): Promise<"terminalized" | "already_terminal"> {
  if (outcome.status === "completed") {
    if (!outcome.finalMessageId) throw new Error("final_message_required");
    const finalMessage = await db.prepare(
      `SELECT message.id
         FROM messages message
         JOIN harness_run_lifecycle_events lifecycle
           ON lifecycle.harness_run_id = ?4
          AND lifecycle.event_key = 'final_message'
          AND lifecycle.event_type = 'final_message_persisted'
        WHERE message.id = ?1 AND message.workspace_id = ?2
          AND message.workstream_id = ?3 AND message.harness_run_id = ?4
          AND message.author_type = 'agent' AND message.message_type = 'text'`,
    ).bind(
      outcome.finalMessageId,
      input.workspaceId,
      input.workstreamId,
      input.harnessRunId,
    ).first<{ id: string }>();
    if (!finalMessage) throw new Error("final_message_not_persisted");
  }
  const now = new Date().toISOString();
  const lifecycleId = crypto.randomUUID();
  const payload = stableJson(outcome.memberSafePayload ?? {});
  const workstreamStatus = outcome.status === "stopped" ? "idle" : outcome.status;
  const results = await db.batch([
    db.prepare(
      `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
       SELECT ?6, id, workspace_id, workstream_id, ?4, 'terminal', 'terminal', ?7, ?8, ?9
         FROM harness_runs
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id = ?4 AND lease_owner = ?5 AND terminalized_at IS NULL
          AND (?7 = 'stopped' OR cancellation_requested_at IS NULL)
          AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      lease.attemptId,
      lease.owner,
      lifecycleId,
      outcome.status,
      payload,
      now,
    ),
    db.prepare(
      `UPDATE harness_runs
          SET status = ?6, completed_at = ?7, final_message_id = ?8,
              model = COALESCE(?9, model), usage_json = COALESCE(?10, usage_json),
              error_json = ?11, terminalized_at = ?7,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND attempt_id = ?4 AND lease_owner = ?5 AND terminalized_at IS NULL
          AND (?6 = 'stopped' OR cancellation_requested_at IS NULL)
          AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(
      input.harnessRunId,
      input.workspaceId,
      input.workstreamId,
      lease.attemptId,
      lease.owner,
      outcome.status,
      now,
      outcome.finalMessageId ?? null,
      outcome.model ?? null,
      outcome.usage ? stableJson(outcome.usage) : null,
      safeErrorJson(outcome.error),
    ),
    db.prepare(
      `UPDATE workstreams
          SET harness_status = ?1, last_activity_at = ?2, updated_at = ?2
        WHERE id = ?3 AND workspace_id = ?4
          AND EXISTS (
            SELECT 1 FROM harness_runs
             WHERE id = ?5 AND attempt_id = ?6 AND terminalized_at = ?2
          )`,
    ).bind(
      workstreamStatus,
      now,
      input.workstreamId,
      input.workspaceId,
      input.harnessRunId,
      lease.attemptId,
    ),
  ]);
  if (d1Changes(results[1]) > 0) return "terminalized";
  const existing = await db.prepare(
    "SELECT attempt_id, status, terminalized_at FROM harness_runs WHERE id = ?",
  ).bind(input.harnessRunId).first<{ attempt_id: string | null; status: string; terminalized_at: string | null }>();
  if (existing?.attempt_id === lease.attemptId && existing.terminalized_at && existing.status === outcome.status) {
    return "already_terminal";
  }
  throw new RunOwnershipLostError();
}

export async function recordInferenceAttempt(
  db: D1Database,
  record: InferenceAttemptRecord,
): Promise<string> {
  const id = record.id ?? crypto.randomUUID();
  await db.prepare(
    `INSERT INTO inference_attempts
     (id, harness_run_id, workspace_id, workstream_id, attempt_id, turn_id,
      endpoint_attempt, fallback_attempt, provider, model, credential_source_hash,
      workspace_identity_hash, routing_decision_json, outcome, failure_classification,
      latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
      cost_microusd, response_bytes, started_at, completed_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
             ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?25)`,
  ).bind(
    id,
    record.harnessRunId,
    record.workspaceId,
    record.workstreamId,
    record.attemptId,
    record.turnId,
    record.endpointAttempt,
    record.fallbackAttempt,
    record.provider,
    record.model,
    record.credentialSourceHash ?? null,
    record.workspaceIdentityHash,
    stableJson(record.routingDecision ?? {}),
    record.outcome,
    record.failureClassification ?? null,
    record.latencyMs ?? null,
    record.ttftMs ?? null,
    record.inputTokens ?? null,
    record.outputTokens ?? null,
    record.reasoningTokens ?? null,
    record.cachedTokens ?? null,
    record.costMicrousd ?? null,
    record.responseBytes ?? null,
    record.startedAt,
    record.completedAt,
  ).run();
  return id;
}

export async function reapStaleHarnessRuns(
  db: D1Database,
  options: { workspaceId?: string; workstreamId?: string; limit?: number } = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const rows = await db.prepare(
    `SELECT id, workspace_id, workstream_id, attempt_id, lease_expires_at
       FROM harness_runs
      WHERE status = 'running' AND terminalized_at IS NULL
        AND attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND (?1 IS NULL OR workspace_id = ?1)
        AND (?2 IS NULL OR workstream_id = ?2)
      ORDER BY lease_expires_at ASC
      LIMIT ?3`,
  ).bind(options.workspaceId ?? null, options.workstreamId ?? null, limit)
    .all<{
      id: string;
      workspace_id: string;
      workstream_id: string;
      attempt_id: string;
      lease_expires_at: string;
    }>();
  const reaped: string[] = [];
  for (const row of rows.results ?? []) {
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare(
        `INSERT INTO harness_run_lifecycle_events
         (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
          event_type, status, member_safe_payload_json, created_at)
         SELECT ?1, id, workspace_id, workstream_id, ?3, 'terminal', 'terminal', 'failed',
                '{"code":"stale_run_reaped"}', ?5
           FROM harness_runs
          WHERE id = ?2 AND attempt_id = ?3 AND lease_expires_at = ?4
            AND status = 'running' AND terminalized_at IS NULL
         ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
      ).bind(eventId, row.id, row.attempt_id, row.lease_expires_at, now),
      db.prepare(
        `UPDATE harness_runs
            SET status = 'failed', completed_at = ?4, terminalized_at = ?4,
                error_json = '{"code":"stale_run_reaped","message":"The prior executor lost its durable lease"}',
                lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ?1 AND attempt_id = ?2 AND lease_expires_at = ?3
            AND status = 'running' AND terminalized_at IS NULL`,
      ).bind(row.id, row.attempt_id, row.lease_expires_at, now),
      db.prepare(
        `UPDATE workstreams SET harness_status = 'failed', updated_at = ?1
          WHERE id = ?2 AND workspace_id = ?3
            AND EXISTS (SELECT 1 FROM harness_runs WHERE id = ?4 AND terminalized_at = ?1)
            AND NOT EXISTS (
              SELECT 1 FROM harness_runs active
               WHERE active.workspace_id = ?3 AND active.workstream_id = ?2
                 AND active.id != ?4 AND active.status = 'running'
                 AND active.terminalized_at IS NULL
                 AND active.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )`,
      ).bind(now, row.workstream_id, row.workspace_id, row.id),
      db.prepare(
        `UPDATE automation_runs
            SET status = 'failed', completed_at = ?1,
                result_summary = COALESCE(
                  result_summary,
                  'The harness executor lost its durable lease'
                )
          WHERE workstream_id = ?2 AND workspace_id = ?3
            AND status IN ('scheduled', 'running', 'needs_input')
            AND EXISTS (
              SELECT 1 FROM harness_runs
               WHERE id = ?4 AND workstream_id = ?2 AND workspace_id = ?3
                 AND terminalized_at = ?1 AND status = 'failed'
            )`,
      ).bind(now, row.workstream_id, row.workspace_id, row.id),
    ]);
    if (d1Changes(results[1]) > 0) reaped.push(row.id);
  }
  return reaped;
}
