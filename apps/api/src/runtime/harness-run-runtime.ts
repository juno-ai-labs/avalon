import { type StructuredFailureDetail, type WorkstreamWorkflowInput } from "@rally/contracts";

import type { OutboundExternalBinding } from "../durable-objects/external-binding-outbox";
import { uuidV7 } from "../lib/uuid-v7";
import type { HarnessRunObjectPort } from "../durable-objects/workstream-harness-run-protocol";
import {
  type TerminalRunStatus,
  type TerminalLoopExecutionFence,
} from "../durable-objects/workstream-harness-run-storage";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
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
  finalTurnId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  error?: { code: string; message: string };
  memberSafePayload?: Record<string, unknown>;
}

export interface PersistedHarnessHostOutcome {
  finalTurnId?: string;
  participantNoticeTurnId?: string;
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
  /** An unsettled provider-deduped write, safe to run again under its own key. */
  | { state: "resume_write"; invocationId: string; executionPlanHash: string }
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
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
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

/**
 * The published spelling of a stored run status.
 *
 * The forward receipt vocabulary translates only admission and cancellation.
 * v35 terminalizes the retired per-run phase spellings before runtime reads.
 */
export function publishedRunStatus(stored: string): string {
  switch (stored) {
    case "admitted": return "scheduled";
    case "cancelled": return "stopped";
    case "waiting": case "steering": throw new Error("retired_run_status");
    default: return stored;
  }
}

/**
 * The inverse, for a status on its way *into* the object.
 *
 * Only `stopped` needs translating; retired per-run phases have no writer.
 */
function storedRunStatus(published: HarnessTerminalStatus): TerminalRunStatus {
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
 * Terminalize a run that never acquired a lease. This is intentionally
 * narrower than normal terminalization: an owned attempt must go through the
 * attempt-fenced terminal path instead.
 */
export async function terminalizeQueuedHarnessRun(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">,
  identity: AttemptIdentity,
  error: { code: string; message: string },
  status: "failed" | "stopped" = "failed",
  loopExecutionFence: TerminalLoopExecutionFence | null = null,
): Promise<"terminalized" | "already_terminal"> {
  const settled = await runs.terminalizeQueuedRun({
    runId: input.harnessRunId,
    attemptId: identity.attemptId,
    status: storedRunStatus(status),
    errorJson: status === "failed" ? safeErrorJson(error) : null,
    memberSafePayloadJson: stableJson({ code: error.code.slice(0, 120) }),
    lifecycleEventId: uuidV7(),
    loopExecutionFence,
    now: Date.now(),
  });
  if (settled.outcome === "not_found" || settled.outcome === "ownership_lost") {
    throw new RunOwnershipLostError();
  }
  return settled.outcome;
}

export async function persistImmutableRunScope(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">,
  lease: AttemptLease,
  scope: ImmutableRunScope,
  onTiming?: (stage: "ownership" | "hash" | "write", durationMs: number) => void,
): Promise<{ scopeHash: string; reused: boolean }> {
  const reportTiming = (stage: "ownership" | "hash" | "write", startedAt: number) => {
    try { onTiming?.(stage, Date.now() - startedAt); } catch { /* Observational only. */ }
  };
  let startedAt = Date.now();
  await assertHarnessAttemptOwned(runs, input.harnessRunId, lease);
  reportTiming("ownership", startedAt);
  const canonicalScope = {
    executionPrincipal: scope.executionPrincipal,
    eligibleConnectionIds: [...new Set(scope.eligibleConnectionIds)].sort(),
    eligibleCapabilities: [...new Set(scope.eligibleCapabilities)].sort(),
    eligibleConnectionCapabilities: Object.fromEntries(
      Object.entries(scope.eligibleConnectionCapabilities)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
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
  startedAt = Date.now();
  const scopeHash = await sha256Hex(stableJson(canonicalScope));
  reportTiming("hash", startedAt);
  startedAt = Date.now();
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
    limitsJson: stableJson(canonicalScope.limits),
  });
  reportTiming("write", startedAt);
  if (persisted.outcome === "ownership_lost") throw new RunOwnershipLostError();
  // `reused` means the run already has a recorded scope, and it wins. The hash
  // computed just above describes the *current* attempt's build, so on a run
  // resumed across a deploy it is legitimately a different value than the one
  // stored — which is why nothing compares the two. `persistScope` carries the
  // full reasoning and the incident it came from.
  return { scopeHash, reused: persisted.outcome === "reused" };
}

export async function persistRunPluginActivation(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">,
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

export async function persistHarnessHostOutcome(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">,
  lease: AttemptLease,
  finalTurn: { turnId: string; text: string } | null,
  participantNotice: { turnId: string; text: string } | null,
  hostOutcome: Pick<TerminalOutcome, "status" | "error">,
): Promise<void> {
  const published = await runs.publishHostOutcome({
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
    finalTurn,
    participantNotice,
    hostOutcomeStatus: hostOutcome.status,
    hostOutcomeError: hostOutcome.error ?? null,
    lifecycleEventId: uuidV7(),
    // A member who stopped the run still gets to read what it had already
    // written. The routed statement made the same exemption, and for the same
    // reason `assertHarnessToolSettlementOwned` does.
    allowCancellationRequested: hostOutcome.status === "stopped",
  });
  if (published.outcome === "ownership_lost") throw new RunOwnershipLostError();
  if (published.outcome === "content_mismatch") {
    throw new Error(`host_outcome_content_mismatch:${published.reasons.join(",")}`);
  }
  // Read back through recovery rather than trusting the write. The lifecycle
  // event, optional canonical assistant turn, and optional participant notice
  // commit together, so recovery must name the same records the host selected.
  const persistedOutcome = await loadPersistedHarnessHostOutcome(runs, input);
  if (
    !persistedOutcome
    || (persistedOutcome.finalTurnId ?? null) !== (finalTurn?.turnId ?? null)
    || (persistedOutcome.participantNoticeTurnId ?? null) !== (participantNotice?.turnId ?? null)
    || persistedOutcome.status !== hostOutcome.status
    || stableJson(persistedOutcome.error ?? null) !== stableJson(hostOutcome.error ?? null)
  ) {
    throw new Error("host_outcome_mismatch");
  }
}

export async function loadPersistedHarnessHostOutcome(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">,
): Promise<PersistedHarnessHostOutcome | null> {
  const lifecycle = await runs.lifecycleEvent({
    runId: input.harnessRunId,
    eventKey: "host_outcome",
  });
  if (!lifecycle) return null;
  if (!lifecycle.status || !TERMINAL_STATUSES.has(lifecycle.status)) {
    throw new Error("host_outcome_invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(lifecycle.member_safe_payload_json) as unknown;
  } catch {
    throw new Error("host_outcome_invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("host_outcome_invalid");
  }
  const payload = decoded as {
    finalTurnId?: unknown;
    participantNoticeTurnId?: unknown;
    error?: unknown;
  };
  if (lifecycle.event_type !== "host_outcome_persisted"
    || (payload.finalTurnId !== null && typeof payload.finalTurnId !== "string")
    || (payload.participantNoticeTurnId !== null
      && typeof payload.participantNoticeTurnId !== "string")) {
    throw new Error("host_outcome_invalid");
  }
  if (typeof payload.finalTurnId === "string") {
    const turn = await runs.finalAssistantTurn({
      runId: input.harnessRunId,
      turnId: payload.finalTurnId,
    });
    if (turn?.turn_id !== payload.finalTurnId) return null;
  }
  if (typeof payload.participantNoticeTurnId === "string") {
    const notice = await runs.hostOutcomeParticipantNotice({
      runId: input.harnessRunId,
      turnId: payload.participantNoticeTurnId,
    });
    if (notice?.turn_id !== payload.participantNoticeTurnId) return null;
  }
  const rawError = payload.error;
  const error = rawError && typeof rawError === "object"
    && typeof (rawError as { code?: unknown }).code === "string"
    && typeof (rawError as { message?: unknown }).message === "string"
    ? {
        code: (rawError as { code: string }).code,
        message: (rawError as { message: string }).message,
      }
    : undefined;
  if (rawError !== undefined && !error) throw new Error("host_outcome_invalid");
  return {
    ...(typeof payload.finalTurnId === "string" ? { finalTurnId: payload.finalTurnId } : {}),
    ...(typeof payload.participantNoticeTurnId === "string"
      ? { participantNoticeTurnId: payload.participantNoticeTurnId }
      : {}),
    status: lifecycle.status as HarnessTerminalStatus,
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
    /** The reply thread the call sent into, committed with the completion. */
    externalBinding?: OutboundExternalBinding;
  },
): Promise<"persisted" | "already_persisted"> {
  return settlementOrThrow(await receipts.complete({
    ...(input.externalBinding ? { externalBinding: input.externalBinding } : {}),
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
    private readonly options: {
      leaseSeconds?: number;
      minimumIntervalMs?: number;
      afterHeartbeat?: () => void | Promise<void>;
      onTiming?: (stage: string, part: "attempt" | "loop" | "coalesced", durationMs: number) => void;
    } = {},
  ) {
    this.currentLease = lease;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get lease(): AttemptLease {
    return this.currentLease;
  }

  async pulse(stage: string, force = false): Promise<void> {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (!force && Date.now() < this.nextHeartbeatAt) return;
    if (this.inFlight) {
      const startedAt = Date.now();
      try {
        await this.inFlight;
      } finally {
        // This caller waited for another stage's renewal; do not attribute
        // the underlying attempt and loop work to the joining stage.
        try { this.options.onTiming?.(stage, "coalesced", Date.now() - startedAt); } catch { /* Observational only. */ }
      }
      return;
    }
    this.inFlight = (async () => {
      try {
        let startedAt = Date.now();
        this.currentLease = await heartbeatHarnessAttempt(
          this.runs,
          this.runId,
          this.currentLease,
          this.options.leaseSeconds ?? 60,
        );
        try { this.options.onTiming?.(stage, "attempt", Date.now() - startedAt); } catch { /* Observational only. */ }
        startedAt = Date.now();
        await this.options.afterHeartbeat?.();
        try { this.options.onTiming?.(stage, "loop", Date.now() - startedAt); } catch { /* Observational only. */ }
        this.nextHeartbeatAt = Date.now() + (this.options.minimumIntervalMs ?? 5_000);
      } catch (error) {
        this.controller.abort(error);
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
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
  await recordResidualReceiptsSettled(runs, row);
}

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

export async function terminalizeHarnessAttempt(
  runs: HarnessRunObjectPort,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">,
  lease: AttemptIdentity,
  outcome: TerminalOutcome,
  receipts: ToolReceiptObjectPort,
  loopExecutionFence?: TerminalLoopExecutionFence,
): Promise<"terminalized" | "already_terminal"> {
  const target = await runs.run({ runId: input.harnessRunId });
  if (!target || target.parent_tool_call_id !== null) throw new Error("harness_run_not_found");
  if (outcome.status === "completed") {
    if (!outcome.finalTurnId) throw new Error("final_turn_required");
    await assertFinalTurnPersisted(runs, input.harnessRunId, outcome.finalTurnId);
  }
  const now = Date.now();
  const payload = stableJson(outcome.memberSafePayload ?? {});
  const settled = await runs.terminalizeAttempt({
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now,
    status: storedRunStatus(outcome.status),
    finalTurnId: outcome.finalTurnId ?? null,
    model: outcome.model ?? null,
    usageJson: outcome.usage ? stableJson(outcome.usage) : null,
    errorJson: safeErrorJson(outcome.error),
    memberSafePayloadJson: payload,
    lifecycleEventId: uuidV7(),
    receiptMarkerEventKey: RESIDUAL_RECEIPTS_SETTLED_EVENT_KEY,
    loopExecutionFence: loopExecutionFence ?? null,
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
      workstreamId: input.parentId,
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
      workstreamId: input.parentId,
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
 * The final turn exists, and the run said it wrote it.
 *
 * Two object-local reads where the routed version was one join. Both halves
 * matter and neither implies the other: the part could exist without the run
 * having recorded that it published one — a partially applied write — and the
 * lifecycle event could exist while the part was never committed.
 */
async function assertFinalTurnPersisted(
  runs: HarnessRunObjectPort,
  harnessRunId: string,
  finalTurnId: string,
): Promise<void> {
  const published = await runs.lifecycleEvent({ runId: harnessRunId, eventKey: "host_outcome" });
  if (published?.event_type !== "host_outcome_persisted") throw new Error("final_turn_not_persisted");
  let payload: { finalTurnId?: unknown };
  try {
    payload = JSON.parse(published.member_safe_payload_json) as { finalTurnId?: unknown };
  } catch {
    throw new Error("final_turn_not_persisted");
  }
  if (payload.finalTurnId !== finalTurnId) throw new Error("final_turn_not_persisted");
  // Transport/authority failures are not evidence that the turn is absent.
  // Let them retain their identity so workflow retry policy can classify them.
  const turn = await runs.finalAssistantTurn({ runId: harnessRunId, turnId: finalTurnId });
  if (turn?.turn_id === finalTurnId) return;
  throw new Error("final_turn_not_persisted");
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
  const { workspaceId, workstreamId } = options;
  const receipts = options.receipts(workspaceId, workstreamId);
  const reaped: string[] = [];

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
  // Reaping and residual repair each have their own bounded page.
  for (const row of await runs.staleLeaseRuns({
    now: Date.now(),
    limit,
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
      );
    } catch (error) {
      reportFailure("stale_root", repair, error);
    }
  }


  return reaped;
}

export const __harnessRunRuntimeTesting = {
  assertFinalTurnPersisted,
  stableJson,
};
