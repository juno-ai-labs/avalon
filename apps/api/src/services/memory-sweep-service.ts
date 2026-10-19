import { IdSchema, WorkspaceIdSchema, asWorkspaceId } from "@rally/contracts";
import { RegionSchema } from "@rally/contracts/regions";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { newId } from "@rally/db";
import {
  memorySweepJsonSchema,
  renderMemorySweepMessages,
  type MemorySweepCandidateInput,
  type MemorySweepMessageInput,
} from "@rally/agent-harness";
import { z } from "zod";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceMemoryApplySweepResultSchema,
  WorkspaceMemorySweepCandidatesResultSchema,
  memorySourceOf,
  type MemoryConversation,
  type MemorySweepOperation,
} from "../durable-objects/workspace-memory-facts-protocol";
import type { MessageRow } from "../durable-objects/workstream-message-storage";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logInfo, logStructuredEvent, logWarn } from "../observability/logger";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";
import { refreshMemoryDigestCopies } from "./memory-digest-service";
import { runStructuredInference } from "./structured-inference";

/**
 * The memory sweep lane: after a run settles, a conversation that has rested
 * and has new person messages behind its cursor is claimed and sent to the
 * Queue; the consumer reads the window, asks a strong model what Rally should
 * remember, applies the answer in `WorkspaceDO` behind the conversation's
 * cursor fence, and settles the cursor.
 *
 * Two halves, deliberately: `attemptMemorySweep` runs inside the conversation
 * object at settlement and from its alarm, costs two single-row reads on most
 * calls, and never throws. `runMemorySweep` runs in the Queue consumer, where
 * a Sol-class call can take its time without holding a Durable Object.
 *
 * Every number below is a placeholder the team has not set
 * (`docs/adding-security-defensive-and-other-limits.md`); the arithmetic is
 * in `docs/agent-memory.md#limits`.
 */

// LIMIT UNSET: the quiet a conversation earns after a sweep, and the most it can earn.
export const MEMORY_SWEEP_REST_FLOOR_MS = 60 * 60_000;
export const MEMORY_SWEEP_REST_CEILING_MS = 24 * 60 * 60_000;
// LIMIT UNSET: how much new person conversation a sweep needs to be worth a model call.
export const MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES = 3;
export const MEMORY_SWEEP_MINIMUM_PERSON_CHARACTERS = 200;
// LIMIT UNSET: the window the model reads, and how far back of the cursor it is shown for context.
export const MEMORY_SWEEP_MAXIMUM_WINDOW_MESSAGES = 300;
export const MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES = 20;
export const MEMORY_SWEEP_MAXIMUM_WINDOW_CHARACTERS = 160_000;
// LIMIT UNSET: how many remembered facts the model is shown as candidates.
export const MEMORY_SWEEP_MAXIMUM_CANDIDATES = 60;
// LIMIT UNSET: how long a claim holds the lane before a lost delivery is presumed and the next run may claim.
export const MEMORY_SWEEP_CLAIM_TIMEOUT_MS = 15 * 60_000;

/** The rest a conversation has earned: the floor, doubling once per quiet sweep, up to the ceiling. */
export function memorySweepRestUntil(now: number, quiet: number): number {
  return now + Math.min(MEMORY_SWEEP_REST_CEILING_MS, MEMORY_SWEEP_REST_FLOOR_MS * 2 ** Math.max(0, quiet));
}

export const MemorySweepMessageSchema = z.strictObject({
  type: z.literal("memory_sweep"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  parentKind: z.enum(["workstream", "automation"]),
  parentId: IdSchema,
  substreamId: z.string().min(1),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  /** The claim this delivery carries; a release from an older one is refused. */
  attempt: z.number().int().positive(),
});
export type MemorySweepMessage = z.infer<typeof MemorySweepMessageSchema>;

export interface MemorySweepTarget {
  workspaceId: string;
  parentKind: "workstream" | "automation" | "space";
  parentId: string;
  substreamId: string;
}

export type MemorySweepAttemptOutcome =
  | { status: "published"; fromSeq: number; toSeq: number; attempt: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; code: string };

interface WindowMessage extends MemorySweepMessageInput {
  authorUserId: string | null;
}

function parseExternalActor(value: string | null): { displayName: string | null } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { displayName?: unknown };
    return { displayName: typeof parsed.displayName === "string" ? parsed.displayName : null };
  } catch {
    return null;
  }
}

