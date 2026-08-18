import type { StructuredFailureDetail, WorkstreamWorkflowInput } from "@avalon/contracts";

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

export type HarnessRunCoordinates = Pick<
  WorkstreamWorkflowInput,
  "workspaceId" | "workstreamId" | "harnessRunId"
>;

export interface InlineChildResult {
  status: "completed" | "failed" | "stopped";
  result?: unknown;
  error?: { code: string; message: string };
  model?: string;
  usage?: Record<string, unknown>;
}

export type InlineChildResultLookup =
  | { state: "missing" }
  | { state: "running"; childInput: HarnessRunCoordinates; leaseExpiresAt: string | null }
  | { state: "replay"; childInput: HarnessRunCoordinates; outcome: InlineChildResult };

export type InlineChildAdmission =
  | {
      state: "claimed";
      childInput: HarnessRunCoordinates;
      lease: AttemptLease;
      chainRootRunId: string;
      chainDepth: number;
      reused: boolean;
    }
  | { state: "replay"; childInput: HarnessRunCoordinates; outcome: InlineChildResult }
  | { state: "busy"; childInput: HarnessRunCoordinates; leaseExpiresAt: string | null }
  | {
      state: "refused";
      reason: "chain_budget_exhausted" | "workspace_child_capacity" | "depth_limit";
    };

export interface AdmitInlineChildOptions extends Partial<AttemptIdentity> {
  parentToolCallId: string;
  objective: string;
  childHarnessRunId?: string;
  maxChainRuns?: number;
  maxActiveWorkspaceChildren?: number;
  maxDepth?: number;
  leaseSeconds?: number;
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
  memoryContextHash?: string | null;
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

export interface PersistedHarnessHostOutcome {
  messageId: string;
  status: HarnessTerminalStatus;
  error?: { code: string; message: string };
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
  /** Exact historical plans accepted only when fencing a pre-existing receipt. */
  compatiblePriorPlans?: Record<string, unknown>[];
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
  error: { code: string; message: string; data?: StructuredFailureDetail };
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

function parseInlineChildResult(value: string | null): InlineChildResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<InlineChildResult>;
    if (
      parsed.status !== "completed"
      && parsed.status !== "failed"
      && parsed.status !== "stopped"
    ) return null;
    return {
      status: parsed.status,
      ...(Object.hasOwn(parsed, "result") ? { result: parsed.result } : {}),
      ...(parsed.error && typeof parsed.error.code === "string" && typeof parsed.error.message === "string"
        ? { error: { code: parsed.error.code, message: parsed.error.message } }
        : {}),
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
      ...(parsed.usage && typeof parsed.usage === "object" ? { usage: parsed.usage } : {}),
    };
  } catch {
    return null;
  }
}

