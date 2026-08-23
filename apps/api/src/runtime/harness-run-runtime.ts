import { asHarnessRunId, asWorkspaceId, asWorkstreamId, type HarnessRunId, type StructuredFailureDetail, type WorkstreamWorkflowInput } from "@avalon/contracts";

import { uuidV7 } from "../lib/uuid-v7";
import type { HarnessRunObjectPort } from "../durable-objects/workstream-harness-run-protocol";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import type {
  BlockDashboardObjectPort,
} from "../durable-objects/workstream-block-dashboard-protocol";
import type { BlockDashboardPortFactory } from "./block-dashboard-port";
import type { ToolReceiptPortFactory } from "./tool-receipt-port";
import type {
  ToolReceiptAdmission,
  ToolReceiptSettlement,
} from "../durable-objects/workstream-tool-receipt-storage";

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
  childHarnessRunId?: HarnessRunId;
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
  /** The lease owner may close this terminal event even when a member stop is already durable. */
  allowCancellationRequested?: boolean;
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

/**
 * The published spelling of a stored run status.
 *
 * `_runtime_harness_runs` did this remap in SQL — `admitted` as `scheduled`,
 * `cancelled` as `stopped`, `waiting` and `steering` both as `running`. The
 * object has never stored the published spellings, so the translation does not
 * disappear with the view; it moves here, to the one boundary that serves
 * callers written against the published enum.
 */
function publishedRunStatus(stored: string): string {
  switch (stored) {
    case "admitted": return "scheduled";
    case "cancelled": return "stopped";
    case "waiting": case "steering": return "running";
    default: return stored;
  }
}

export async function claimHarnessAttempt(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "harnessRunId">,
  options: AttemptIdentity & { leaseSeconds?: number },
): Promise<AttemptClaim> {
  const leaseSeconds = Math.max(10, Math.min(300, Math.trunc(options.leaseSeconds ?? 60)));
  // One call where the routed version was a three-statement batch followed by
  // one of two diagnostic reads. The claim, its lifecycle event, and the answer
  // to "why not" all come from the same transaction, so the diagnosis cannot
  // describe a row that has moved since the refusal.
  const claim = await runs.claimAttempt({
    runId: input.harnessRunId,
    attemptId: options.attemptId,
    owner: options.owner,
    now: Date.now(),
    leaseSeconds,
    lifecycleEventId: uuidV7(),
  });
  switch (claim.outcome) {
    case "claimed":
      return {
        state: "claimed",
        lease: {
          attemptId: options.attemptId,
          owner: options.owner,
          attemptNumber: claim.attemptEpoch,
          leaseExpiresAt: new Date(claim.leaseExpiresAt).toISOString(),
        },
      };
    case "terminal":
      return { state: "terminal", status: publishedRunStatus(claim.status) as HarnessTerminalStatus };
    case "cancelled":
      return { state: "cancelled" };
    case "busy":
      return {
        state: "busy",
        leaseExpiresAt: claim.activeLeaseExpiresAt === null
          ? null
          : new Date(claim.activeLeaseExpiresAt).toISOString(),
      };
    default:
      throw new Error("harness_run_not_found");
  }
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
  runs: HarnessRunObjectPort,
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
  const childHarnessRunId = options.childHarnessRunId ?? asHarnessRunId(uuidV7());
  const attemptId = options.attemptId ?? uuidV7();
  const owner = options.owner ?? `inline-child:${childHarnessRunId}:${attemptId}`;
  const objectiveHash = await sha256Hex(options.objective);
  const lifecycleId = uuidV7();
  const now = new Date().toISOString();

  // This early assertion gives callers a precise cancellation/ownership error.
  // The INSERT repeats the complete fence, so losing ownership between the
  // assertion and the write cannot admit a child.
  await assertHarnessAttemptOwned(runs, parentInput.harnessRunId, parentLease);
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
      workspaceId: asWorkspaceId(existing.workspace_id),
      workstreamId: asWorkstreamId(existing.workstream_id),
      harnessRunId: asHarnessRunId(existing.id),
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
    await assertHarnessAttemptOwned(runs, parentInput.harnessRunId, parentLease);
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

  await assertHarnessAttemptOwned(runs, parentInput.harnessRunId, parentLease);
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
    workspaceId: asWorkspaceId(row.workspace_id),
    workstreamId: asWorkstreamId(row.workstream_id),
    harnessRunId: asHarnessRunId(row.id),
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
  const lifecycleId = uuidV7();
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
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  scope: ImmutableRunScope,
): Promise<{ scopeHash: string; reused: boolean }> {
  await assertHarnessAttemptOwned(runs, input.harnessRunId, lease);
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
  const persisted = await runs.persistScope({
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
    scopeHash,
    executionPrincipalJson: stableJson(canonicalScope.executionPrincipal),
    eligibleConnectionIdsJson: stableJson(canonicalScope.eligibleConnectionIds),
    eligibleCapabilitiesJson: stableJson(canonicalScope.eligibleCapabilities),
    eligibleConnectionCapabilitiesJson: stableJson(canonicalScope.eligibleConnectionCapabilities),
    triggerPolicyJson: stableJson(canonicalScope.triggerPolicy),
    routingPolicyVersion: canonicalScope.routingPolicyVersion,
    promptVersion: canonicalScope.promptVersion,
    toolSurfaceHash: canonicalScope.toolSurfaceHash,
    memoryContextHash: canonicalScope.memoryContextHash,
    limitsJson: stableJson(canonicalScope.limits),
  });
  if (persisted.outcome === "ownership_lost") throw new RunOwnershipLostError();
  if (persisted.outcome === "mismatch") throw new Error("immutable_run_scope_mismatch");
  return { scopeHash, reused: persisted.outcome === "reused" };
}