/** Tool rows and empty rows are how the work was done, not what was said. */
function windowMessage(row: MessageRow, cursor: number): WindowMessage | null {
  if (row.message_type === "tool") return null;
  const text = String(row.text_content ?? "").trim();
  if (text.length === 0) return null;
  const external = parseExternalActor(row.external_actor_json);
  const authorType = external
    ? "external" as const
    : row.author_type === "agent"
      ? "agent" as const
      : row.author_type === "system" ? "system" as const : "person" as const;
  return {
    seq: Number(row.sequence_number),
    authorType,
    authorId: row.author_user_id,
    authorUserId: row.author_user_id,
    authorName: external?.displayName ?? null,
    occurredAt: new Date(Number(row.created_at)).toISOString(),
    text,
    context: Number(row.sequence_number) <= cursor,
  };
}

async function readWindow(
  env: Env,
  target: MemorySweepTarget,
  fromSeq: number,
  toSeq: number | null,
): Promise<{ messages: WindowMessage[]; latestSeq: number; truncated: boolean }> {
  const rows = await createMessageObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId)
    .messagesAfter({
      afterSequence: Math.max(0, fromSeq - MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES),
      limit: MEMORY_SWEEP_MAXIMUM_WINDOW_MESSAGES + MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES + 1,
    });
  const bounded = toSeq === null ? rows : rows.filter((row) => Number(row.sequence_number) <= toSeq);
  const messages = bounded.flatMap((row) => {
    const message = windowMessage(row, fromSeq);
    return message ? [message] : [];
  });
  // Drop from the oldest end until the window fits its character budget.
  let budget = MEMORY_SWEEP_MAXIMUM_WINDOW_CHARACTERS;
  let firstKept = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = messages[index]!.text.length;
    if (cost > budget) break;
    budget -= cost;
    firstKept = index;
  }
  const kept = messages.slice(firstKept);
  const newest = bounded.at(-1);
  return {
    messages: kept,
    latestSeq: kept.at(-1)?.seq ?? (newest ? Number(newest.sequence_number) : fromSeq),
    truncated: rows.length > MEMORY_SWEEP_MAXIMUM_WINDOW_MESSAGES + MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES
      || kept.length < messages.length,
  };
}

function isPerson(message: WindowMessage): boolean {
  return message.authorType === "person" || message.authorType === "external";
}

/**
 * Decide whether this conversation is due a sweep, and if so claim it and
 * send it to the Queue. Runs at settlement and from the alarm. Never throws.
 */
export async function attemptMemorySweep(env: Env, target: MemorySweepTarget): Promise<MemorySweepAttemptOutcome> {
  try {
    return await attempt(env, target);
  } catch (error) {
    logWarn(env, "memory_sweep_attempt_failed", {
      workspace_id: target.workspaceId,
      workstream_id: target.parentId,
      substream_id: target.substreamId,
      reason: diagnosticErrorCode(error, "memory_sweep_attempt_failed"),
    });
    return { status: "failed", code: "attempt_threw" };
  }
}