async function parseVerifiedInlineChildResult(
  value: string | null,
  expectedHash: string | null,
): Promise<InlineChildResult | null> {
  if (!value || !expectedHash) return null;
  if (await sha256Hex(value) !== expectedHash) {
    throw new Error("inline_child_result_hash_mismatch");
  }
  return parseInlineChildResult(value);
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
          AND parent_tool_call_id IS NULL
          AND status IN ('scheduled', 'running')
          AND terminalized_at IS NULL
          AND cancellation_requested_at IS NULL
          AND (
            attempt_id IS NULL
            OR (attempt_id = ?4 AND lease_owner = ?5)
            OR lease_expires_at IS NULL
            OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
          AND (
            harness_runs.origin = 'block_dashboard_block'
            OR NOT EXISTS (
              SELECT 1
                FROM harness_runs active
               WHERE active.workspace_id = ?2
                 AND active.workstream_id = ?3
                 AND active.id != ?1
                 AND active.origin != 'block_dashboard_block'
                 AND active.parent_tool_call_id IS NULL
                 AND active.status = 'running'
                 AND active.terminalized_at IS NULL
                 AND active.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
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
          AND parent_tool_call_id IS NULL
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
               AND origin != 'block_dashboard_block'
               AND parent_tool_call_id IS NULL
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
                AND (harness_runs.origin = 'block_dashboard_block' OR active.origin != 'block_dashboard_block')
                AND active.parent_tool_call_id IS NULL
                AND active.status = 'running' AND active.terminalized_at IS NULL)
              AS active_lease_expires_at
      FROM harness_runs
      WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
        AND parent_tool_call_id IS NULL`,
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
 * Admit an inline child run without entering the ordinary workstream queue.
 *
 * The conditional INSERT is the capacity reservation: D1 serializes the
 * statement, so concurrent children cannot both observe the last available
 * chain/workspace slot. The parent tool-call ID is the durable idempotency key.
 * Only a hash of the delegated objective is persisted.
 */
export async function admitInlineChildAttempt(
  db: D1Database,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  options: AdmitInlineChildOptions,
): Promise<InlineChildAdmission> {
  if (!options.parentToolCallId.trim()) throw new Error("parent_tool_call_id_required");
  if (!options.objective.trim()) throw new Error("child_objective_required");
  const maxChainRuns = Math.max(2, Math.min(64, Math.trunc(options.maxChainRuns ?? 4)));
  const maxActiveWorkspaceChildren = Math.max(
    1,
    Math.min(64, Math.trunc(options.maxActiveWorkspaceChildren ?? 8)),
  );
  const maxDepth = Math.max(1, Math.min(16, Math.trunc(options.maxDepth ?? 2)));
  const leaseSeconds = Math.max(10, Math.min(300, Math.trunc(options.leaseSeconds ?? 60)));
  const childHarnessRunId = options.childHarnessRunId ?? crypto.randomUUID();
  const attemptId = options.attemptId ?? crypto.randomUUID();
  const owner = options.owner ?? `inline-child:${childHarnessRunId}:${attemptId}`;
  const objectiveHash = await sha256Hex(options.objective);
  const lifecycleId = crypto.randomUUID();
  const now = new Date().toISOString();

  // This early assertion gives callers a precise cancellation/ownership error.
  // The INSERT repeats the complete fence, so losing ownership between the
  // assertion and the write cannot admit a child.
  await assertHarnessAttemptOwned(db, parentInput.harnessRunId, parentLease);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json,
        parent_harness_run_id, status, started_at, created_at, attempt_id,
        attempt_number, lease_owner, lease_expires_at, heartbeat_at,
        parent_tool_call_id, chain_root_harness_run_id, chain_depth,
        delegated_task_hash, inherited_scope_hash)
       SELECT ?6, parent.workspace_id, parent.workstream_id, 'sub_agent',
              parent.execution_principal_json, parent.id, 'running', ?12, ?12,
              ?7, 1, ?8,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?9)),
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?10,
              COALESCE(parent.chain_root_harness_run_id, parent.id),
              parent.chain_depth + 1, ?11, parent_scope.scope_hash
         FROM harness_runs parent
         JOIN harness_run_scopes parent_scope ON parent_scope.harness_run_id = parent.id
        WHERE parent.id = ?1 AND parent.workspace_id = ?2 AND parent.workstream_id = ?3
          AND parent.attempt_id = ?4 AND parent.lease_owner = ?5
          AND parent.status = 'running' AND parent.terminalized_at IS NULL
          AND parent.cancellation_requested_at IS NULL
          AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND parent.chain_depth + 1 <= ?13
          AND (
            SELECT COUNT(*) FROM harness_runs chain_run
             WHERE chain_run.id = COALESCE(parent.chain_root_harness_run_id, parent.id)
                OR (
                  chain_run.chain_root_harness_run_id = COALESCE(parent.chain_root_harness_run_id, parent.id)
                  AND chain_run.parent_tool_call_id IS NOT NULL
                )
          ) < ?14
          AND (
            SELECT COUNT(*) FROM harness_runs active_child
             WHERE active_child.workspace_id = parent.workspace_id
               AND active_child.parent_tool_call_id IS NOT NULL
               AND active_child.status = 'running'
               AND active_child.terminalized_at IS NULL
               AND active_child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ) < ?15
       ON CONFLICT DO NOTHING`,
    ).bind(
      parentInput.harnessRunId,
      parentInput.workspaceId,
      parentInput.workstreamId,
      parentLease.attemptId,
      parentLease.owner,
      childHarnessRunId,
      attemptId,
      owner,
      leaseSeconds,
      options.parentToolCallId,
      objectiveHash,
      now,
      maxDepth,
      maxChainRuns,
      maxActiveWorkspaceChildren,
    ),
    db.prepare(
      `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
       SELECT ?1, child.id, child.workspace_id, child.workstream_id, child.attempt_id,
              'admitted', 'child_admitted', 'running',
              json_object('parentHarnessRunId', child.parent_harness_run_id,
                          'chainDepth', child.chain_depth), ?3
         FROM harness_runs child
        WHERE child.id = ?2 AND child.parent_harness_run_id = ?4
          AND child.parent_tool_call_id = ?5 AND child.attempt_id = ?6
       ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
    ).bind(
      lifecycleId,
      childHarnessRunId,
      now,
      parentInput.harnessRunId,
      options.parentToolCallId,
      attemptId,
    ),
  ]);

  if (d1Changes(results[0]) > 0) {
    const inserted = await db.prepare(
      `SELECT lease_expires_at, chain_root_harness_run_id, chain_depth
         FROM harness_runs
        WHERE id = ?1 AND attempt_id = ?2 AND lease_owner = ?3`,
    ).bind(childHarnessRunId, attemptId, owner)
      .first<{
        lease_expires_at: string;
        chain_root_harness_run_id: string;
        chain_depth: number;
      }>();
    if (!inserted) throw new RunOwnershipLostError();
    return {
      state: "claimed",
      childInput: {
        workspaceId: parentInput.workspaceId,
        workstreamId: parentInput.workstreamId,
        harnessRunId: childHarnessRunId,
      },
      lease: {
        attemptId,
        owner,
        attemptNumber: 1,
        leaseExpiresAt: inserted.lease_expires_at,
      },
      chainRootRunId: inserted.chain_root_harness_run_id,
      chainDepth: Number(inserted.chain_depth),
      reused: false,
    };
  }

  const existing = await db.prepare(
    `SELECT id, workspace_id, workstream_id, status, attempt_id, attempt_number,
            lease_owner, lease_expires_at, terminalized_at, delegated_task_hash,
            child_result_json, child_result_hash, chain_root_harness_run_id, chain_depth
       FROM harness_runs
      WHERE parent_harness_run_id = ?1 AND parent_tool_call_id = ?2`,
  ).bind(parentInput.harnessRunId, options.parentToolCallId)
    .first<{
      id: string;
      workspace_id: string;
      workstream_id: string;
      status: string;
      attempt_id: string | null;
      attempt_number: number;
      lease_owner: string | null;
      lease_expires_at: string | null;
      terminalized_at: string | null;
      delegated_task_hash: string | null;
      child_result_json: string | null;
      child_result_hash: string | null;
      chain_root_harness_run_id: string;
      chain_depth: number;
    }>();

  if (existing) {
    if (existing.delegated_task_hash !== objectiveHash) {
      throw new Error("inline_child_objective_mismatch");
    }
    const childInput = {
      workspaceId: existing.workspace_id,
      workstreamId: existing.workstream_id,
      harnessRunId: existing.id,
    };
    if (existing.terminalized_at || TERMINAL_STATUSES.has(existing.status)) {
      const outcome = await parseVerifiedInlineChildResult(
        existing.child_result_json,
        existing.child_result_hash,
      );
      if (!outcome) throw new Error("inline_child_terminal_result_missing");
      return { state: "replay", childInput, outcome };
    }
    if (
      existing.lease_expires_at
      && existing.lease_expires_at > new Date().toISOString()
    ) return { state: "busy", childInput, leaseExpiresAt: existing.lease_expires_at };
    if (!existing.attempt_id || !existing.lease_owner) throw new RunOwnershipLostError();

    // Resume the same durable attempt after its lease expires. Retaining the
    // attempt ID keeps its immutable scope and tool receipts valid, while a
    // fresh lease owner fences the obsolete executor that lost the lease.
    const reclaimed = await db.prepare(
      `UPDATE harness_runs
          SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?5)),
              lease_owner = ?9,
              attempt_number = attempt_number + 1
        WHERE id = ?1 AND parent_harness_run_id = ?2 AND parent_tool_call_id = ?3
          AND attempt_id = ?6 AND lease_owner = ?7
          AND status = 'running' AND terminalized_at IS NULL
          AND cancellation_requested_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          AND EXISTS (
            SELECT 1 FROM harness_runs parent
             WHERE parent.id = ?2 AND parent.attempt_id = ?4 AND parent.lease_owner = ?8
               AND parent.status = 'running' AND parent.terminalized_at IS NULL
               AND parent.cancellation_requested_at IS NULL
               AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
          AND (
            SELECT COUNT(*) FROM harness_runs active_child
             WHERE active_child.workspace_id = ?10
               AND active_child.id != ?1
               AND active_child.parent_tool_call_id IS NOT NULL
               AND active_child.status = 'running'
               AND active_child.terminalized_at IS NULL
               AND active_child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ) < ?11`,
    ).bind(
      existing.id,
      parentInput.harnessRunId,
      options.parentToolCallId,
      parentLease.attemptId,
      leaseSeconds,
      existing.attempt_id,
      existing.lease_owner,
      parentLease.owner,
      owner,
      parentInput.workspaceId,
      maxActiveWorkspaceChildren,
    ).run();
    if (d1Changes(reclaimed) > 0) {
      const row = await db.prepare(
        `SELECT attempt_number, lease_expires_at FROM harness_runs
          WHERE id = ? AND attempt_id = ? AND lease_owner = ?`,
      ).bind(existing.id, existing.attempt_id, owner)
        .first<{ attempt_number: number; lease_expires_at: string }>();
      if (!row) throw new RunOwnershipLostError();
      return {
        state: "claimed",
        childInput,
        lease: {
          attemptId: existing.attempt_id,
          owner,
          attemptNumber: Number(row.attempt_number),
          leaseExpiresAt: row.lease_expires_at,
        },
        chainRootRunId: existing.chain_root_harness_run_id,
        chainDepth: Number(existing.chain_depth),
        reused: true,
      };
    }
    await assertHarnessAttemptOwned(db, parentInput.harnessRunId, parentLease);
    const fresh = await db.prepare(
      `SELECT child.status, child.terminalized_at, child.cancellation_requested_at,
              child.lease_expires_at, child.child_result_json, child.child_result_hash,
              child.delegated_task_hash,
              CASE WHEN child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                   THEN 1 ELSE 0 END AS lease_is_active,
              (SELECT COUNT(*) FROM harness_runs active_child
                WHERE active_child.workspace_id = child.workspace_id
                  AND active_child.id != child.id
                  AND active_child.parent_tool_call_id IS NOT NULL
                  AND active_child.status = 'running'
                  AND active_child.terminalized_at IS NULL
                  AND active_child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                AS active_children
         FROM harness_runs child
        WHERE child.id = ?1 AND child.parent_harness_run_id = ?2
          AND child.parent_tool_call_id = ?3`,
    ).bind(existing.id, parentInput.harnessRunId, options.parentToolCallId)
      .first<{
        status: string;
        terminalized_at: string | null;
        cancellation_requested_at: string | null;
        lease_expires_at: string | null;
        child_result_json: string | null;
        child_result_hash: string | null;
        delegated_task_hash: string | null;
        lease_is_active: number;
        active_children: number;
      }>();
    if (!fresh) throw new RunOwnershipLostError();
    if (fresh.delegated_task_hash !== objectiveHash) {
      throw new Error("inline_child_objective_mismatch");
    }
    if (fresh.terminalized_at || TERMINAL_STATUSES.has(fresh.status)) {
      const outcome = await parseVerifiedInlineChildResult(
        fresh.child_result_json,
        fresh.child_result_hash,
      );
      if (!outcome) throw new Error("inline_child_terminal_result_missing");
      return { state: "replay", childInput, outcome };
    }
    if (fresh.cancellation_requested_at) throw new RunCancelledError();
    if (Number(fresh.lease_is_active)) {
      return { state: "busy", childInput, leaseExpiresAt: fresh.lease_expires_at };
    }
    if (Number(fresh.active_children) >= maxActiveWorkspaceChildren) {
      return { state: "refused", reason: "workspace_child_capacity" };
    }
    throw new Error("inline_child_admission_conflict");
  }

  await assertHarnessAttemptOwned(db, parentInput.harnessRunId, parentLease);
  const capacity = await db.prepare(
    `SELECT parent.chain_depth,
            EXISTS (
              SELECT 1 FROM harness_run_scopes scope
               WHERE scope.harness_run_id = parent.id
            ) AS has_scope,
            (SELECT COUNT(*) FROM harness_runs chain_run
              WHERE chain_run.id = COALESCE(parent.chain_root_harness_run_id, parent.id)
                 OR (
                   chain_run.chain_root_harness_run_id = COALESCE(parent.chain_root_harness_run_id, parent.id)
                   AND chain_run.parent_tool_call_id IS NOT NULL
                 )) AS chain_runs,
            (SELECT COUNT(*) FROM harness_runs active_child
              WHERE active_child.workspace_id = parent.workspace_id
                AND active_child.parent_tool_call_id IS NOT NULL
                AND active_child.status = 'running' AND active_child.terminalized_at IS NULL
                AND active_child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS active_children
       FROM harness_runs parent WHERE parent.id = ?1`,
  ).bind(parentInput.harnessRunId)
    .first<{
      chain_depth: number;
      has_scope: number;
      chain_runs: number;
      active_children: number;
    }>();
  if (!capacity) throw new RunOwnershipLostError();
  if (!Number(capacity.has_scope)) throw new Error("inline_child_parent_scope_missing");
  if (Number(capacity.chain_depth) + 1 > maxDepth) return { state: "refused", reason: "depth_limit" };
  if (Number(capacity.chain_runs) >= maxChainRuns) {
    return { state: "refused", reason: "chain_budget_exhausted" };
  }
  if (Number(capacity.active_children) >= maxActiveWorkspaceChildren) {
    return { state: "refused", reason: "workspace_child_capacity" };
  }
  // All durable admission predicates still hold. The failed insert therefore
  // came from a caller-supplied ID collision or another unexpected database
  // conflict, not from a capacity policy. Do not misreport it as saturation.
  throw new Error("inline_child_admission_conflict");
}

export async function loadInlineChildResult(
  db: D1Database,
  parentHarnessRunId: string,
  parentToolCallId: string,
): Promise<InlineChildResultLookup> {
  const row = await db.prepare(
    `SELECT id, workspace_id, workstream_id, status, terminalized_at,
            lease_expires_at, child_result_json, child_result_hash
       FROM harness_runs
      WHERE parent_harness_run_id = ?1 AND parent_tool_call_id = ?2`,
  ).bind(parentHarnessRunId, parentToolCallId)
    .first<{
      id: string;
      workspace_id: string;
      workstream_id: string;
      status: string;
      terminalized_at: string | null;
      lease_expires_at: string | null;
      child_result_json: string | null;
      child_result_hash: string | null;
    }>();
  if (!row) return { state: "missing" };
  const childInput = {
    workspaceId: row.workspace_id,
    workstreamId: row.workstream_id,
    harnessRunId: row.id,
  };
  if (!row.terminalized_at && !TERMINAL_STATUSES.has(row.status)) {
    return { state: "running", childInput, leaseExpiresAt: row.lease_expires_at };
  }
  const outcome = await parseVerifiedInlineChildResult(
    row.child_result_json,
    row.child_result_hash,
  );
  if (!outcome) throw new Error("inline_child_terminal_result_missing");
  return { state: "replay", childInput, outcome };
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
          AND parent_tool_call_id IS NULL
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
          AND parent_tool_call_id IS NULL
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
               AND origin != 'block_dashboard_block'
          )
          AND NOT EXISTS (
            SELECT 1 FROM harness_runs active
             WHERE active.workspace_id = ?3 AND active.workstream_id = ?2
               AND active.id != ?4
               AND active.origin != 'block_dashboard_block'
               AND active.parent_tool_call_id IS NULL
               AND active.status IN ('scheduled', 'running')
               AND active.terminalized_at IS NULL
               AND active.cancellation_requested_at IS NULL
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
    `SELECT attempt_id, status, terminalized_at FROM harness_runs
      WHERE id = ? AND parent_tool_call_id IS NULL`,
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
    memoryContextHash: scope.memoryContextHash ?? null,
    limits: scope.limits,
  };
  const scopeHash = await sha256Hex(stableJson(canonicalScope));
  const now = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO harness_run_scopes
     (harness_run_id, workspace_id, workstream_id, attempt_id, execution_principal_json,
      eligible_connection_ids_json, eligible_capabilities_json, eligible_connection_capabilities_json,
      trigger_policy_json, routing_policy_version, prompt_version, tool_surface_hash,
      memory_context_hash, limits_json, scope_hash, created_at)
     SELECT ?1, ?2, ?3, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
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
    canonicalScope.memoryContextHash,
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

/** Persist a child scope only when it is a read-only narrowing of its parent. */
export async function persistInlineChildScope(
  db: D1Database,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  childInput: HarnessRunCoordinates,
  childLease: AttemptLease,
  scope: ImmutableRunScope,
): Promise<{ scopeHash: string; reused: boolean }> {
  await assertHarnessAttemptOwned(db, parentInput.harnessRunId, parentLease);
  await assertInlineChildAttemptOwned(
    db,
    parentInput,
    parentLease,
    childInput,
    childLease,
  );
  const parentScope = await db.prepare(
    `SELECT scope.scope_hash, scope.execution_principal_json,
            scope.eligible_connection_ids_json, scope.eligible_capabilities_json,
            scope.eligible_connection_capabilities_json
       FROM harness_run_scopes scope
       JOIN harness_runs child ON child.id = ?2
      WHERE scope.harness_run_id = ?1
        AND child.parent_harness_run_id = ?1
        AND child.parent_tool_call_id IS NOT NULL
        AND child.inherited_scope_hash = scope.scope_hash`,
  ).bind(parentInput.harnessRunId, childInput.harnessRunId)
    .first<{
      scope_hash: string;
      execution_principal_json: string;
      eligible_connection_ids_json: string;
      eligible_capabilities_json: string;
      eligible_connection_capabilities_json: string;
    }>();
  if (!parentScope) throw new Error("inline_child_parent_scope_missing");

  const parentConnectionIds = new Set(JSON.parse(parentScope.eligible_connection_ids_json) as string[]);
  const parentCapabilities = new Set(JSON.parse(parentScope.eligible_capabilities_json) as string[]);
  const parentConnectionCapabilities = JSON.parse(
    parentScope.eligible_connection_capabilities_json,
  ) as Record<string, string[]>;
  if (stableJson(scope.executionPrincipal) !== stableJson(JSON.parse(parentScope.execution_principal_json))) {
    throw new Error("inline_child_principal_mismatch");
  }
  if (scope.triggerPolicy.readOnly !== true || scope.triggerPolicy.kind !== "sub_agent") {
    throw new Error("inline_child_scope_not_read_only");
  }
  if (scope.eligibleConnectionIds.some((connectionId) => !parentConnectionIds.has(connectionId))) {
    throw new Error("inline_child_scope_widened");
  }
  if (scope.eligibleCapabilities.some((capability) => !parentCapabilities.has(capability))) {
    throw new Error("inline_child_scope_widened");
  }
  for (const [connectionId, capabilities] of Object.entries(scope.eligibleConnectionCapabilities)) {
    if (!parentConnectionIds.has(connectionId)) throw new Error("inline_child_scope_widened");
    const parentGranted = new Set(parentConnectionCapabilities[connectionId] ?? []);
    if (capabilities.some((capability) => !parentGranted.has(capability))) {
      throw new Error("inline_child_scope_widened");
    }
  }

  const persisted = await persistImmutableRunScope(db, childInput, childLease, scope);
  // A scope persisted after the parent lost ownership is never exposed to the
  // child model: this final fence turns the call into an authoritative abort.
  await assertInlineChildAttemptOwned(
    db,
    parentInput,
    parentLease,
    childInput,
    childLease,
  );
  return persisted;
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

export async function heartbeatInlineChildAttempt(
  db: D1Database,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  childInput: HarnessRunCoordinates,
  childLease: AttemptLease,
  leaseSeconds = 60,
): Promise<AttemptLease> {
  const boundedSeconds = Math.max(10, Math.min(300, Math.trunc(leaseSeconds)));
  const result = await db.prepare(
    `UPDATE harness_runs AS child
        SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?8))
      WHERE child.id = ?4 AND child.workspace_id = ?2 AND child.workstream_id = ?3
        AND child.parent_harness_run_id = ?1
        AND child.parent_tool_call_id IS NOT NULL
        AND child.attempt_id = ?5 AND child.lease_owner = ?6
        AND child.status = 'running' AND child.terminalized_at IS NULL
        AND child.cancellation_requested_at IS NULL
        AND child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND EXISTS (
          SELECT 1 FROM harness_runs parent
           WHERE parent.id = ?1 AND parent.workspace_id = ?2 AND parent.workstream_id = ?3
             AND parent.attempt_id = ?7 AND parent.lease_owner = ?9
             AND parent.status = 'running' AND parent.terminalized_at IS NULL
             AND parent.cancellation_requested_at IS NULL
             AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )`,
  ).bind(
    parentInput.harnessRunId,
    parentInput.workspaceId,
    parentInput.workstreamId,
    childInput.harnessRunId,
    childLease.attemptId,
    childLease.owner,
    parentLease.attemptId,
    boundedSeconds,
    parentLease.owner,
  ).run();
  if (d1Changes(result) === 0) {
    const state = await db.prepare(
      `SELECT child.status, child.cancellation_requested_at,
              parent.status AS parent_status,
              parent.cancellation_requested_at AS parent_cancellation_requested_at
         FROM harness_runs child
         LEFT JOIN harness_runs parent ON parent.id = child.parent_harness_run_id
        WHERE child.id = ?`,
    ).bind(childInput.harnessRunId)
      .first<{
        status: string;
        cancellation_requested_at: string | null;
        parent_status: string | null;
        parent_cancellation_requested_at: string | null;
      }>();
    if (
      state?.status === "stopped"
      || state?.cancellation_requested_at
      || state?.parent_status === "stopped"
      || state?.parent_cancellation_requested_at
    ) throw new RunCancelledError();
    throw new RunOwnershipLostError();
  }
  const row = await db.prepare(
    `SELECT lease_expires_at FROM harness_runs
      WHERE id = ? AND attempt_id = ? AND lease_owner = ?`,
  ).bind(childInput.harnessRunId, childLease.attemptId, childLease.owner)
    .first<{ lease_expires_at: string }>();
  if (!row) throw new RunOwnershipLostError();
  return { ...childLease, leaseExpiresAt: row.lease_expires_at };
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

export async function assertInlineChildAttemptOwned(
  db: D1Database,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  childInput: HarnessRunCoordinates,
  childLease: AttemptLease,
): Promise<void> {
  const row = await db.prepare(
    `SELECT child.status, child.cancellation_requested_at,
            parent.status AS parent_status,
            parent.cancellation_requested_at AS parent_cancellation_requested_at
       FROM harness_runs child
       JOIN harness_runs parent ON parent.id = child.parent_harness_run_id
      WHERE child.id = ?4 AND child.workspace_id = ?2 AND child.workstream_id = ?3
        AND child.parent_harness_run_id = ?1
        AND child.parent_tool_call_id IS NOT NULL
        AND child.attempt_id = ?5 AND child.lease_owner = ?6
        AND child.terminalized_at IS NULL
        AND child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND parent.id = ?1 AND parent.workspace_id = ?2 AND parent.workstream_id = ?3
        AND parent.attempt_id = ?7 AND parent.lease_owner = ?8
        AND parent.terminalized_at IS NULL
        AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(
    parentInput.harnessRunId,
    parentInput.workspaceId,
    parentInput.workstreamId,
    childInput.harnessRunId,
    childLease.attemptId,
    childLease.owner,
    parentLease.attemptId,
    parentLease.owner,
  ).first<{
    status: string;
    cancellation_requested_at: string | null;
    parent_status: string;
    parent_cancellation_requested_at: string | null;
  }>();
  if (!row) throw new RunOwnershipLostError();
  if (
    row.status === "stopped"
    || row.cancellation_requested_at
    || row.parent_status === "stopped"
    || row.parent_cancellation_requested_at
  ) throw new RunCancelledError();
  if (row.status !== "running" || row.parent_status !== "running") {
    throw new RunOwnershipLostError();
  }
}

export async function persistHarnessFinalMessage(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  message: { id: string; sequenceNumber: number; text: string; createdAt: string },
  hostOutcome: Pick<TerminalOutcome, "status" | "error">,
): Promise<void> {
  if (hostOutcome.status === "stopped") {
    const owned = await db.prepare(
      `SELECT 1 AS owned
         FROM harness_runs
        WHERE id = ?1 AND attempt_id = ?2 AND lease_owner = ?3
          AND status = 'running' AND terminalized_at IS NULL
          AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(input.harnessRunId, lease.attemptId, lease.owner).first<{ owned: number }>();
    if (!owned) throw new RunOwnershipLostError();
  } else {
    await assertHarnessAttemptOwned(db, input.harnessRunId, lease);
  }
  const lifecycleId = crypto.randomUUID();
  const eventPayload = stableJson({
    finalMessageId: message.id,
    hostOutcome: {
      status: hostOutcome.status,
      ...(hostOutcome.error ? { error: hostOutcome.error } : {}),
    },
  });
  await db.batch([
    db.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type,
        message_type, text_content, sequence_number, created_at,
        harness_run_id, harness_attempt_id)
       SELECT ?6, ?7, ?2, ?3, 'agent', 'text', ?8, ?9, ?10, ?1, ?4
         FROM harness_runs
        WHERE id = ?1 AND workspace_id = ?2 AND workstream_id = ?3
          AND parent_tool_call_id IS NULL
          AND attempt_id = ?4 AND lease_owner = ?5 AND status = 'running'
          AND terminalized_at IS NULL
          AND (?11 = 'stopped' OR cancellation_requested_at IS NULL)
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
      hostOutcome.status,
    ),
    db.prepare(
      `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
       SELECT ?6, run.id, run.workspace_id, run.workstream_id, ?4,
              'final_message', 'final_message_persisted', ?10, ?8, ?9
         FROM harness_runs run
         JOIN messages message
           ON message.id = ?7
          AND message.workspace_id = run.workspace_id
          AND message.workstream_id = run.workstream_id
          AND message.harness_run_id = run.id
          AND message.harness_attempt_id = run.attempt_id
        WHERE run.id = ?1 AND run.workspace_id = ?2 AND run.workstream_id = ?3
          AND run.parent_tool_call_id IS NULL
          AND run.attempt_id = ?4 AND run.lease_owner = ?5
          AND run.status = 'running' AND run.terminalized_at IS NULL
          AND (?10 = 'stopped' OR run.cancellation_requested_at IS NULL)
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
      hostOutcome.status,
    ),
    db.prepare(
      `UPDATE workstreams
          SET latest_attention_sequence_number = MAX(latest_attention_sequence_number, ?4),
              last_activity_at = ?5,
              updated_at = ?5
        WHERE id = ?1 AND workspace_id = ?2
          AND EXISTS (
            SELECT 1 FROM messages
             WHERE id = ?3 AND workstream_id = ?1 AND workspace_id = ?2
               AND author_type = 'agent' AND message_type = 'text'
          )`,
    ).bind(
      input.workstreamId,
      input.workspaceId,
      message.id,
      message.sequenceNumber,
      message.createdAt,
    ),
  ]);
  const persisted = await db.prepare(
    `SELECT message.id
       FROM messages message
       JOIN harness_run_lifecycle_events lifecycle
         ON lifecycle.harness_run_id = message.harness_run_id
        AND lifecycle.attempt_id = message.harness_attempt_id
        AND lifecycle.event_key = 'final_message'
        AND lifecycle.event_type = 'final_message_persisted'
      WHERE message.id = ?1 AND message.workspace_id = ?2
        AND message.workstream_id = ?3 AND message.harness_run_id = ?4
        AND message.harness_attempt_id = ?5 AND lifecycle.attempt_id = ?5`,
  ).bind(
    message.id,
    input.workspaceId,
    input.workstreamId,
    input.harnessRunId,
    lease.attemptId,
  ).first<{ id: string }>();
  if (!persisted) throw new RunOwnershipLostError();
  const persistedOutcome = await loadPersistedHarnessFinalOutcome(db, input);
  if (
    !persistedOutcome
    || persistedOutcome.messageId !== message.id
    || persistedOutcome.status !== hostOutcome.status
    || stableJson(persistedOutcome.error ?? null) !== stableJson(hostOutcome.error ?? null)
  ) {
    throw new Error("final_message_host_outcome_mismatch");
  }
}

