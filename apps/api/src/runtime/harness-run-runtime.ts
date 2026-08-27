import { asHarnessRunId, type HarnessRunId, type StructuredFailureDetail, type WorkstreamWorkflowInput } from "@rally/contracts";

import { uuidV7 } from "../lib/uuid-v7";
import type { HarnessRunObjectPort } from "../durable-objects/workstream-harness-run-protocol";
import type { MessageObjectPort } from "../durable-objects/workstream-message-protocol";
import { TERMINAL_RUN_STATUSES } from "../durable-objects/workstream-harness-run-storage";
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

// The *published* vocabulary. `TERMINAL_RUN_STATUSES`, imported from the
// storage class, is the same set in the object's own words, where this
// `stopped` is `cancelled`. Which one applies depends on whether the value came
// off a `RunRow` or out of a published payload.
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
      reason: "chain_budget_exhausted" | "depth_limit";
    };

export interface AdmitInlineChildOptions extends Partial<AttemptIdentity> {
  parentToolCallId: string;
  objective: string;
  childHarnessRunId?: HarnessRunId;
  maxChainRuns?: number;
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
export function publishedRunStatus(stored: string): string {
  switch (stored) {
    case "admitted": return "scheduled";
    case "cancelled": return "stopped";
    case "waiting": case "steering": return "running";
    default: return stored;
  }
}

/**
 * The inverse, for a status on its way *into* the object.
 *
 * Only `stopped` needs translating: the runtime never writes `scheduled`,
 * `waiting` or `steering` — those are states the object reaches on its own.
 */
function storedRunStatus(published: string): string {
  return published === "stopped" ? "cancelled" : published;
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
  runs: HarnessRunObjectPort,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  options: AdmitInlineChildOptions,
): Promise<InlineChildAdmission> {
  if (!options.parentToolCallId.trim()) throw new Error("parent_tool_call_id_required");
  if (!options.objective.trim()) throw new Error("child_objective_required");
  const childHarnessRunId = options.childHarnessRunId ?? asHarnessRunId(uuidV7());
  const attemptId = options.attemptId ?? uuidV7();
  const admitted = await runs.admitInlineChild({
    parentRunId: parentInput.harnessRunId,
    parentAttemptId: parentLease.attemptId,
    parentOwner: parentLease.owner,
    parentToolCallId: options.parentToolCallId,
    childRunId: childHarnessRunId,
    childAttemptId: attemptId,
    childOwner: options.owner ?? `inline-child:${childHarnessRunId}:${attemptId}`,
    objectiveHash: await sha256Hex(options.objective),
    leaseSeconds: Math.max(10, Math.min(300, Math.trunc(options.leaseSeconds ?? 60))),
    maxDepth: Math.max(1, Math.min(16, Math.trunc(options.maxDepth ?? 2))),
    maxChainRuns: Math.max(2, Math.min(64, Math.trunc(options.maxChainRuns ?? 4))),
    lifecycleEventId: uuidV7(),
    now: Date.now(),
  });

  if (admitted.outcome === "ownership_lost") throw new RunOwnershipLostError();
  if (admitted.outcome === "cancelled") throw new RunCancelledError();
  if (admitted.outcome === "objective_mismatch") throw new Error("inline_child_objective_mismatch");
  if (admitted.outcome === "parent_scope_missing") {
    throw new Error("inline_child_parent_scope_missing");
  }
  if (admitted.outcome === "refused") return { state: "refused", reason: admitted.reason };

  const childInput = {
    workspaceId: parentInput.workspaceId,
    workstreamId: parentInput.workstreamId,
    harnessRunId: asHarnessRunId(admitted.childRunId),
  };
  if (admitted.outcome === "replay") {
    const outcome = await parseVerifiedInlineChildResult(
      admitted.childResultJson,
      admitted.childResultHash,
    );
    if (!outcome) throw new Error("inline_child_terminal_result_missing");
    return { state: "replay", childInput, outcome };
  }
  if (admitted.outcome === "busy") {
    return {
      state: "busy",
      childInput,
      leaseExpiresAt: admitted.leaseExpiresAt === null
        ? null
        : new Date(admitted.leaseExpiresAt).toISOString(),
    };
  }
  return {
    state: "claimed",
    childInput,
    lease: {
      attemptId: admitted.attemptId,
      owner: admitted.owner,
      attemptNumber: admitted.attemptEpoch,
      leaseExpiresAt: new Date(admitted.leaseExpiresAt).toISOString(),
    },
    chainRootRunId: admitted.chainRootRunId,
    chainDepth: admitted.chainDepth,
    reused: admitted.reused,
  };
}

export async function loadInlineChildResult(
  runs: HarnessRunObjectPort,
  parentInput: HarnessRunCoordinates,
  parentToolCallId: string,
): Promise<InlineChildResultLookup> {
  const row = await runs.inlineChildByToolCall({
    parentRunId: parentInput.harnessRunId,
    parentToolCallId,
  });
  if (!row) return { state: "missing" };
  // A sub-agent is always in its parent's work stream — a delegated run is a
  // fork of this conversation, not a new one — so the coordinates are the
  // caller's own rather than columns projected back out of the row.
  const childInput = {
    workspaceId: parentInput.workspaceId,
    workstreamId: parentInput.workstreamId,
    harnessRunId: asHarnessRunId(row.run_id),
  };
  if (row.terminalized_at === null && !TERMINAL_RUN_STATUSES.has(row.status)) {
    return {
      state: "running",
      childInput,
      leaseExpiresAt: row.lease_expires_at === null
        ? null
        : new Date(row.lease_expires_at).toISOString(),
    };
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
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  identity: AttemptIdentity,
  error: { code: string; message: string },
  status: "failed" | "stopped" = "failed",
): Promise<"terminalized" | "already_terminal"> {
  const settled = await runs.terminalizeQueuedRun({
    runId: input.harnessRunId,
    attemptId: identity.attemptId,
    status: storedRunStatus(status),
    errorJson: status === "failed" ? safeErrorJson(error) : null,
    memberSafePayloadJson: stableJson({ code: error.code.slice(0, 120) }),
    lifecycleEventId: uuidV7(),
    now: Date.now(),
  });
  if (settled.outcome === "not_found" || settled.outcome === "ownership_lost") {
    throw new RunOwnershipLostError();
  }
  return settled.outcome;
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
  // The routed version was one statement joining the parent's scope to the
  // child, so a child inheriting a *different* scope hash simply produced no
  // row — indistinguishable from the parent having no scope at all. Both are
  // still the same refusal, but the join is now two reads and a comparison.
  //
  // `!parentScope` is unreachable through the public path and stays for the
  // type: `admitInlineChild` refuses to create a child at all when the parent
  // has no frozen scope, and a scope is never deleted. The comparison below it
  // is the check with teeth.
  const [parentScope, child] = await Promise.all([
    runs.scope({ runId: parentInput.harnessRunId }),
    runs.run({ runId: childInput.harnessRunId }),
  ]);
  if (!parentScope
    || !child
    || child.parent_run_id !== parentInput.harnessRunId
    || child.parent_tool_call_id === null
    || child.inherited_scope_hash !== parentScope.scope_hash) {
    throw new Error("inline_child_parent_scope_missing");
  }

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
  runs: HarnessRunObjectPort,
  parentInput: HarnessRunCoordinates,
  parentLease: AttemptLease,
  childInput: HarnessRunCoordinates,
  childLease: AttemptLease,
  leaseSeconds = 60,
): Promise<AttemptLease> {
  const renewed = await runs.heartbeatInlineChild({
    parentRunId: parentInput.harnessRunId,
    parentAttemptId: parentLease.attemptId,
    parentOwner: parentLease.owner,
    childRunId: childInput.harnessRunId,
    childAttemptId: childLease.attemptId,
    childOwner: childLease.owner,
    leaseSeconds: Math.max(10, Math.min(300, Math.trunc(leaseSeconds))),
    now: Date.now(),
  });
  if (renewed.outcome === "cancelled") throw new RunCancelledError();
  if (renewed.outcome === "ownership_lost") throw new RunOwnershipLostError();
  return { ...childLease, leaseExpiresAt: new Date(renewed.leaseExpiresAt).toISOString() };
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
  runs: HarnessRunObjectPort,
  messages: MessageObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  message: { id: string; text: string },
  hostOutcome: Pick<TerminalOutcome, "status" | "error">,
): Promise<void> {
  const published = await runs.publishFinalMessage({
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
    messageId: message.id,
    text: message.text,
    hostOutcomeStatus: hostOutcome.status,
    eventPayloadJson: stableJson({
      finalMessageId: message.id,
      hostOutcome: {
        status: hostOutcome.status,
        ...(hostOutcome.error ? { error: hostOutcome.error } : {}),
      },
    }),
    lifecycleEventId: uuidV7(),
    // A member who stopped the run still gets to read what it had already
    // written. The routed statement made the same exemption, and for the same
    // reason `assertHarnessToolSettlementOwned` does.
    allowCancellationRequested: hostOutcome.status === "stopped",
  });
  if (published.outcome === "ownership_lost") throw new RunOwnershipLostError();
  // Read back through the same pair a recovery would, rather than trusting the
  // write: the two rows are what every later reader joins, and a mismatch here
  // is the one chance to notice before the run is reported terminal.
  const persistedOutcome = await loadPersistedHarnessFinalOutcome(runs, messages, input);
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
  runs: HarnessRunObjectPort,
  messages: MessageObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
): Promise<PersistedHarnessHostOutcome | null> {
  // The routed version was one join across two authorities, so every way of
  // failing produced the same empty row. These are the join's three conditions,
  // asked separately: the message exists and this run wrote it, the event
  // exists, and the two agree on which attempt did it. Only the last is a
  // corruption rather than an absence, and it still reads as "nothing
  // persisted" because that is what a caller must do about it either way.
  const [message, lifecycle] = await Promise.all([
    messages.messageByClientId({ clientMessageId: `harness:${input.harnessRunId}` }),
    runs.lifecycleEvent({ runId: input.harnessRunId, eventKey: "final_message" }),
  ]);
  if (!message
    || message.harness_run_id !== input.harnessRunId
    || !lifecycle
    || lifecycle.event_type !== "final_message_persisted"
    || lifecycle.attempt_id !== message.harness_attempt_id) {
    return null;
  }
  const row = {
    message_id: message.id,
    status: lifecycle.status,
    member_safe_payload_json: lifecycle.member_safe_payload_json,
  };
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
    private readonly runs: HarnessRunObjectPort,
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
            this.runs,
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
  const settled = await runs.terminalizeInlineChild({
    parentRunId: parentInput.harnessRunId,
    parentAttemptId: parentLease.attemptId,
    parentOwner: parentLease.owner,
    childRunId: childInput.harnessRunId,
    childAttemptId: childLease.attemptId,
    childOwner: childLease.owner,
    status: storedRunStatus(sanitizedOutcome.status),
    model: sanitizedOutcome.model ?? null,
    usageJson: sanitizedOutcome.usage ? stableJson(sanitizedOutcome.usage) : null,
    errorJson: safeErrorJson(sanitizedOutcome.error),
    childResultJson: resultJson,
    childResultHash: await sha256Hex(resultJson),
    memberSafePayloadJson: stableJson({
      ...(sanitizedOutcome.error ? { code: sanitizedOutcome.error.code } : {}),
    }),
    lifecycleEventId: uuidV7(),
    now: Date.now(),
  });
  if (settled.outcome === "ownership_lost") throw new RunOwnershipLostError();
  return settled.outcome;
}

export async function cancelDescendantHarnessRuns(
  runs: HarnessRunObjectPort,
  rootHarnessRunId: string,
  reason: string,
): Promise<number> {
  const cancelled = await runs.cancelDescendants({
    rootRunId: rootHarnessRunId,
    reason: reason.slice(0, 200) || "parent_cancelled",
    now: Date.now(),
  });
  return cancelled.cancelled;
}

const RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY = "residual_receipts_settled";

interface TerminalizedReceiptRepair {
  runId: string;
  workspaceId: string;
  workstreamId: string;
  attemptId: string;
  // Every terminal status, not only the two the named paths reach. The narrow
  // reading of "must not leave a card spinning" cost fourteen hours of spinner
  // on a run that failed between `tool_started` and the guard reporting
  // `tool_failed`; this is the backstop for that whole class, so it must not be
  // re-narrowed to the paths currently known to need it.
  status: HarnessTerminalStatus;
  /** Epoch milliseconds — the object's vocabulary, which every consumer now speaks. */
  terminalizedAt: number;
  errorJson: string | null;
  memberSafePayloadJson: string;
  parentToolCallId: string | null;
  /**
   * Whether the run wrote its own terminal row or was reaped after its lease
   * lapsed. Only a reaped run may tell a member its lease was lost; a run that
   * ended on its own must not, however it ended.
   */
  terminalization: "direct" | "reaped";
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
  runs: HarnessRunObjectPort,
  row: TerminalizedReceiptRepair,
): Promise<void> {
  const recorded = await runs.recordReceiptReconciliation({
    runId: row.runId,
    attemptId: row.attemptId,
    terminalizedAt: row.terminalizedAt,
    eventKey: RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY,
    eventId: uuidV7(),
    now: Date.now(),
  });
  if (recorded.outcome === "not_terminal") {
    throw new Error("residual_receipt_reconciliation_not_recorded");
  }
}

async function settleAndRecordResidualReceipts(
  runs: HarnessRunObjectPort,
  receipts: ToolReceiptObjectPort,
  row: TerminalizedReceiptRepair,
  beforeRecord?: () => Promise<void>,
): Promise<void> {
  const fallback = receiptRepairFailure(row);
  const result = await receipts.settleResidualReceipts({
    runId: row.runId,
    attemptId: row.attemptId,
    lease: { kind: "terminalized", at: row.terminalizedAt },
    ...fallback,
    now: row.terminalizedAt,
  });
  if (result.open > 0) throw new Error("residual_receipts_not_settled");
  await beforeRecord?.();
  await recordResidualReceiptsSettled(runs, row);
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
/**
 * A stored terminal status in the published vocabulary, without a cast.
 *
 * `residualRepairCandidates` selects only the four terminal statuses, so this
 * total mapping is exhaustive over what it can return. Written out rather than
 * routed through `publishedRunStatus`, whose `string` return would need an
 * assertion here — and an assertion is what would stop the compiler noticing if
 * that predicate ever widened to a status this record cannot carry.
 */
function terminalStatusOf(stored: string): HarnessTerminalStatus {
  switch (stored) {
    case "cancelled": return "stopped";
    case "completed": return "completed";
    case "needs_input": return "needs_input";
    case "failed": return "failed";
    default: throw new Error(`harness_repair_unexpected_terminal_status:${stored}`);
  }
}

/**
 * Which path terminalized a run, from the row alone.
 *
 * A retry has to reproduce the wording its first pass would have written, so it
 * re-derives this rather than assuming. Reaping is what a lapsed lease and a
 * reaped child have in common; everything else wrote its own terminal row.
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

function settleOtherAuthorities(
  options: { blocks: BlockDashboardPortFactory },
  automationDatabase: D1Database | null,
  origin: string,
  repair: TerminalizedReceiptRepair,
): () => Promise<void> {
  return async () => {
    await options.blocks(repair.workspaceId, repair.workstreamId).abandonBlockRun({
      harnessRunId: repair.runId,
      terminalizedAt: repair.terminalizedAt,
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
    // `automation_runs` is a regional D1 table rather than an object-local one,
    // so this is the one place a terminalization instant crosses back into
    // ISO-8601 text.
  ).bind(new Date(row.terminalizedAt).toISOString(), row.workstreamId, row.workspaceId).run();
}

export async function terminalizeHarnessAttempt(
  runs: HarnessRunObjectPort,
  messages: MessageObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  lease: AttemptLease,
  outcome: TerminalOutcome,
  receipts: ToolReceiptObjectPort,
  blocks: BlockDashboardObjectPort,
): Promise<"terminalized" | "already_terminal"> {
  const target = await runs.run({ runId: input.harnessRunId });
  if (!target || target.parent_tool_call_id !== null) throw new Error("harness_run_not_found");
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
      await assertFinalMessagePersisted(runs, messages, input.harnessRunId, outcome.finalMessageId);
    }
  }
  const now = Date.now();
  const payload = stableJson(outcome.memberSafePayload ?? {});
  const settled = await runs.terminalizeAttempt({
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now,
    status: storedRunStatus(outcome.status),
    finalPartId: outcome.finalMessageId ?? null,
    model: outcome.model ?? null,
    usageJson: outcome.usage ? stableJson(outcome.usage) : null,
    errorJson: safeErrorJson(outcome.error),
    memberSafePayloadJson: payload,
    lifecycleEventId: uuidV7(),
    receiptMarkerEventKey: RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY,
  });
  if (settled.outcome === "not_found") throw new Error("harness_run_not_found");
  if (settled.outcome === "ownership_lost") throw new RunOwnershipLostError();

  // Every receipt this run still had open is classified and closed now that the
  // run is terminal. A write caught mid-flight becomes `ambiguous` rather than
  // `failed`: the provider may already have performed it, and stopping is not
  // evidence either way.
  //
  // Every terminal status, not only `stopped`. A run that ends any other way is
  // *supposed* to have settled each receipt as its tool returned, so an open
  // one here is a defect — but a defect whose only symptom is a card that spins
  // forever, because nothing downstream repairs it: the bounded sweep only
  // revisits rows that reached this call, and a `failed` root is not reachable
  // from a member's next message either. The narrow reading of "must not leave
  // a card spinning" cost fourteen hours of spinner on a `load_plugin` whose
  // run failed between `tool_started` and the guard that reports `tool_failed`.
  // This is the backstop for that whole class, so it must not be re-narrowed to
  // the paths currently known to need it.
  //
  // After the terminal write rather than inside it, because the receipts are a
  // different authority. Of the two possible orderings only this one fails
  // safe — see `settleResidualReceipts` — and `already_terminal` reporting
  // whether the marker was ever written is what lets a crash between the two
  // be repaired here rather than never.
  if (settled.outcome === "terminalized") {
    await settleAndRecordResidualReceipts(runs, receipts, {
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
  // The terminal row landed but the settlement that follows it did not, so this
  // repeat of the same call finishes the protocol rather than reporting a run
  // whose card is still open as fully settled.
  //
  // `already_terminal` is only returned for a run whose stored status already
  // equals the one asked for, so this branch's status is `outcome.status` by
  // construction and there is nothing left to compare it against — and every
  // terminal status reaches here, for the reason the first pass gives.
  if (!settled.receiptsReconciled) {
    await settleAndRecordResidualReceipts(runs, receipts, {
      runId: input.harnessRunId,
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      attemptId: lease.attemptId,
      status: outcome.status,
      terminalizedAt: settled.terminalizedAt,
      errorJson: settled.errorJson,
      memberSafePayloadJson: settled.memberSafePayloadJson,
      parentToolCallId: null,
      // Derived, not assumed: the row reached this branch because *some* first
      // pass terminalized it and lost its settlement, and that pass was not
      // necessarily this executor. The stale-lease reaper keeps `attempt_id`
      // and only clears the lease, so a reaped root whose settlement was lost
      // matches every predicate above when its original executor returns — and
      // hardcoding `direct` would then write `run_terminated` where the
      // reaper's own retry writes `parent_run_terminated`. Same reason the
      // sweep re-derives it.
      terminalization: terminalizationOf(settled.errorJson, null),
    });
  }
  return "already_terminal";
}

/**
 * The final message exists, and the run said it wrote it.
 *
 * Two object-local reads where the routed version was one join. Both halves
 * matter and neither implies the other: the part could exist without the run
 * having recorded that it published one — a partially applied write — and the
 * lifecycle event could exist while the part was never committed.
 */
async function assertFinalMessagePersisted(
  runs: HarnessRunObjectPort,
  messages: MessageObjectPort,
  harnessRunId: string,
  finalMessageId: string,
): Promise<void> {
  const [message, published] = await Promise.all([
    messages.message({ messageId: finalMessageId }),
    runs.lifecycleEvent({ runId: harnessRunId, eventKey: "final_message" }),
  ]);
  if (!message
    || message.harness_run_id !== harnessRunId
    || message.author_type !== "agent"
    || message.message_type !== "text"
    || published?.event_type !== "final_message_persisted") {
    throw new Error("final_message_not_persisted");
  }
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

interface StaleHarnessRunReapOptions {
  workspaceId: string;
  workstreamId: string;
  limit?: number;
  /** WorkspaceDO authority for automation settlement; null for block-only runtimes. */
  automationDatabase: D1Database | null;
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
}

/**
 * Reconcile receipts and related authorities left open by already-terminal
 * runs, without expiring or terminalizing any nonterminal run.
 */
export async function repairTerminalResidualReceipts(
  runs: HarnessRunObjectPort,
  options: StaleHarnessRunReapOptions,
): Promise<void> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const blockOnly = options.automationDatabase === null;
  const { workspaceId, workstreamId } = options;
  const receipts = options.receipts(workspaceId, workstreamId);

  // Terminalization and receipt settlement cross object calls. If the second
  // call failed, the terminal row is the durable authority and this marker is
  // absent. Repair those rows first so a run cannot be permanently terminal
  // while its member-visible tool card remains open. Successful repairs record
  // the marker, so the bounded walk makes forward progress instead of scanning
  // the same historical rows on every activation.
  //
  // On its own budget, deliberately. This pass and stale-run reaping used to
  // share one. The general reaper composes this helper before its time-sensitive
  // stale-lease pass, while callers such as transcript backfill can safely run
  // terminal repair alone without changing nonterminal run state.
  for (const row of await runs.residualRepairCandidates({
    markerEventKey: RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY,
    blockOnly,
    limit,
  })) {
    const repair = {
      runId: row.run_id,
      workspaceId,
      workstreamId,
      attemptId: row.attempt_id,
      status: terminalStatusOf(row.status),
      terminalizedAt: row.terminalized_at,
      errorJson: row.error_json,
      memberSafePayloadJson: row.member_safe_payload_json,
      parentToolCallId: row.parent_tool_call_id,
      terminalization: terminalizationOf(row.error_json, row.parent_tool_call_id),
    } satisfies TerminalizedReceiptRepair;
    try {
      await settleAndRecordResidualReceipts(
        runs,
        receipts,
        repair,
        settleOtherAuthorities(options, options.automationDatabase, row.origin, repair),
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
}

export async function reapStaleHarnessRuns(
  runs: HarnessRunObjectPort,
  options: StaleHarnessRunReapOptions,
): Promise<string[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const blockOnly = options.automationDatabase === null;
  const { workspaceId, workstreamId } = options;
  const receipts = options.receipts(workspaceId, workstreamId);
  const reaped: string[] = [];
  let processed = 0;

  const reportFailure = (
    phase: "stale_root" | "stale_child",
    repair: TerminalizedReceiptRepair,
    error: unknown,
  ): void => {
    options.onReceiptRepairFailure?.({
      phase,
      runId: repair.runId,
      workspaceId: repair.workspaceId,
      workstreamId: repair.workstreamId,
      attemptId: repair.attemptId,
      reason: error instanceof Error ? error.message : String(error),
    });
  };

  await repairTerminalResidualReceipts(runs, options);

  // No early return on a full repair page: the reaps below are the
  // time-sensitive half and must run on every activation.
  //
  // Reaping work, which the root and child passes share. The repair pass above
  // is bounded by its own LIMIT and deliberately does not count against this.
  for (const row of await runs.staleLeaseRuns({
    blockOnly,
    now: Date.now(),
    limit: limit - processed,
  })) {
    const now = Date.now();
    const settled = await runs.reapStaleRoot({
      runId: row.run_id,
      attemptId: row.attempt_id,
      leaseExpiresAt: row.lease_expires_at,
      lifecycleEventId: uuidV7(),
      now,
    });
    if (settled.outcome === "not_stale") continue;
    reaped.push(row.run_id);
    processed += 1;
    // Every live-lease receipt operation must refuse here because that lease is
    // precisely what expired. Residual settlement instead re-reads this exact
    // terminal stamp inside the object transaction. Its lifecycle marker lands
    // only after receipt settlement and the run's other authority — its block,
    // or its automation run — both succeed, so a later bounded sweep retries a
    // transient second-call failure.
    const repair = {
      runId: row.run_id,
      workspaceId,
      workstreamId,
      attemptId: row.attempt_id,
      status: "failed",
      terminalizedAt: now,
      // The stale-run error is already durable on the run. Residual root
      // receipts intentionally keep the predecessor's generic
      // `parent_run_terminated` fallback, so there is no receipt error to
      // thread through this shared shape.
      errorJson: null,
      memberSafePayloadJson: '{"code":"stale_run_reaped"}',
      parentToolCallId: null,
      // This pass *is* the reaper, so the lease demonstrably lapsed.
      terminalization: "reaped",
    } satisfies TerminalizedReceiptRepair;
    try {
      await settleAndRecordResidualReceipts(
        runs,
        receipts,
        repair,
        settleOtherAuthorities(options, options.automationDatabase, row.origin, repair),
      );
    } catch (error) {
      reportFailure("stale_root", repair, error);
    }
  }

  const childLimit = limit - processed;
  if (childLimit <= 0) return reaped;

  for (const row of await runs.reapableInlineChildren({ now: Date.now(), limit: childLimit })) {
    const now = Date.now();
    const status = row.cancellation_requested_at === null ? "failed" : "stopped";
    const error = row.cancellation_requested_at === null
      ? { code: "parent_run_unavailable", message: "The parent run no longer owns a live attempt" }
      : { code: "run_cancelled", message: "The child run was cancelled" };
    const childResultJson = stableJson({ error, status });
    const memberSafePayloadJson = stableJson({ code: error.code });
    const errorJson = safeErrorJson(error);
    const settled = await runs.reapStaleInlineChild({
      runId: row.run_id,
      attemptId: row.attempt_id,
      owner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      status: storedRunStatus(status),
      errorJson,
      childResultJson,
      childResultHash: await sha256Hex(childResultJson),
      memberSafePayloadJson,
      lifecycleEventId: uuidV7(),
      now,
    });
    if (settled.outcome === "not_stale") continue;
    // Same rule, and the same ordering, as a stopped parent: the child's own
    // receipts are classified and closed once it is terminal.
    const repair = {
      runId: row.run_id,
      workspaceId,
      workstreamId,
      attemptId: row.attempt_id,
      status,
      terminalizedAt: now,
      errorJson,
      memberSafePayloadJson,
      parentToolCallId: row.parent_tool_call_id,
      // A reaped child, by construction: this is the pass that reaps them.
      terminalization: "reaped",
    } satisfies TerminalizedReceiptRepair;
    try {
      await settleAndRecordResidualReceipts(runs, receipts, repair);
    } catch (receiptError) {
      reportFailure("stale_child", repair, receiptError);
    }
    // The parent will read this back through `loadInlineChildResult`, which
    // refuses a result whose hash does not match. Verifying it here turns a
    // corrupt write into a failure of the sweep rather than of the parent's
    // next tool call.
    const persisted = await runs.run({ runId: row.run_id });
    const verified = await parseVerifiedInlineChildResult(
      persisted?.child_result_json ?? null,
      persisted?.child_result_hash ?? null,
    );
    if (!verified || verified.status !== status) {
      throw new Error("inline_child_terminal_result_missing");
    }
    reaped.push(row.run_id);
  }
  return reaped;
}