async function attempt(env: Env, target: MemorySweepTarget): Promise<MemorySweepAttemptOutcome> {
  if (!env.OPENROUTER_API_KEY) return { status: "skipped", reason: "no_model_access" };
  // A Channel's own feed is not swept in this release (prd.md non-goal 9).
  if (target.parentKind === "space") return { status: "skipped", reason: "space_parent" };
  const now = Date.now();
  const scheduling = createSchedulingObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId);
  const [identity, state] = await Promise.all([
    createIdentityObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId).identity(),
    scheduling.memorySweepState(),
  ]);
  // Every path below moves `retry_at`, or the alarm would wake into the same answer.
  await scheduling.deferMemorySweep({ retryAt: null, now });
  if (!identity) return { status: "skipped", reason: "conversation_missing" };
  if (identity.archived_at != null) return { status: "skipped", reason: "archived" };
  const cursor = Number(state?.swept_through_seq ?? 0);
  const window = await readWindow(env, target, cursor, null);
  const spoken = window.messages.filter((message) => !message.context && isPerson(message));
  const spokenCharacters = spoken.reduce((total, message) => total + message.text.length, 0);
  if (spoken.length < MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES || spokenCharacters < MEMORY_SWEEP_MINIMUM_PERSON_CHARACTERS) {
    return { status: "skipped", reason: "insufficient_new_conversation" };
  }
  if (state && state.rest_until > now) {
    // Rested later, with something to sweep: the alarm comes back at the rest.
    await scheduling.deferMemorySweep({ retryAt: Number(state.rest_until), now });
    return { status: "skipped", reason: "resting" };
  }
  const toSeq = window.latestSeq;
  if (toSeq <= cursor) return { status: "skipped", reason: "nothing_new" };
  const claim = await scheduling.claimMemorySweep({
    now,
    fromSeq: cursor,
    toSeq,
    restUntil: memorySweepRestUntil(now, 0),
    claimTimeoutMs: MEMORY_SWEEP_CLAIM_TIMEOUT_MS,
  });
  if (!claim) return { status: "skipped", reason: "claimed_elsewhere" };
  const message: MemorySweepMessage = MemorySweepMessageSchema.parse({
    type: "memory_sweep",
    region: env.AVALON_REGION,
    workspaceId: target.workspaceId,
    parentKind: target.parentKind,
    parentId: target.parentId,
    substreamId: target.substreamId,
    fromSeq: cursor,
    toSeq,
    attempt: claim.attempt,
  });
  try {
    await env.ACTIVITY_QUEUE.send(message);
  } catch (error) {
    // The claim's rest still stands; releasing lets the alarm try again at it.
    await scheduling.releaseMemorySweep({ attempt: claim.attempt, now: Date.now() });
    throw error;
  }
  logInfo(env, "memory_sweep_published", {
    workspace_id: target.workspaceId,
    workstream_id: target.parentId,
    substream_id: target.substreamId,
    from_seq: cursor,
    to_seq: toSeq,
    attempt: claim.attempt,
    person_messages: spoken.length,
  });
  return { status: "published", fromSeq: cursor, toSeq, attempt: claim.attempt };
}

// -- The consumer half ---------------------------------------------------------

const Rfc3339 = z.string().datetime({ offset: true });

/** What the model returns, in the flat shape the strict schema carries. */
const ModelOperationSchema = z.strictObject({
  op: z.enum(["add", "update", "confirm", "retract"]),
  subjectKind: z.enum(["organization", "channel", "thread", "breakout", "person", "sidekick"]).nullable(),
  subjectId: z.string().nullable(),
  kind: z.enum(["standing", "situational"]).nullable(),
  text: z.string().nullable(),
  validFrom: Rfc3339.nullable(),
  validUntil: Rfc3339.nullable(),
  validUntilBasis: z.enum(["stated", "event", "assumed"]).nullable(),
  derivedFrom: z.enum(["person", "external", "agent"]).nullable(),
  conflict: z.boolean(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.number().int().nonnegative()).max(32),
  factId: z.string().nullable(),
  reason: z.string().nullable(),
});
const MemorySweepDecisionSchema = z.strictObject({ operations: z.array(ModelOperationSchema).max(64) });
type ModelOperation = z.infer<typeof ModelOperationSchema>;

const instant = (value: string | null): number | null => (value === null ? null : Date.parse(value));

/**
 * The flat model shape narrowed to the store's operations. A row the model
 * left incoherent (an `add` with no text, an `update` with no id) is dropped
 * here and counted, rather than refused one hop later under a vaguer code.
 */