export async function loadPersistedHarnessFinalOutcome(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
): Promise<PersistedHarnessHostOutcome | null> {
  const row = await db.prepare(
    `SELECT message.id AS message_id, lifecycle.status, lifecycle.member_safe_payload_json
       FROM messages message
       JOIN harness_run_lifecycle_events lifecycle
         ON lifecycle.harness_run_id = message.harness_run_id
        AND lifecycle.attempt_id = message.harness_attempt_id
        AND lifecycle.event_key = 'final_message'
        AND lifecycle.event_type = 'final_message_persisted'
      WHERE message.workspace_id = ?1 AND message.workstream_id = ?2
        AND message.harness_run_id = ?3
        AND message.client_message_id = ?4`,
  ).bind(
    input.workspaceId,
    input.workstreamId,
    input.harnessRunId,
    `harness:${input.harnessRunId}`,
  ).first<{
    message_id: string;
    status: string | null;
    member_safe_payload_json: string;
  }>();
  if (!row) return null;
  if (!row.status || !TERMINAL_STATUSES.has(row.status)) {
    throw new Error("final_message_host_outcome_invalid");
  }

  let payload: {
    finalMessageId?: unknown;
    hostOutcome?: { status?: unknown; error?: unknown };
  };
  try {
    payload = JSON.parse(row.member_safe_payload_json) as typeof payload;
  } catch {
    throw new Error("final_message_host_outcome_invalid");
  }
  if (payload.finalMessageId !== row.message_id) {
    throw new Error("final_message_host_outcome_invalid");
  }

  // The completed-only shape predates exact host-outcome checkpoints. Preserve
  // that one safe legacy interpretation; every other status must carry the
  // versioned host outcome so recovery can never infer or upgrade it.
  if (!payload.hostOutcome) {
    if (row.status !== "completed") throw new Error("final_message_host_outcome_invalid");
    return { messageId: row.message_id, status: "completed" };
  }
  if (payload.hostOutcome.status !== row.status) {
    throw new Error("final_message_host_outcome_invalid");
  }
  const rawError = payload.hostOutcome.error;
  const error = rawError && typeof rawError === "object"
    && typeof (rawError as { code?: unknown }).code === "string"
    && typeof (rawError as { message?: unknown }).message === "string"
    ? {
        code: (rawError as { code: string }).code,
        message: (rawError as { message: string }).message,
      }
    : undefined;
  if (rawError !== undefined && !error) throw new Error("final_message_host_outcome_invalid");
  return {
    messageId: row.message_id,
    status: row.status as HarnessTerminalStatus,
    ...(error ? { error } : {}),
  };
}