/** Persist a child scope only when it is a read-only narrowing of its parent. */
export async function persistInlineChildScope(
  db: D1Database,
  runs: HarnessRunObjectPort,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  childInput: HarnessRunCoordinates,
  childLease: AttemptLease,
  scope: ImmutableRunScope,
): Promise<{ scopeHash: string; reused: boolean }> {
  await assertHarnessAttemptOwned(runs, parentInput.harnessRunId, parentLease);
  await assertInlineChildAttemptOwned(
    runs,
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

  const persisted = await persistImmutableRunScope(runs, childInput, childLease, scope);
  // A scope persisted after the parent lost ownership is never exposed to the
  // child model: this final fence turns the call into an authoritative abort.
  await assertInlineChildAttemptOwned(
    runs,
    parentInput,
    parentLease,
    childInput,
    childLease,
  );
  return persisted;
}

export async function persistRunPluginActivation(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  plugin: { pluginId: string; toolSurfaceHash: string },
): Promise<void> {
  const persisted = await runs.persistPluginActivation({
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
    pluginId: plugin.pluginId,
    toolSurfaceHash: plugin.toolSurfaceHash,
  });
  if (persisted.outcome === "ownership_lost") throw new RunOwnershipLostError();
  if (persisted.outcome === "mismatch") throw new Error("plugin_activation_mismatch");
}

export async function heartbeatHarnessAttempt(
  runs: HarnessRunObjectPort,
  runId: string,
  lease: AttemptLease,
  leaseSeconds = 60,
): Promise<AttemptLease> {
  const boundedSeconds = Math.max(10, Math.min(300, Math.trunc(leaseSeconds)));
  // One round trip where there were three: the update, a re-read to tell a
  // cancelled run from a lost lease when nothing changed, and a third read for
  // the deadline this call had itself just written.
  const beat = await runs.heartbeatAttempt({
    runId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
    leaseSeconds: boundedSeconds,
  });
  if (beat.outcome === "cancelled") throw new RunCancelledError();
  if (beat.outcome === "ownership_lost") throw new RunOwnershipLostError();
  return { ...lease, leaseExpiresAt: new Date(beat.leaseExpiresAt).toISOString() };
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
    // No alias on the UPDATE target: post-cutover this statement lands on the
    // object's INSTEAD-OF-trigger view, and SQLite cannot resolve an alias on
    // a view target ("no such column: child.id"). Qualifying by name works on
    // both a table and a view.
    `UPDATE harness_runs
        SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?8))
      WHERE harness_runs.id = ?4 AND harness_runs.workspace_id = ?2 AND harness_runs.workstream_id = ?3
        AND harness_runs.parent_harness_run_id = ?1
        AND harness_runs.parent_tool_call_id IS NOT NULL
        AND harness_runs.attempt_id = ?5 AND harness_runs.lease_owner = ?6
        AND harness_runs.status = 'running' AND harness_runs.terminalized_at IS NULL
        AND harness_runs.cancellation_requested_at IS NULL
        AND harness_runs.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
  runs: HarnessRunObjectPort,
  runId: string,
  lease: AttemptLease,
): Promise<void> {
  const owned = await runs.attemptOwnership({
    runId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
  });
  if (owned.outcome === "cancelled") throw new RunCancelledError();
  if (owned.outcome === "ownership_lost") throw new RunOwnershipLostError();
}

/**
 * A live lease owner may close an already-started tool after cancellation was
 * requested. This deliberately omits the ordinary cancellation fence:
 * cancellation blocks new work, but it cannot strand the child receipt that the
 * same attempt must settle before terminalizing its parent.
 */
export async function assertHarnessToolSettlementOwned(
  runs: HarnessRunObjectPort,
  runId: string,
  lease: AttemptLease,
): Promise<void> {
  const owned = await runs.attemptOwnership({
    runId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
    allowCancellationRequested: true,
  });
  if (owned.outcome !== "owned") throw new RunOwnershipLostError();
}

export async function assertInlineChildAttemptOwned(
  runs: HarnessRunObjectPort,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  childInput: HarnessRunCoordinates,
  childLease: AttemptLease,
): Promise<void> {
  const owned = await runs.inlineChildOwnership({
    parentRunId: parentInput.harnessRunId,
    parentAttemptId: parentLease.attemptId,
    parentOwner: parentLease.owner,
    childRunId: childInput.harnessRunId,
    childAttemptId: childLease.attemptId,
    childOwner: childLease.owner,
    now: Date.now(),
  });
  if (owned.outcome === "cancelled") throw new RunCancelledError();
  if (owned.outcome === "ownership_lost") throw new RunOwnershipLostError();
}

export async function persistHarnessFinalMessage(
  db: D1Database,
  runs: HarnessRunObjectPort,
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
    await assertHarnessAttemptOwned(runs, input.harnessRunId, lease);
  }
  const lifecycleId = uuidV7();
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
 * Map the object's admission outcome onto the claim callers already handle.
 *
 * `ownership_lost` becomes the exception it always was. The object returns it
 * rather than throwing because an error crossing RPC arrives as an opaque
 * string; the distinction between "your lease moved on" and "the object broke"
 * has to survive the trip, and only the first is a normal end to a run.
 */
function claimFromAdmission(
  admission: ToolReceiptAdmission,
  executionPlanHash: string,
): ToolPlanClaim {
  if (admission.state === "cancelled") throw new RunCancelledError();
  if (admission.state === "ownership_lost") throw new RunOwnershipLostError();
  return { state: admission.state, invocationId: admission.effectIntentId, executionPlanHash };
}

function settlementOrThrow(settlement: ToolReceiptSettlement): "persisted" | "already_persisted" {
  if (settlement === "cancelled") throw new RunCancelledError();
  if (settlement === "ownership_lost") throw new RunOwnershipLostError();
  return settlement;
}

/**
 * Admit a tool call's execution plan against the run's durable receipts.
 *
 * The hashing happens here and the decision happens in the object: hashing is
 * async and the decision must be synchronous to be atomic. What used to be a
 * fence, a two-statement batch, a reconciling read, and — on two paths — a
 * nested settlement, each its own round trip with the lease re-proved in SQL
 * every time, is now one call that cannot be interleaved.
 */
export async function persistToolExecutionPlan(
  receipts: ToolReceiptObjectPort,
  lease: AttemptLease,
  plan: ToolExecutionPlan,
): Promise<ToolPlanClaim> {
  const executionPlanJson = stableJson(plan.plan);
  const executionPlanHash = await sha256Hex(executionPlanJson);
  const compatiblePriorPlanHashes = await Promise.all(
    (plan.compatiblePriorPlans ?? []).map((compatiblePlan) => sha256Hex(stableJson(compatiblePlan))),
  );
  return claimFromAdmission(await receipts.admit({
    effectIntentId: plan.invocationId ?? uuidV7(),
    runId: plan.harnessRunId,
    toolCallId: plan.toolCallId,
    toolName: plan.toolName,
    mode: plan.mode,
    connectionId: plan.connectionId ?? null,
    requestHash: plan.inputHash,
    inputJson: stableJson(plan.input),
    executionPlanHash,
    executionPlanJson,
    compatiblePriorPlanHashes,
    providerIdempotencyKey: plan.providerIdempotencyKey ?? null,
    fence: { runId: plan.harnessRunId, attemptId: lease.attemptId, owner: lease.owner },
    now: Date.now(),
  }), executionPlanHash);
}

export async function checkpointToolInvocation(
  receipts: ToolReceiptObjectPort,
  lease: AttemptLease,
  input: {
    harnessRunId: string;
    invocationId: string;
    checkpointIndex: number;
    phase: string;
    memberSafePayload?: Record<string, unknown>;
  },
): Promise<void> {
  settlementOrThrow(await receipts.checkpoint({
    effectIntentId: input.invocationId,
    checkpointIndex: input.checkpointIndex,
    phase: input.phase,
    payloadJson: stableJson(input.memberSafePayload ?? {}),
    fence: { runId: input.harnessRunId, attemptId: lease.attemptId, owner: lease.owner },
    now: Date.now(),
  }));
}

/**
 * Commit a successful provider result before it is returned to Bind. The caller
 * must durably store the bounded replay payload first and pass its reference
 * here; the object then makes the result replayable and appends its immutable
 * checkpoint in the same transaction.
 */
export async function completeToolInvocation(
  receipts: ToolReceiptObjectPort,
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
    /** Close an already-started receipt even when the parent has a member stop request. */
    allowCancellationRequested?: boolean;
  },
): Promise<"persisted" | "already_persisted"> {
  return settlementOrThrow(await receipts.complete({
    effectIntentId: input.invocationId,
    checkpointIndex: input.checkpointIndex,
    outputRef: input.outputRef,
    outputSummary: input.outputSummary,
    providerOperationId: input.providerOperationId ?? null,
    payloadJson: stableJson(input.memberSafePayload ?? {}),
    allowAmbiguousReconciliation: input.allowAmbiguousReconciliation === true,
    allowCancellationRequested: input.allowCancellationRequested === true,
    fence: { runId: input.harnessRunId, attemptId: lease.attemptId, owner: lease.owner },
    now: Date.now(),
  }));
}

/**
 * Make a failed or ambiguous tool receipt terminal. The appended checkpoint and
 * the terminal mutation commit together or neither commits.
 */
export async function finalizeToolInvocationFailure(
  receipts: ToolReceiptObjectPort,
  lease: AttemptLease,
  input: ToolInvocationFailure,
): Promise<"persisted" | "already_persisted"> {
  const code = input.error.code.slice(0, 120);
  return settlementOrThrow(await receipts.fail({
    effectIntentId: input.invocationId,
    status: input.status,
    phase: input.phase.slice(0, 120),
    errorJson: JSON.stringify({
      code,
      message: input.error.message.slice(0, 500),
      ...(input.error.data ? { data: input.error.data } : {}),
    }),
    payloadJson: stableJson(input.memberSafePayload ?? { code }),
    allowCancellationRequested: input.allowCancellationRequested === true,
    fence: { runId: input.harnessRunId, attemptId: lease.attemptId, owner: lease.owner },
    now: Date.now(),
  }));
}

export async function markToolInvocationTimedOut(
  receipts: ToolReceiptObjectPort,
  lease: AttemptLease,
  input: { harnessRunId: string; invocationId: string; mayHaveWritten: boolean },
): Promise<"failed" | "ambiguous"> {
  const status = input.mayHaveWritten ? "ambiguous" : "failed";
  const code = input.mayHaveWritten ? "ambiguous_external_write" : "tool_timeout";
  await finalizeToolInvocationFailure(receipts, lease, {
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
    private readonly runs: HarnessRunObjectPort,
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
            this.runs,
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
  runs: HarnessRunObjectPort,
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
  const lifecycleId = uuidV7();
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
      // Alias-free for the same reason as the inline-child heartbeat: the
      // object's harness_runs is an INSTEAD-OF-trigger view, and SQLite cannot
      // resolve an alias on a view UPDATE target.
      `UPDATE harness_runs
          SET status = ?8, completed_at = ?9, terminalized_at = ?9,
              model = COALESCE(?10, model), usage_json = COALESCE(?11, usage_json),
              error_json = ?12, child_result_json = ?13, child_result_hash = ?14,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE harness_runs.id = ?5 AND harness_runs.workspace_id = ?3 AND harness_runs.workstream_id = ?4
          AND harness_runs.parent_harness_run_id = ?2
          AND harness_runs.parent_tool_call_id IS NOT NULL
          AND harness_runs.attempt_id = ?6 AND harness_runs.lease_owner = ?7
          AND harness_runs.terminalized_at IS NULL
          AND (?8 = 'stopped' OR harness_runs.cancellation_requested_at IS NULL)
          AND harness_runs.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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

const RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY = "residual_receipts_settled";

interface TerminalizedReceiptRepair {
  runId: string;
  workspaceId: string;
  workstreamId: string;
  attemptId: string;
  status: HarnessTerminalStatus;
  terminalizedAt: string;
  errorJson: string | null;
  memberSafePayloadJson: string;
  parentToolCallId: string | null;
  /**
   * Whether the run wrote its own terminal row or was reaped after its lease
   * lapsed. Only a reaped run may tell a member its lease was lost; a run that
   * terminalized under its own executor and still left a receipt open did so
   * for some other reason, and saying "lost its durable lease" would send
   * whoever reads the card looking for an infrastructure fault that never
   * happened.
   */
  terminalization: "direct" | "reaped";
}

/**
 * Which path terminalized a run, read back from the row it left behind rather
 * than from who is asking. A retry — the repeated `terminalizeHarnessAttempt`
 * call or the bounded sweep — has to reproduce the wording its first pass would
 * have written, or the same receipt gets two different explanations depending
 * on which retry happened to close it.
 *
 * `stale_run_reaped` is read as the reaper's signature, not as one error code
 * among many: it is written in exactly one place, by the pass that terminalizes
 * a root whose lease lapsed. A future path that writes that code without having
 * observed a lease lapse would silently start telling members their lease was
 * lost, so it belongs to the reaper alone.
 */
function terminalizationOf(
  errorJson: string | null,
  parentToolCallId: string | null,
): "direct" | "reaped" {
  if (parentToolCallId !== null) return "reaped";
  return readErrorCode(errorJson) === "stale_run_reaped" ? "reaped" : "direct";
}

/** The `code` of a stored `{"code","message"}` run error, when it has one. */
function readErrorCode(errorJson: string | null): string | null {
  if (!errorJson) return null;
  try {
    const parsed: unknown = JSON.parse(errorJson);
    if (typeof parsed === "object" && parsed !== null && "code" in parsed) {
      const code: unknown = (parsed as { code: unknown }).code;
      return typeof code === "string" ? code : null;
    }
  } catch {
    // A terminal row from an older shape carries no readable code. Treating it
    // as "not reaped" keeps the direct wording, which is the safe default: it
    // states only that the run ended, never that a lease was lost.
  }
  return null;
}

function receiptRepairFailure(row: TerminalizedReceiptRepair): {
  phase: string;
  errorJson: string;
  payloadJson: string;
  ambiguousMessage: string;
} {
  const stopped = row.status === "stopped";
  const child = row.parentToolCallId !== null;
  // A root that wrote its own terminal row. The lease was never lost, so the
  // reaper's wording would be a fabricated cause; all that is known is that the
  // run ended with this tool still open.
  const directRoot = !child && !stopped && row.terminalization === "direct";
  return {
    phase: stopped ? "cancelled" : "failed",
    // A stopped root keeps the pre-existing member-safe receipt contract:
    // the detailed stop reason belongs to the terminal run, while a tool that
    // never returned gets the generic cancellation fallback. Child reaping
    // preserves its own persisted child error when one exists.
    errorJson: stopped
      ? child
        ? row.errorJson ?? JSON.stringify({ code: "run_cancelled", message: "The child run was cancelled" })
        : JSON.stringify({ code: "run_cancelled", message: "The run stopped before the tool produced a result" })
      : child
        ? row.errorJson ?? JSON.stringify({ code: "run_failed", message: "The child run ended before the tool produced a result" })
        : directRoot
          ? JSON.stringify({ code: "run_terminated", message: "The run ended before the tool produced a result" })
          : JSON.stringify({ code: "parent_run_terminated", message: "The parent run lost its durable lease" }),
    payloadJson: stopped && !child
      ? '{"code":"run_cancelled"}'
      : row.memberSafePayloadJson,
    ambiguousMessage: child
      ? "The child run ended while an external write was unresolved"
      : stopped
        ? "The run stopped while an external write was unresolved"
        : directRoot
          ? "The run ended while an external write was unresolved"
          : "The parent run lost its durable lease while an external write was in flight",
  };
}

async function recordResidualReceiptsSettled(
  db: D1Database,
  row: TerminalizedReceiptRepair,
): Promise<void> {
  const markerId = uuidV7();
  const result = await db.prepare(
    `INSERT INTO harness_run_lifecycle_events
       (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
        event_type, status, member_safe_payload_json, created_at)
     SELECT ?1, id, workspace_id, workstream_id, attempt_id, ?2,
            'receipt_reconciliation', status, '{}', ?3
       FROM harness_runs
      WHERE id = ?4 AND workspace_id = ?5 AND workstream_id = ?6
        AND attempt_id = ?7 AND terminalized_at = ?3
     ON CONFLICT(harness_run_id, event_key) DO NOTHING`,
  ).bind(
    markerId,
    RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY,
    row.terminalizedAt,
    row.runId,
    row.workspaceId,
    row.workstreamId,
    row.attemptId,
  ).run();
  if (d1Changes(result) > 0) return;
  const existing = await db.prepare(
    `SELECT 1 AS ok FROM harness_run_lifecycle_events
      WHERE harness_run_id = ?1 AND attempt_id = ?2 AND event_key = ?3`,
  ).bind(row.runId, row.attemptId, RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY)
    .first<{ ok: number }>();
  if (!existing) throw new Error("residual_receipt_reconciliation_not_recorded");
}

async function settleAndRecordResidualReceipts(
  db: D1Database,
  receipts: ToolReceiptObjectPort,
  row: TerminalizedReceiptRepair,
  beforeRecord?: () => Promise<void>,
): Promise<void> {
  const fallback = receiptRepairFailure(row);
  const result = await receipts.settleResidualReceipts({
    runId: row.runId,
    attemptId: row.attemptId,
    lease: { kind: "terminalized", at: Date.parse(row.terminalizedAt) },
    ...fallback,
    now: Date.parse(row.terminalizedAt),
  });
  if (result.open > 0) throw new Error("residual_receipts_not_settled");
  await beforeRecord?.();
  await recordResidualReceiptsSettled(db, row);
}

/**
 * Everything a terminalized run left open outside its own receipts, settled
 * before the marker that says its reconciliation finished.
 *
 * Two authorities, and both are reached the same way and for the same reason:
 * neither can be another statement in the batch that terminalized the run — the
 * block lives in its own object and the automation run in another database —
 * and each re-reads the run's `terminalized_at` inside its own transaction, so
 * a run since taken over is not closed by the sweep that lost it. Running them
 * here rather than beside the batch is what makes a transient failure retried:
 * `settleAndRecordResidualReceipts` records nothing when this throws, and the
 * bounded sweep comes back for every terminal run missing that marker.
 *
 * `abandonBlockRun` is called for every run, not only a HyperSight one, and not
 * because this run has a block — it may well not. The operation also repairs
 * blocks whose runs are already terminal but which never settled, the state a
 * failed settlement RPC leaves behind and which no selector here can find
 * again. Gating it on the run's own origin would mean a work stream whose later
 * stale runs happen to be ordinary ones never clears its orphan. The cost is
 * one round trip per run on a sweep that already makes one for receipts.
 */
function settleOtherAuthorities(
  options: { blocks: BlockDashboardPortFactory },
  automationDatabase: D1Database | null,
  origin: string,
  repair: TerminalizedReceiptRepair,
): () => Promise<void> {
  return async () => {
    await options.blocks(repair.workspaceId, repair.workstreamId).abandonBlockRun({
      harnessRunId: repair.runId,
      terminalizedAt: Date.parse(repair.terminalizedAt),
      errorJson: JSON.stringify({
        code: "stale_run_reaped",
        message: "The HyperSight refresh lost its durable lease",
      }),
    });
    // A reaped root only. `settleStaleAutomationRun` matches every
    // `scheduled`/`running` automation row in the work stream rather than this
    // run's own, which is safe for a lease that demonstrably lapsed and is not
    // safe for the ordinary terminal rows the repair walk now also visits:
    // backfilling a marker onto a year-old failed run would fail whichever
    // automation happens to be running in that work stream now. The walk's
    // predicate used to make `status = 'failed'` imply `stale_run_reaped`; it
    // no longer does, so the implication is stated.
    //
    // Only this arm. `abandonBlockRun` above stays unconditional for the reason
    // its own comment gives — it repairs orphans no selector can find again,
    // and narrowing it would leave them.
    if (
      repair.terminalization === "reaped"
      && repair.status === "failed"
      && repair.parentToolCallId === null
      && origin !== "block_dashboard_block"
    ) {
      await settleStaleAutomationRun(automationDatabase, repair);
    }
  };
}

async function settleStaleAutomationRun(
  db: D1Database | null,
  row: Pick<TerminalizedReceiptRepair, "workspaceId" | "workstreamId" | "terminalizedAt">,
): Promise<void> {
  if (!db) return;
  await db.prepare(
    `UPDATE automation_runs
        SET status = 'failed', completed_at = ?1,
            result_summary = COALESCE(
              result_summary,
              'The harness executor lost its durable lease'
            )
      WHERE workstream_id = ?2 AND workspace_id = ?3
        -- A later continuation legitimately owns needs_input. Historical
        -- receipt backfill must not turn that newer member-visible wait into
        -- failure for an earlier stale executor in the same work stream.
        AND status IN ('scheduled', 'running')`,
  ).bind(row.terminalizedAt, row.workstreamId, row.workspaceId).run();
}

export async function terminalizeHarnessAttempt(
  db: D1Database,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  outcome: TerminalOutcome,
  receipts: ToolReceiptObjectPort,
  blocks: BlockDashboardObjectPort,
): Promise<"terminalized" | "already_terminal"> {
  const target = await db.prepare(
    `SELECT origin FROM harness_runs
      WHERE id = ? AND workspace_id = ? AND workstream_id = ? AND parent_tool_call_id IS NULL`,
  ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{ origin: string }>();
  if (!target) throw new Error("harness_run_not_found");
  if (outcome.status === "completed") {
    if (target.origin === "block_dashboard_block") {
      // The block's own record, read through the object that owns it. A
      // HyperSight run that has not produced markdown has not produced the
      // thing it exists for, and calling it completed leaves a member looking
      // at an empty block the product believes succeeded.
      if (!await blocks.hasPersistedResult({ harnessRunId: input.harnessRunId })) {
        throw new Error("block_dashboard_result_not_persisted");
      }
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
  const lifecycleId = uuidV7();
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
  if (d1Changes(results[1]) > 0) {
    // Every receipt this run still had open is classified and closed now that
    // the run is terminal, because a terminal run must not leave a tool card
    // spinning. A write caught mid-flight becomes `ambiguous` rather than
    // `failed`: the provider may already have performed it, and the run ending
    // is not evidence either way.
    //
    // Every terminal status, not only `stopped`. A run that ends any other way
    // is *supposed* to have settled each receipt as its tool returned, so an
    // open one here is a defect — but a defect whose only symptom is a card
    // that spins forever, because nothing downstream repairs it: the bounded
    // sweep only revisits rows that reached this call, and a `failed` root is
    // not reachable from a member's next message either. The narrow reading of
    // "must not leave a card spinning" cost fourteen hours of spinner on a
    // `load_plugin` whose run failed between `tool_started` and the guard that
    // reports `tool_failed`. This is the backstop for that whole class, so it
    // must not be re-narrowed to the paths currently known to need it.
    //
    // After the terminal write rather than before it, and in a second call
    // rather than the same transaction, because the lifecycle row is in this
    // database and the receipts are in the work stream's object. Of the two
    // possible orderings only this one fails safe — see
    // `settleResidualReceipts`.
    await settleAndRecordResidualReceipts(db, receipts, {
      runId: input.harnessRunId,
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      attemptId: lease.attemptId,
      status: outcome.status,
      terminalizedAt: now,
      errorJson: safeErrorJson(outcome.error),
      memberSafePayloadJson: payload,
      parentToolCallId: null,
      terminalization: "direct",
    });
    return "terminalized";
  }
  const existing = await db.prepare(
    `SELECT run.attempt_id, run.status, run.terminalized_at, run.error_json,
            COALESCE(terminal.member_safe_payload_json, '{}') AS member_safe_payload_json,
            EXISTS (
              SELECT 1 FROM harness_run_lifecycle_events settled
               WHERE settled.harness_run_id = run.id
                 AND settled.attempt_id = run.attempt_id
                 AND settled.event_key = ?2
            ) AS receipts_reconciled
       FROM harness_runs run
       LEFT JOIN harness_run_lifecycle_events terminal
         ON terminal.harness_run_id = run.id AND terminal.event_key = 'terminal'
      WHERE run.id = ?1 AND run.parent_tool_call_id IS NULL`,
  ).bind(input.harnessRunId, RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY).first<{
    attempt_id: string | null;
    status: string;
    terminalized_at: string | null;
    error_json: string | null;
    member_safe_payload_json: string;
    receipts_reconciled: number;
  }>();
  if (existing?.attempt_id === lease.attemptId && existing.terminalized_at && existing.status === outcome.status) {
    // The terminal row landed but the settlement that follows it did not, so
    // this repeat of the same call finishes the protocol rather than reporting
    // a run whose card is still open as fully settled.
    if (existing.receipts_reconciled === 0) {
      await settleAndRecordResidualReceipts(db, receipts, {
        runId: input.harnessRunId,
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        attemptId: lease.attemptId,
        status: outcome.status,
        terminalizedAt: existing.terminalized_at,
        errorJson: existing.error_json,
        memberSafePayloadJson: existing.member_safe_payload_json,
        parentToolCallId: null,
        // Derived, not assumed: the row reached this branch because *some*
        // first pass terminalized it and lost its settlement, and that pass was
        // not necessarily this executor. The stale-lease reaper keeps
        // `attempt_id` and only clears the lease, so a reaped root whose
        // settlement was lost matches every predicate above when its original
        // executor returns — and hardcoding `direct` would then write
        // `run_terminated` where the reaper's own retry writes
        // `parent_run_terminated`. Same reason the sweep re-derives it.
        terminalization: terminalizationOf(existing.error_json, null),
      });
    }
    return "already_terminal";
  }
  throw new RunOwnershipLostError();
}

export async function recordInferenceAttempt(
  runs: HarnessRunObjectPort,
  record: InferenceAttemptRecord,
): Promise<string> {
  const id = record.id ?? uuidV7();
  await runs.recordInferenceAttempt({
    inferenceAttemptId: id,
    runId: record.harnessRunId,
    attemptId: record.attemptId,
    turnId: record.turnId,
    endpointAttempt: record.endpointAttempt,
    fallbackAttempt: record.fallbackAttempt,
    provider: record.provider,
    model: record.model,
    credentialSourceHash: record.credentialSourceHash ?? null,
    workspaceIdentityHash: record.workspaceIdentityHash,
    routingDecisionJson: stableJson(record.routingDecision ?? {}),
    outcome: record.outcome,
    failureClassification: record.failureClassification ?? null,
    latencyMs: record.latencyMs ?? null,
    ttftMs: record.ttftMs ?? null,
    inputTokens: record.inputTokens ?? null,
    outputTokens: record.outputTokens ?? null,
    reasoningTokens: record.reasoningTokens ?? null,
    cachedTokens: record.cachedTokens ?? null,
    costMicros: record.costMicrousd ?? null,
    responseBytes: record.responseBytes ?? null,
    startedAt: Date.parse(record.startedAt),
    completedAt: Date.parse(record.completedAt),
    now: Date.now(),
  });
  return id;
}

export async function reapStaleHarnessRuns(
  db: D1Database,
  options: {
    workspaceId?: string;
    workstreamId?: string;
    limit?: number;
    /** WorkspaceDO authority for automation settlement; null for block-only runtimes. */
    automationDatabase?: D1Database | null;
    /**
     * How to reach a run's receipt authority. Required rather than defaulted:
     * a sweep that terminalizes a run and silently leaves its receipts
     * `executing` is worse than one that fails to start, and a default would
     * make that the quiet outcome of forgetting to wire it.
     */
    receipts: ToolReceiptPortFactory;
    /** A terminal row that could not be reconciled must not block run admission. */
    onReceiptRepairFailure?: (failure: {
      phase: "terminal_repair" | "stale_root" | "stale_child";
      runId: string;
      workspaceId: string;
      workstreamId: string;
      attemptId: string;
      reason: string;
    }) => void;
    /**
     * How to reach a run's HyperSight block authority. Required for the reason
     * `receipts` is: a sweep that terminalizes a block's run and leaves the
     * block `running` is worse than one that fails to start.
     */
    blocks: BlockDashboardPortFactory;
  },
): Promise<string[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const blockOnly = options.automationDatabase === null ? 1 : 0;
  // Reaping work, which the root and child passes share. The repair pass below
  // is bounded by its own `LIMIT` and deliberately does not count against this.
  const reaped: string[] = [];
  let processed = 0;

  // Terminalization and receipt settlement cross object calls. If the second
  // call failed, the terminal row is the durable authority and this marker is
  // absent. Repair those rows first so a run cannot be permanently terminal
  // while its member-visible tool card remains open. Successful repairs record
  // the marker, so the bounded walk makes forward progress instead of scanning
  // the same historical rows on every activation.
  //
  // On its own budget, deliberately. This pass and the two reaps below used to
  // share one, which was harmless while the pass could only select the three
  // paths that wrote a marker. It selects every unmarked terminal row now, so a
  // shared budget would let a history backfill return before the stale-lease
  // reap ran at all — and that reap is the only recovery for an executor that
  // died without terminalizing, which is the worse of the two ways a tool card
  // gets stranded. A backfill must never delay it.
  const repairRows = await db.prepare(
    `SELECT run.id, run.workspace_id, run.workstream_id, run.attempt_id, run.origin,
            run.status, run.terminalized_at, run.error_json,
            run.parent_tool_call_id,
            COALESCE(terminal.member_safe_payload_json, '{}') AS member_safe_payload_json
       FROM harness_runs run
       LEFT JOIN harness_run_lifecycle_events terminal
         ON terminal.harness_run_id = run.id AND terminal.event_key = 'terminal'
      WHERE run.status IN ('completed', 'needs_input', 'failed', 'stopped')
        AND run.terminalized_at IS NOT NULL
        AND run.attempt_id IS NOT NULL
        -- Every terminal-first path attempts residual settlement, so every
        -- terminal row is a candidate for the retry. The predicate used to name
        -- the three paths that did — member-stopped roots, reaped children,
        -- stale-lease roots — which meant a completed or directly-failed root
        -- that lost its settlement response was matched by nothing at all
        -- and kept a tool card spinning forever. Naming paths here is what made
        -- that possible; do not narrow it back to a list.
        --
        -- The cost is that rows terminalized before this became universal have
        -- no marker either, so the walk backfills them a bounded page at a time
        -- before it reaches the stale-lease reap below. That drains within a few
        -- dispatches of one work stream and each repaired row records its
        -- marker, so it is paid once rather than on every activation.
        AND (?1 IS NULL OR run.workspace_id = ?1)
        AND (?2 IS NULL OR run.workstream_id = ?2)
        AND (?4 = 0 OR run.parent_tool_call_id IS NOT NULL OR run.origin = 'block_dashboard_block')
        AND NOT EXISTS (
          SELECT 1 FROM harness_run_lifecycle_events settled
           WHERE settled.harness_run_id = run.id
             AND settled.attempt_id = run.attempt_id
             AND settled.event_key = ?3
        )
      -- Newest first, for one reason: a card stranded minutes ago is the one a
      -- member is looking at, and it must not wait behind every historical row
      -- in the work stream.
      --
      -- Not because it helps with a row that can never settle. One whose
      -- object-side terminal stamp does not match records no marker however
      -- often it is tried, so it is re-selected forever and holds a slot in
      -- every page; ordering only decides which such rows do the holding --
      -- newest-first wedges recent ones, oldest-first wedges old ones -- and
      -- neither drops them. Enough of them in one work stream (this walk is
      -- scoped to one) and the rest of its history is never reached. Paginating
      -- past them needs durable per-row retry state and a backoff nobody here
      -- can derive a number for, so it is not built on speculation: each
      -- failure already reports through onReceiptRepairFailure, which the
      -- Substream logs as harness_residual_receipt_repair_failed, and a wedged
      -- page is that warning repeating the same run id.
      ORDER BY run.terminalized_at DESC, run.id DESC
      LIMIT ?5`,
  ).bind(
    options.workspaceId ?? null,
    options.workstreamId ?? null,
    RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY,
    blockOnly,
    limit,
  ).all<{
    id: string;
    workspace_id: string;
    workstream_id: string;
    attempt_id: string;
    origin: string;
    status: HarnessTerminalStatus;
    terminalized_at: string;
    error_json: string | null;
    parent_tool_call_id: string | null;
    member_safe_payload_json: string;
  }>();
  for (const row of repairRows.results ?? []) {
    // A retry has to reproduce the wording its first pass would have written,
    // so it re-derives which path terminalized the row rather than assuming
    // one. Reaping is what a lapsed lease and a reaped child have in common;
    // everything else wrote its own terminal row.
    const terminalization = terminalizationOf(row.error_json, row.parent_tool_call_id);
    const repair = {
      runId: row.id,
      workspaceId: row.workspace_id,
      workstreamId: row.workstream_id,
      attemptId: row.attempt_id,
      status: row.status,
      terminalizedAt: row.terminalized_at,
      errorJson: row.error_json,
      memberSafePayloadJson: row.member_safe_payload_json,
      parentToolCallId: row.parent_tool_call_id,
      terminalization,
    } satisfies TerminalizedReceiptRepair;
    try {
      await settleAndRecordResidualReceipts(
        db,
        options.receipts(row.workspace_id, row.workstream_id),
        repair,
        settleOtherAuthorities(
          options,
          options.automationDatabase === undefined ? db : options.automationDatabase,
          row.origin,
          repair,
        ),
      );
    } catch (error) {
      options.onReceiptRepairFailure?.({
        phase: "terminal_repair",
        runId: repair.runId,
        workspaceId: repair.workspaceId,
        workstreamId: repair.workstreamId,
        attemptId: repair.attemptId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // No early return on a full repair page: the reaps below are the
  // time-sensitive half and must run on every activation.

  // Ordinary attempts are the only runs whose expired lease is itself a
  // terminal condition. An inline child is deliberately reclaimable while its
  // parent still owns a live attempt, so including children in this query
  // races the child's idempotent takeover path.
  //
  // This pass is the only recovery for an executor that died without
  // terminalizing at all, and nothing schedules it: `reapStaleHarnessRuns` is
  // called from one place, immediately before a new attempt is claimed
  // (`substream-agent.ts`, and its BlockDashboard twin). A work stream nobody
  // sends another message to therefore keeps such a run `running` and its tool
  // card spinning indefinitely. Closing that needs the object to wake on its
  // own expired lease, which is a wake reason and belongs to
  // `docs/durable-object-alarms.md` rather than to this function.
  const rows = await db.prepare(
    `SELECT id, workspace_id, workstream_id, attempt_id, lease_expires_at, origin
       FROM harness_runs
      WHERE status = 'running' AND terminalized_at IS NULL
        AND parent_tool_call_id IS NULL
        AND attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND (?1 IS NULL OR workspace_id = ?1)
        AND (?2 IS NULL OR workstream_id = ?2)
        AND (?3 = 0 OR origin = 'block_dashboard_block')
      ORDER BY lease_expires_at ASC
      LIMIT ?4`,
  ).bind(
    options.workspaceId ?? null,
    options.workstreamId ?? null,
    blockOnly,
    limit - processed,
  )
    .all<{
      id: string;
      workspace_id: string;
      workstream_id: string;
      attempt_id: string;
      lease_expires_at: string;
      origin: string;
    }>();
  for (const row of rows.results ?? []) {
    const now = new Date().toISOString();
    const eventId = uuidV7();
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
      processed += 1;
      // Every live-lease receipt operation must refuse here because that lease
      // is precisely what expired. Residual settlement instead re-reads this
      // exact terminal stamp inside the object transaction. Its lifecycle
      // marker lands only after receipt settlement and the run's other
      // authority — its block, or its automation run — both succeed, so a later
      // bounded sweep retries a transient second-call failure.
      const repair = {
        runId: row.id,
        workspaceId: row.workspace_id,
        workstreamId: row.workstream_id,
        attemptId: row.attempt_id,
        status: "failed",
        terminalizedAt: now,
        // The stale-run error is already durable on `harness_runs`. Residual
        // root receipts intentionally keep the predecessor's generic
        // `parent_run_terminated` fallback, so there is no receipt error to
        // thread through this shared shape.
        errorJson: null,
        memberSafePayloadJson: '{"code":"stale_run_reaped"}',
        parentToolCallId: null,
        terminalization: "reaped",
      } satisfies TerminalizedReceiptRepair;
      const automationDatabase = options.automationDatabase === undefined
        ? db
        : options.automationDatabase;
      try {
        await settleAndRecordResidualReceipts(
          db,
          options.receipts(row.workspace_id, row.workstream_id),
          repair,
          settleOtherAuthorities(options, automationDatabase, row.origin, repair),
        );
      } catch (error) {
        options.onReceiptRepairFailure?.({
          phase: "stale_root",
          runId: repair.runId,
          workspaceId: repair.workspaceId,
          workstreamId: repair.workstreamId,
          attemptId: repair.attemptId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const childLimit = limit - processed;
  if (childLimit <= 0) return reaped;

  // Children are cleaned up only after their own lease expires and their
  // parent can no longer supervise them. A stale child beneath a live parent
  // is intentionally omitted so the same parent tool-call receipt can reclaim
  // its durable attempt. Both the snapshot and the updates below repeat these
  // predicates, fencing a parent/child heartbeat that wins the race.
  const childRows = await db.prepare(
    `SELECT child.id, child.workspace_id, child.workstream_id, child.attempt_id,
            child.lease_expires_at, child.parent_harness_run_id,
            child.parent_tool_call_id, child.cancellation_requested_at,
            child.lease_owner
       FROM harness_runs child
      WHERE child.status = 'running' AND child.terminalized_at IS NULL
        AND child.parent_harness_run_id IS NOT NULL
        AND child.parent_tool_call_id IS NOT NULL
        AND child.attempt_id IS NOT NULL AND child.lease_owner IS NOT NULL
        AND child.lease_expires_at IS NOT NULL
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
      lease_owner: string;
    }>();

  for (const row of childRows.results ?? []) {
    const now = new Date().toISOString();
    const eventId = uuidV7();
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
            AND child.lease_owner = ?9 AND child.parent_harness_run_id = ?5
            AND child.parent_tool_call_id IS NOT NULL
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
        row.lease_owner,
      ),
      db.prepare(
        // Alias-free because the object's harness_runs is an INSTEAD-OF-trigger
        // view and SQLite cannot resolve an alias on a view UPDATE target; the
        // outer rows correlate into the subqueries by the view's own name.
        `UPDATE harness_runs
            SET status = ?6, completed_at = ?7, terminalized_at = ?7,
                error_json = ?8, child_result_json = ?9, child_result_hash = ?10,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE harness_runs.id = ?1 AND harness_runs.attempt_id = ?2 AND harness_runs.lease_expires_at = ?3
            AND harness_runs.lease_owner = ?12 AND harness_runs.parent_harness_run_id = ?4
            AND harness_runs.parent_tool_call_id = ?5
            AND harness_runs.status = 'running' AND harness_runs.terminalized_at IS NULL
            AND harness_runs.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ${invalidParentPredicate.replaceAll("child.", "harness_runs.")}
            AND EXISTS (
              SELECT 1 FROM harness_run_lifecycle_events lifecycle
               WHERE lifecycle.id = ?11 AND lifecycle.harness_run_id = harness_runs.id
                 AND lifecycle.attempt_id = harness_runs.attempt_id
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
        row.lease_owner,
      ),
    ]);
    if (d1Changes(results[1]) === 0) continue;
    // Same rule, and the same ordering, as a stopped parent: the child's own
    // receipts are classified and closed once it is terminal.
    const repair = {
        runId: row.id,
        workspaceId: row.workspace_id,
        workstreamId: row.workstream_id,
        attemptId: row.attempt_id,
        status,
        terminalizedAt: now,
        errorJson,
        memberSafePayloadJson: memberPayload,
        parentToolCallId: row.parent_tool_call_id,
        terminalization: "reaped",
    } satisfies TerminalizedReceiptRepair;
    try {
      await settleAndRecordResidualReceipts(
        db,
        options.receipts(row.workspace_id, row.workstream_id),
        repair,
      );
    } catch (receiptError) {
      options.onReceiptRepairFailure?.({
        phase: "stale_child",
        runId: repair.runId,
        workspaceId: repair.workspaceId,
        workstreamId: repair.workstreamId,
        attemptId: repair.attemptId,
        reason: receiptError instanceof Error ? receiptError.message : String(receiptError),
      });
    }
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