function narrowOperation(operation: ModelOperation): MemorySweepOperation | null {
  const text = operation.text?.trim() ?? "";
  switch (operation.op) {
    case "add":
      if (!operation.subjectKind || !operation.kind || text.length === 0 || text.length > 600) return null;
      return {
        op: "add",
        subjectKind: operation.subjectKind,
        subjectId: operation.subjectId,
        kind: operation.kind,
        text,
        validFrom: instant(operation.validFrom),
        validUntil: instant(operation.validUntil),
        validUntilBasis: operation.validUntilBasis,
        derivedFrom: operation.derivedFrom ?? "person",
        conflict: operation.conflict,
        confidence: operation.confidence,
        evidence: operation.evidence,
      };
    case "update":
      if (!operation.factId || text.length === 0 || text.length > 600) return null;
      return { op: "update", factId: operation.factId, text, validUntil: instant(operation.validUntil), evidence: operation.evidence };
    case "confirm":
      if (!operation.factId) return null;
      return { op: "confirm", factId: operation.factId, evidence: operation.evidence };
    case "retract":
      if (!operation.factId) return null;
      return {
        op: "retract",
        factId: operation.factId,
        reason: (operation.reason?.trim() || "no longer true").slice(0, 300),
        evidence: operation.evidence,
      };
  }
}

/** Distinct words worth matching remembered facts on; the store builds the FTS expression. */
export function sweepTerms(messages: readonly { text: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    for (const token of message.text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token.length < 4) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 64).map(([token]) => token);
}

export type MemorySweepRunOutcome =
  | { status: "applied"; operations: number; refused: number; toSeq: number }
  | { status: "already_applied"; toSeq: number }
  | { status: "rewound"; toSeq: number }
  | { status: "nothing_to_sweep" }
  | { status: "failed"; code: string };

/**
 * One delivery: read the window, ask the model, apply, settle. Throws on a
 * model or store failure after releasing the claim, so the consumer's log
 * names the reason and the alarm retries at the claim's rest.
 */