/**
 * Does a receipt already settled at these coordinates describe a *read* that
 * this call is also a read of?
 *
 * Receipt ids are positional (`…:turn:<n>:tool:<i>`) so a re-executed pass can
 * replay the first pass's tool results instead of repeating them. The coordinate
 * is therefore reused whenever a pass restarts — and a pass that restarts is
 * given the transcript window up to its own trigger, so it cannot see the calls
 * the previous pass made and will not reliably reproduce them. Landing a
 * different call on an occupied coordinate is the normal consequence, not a
 * defect.
 *
 * For a read there is nothing to be ambiguous about: no external state moved,
 * the recorded result was already consumed by a pass that is gone, and the call
 * in hand can simply execute. `record_before_execute` writes keep failing closed
 * — for them the coordinate IS the idempotency key.
 */
function completedReadReceipt(
  existing: { status: string; input_hash: string; execution_plan_json: string | null },
  plan: ToolExecutionPlan,
): boolean {
  // Both statements of the incoming call's mode have to agree. Every current
  // caller derives them from one `receiptPolicy.definition`, so they cannot
  // disagree today; the pair is checked because the plan is what gets persisted
  // and compared on the next pass, and a caller that ever sets them separately
  // must not be able to widen this by disagreeing with itself.
  if (existing.status !== "completed" || plan.mode !== "read" || plan.plan.mode !== "read") return false;
  // Only a demonstrably different call rebinds. Identical input whose recorded
  // policy cannot be proven compatible is the receipt-identity fence — one call
  // whose identity is in doubt — and that still fails closed.
  if (existing.input_hash === plan.inputHash) return false;
  try {
    const recorded = JSON.parse(existing.execution_plan_json ?? "null") as { mode?: unknown } | null;
    return recorded?.mode === "read";
  } catch {
    // An unreadable plan cannot prove the recorded call was a read, and this
    // decision is only ever allowed to relax on proof.
    return false;
  }
}