export async function runMemorySweep(env: Env, message: MemorySweepMessage): Promise<MemorySweepRunOutcome> {
  const target: MemorySweepTarget = {
    workspaceId: message.workspaceId,
    parentKind: message.parentKind,
    parentId: message.parentId,
    substreamId: message.substreamId,
  };
  const conversation: MemoryConversation = {
    parentKind: message.parentKind,
    parentId: message.parentId,
    substreamId: message.substreamId,
  };
  const scheduling = createSchedulingObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId);
  const workspace = await durableObjectStubForWorkspace(
    env, env.WORKSPACE_DOS, asWorkspaceId(message.workspaceId), workspaceDOName(env.AVALON_REGION, asWorkspaceId(message.workspaceId)),
  );
  const settle = (toSeq: number, wrote: boolean) => scheduling.settleMemorySweep({
    fromSeq: message.fromSeq,
    toSeq,
    attempt: message.attempt,
    wrote,
    restUntil: (quiet) => memorySweepRestUntil(Date.now(), quiet),
    now: Date.now(),
  });
  try {
    const window = await readWindow(env, target, message.fromSeq, message.toSeq);
    const fresh = window.messages.filter((entry) => !entry.context);
    const speakerIds = [...new Set(fresh.filter(isPerson).flatMap((entry) => entry.authorUserId ? [entry.authorUserId] : []))];
    const now = Date.now();
    const candidates = WorkspaceMemorySweepCandidatesResultSchema.parse(await workspace.memorySweepCandidates({
      workspaceId: message.workspaceId,
      conversation,
      terms: sweepTerms(fresh),
      speakerIds,
      now,
      limit: MEMORY_SWEEP_MAXIMUM_CANDIDATES,
    }));
    if (candidates.outcome === "conversation_missing" || fresh.length === 0) {
      await settle(message.toSeq, false);
      return { status: "nothing_to_sweep" };
    }
    const placement = candidates.placement;
    const inference = await runStructuredInference(env, {
      role: "memory_sweep",
      activity: "memory_sweep",
      context: { workspaceId: message.workspaceId, workstreamId: message.parentId, substreamId: message.substreamId },
      messages: renderMemorySweepMessages({
        now: new Date(now).toISOString(),
        placement: {
          subject: { kind: placement.subject.kind as "thread" | "breakout" | "sidekick" | "channel", title: placement.subject.title },
          thread: placement.thread ? { title: placement.thread.title } : null,
          channels: placement.channels,
          organizationWide: placement.organizationWide,
          people: placement.people.map((person) => ({
            id: person.id,
            name: fresh.find((entry) => entry.authorUserId === person.id)?.authorName ?? null,
          })),
        },
        candidates: candidates.candidates.map((fact): MemorySweepCandidateInput => ({
          factId: fact.factId,
          subjectKind: fact.subjectKind,
          kind: fact.kind,
          text: fact.text,
          validFrom: fact.validFrom === null ? null : new Date(fact.validFrom).toISOString(),
          validUntil: fact.validUntil === null ? null : new Date(fact.validUntil).toISOString(),
          derivedFrom: fact.derivedFrom,
          conflict: fact.conflict,
        })),
        messages: window.messages,
        windowTruncated: window.truncated,
      }),
      schemaName: "memory_sweep",
      jsonSchema: memorySweepJsonSchema,
      parse: (value) => MemorySweepDecisionSchema.parse(value),
    });
    const operations = inference.result.operations.flatMap((operation) => {
      const narrowed = narrowOperation(operation);
      return narrowed ? [narrowed] : [];
    });
    const dropped = inference.result.operations.length - operations.length;
    const applied = WorkspaceMemoryApplySweepResultSchema.parse(await workspace.applyMemorySweep({
      workspaceId: message.workspaceId,
      conversation,
      fromSeq: message.fromSeq,
      toSeq: message.toSeq,
      operations,
      model: inference.model,
      inputTokens: inference.inputTokens,
      outputTokens: inference.outputTokens,
      factIds: operations.map(() => newId()),
      speakerIds,
      candidateFactIds: candidates.candidates.map((fact) => fact.factId),
      now: Date.now(),
    }));
    if (applied.outcome === "cursor_ahead") {
      // The store is behind this conversation's cursor: a range was skipped.
      // Rewind so the next attempt re-reads from what the store last applied.
      await settle(applied.storedToSeq, false);
      logWarn(env, "memory_sweep_cursor_ahead", {
        workspace_id: message.workspaceId, workstream_id: message.parentId, substream_id: message.substreamId,
        from_seq: message.fromSeq, stored_to_seq: applied.storedToSeq,
      });
      return { status: "rewound", toSeq: applied.storedToSeq };
    }
    const wrote = applied.outcome === "applied"
      ? applied.receipt.operationCount - applied.refused.length > 0
      : applied.receipt.operationCount > 0;
    await settle(applied.receipt.toSeq, wrote);
    if (applied.outcome === "already_applied") return { status: "already_applied", toSeq: applied.receipt.toSeq };
    // Every copy this conversation holds now reads a stale store; refresh
    // them here rather than wait for the next run of each principal. Never
    // throws, so a failed refresh cannot release a sweep that committed.
    if (wrote) await refreshMemoryDigestCopies(env, { workspaceId: message.workspaceId, ...conversation });
    logStructuredEvent(env, "info", "memory_sweep_applied", {
      workspace_id: message.workspaceId,
      workstream_id: message.parentId,
      substream_id: message.substreamId,
      source: memorySourceOf(conversation),
      from_seq: message.fromSeq,
      to_seq: message.toSeq,
      model: inference.model,
      operations: operations.length,
      refused: applied.refused.length,
      refused_codes: applied.refused.map((entry) => entry.code),
      dropped_incoherent: dropped,
      candidates: candidates.candidates.length,
      window_messages: fresh.length,
    });
    return { status: "applied", operations: operations.length, refused: applied.refused.length, toSeq: applied.receipt.toSeq };
  } catch (error) {
    await scheduling.releaseMemorySweep({ attempt: message.attempt, now: Date.now() }).catch(() => undefined);
    const code = zodDiagnosticCode(error, "memory_sweep_decision") ?? diagnosticErrorCode(error, "memory_sweep_failed");
    logWarn(env, "memory_sweep_failed", {
      workspace_id: message.workspaceId,
      workstream_id: message.parentId,
      substream_id: message.substreamId,
      from_seq: message.fromSeq,
      to_seq: message.toSeq,
      attempt: message.attempt,
      reason: code,
    });
    throw error;
  }
}