/**
 * Is durable state outside the receipt row keyed to this receipt?
 *
 * A receipt is not always the only record of its call. `run_subagent` keys its
 * child run by the parent's coordinate and refuses a second objective there
 * (`inline_child_objective_mismatch`), and an attachment read records the
 * resource derivatives it depended on against the invocation id — rows whose
 * lifecycle triggers delete the invocation when the old resource changes, which
 * after a rebind would delete the row a *different*, possibly in-flight read
 * now owns.
 *
 * Both are asked as questions about state rather than about tool names, so a
 * tool that starts keying either one is covered without being enumerated here.
 * A receipt that owns any of it keeps failing closed.
 */
async function receiptOwnsDependentState(
  db: D1Database,
  plan: ToolExecutionPlan,
  invocationId: string,
): Promise<boolean> {
  const dependents = await db.prepare(
    `SELECT
       EXISTS (
         SELECT 1 FROM harness_runs
          WHERE parent_harness_run_id = ?1 AND parent_tool_call_id = ?2
       ) AS child_run,
       EXISTS (
         SELECT 1 FROM attachment_tool_receipts WHERE tool_invocation_id = ?3
       ) AS attachment_dependency`,
  ).bind(plan.harnessRunId, plan.toolCallId, invocationId)
    .first<{ child_run: number; attachment_dependency: number }>();
  return Boolean(dependents?.child_run) || Boolean(dependents?.attachment_dependency);
}

/** Rebind a settled read receipt to the call that landed on its coordinates. */
async function replanCompletedReadReceipt(
  db: D1Database,
  lease: AttemptLease,
  plan: ToolExecutionPlan,
  bind: {
    invocationId: string;
    executionPlanJson: string;
    executionPlanHash: string;
    now: string;
  },
): Promise<ToolPlanClaim> {
  // Its own id rather than the one the planning batch minted: that one is bound
  // to an insert that did not land here, and keeping the two apart costs a UUID.
  const checkpointId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO tool_invocation_checkpoints
       (id, tool_invocation_id, harness_run_id, attempt_id, checkpoint_index,
        phase, member_safe_payload_json, created_at)
       SELECT ?1, ti.id, ti.harness_run_id, ?3, ti.checkpoint_index + 1,
              'execution_replanned', ?5, ?4
         FROM tool_invocations ti
         JOIN harness_runs hr ON hr.id = ti.harness_run_id
        WHERE ti.id = ?2 AND ti.attempt_id = ?3 AND ti.status = 'completed'
          AND hr.attempt_id = ?3 AND hr.lease_owner = ?6 AND hr.status = 'running'
          AND hr.cancellation_requested_at IS NULL AND hr.terminalized_at IS NULL
          AND hr.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(tool_invocation_id, checkpoint_index) DO NOTHING`,
    ).bind(
      checkpointId,
      bind.invocationId,
      lease.attemptId,
      bind.now,
      stableJson({ toolName: plan.toolName }),
      lease.owner,
    ),
    db.prepare(
      `UPDATE tool_invocations
          SET tool_name = ?1, connection_id = ?2, input_hash = ?3, input_json = ?4,
              execution_plan_hash = ?5, execution_plan_json = ?6,
              provider_idempotency_key = ?7, status = 'started', started_at = ?8,
              completed_at = NULL, output_ref = NULL, output_summary = NULL,
              error_json = NULL, last_checkpoint_at = ?8,
              checkpoint_index = (
                SELECT checkpoint_index FROM tool_invocation_checkpoints WHERE id = ?11
              ),
              lease_expires_at = (
                SELECT lease_expires_at FROM harness_runs WHERE id = ?12
              )
        WHERE id = ?9 AND attempt_id = ?10 AND status = 'completed'
          AND EXISTS (
            SELECT 1 FROM tool_invocation_checkpoints
             WHERE id = ?11 AND tool_invocation_id = ?9 AND attempt_id = ?10
          )`,
    ).bind(
      plan.toolName,
      plan.connectionId ?? null,
      plan.inputHash,
      stableJson(plan.input),
      bind.executionPlanHash,
      bind.executionPlanJson,
      plan.providerIdempotencyKey ?? null,
      bind.now,
      bind.invocationId,
      lease.attemptId,
      checkpointId,
      plan.harnessRunId,
    ),
  ]);
  if (d1Changes(results[1]) > 0) {
    return { state: "created", invocationId: bind.invocationId, executionPlanHash: bind.executionPlanHash };
  }
  // The row moved under us between the read and the rebind. Fail closed rather
  // than guess which of the two calls the receipt now describes.
  await assertHarnessAttemptOwned(db, plan.harnessRunId, lease);
  return {
    state: "ambiguous_external_write",
    invocationId: bind.invocationId,
    executionPlanHash: bind.executionPlanHash,
  };
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
  const compatiblePriorPlanHashes = new Set(await Promise.all(
    (plan.compatiblePriorPlans ?? []).map((compatiblePlan) => sha256Hex(stableJson(compatiblePlan))),
  ));
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
    `SELECT id, attempt_id, input_hash, execution_plan_hash, execution_plan_json, status
       FROM tool_invocations
      WHERE harness_run_id = ? AND tool_call_id = ?`,
  ).bind(plan.harnessRunId, plan.toolCallId)
    .first<{
      id: string;
      attempt_id: string | null;
      input_hash: string;
      execution_plan_hash: string | null;
      execution_plan_json: string | null;
      status: string;
    }>();
  if (!existing) throw new RunOwnershipLostError();
  await assertHarnessAttemptOwned(db, plan.harnessRunId, lease);
  if (existing.attempt_id !== lease.attemptId) {
    return { state: "ambiguous_external_write", invocationId: existing.id, executionPlanHash };
  }
  if (
    existing.input_hash !== plan.inputHash
    || (
      existing.execution_plan_hash !== executionPlanHash
      && !compatiblePriorPlanHashes.has(existing.execution_plan_hash ?? "")
    )
  ) {
    if (
      completedReadReceipt(existing, plan)
      && !(await receiptOwnsDependentState(db, plan, existing.id))
    ) {
      return replanCompletedReadReceipt(db, lease, plan, {
        invocationId: existing.id,
        executionPlanJson,
        executionPlanHash,
        now,
      });
    }
    // `completed` is the one status this cannot finalize: an ambiguous finalize
    // moves `('pending', 'started', 'failed')`, so a completed row matches
    // nothing and the attempt reports `RunOwnershipLost` — a lease failure that
    // never happened — taking the run down with it. A `failed` row still moves,
    // and still should: a write that failed may have reached the provider first.
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
    allowAmbiguousReconciliation?: boolean;
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
       SELECT ?1, ti.id, ti.harness_run_id, ?4, MAX(?5, ti.checkpoint_index + 1),
              'result_persisted', ?6, ?7
         FROM tool_invocations ti
         JOIN harness_runs hr ON hr.id = ti.harness_run_id
        WHERE ti.id = ?2 AND ti.harness_run_id = ?3 AND ti.attempt_id = ?4
          AND (ti.status IN ('pending', 'started') OR (?9 = 1 AND ti.status = 'ambiguous'))
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
      input.allowAmbiguousReconciliation ? 1 : 0,
    ),
    db.prepare(
      // The index comes from the checkpoint that was just written, not from the
      // caller's number. A receipt that has been replanned in place already
      // carries checkpoints past the caller's static index, and binding that
      // number here would look for a checkpoint the insert above never wrote.
      `UPDATE tool_invocations
          SET status = 'completed', output_ref = ?1, output_summary = ?2,
              provider_operation_id = ?3, completed_at = ?4,
              checkpoint_index = (
                SELECT checkpoint_index FROM tool_invocation_checkpoints WHERE id = ?10
              ),
              last_checkpoint_at = ?4,
              lease_expires_at = NULL, error_json = NULL
        WHERE id = ?6 AND harness_run_id = ?7 AND attempt_id = ?8
          AND (status IN ('pending', 'started') OR (?11 = 1 AND status = 'ambiguous'))
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
               AND attempt_id = ?8 AND checkpoint_index >= ?5
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
      input.allowAmbiguousReconciliation ? 1 : 0,
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
  const errorJson = JSON.stringify({
    code,
    message,
    ...(input.error.data ? { data: input.error.data } : {}),
  });
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

/** Coalesced child heartbeat that is fenced by both child and parent leases. */
export class InlineChildRunLiveness {
  readonly controller = new AbortController();
  private inFlight: Promise<void> | null = null;
  private nextHeartbeatAt = 0;
  private currentLease: AttemptLease;

  constructor(
    private readonly db: D1Database,
    private readonly parentInput: HarnessRunCoordinates,
    private readonly parentLease: AttemptLease,
    private readonly childInput: HarnessRunCoordinates,
    childLease: AttemptLease,
    private readonly options: { leaseSeconds?: number; minimumIntervalMs?: number } = {},
  ) {
    this.currentLease = childLease;
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
          this.currentLease = await heartbeatInlineChildAttempt(
            this.db,
            this.parentInput,
            this.parentLease,
            this.childInput,
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

export async function terminalizeInlineChildAttempt(
  db: D1Database,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  childInput: HarnessRunCoordinates,
  childLease: AttemptLease,
  outcome: InlineChildResult,
): Promise<"terminalized" | "already_terminal"> {
  if (outcome.status === "completed" && !Object.hasOwn(outcome, "result")) {
    throw new Error("child_result_required");
  }
  const sanitizedOutcome: InlineChildResult = {
    status: outcome.status,
    ...(Object.hasOwn(outcome, "result") ? { result: outcome.result } : {}),
    ...(outcome.error
      ? {
          error: {
            code: outcome.error.code.slice(0, 120),
            message: outcome.error.message.slice(0, 500),
          },
        }
      : {}),
    ...(outcome.model ? { model: outcome.model.slice(0, 200) } : {}),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
  const resultJson = stableJson(sanitizedOutcome);
  const resultHash = await sha256Hex(resultJson);
  const now = new Date().toISOString();
  const lifecycleId = crypto.randomUUID();
  const memberPayload = stableJson({
    ...(sanitizedOutcome.error ? { code: sanitizedOutcome.error.code } : {}),
  });
  const results = await db.batch([
    db.prepare(
      `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
       SELECT ?1, child.id, child.workspace_id, child.workstream_id, ?6,
              'terminal', 'terminal', ?8, ?9, ?10
         FROM harness_runs child
         JOIN harness_runs parent ON parent.id = child.parent_harness_run_id
        WHERE child.id = ?5 AND child.workspace_id = ?3 AND child.workstream_id = ?4
          AND child.parent_harness_run_id = ?2
          AND child.parent_tool_call_id IS NOT NULL
          AND child.attempt_id = ?6 AND child.lease_owner = ?7
          AND child.terminalized_at IS NULL
          AND (?8 = 'stopped' OR child.cancellation_requested_at IS NULL)
          AND child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND parent.attempt_id = ?11 AND parent.lease_owner = ?12
          AND parent.status = 'running' AND parent.terminalized_at IS NULL
          AND (?8 = 'stopped' OR parent.cancellation_requested_at IS NULL)
          AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
    ).bind(
      lifecycleId,
      parentInput.harnessRunId,
      childInput.workspaceId,
      childInput.workstreamId,
      childInput.harnessRunId,
      childLease.attemptId,
      childLease.owner,
      sanitizedOutcome.status,
      memberPayload,
      now,
      parentLease.attemptId,
      parentLease.owner,
    ),
    db.prepare(
      `UPDATE harness_runs AS child
          SET status = ?8, completed_at = ?9, terminalized_at = ?9,
              model = COALESCE(?10, model), usage_json = COALESCE(?11, usage_json),
              error_json = ?12, child_result_json = ?13, child_result_hash = ?14,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE child.id = ?5 AND child.workspace_id = ?3 AND child.workstream_id = ?4
          AND child.parent_harness_run_id = ?2
          AND child.parent_tool_call_id IS NOT NULL
          AND child.attempt_id = ?6 AND child.lease_owner = ?7
          AND child.terminalized_at IS NULL
          AND (?8 = 'stopped' OR child.cancellation_requested_at IS NULL)
          AND child.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND EXISTS (
            SELECT 1 FROM harness_runs parent
             WHERE parent.id = ?2 AND parent.attempt_id = ?15 AND parent.lease_owner = ?16
               AND parent.status = 'running' AND parent.terminalized_at IS NULL
               AND (?8 = 'stopped' OR parent.cancellation_requested_at IS NULL)
               AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
          AND EXISTS (
            SELECT 1 FROM harness_run_lifecycle_events lifecycle
             WHERE lifecycle.id = ?1 AND lifecycle.harness_run_id = ?5
               AND lifecycle.attempt_id = ?6 AND lifecycle.event_key = 'terminal'
          )`,
    ).bind(
      lifecycleId,
      parentInput.harnessRunId,
      childInput.workspaceId,
      childInput.workstreamId,
      childInput.harnessRunId,
      childLease.attemptId,
      childLease.owner,
      sanitizedOutcome.status,
      now,
      sanitizedOutcome.model ?? null,
      sanitizedOutcome.usage ? stableJson(sanitizedOutcome.usage) : null,
      safeErrorJson(sanitizedOutcome.error),
      resultJson,
      resultHash,
      parentLease.attemptId,
      parentLease.owner,
    ),
  ]);
  if (d1Changes(results[1]) > 0) return "terminalized";
  const existing = await db.prepare(
    `SELECT status, attempt_id, terminalized_at, child_result_hash
       FROM harness_runs
      WHERE id = ? AND parent_harness_run_id = ? AND parent_tool_call_id IS NOT NULL`,
  ).bind(childInput.harnessRunId, parentInput.harnessRunId)
    .first<{
      status: string;
      attempt_id: string | null;
      terminalized_at: string | null;
      child_result_hash: string | null;
    }>();
  if (
    existing?.attempt_id === childLease.attemptId
    && existing.terminalized_at
    && existing.status === sanitizedOutcome.status
    && existing.child_result_hash === resultHash
  ) return "already_terminal";
  throw new RunOwnershipLostError();
}

export async function cancelDescendantHarnessRuns(
  db: D1Database,
  rootHarnessRunId: string,
  reason: string,
): Promise<number> {
  const at = new Date().toISOString();
  const boundedReason = reason.slice(0, 200) || "parent_cancelled";
  const result = await db.prepare(
    `UPDATE harness_runs
        SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?2),
            cancellation_reason = COALESCE(cancellation_reason, ?3)
      WHERE (chain_root_harness_run_id = ?1 OR parent_harness_run_id = ?1)
        AND parent_tool_call_id IS NOT NULL
        AND status IN ('scheduled', 'running') AND terminalized_at IS NULL`,
  ).bind(rootHarnessRunId, at, boundedReason).run();
  return d1Changes(result);
}

export async function terminalizeHarnessAttempt(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  outcome: TerminalOutcome,
): Promise<"terminalized" | "already_terminal"> {
  const target = await db.prepare(
    `SELECT origin FROM harness_runs
      WHERE id = ? AND workspace_id = ? AND workstream_id = ? AND parent_tool_call_id IS NULL`,
  ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{ origin: string }>();
  if (!target) throw new Error("harness_run_not_found");
  if (outcome.status === "completed") {
    if (target.origin === "block_dashboard_block") {
      const result = await db.prepare(
        `SELECT id FROM block_dashboard_block_runs
          WHERE harness_run_id = ? AND workspace_id = ? AND workstream_id = ?
            AND status = 'completed' AND markdown IS NOT NULL`,
      ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{ id: string }>();
      if (!result) throw new Error("block_dashboard_result_not_persisted");
    } else {
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
          AND parent_tool_call_id IS NULL
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
          AND parent_tool_call_id IS NULL
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
               AND parent_tool_call_id IS NULL
               AND origin != 'block_dashboard_block'
          )
          AND NOT EXISTS (
            SELECT 1 FROM harness_runs active
             WHERE active.workspace_id = ?4 AND active.workstream_id = ?3
               AND active.id != ?5
               AND active.origin != 'block_dashboard_block'
               AND active.parent_tool_call_id IS NULL
               AND active.status IN ('scheduled', 'running')
               AND active.terminalized_at IS NULL
               AND active.cancellation_requested_at IS NULL
          )`,
    ).bind(
      workstreamStatus,
      now,
      input.workstreamId,
      input.workspaceId,
      input.harnessRunId,
      lease.attemptId,
    ),
    db.prepare(
      `UPDATE harness_runs
          SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?1),
              cancellation_reason = COALESCE(cancellation_reason, 'parent_terminalized')
        WHERE chain_root_harness_run_id = ?2
          AND parent_tool_call_id IS NOT NULL
          AND status IN ('scheduled', 'running') AND terminalized_at IS NULL
          AND EXISTS (
            SELECT 1 FROM harness_runs parent
             WHERE parent.id = ?2 AND parent.attempt_id = ?3 AND parent.terminalized_at = ?1
          )`,
    ).bind(now, input.harnessRunId, lease.attemptId),
  ]);
  if (d1Changes(results[1]) > 0) return "terminalized";
  const existing = await db.prepare(
    `SELECT attempt_id, status, terminalized_at FROM harness_runs
      WHERE id = ? AND parent_tool_call_id IS NULL`,
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
  // Ordinary attempts are the only runs whose expired lease is itself a
  // terminal condition. An inline child is deliberately reclaimable while its
  // parent still owns a live attempt, so including children in this query
  // races the child's idempotent takeover path.
  const rows = await db.prepare(
    `SELECT id, workspace_id, workstream_id, attempt_id, lease_expires_at
       FROM harness_runs
      WHERE status = 'running' AND terminalized_at IS NULL
        AND parent_tool_call_id IS NULL
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
            AND parent_tool_call_id IS NULL
            AND status = 'running' AND terminalized_at IS NULL
         ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
      ).bind(eventId, row.id, row.attempt_id, row.lease_expires_at, now),
      db.prepare(
        `UPDATE harness_runs
            SET status = 'failed', completed_at = ?4, terminalized_at = ?4,
                error_json = '{"code":"stale_run_reaped","message":"The prior executor lost its durable lease"}',
                lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ?1 AND attempt_id = ?2 AND lease_expires_at = ?3
            AND parent_tool_call_id IS NULL
            AND status = 'running' AND terminalized_at IS NULL`,
      ).bind(row.id, row.attempt_id, row.lease_expires_at, now),
      db.prepare(
        `UPDATE workstreams SET harness_status = 'failed', updated_at = ?1
          WHERE id = ?2 AND workspace_id = ?3
            AND EXISTS (
              SELECT 1 FROM harness_runs
               WHERE id = ?4 AND terminalized_at = ?1 AND parent_tool_call_id IS NULL
                 AND origin != 'block_dashboard_block'
            )
            AND NOT EXISTS (
              SELECT 1 FROM harness_runs active
               WHERE active.workspace_id = ?3 AND active.workstream_id = ?2
                 AND active.id != ?4 AND active.status = 'running'
                 AND active.origin != 'block_dashboard_block'
                 AND active.parent_tool_call_id IS NULL
                 AND active.terminalized_at IS NULL
                 AND active.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )`,
      ).bind(now, row.workstream_id, row.workspace_id, row.id),
      db.prepare(
        `UPDATE block_dashboard_block_runs
            SET status = 'failed', completed_at = ?1,
                error_json = '{"code":"stale_run_reaped","message":"The HyperSight refresh lost its durable lease"}'
          WHERE harness_run_id = ?2 AND status IN ('queued', 'running')
            AND EXISTS (
              SELECT 1 FROM harness_runs
               WHERE id = ?2 AND terminalized_at = ?1 AND origin = 'block_dashboard_block'
            )`,
      ).bind(now, row.id),
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
                 AND parent_tool_call_id IS NULL
                 AND origin != 'block_dashboard_block'
            )`,
      ).bind(now, row.workstream_id, row.workspace_id, row.id),
      db.prepare(
        `UPDATE harness_runs
            SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?1),
                cancellation_reason = COALESCE(cancellation_reason, 'parent_stale_run_reaped')
          WHERE chain_root_harness_run_id = ?2
            AND parent_tool_call_id IS NOT NULL
            AND status IN ('scheduled', 'running') AND terminalized_at IS NULL
            AND EXISTS (
              SELECT 1 FROM harness_runs parent
               WHERE parent.id = ?2 AND parent.terminalized_at = ?1
                 AND parent.parent_tool_call_id IS NULL
            )`,
      ).bind(now, row.id),
    ]);
    if (d1Changes(results[1]) > 0) {
      reaped.push(row.id);
    }
  }

  const childLimit = limit - reaped.length;
  if (childLimit <= 0) return reaped;

  // Children are cleaned up only after their own lease expires and their
  // parent can no longer supervise them. A stale child beneath a live parent
  // is intentionally omitted so the same parent tool-call receipt can reclaim
  // its durable attempt. Both the snapshot and the updates below repeat these
  // predicates, fencing a parent/child heartbeat that wins the race.
  const childRows = await db.prepare(
    `SELECT child.id, child.workspace_id, child.workstream_id, child.attempt_id,
            child.lease_expires_at, child.parent_harness_run_id,
            child.parent_tool_call_id, child.cancellation_requested_at
       FROM harness_runs child
      WHERE child.status = 'running' AND child.terminalized_at IS NULL
        AND child.parent_harness_run_id IS NOT NULL
        AND child.parent_tool_call_id IS NOT NULL
        AND child.attempt_id IS NOT NULL AND child.lease_expires_at IS NOT NULL
        AND child.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND (?1 IS NULL OR child.workspace_id = ?1)
        AND (?2 IS NULL OR child.workstream_id = ?2)
        AND (
          child.cancellation_requested_at IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM harness_runs parent
             WHERE parent.id = child.parent_harness_run_id
               AND parent.status = 'running' AND parent.terminalized_at IS NULL
               AND parent.cancellation_requested_at IS NULL
               AND parent.attempt_id IS NOT NULL AND parent.lease_owner IS NOT NULL
               AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
        )
      ORDER BY child.lease_expires_at ASC
      LIMIT ?3`,
  ).bind(options.workspaceId ?? null, options.workstreamId ?? null, childLimit)
    .all<{
      id: string;
      workspace_id: string;
      workstream_id: string;
      attempt_id: string;
      lease_expires_at: string;
      parent_harness_run_id: string;
      parent_tool_call_id: string;
      cancellation_requested_at: string | null;
    }>();

  for (const row of childRows.results ?? []) {
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const status = row.cancellation_requested_at ? "stopped" : "failed";
    const error = row.cancellation_requested_at
      ? { code: "run_cancelled", message: "The child run was cancelled" }
      : { code: "parent_run_unavailable", message: "The parent run no longer owns a live attempt" };
    const childResultJson = stableJson({ error, status });
    const childResultHash = await sha256Hex(childResultJson);
    const memberPayload = stableJson({ code: error.code });
    const errorJson = safeErrorJson(error);
    const invalidParentPredicate = `(
      child.cancellation_requested_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM harness_runs parent
         WHERE parent.id = child.parent_harness_run_id
           AND parent.status = 'running' AND parent.terminalized_at IS NULL
           AND parent.cancellation_requested_at IS NULL
           AND parent.attempt_id IS NOT NULL AND parent.lease_owner IS NOT NULL
           AND parent.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    )`;
    const results = await db.batch([
      db.prepare(
        `INSERT INTO harness_run_lifecycle_events
         (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
          event_type, status, member_safe_payload_json, created_at)
         SELECT ?1, child.id, child.workspace_id, child.workstream_id, ?3,
                'terminal', 'terminal', ?6, ?7, ?8
           FROM harness_runs child
          WHERE child.id = ?2 AND child.attempt_id = ?3 AND child.lease_expires_at = ?4
            AND child.parent_harness_run_id = ?5 AND child.parent_tool_call_id IS NOT NULL
            AND child.status = 'running' AND child.terminalized_at IS NULL
            AND child.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ${invalidParentPredicate}
         ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
      ).bind(
        eventId,
        row.id,
        row.attempt_id,
        row.lease_expires_at,
        row.parent_harness_run_id,
        status,
        memberPayload,
        now,
      ),
      db.prepare(
        `UPDATE harness_runs AS child
            SET status = ?6, completed_at = ?7, terminalized_at = ?7,
                error_json = ?8, child_result_json = ?9, child_result_hash = ?10,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE child.id = ?1 AND child.attempt_id = ?2 AND child.lease_expires_at = ?3
            AND child.parent_harness_run_id = ?4 AND child.parent_tool_call_id = ?5
            AND child.status = 'running' AND child.terminalized_at IS NULL
            AND child.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ${invalidParentPredicate}
            AND EXISTS (
              SELECT 1 FROM harness_run_lifecycle_events lifecycle
               WHERE lifecycle.id = ?11 AND lifecycle.harness_run_id = child.id
                 AND lifecycle.attempt_id = child.attempt_id
                 AND lifecycle.event_key = 'terminal'
            )`,
      ).bind(
        row.id,
        row.attempt_id,
        row.lease_expires_at,
        row.parent_harness_run_id,
        row.parent_tool_call_id,
        status,
        now,
        errorJson,
        childResultJson,
        childResultHash,
        eventId,
      ),
    ]);
    if (d1Changes(results[1]) === 0) continue;
    const persisted = await db.prepare(
      `SELECT child_result_json, child_result_hash
         FROM harness_runs
        WHERE id = ?1 AND terminalized_at = ?2 AND parent_tool_call_id = ?3`,
    ).bind(row.id, now, row.parent_tool_call_id)
      .first<{ child_result_json: string | null; child_result_hash: string | null }>();
    const verified = await parseVerifiedInlineChildResult(
      persisted?.child_result_json ?? null,
      persisted?.child_result_hash ?? null,
    );
    if (!verified || verified.status !== status) {
      throw new Error("inline_child_terminal_result_missing");
    }
    reaped.push(row.id);
  }
  return reaped;
}
