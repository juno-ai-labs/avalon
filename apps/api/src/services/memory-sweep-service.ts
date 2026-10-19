import { IdSchema, WorkspaceIdSchema, asWorkspaceId } from "@rally/contracts";
import { RegionSchema } from "@rally/contracts/regions";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { newId } from "@rally/db";
import {
  MAXIMUM_MEMORY_SWEEP_EVIDENCE,
  MAXIMUM_MEMORY_SWEEP_OPERATIONS,
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
  type MemoryDerivedFrom,
  type MemorySweepOperation,
} from "../durable-objects/workspace-memory-facts-protocol";
import type { MessageRow } from "../durable-objects/workstream-message-storage";
import { memorySweepRestUntil as restUntilAfter } from "../durable-objects/workstream-scheduling-storage";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logInfo, logStructuredEvent, logWarn } from "../observability/logger";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";
import { runStructuredInference } from "./structured-inference";

/**
 * The memory sweep lane: after a run settles, a conversation that has rested
 * and has new person messages behind its cursor is claimed and sent to the
 * Queue; the consumer reads the window, asks a strong model what Rally should
 * remember, applies the answer in `WorkspaceDO` behind the conversation's
 * cursor fence, and settles the cursor.
 *
 * Two halves, deliberately: `attemptMemorySweep` runs inside the conversation
 * object at settlement and from its alarm, costs two single-row reads and one
 * write on most calls, and never throws. `runMemorySweep` runs in the Queue consumer, where
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
  return restUntilAfter(now, quiet, MEMORY_SWEEP_REST_FLOOR_MS, MEMORY_SWEEP_REST_CEILING_MS);
}

/** The receipt's `model` for a range recorded without a model call: nothing in it was worth one. */
const NO_MODEL = "none";

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

interface SweepWindow {
  messages: WindowMessage[];
  /** Where a sweep of this window ends: the last message kept, or the page's last row when nothing was cut. */
  latestSeq: number;
  /** The window could not grow: the page came back at its row limit, or the budget cut it. A later sweep reads on. */
  truncated: boolean;
}

async function readWindow(
  env: Env,
  target: MemorySweepTarget,
  fromSeq: number,
  toSeq: number | null,
): Promise<SweepWindow> {
  const limit = MEMORY_SWEEP_MAXIMUM_WINDOW_MESSAGES + MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES + 1;
  const rows = await createMessageObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId)
    .messagesAfter({ afterSequence: Math.max(0, fromSeq - MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES), limit });
  const bounded = toSeq === null ? rows : rows.filter((row) => Number(row.sequence_number) <= toSeq);
  const messages = bounded.flatMap((row) => {
    const message = windowMessage(row, fromSeq);
    return message ? [message] : [];
  });
  // Context rows are bounded by count (the overlap) and kept whole. The fresh
  // ones are kept oldest first until the character budget runs out, and the
  // sweep ends at the last one kept, so what did not fit is the next sweep's.
  // Cutting from the newest end is what keeps the cursor honest: a window
  // that dropped its oldest messages and still ended at its newest would
  // skip them for good. A single message is within MESSAGE_MAX_CHARACTERS,
  // below the budget, so the first one always fits.
  const context = messages.filter((message) => message.context);
  const fresh = messages.filter((message) => !message.context);
  let budget = MEMORY_SWEEP_MAXIMUM_WINDOW_CHARACTERS;
  let keptFresh = 0;
  for (const message of fresh) {
    if (message.text.length > budget) break;
    budget -= message.text.length;
    keptFresh += 1;
  }
  const kept = fresh.slice(0, keptFresh);
  const cut = keptFresh < fresh.length;
  const newest = bounded.at(-1);
  const lastRowSeq = newest ? Number(newest.sequence_number) : fromSeq;
  return {
    messages: [...context, ...kept],
    latestSeq: cut ? kept.at(-1)?.seq ?? fromSeq : lastRowSeq,
    truncated: cut || rows.length >= limit,
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
  // A Channel's own feed is not swept in this release (prd.md non-goal 9).
  if (target.parentKind === "space") return { status: "skipped", reason: "space_parent" };
  const now = Date.now();
  const scheduling = createSchedulingObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId);
  const [identity, state] = await Promise.all([
    createIdentityObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId).identity(),
    scheduling.memorySweepState(),
  ]);
  // Every path below moves `retry_at`, or the alarm would wake into the same answer.
  const skip = async (reason: string, retryAt: number | null = null): Promise<MemorySweepAttemptOutcome> => {
    await scheduling.deferMemorySweep({ retryAt, now });
    return { status: "skipped", reason };
  };
  if (!env.OPENROUTER_API_KEY) return skip("no_model_access");
  if (!identity) return skip("conversation_missing");
  if (identity.archived_at != null) return skip("archived");
  const cursor = Number(state?.swept_through_seq ?? 0);
  if (state && state.rest_until > now) {
    // Resting: ask the alarm back at the rest when there is anything after
    // the cursor, without reading it. The floors are checked when it comes.
    const pending = await createMessageObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId)
      .hasMessageAfter({ afterSequence: cursor });
    return skip("resting", pending ? Number(state.rest_until) : null);
  }
  // Moved before the window is read, so a read that throws leaves the alarm quiet.
  await scheduling.deferMemorySweep({ retryAt: null, now });
  const window = await readWindow(env, target, cursor, null);
  const spoken = window.messages.filter((message) => !message.context && isPerson(message));
  const spokenCharacters = spoken.reduce((total, message) => total + message.text.length, 0);
  if (spoken.length < MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES || spokenCharacters < MEMORY_SWEEP_MINIMUM_PERSON_CHARACTERS) {
    if (!window.truncated) return { status: "skipped", reason: "insufficient_new_conversation" };
    // A window that cannot grow (a full page of rows, or the character budget
    // spent on agent text) would never meet the floors from this cursor, and
    // the cursor would never pass it. Record what was read as swept with no
    // model call (a receipt first, so the store's fence moves with the cursor)
    // and let the next attempt read on from there.
    const settled = await recordUnswept(env, target, scheduling, { fromSeq: cursor, toSeq: window.latestSeq, attempt: 0 });
    logInfo(env, "memory_sweep_page_skipped", {
      workspace_id: target.workspaceId,
      workstream_id: target.parentId,
      substream_id: target.substreamId,
      from_seq: cursor,
      to_seq: settled,
      person_messages: spoken.length,
    });
    return { status: "skipped", reason: "page_without_conversation" };
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
  evidence: z.array(z.number().int().nonnegative()).max(MAXIMUM_MEMORY_SWEEP_EVIDENCE),
  factId: z.string().nullable(),
  reason: z.string().nullable(),
});
/**
 * Only the envelope is held strictly: each operation is checked on its own,
 * so one malformed row (a date that is not RFC 3339, a confidence out of
 * range) costs that row and not the paid call that produced the rest.
 */
const MemorySweepDecisionSchema = z.strictObject({ operations: z.array(z.unknown()) });
type ModelOperation = z.infer<typeof ModelOperationSchema>;
type TrustClass = Exclude<MemoryDerivedFrom, "mixed">;

const instant = (value: string | null): number | null => (value === null ? null : Date.parse(value));

function trustOf(authorType: WindowMessage["authorType"]): TrustClass {
  return authorType === "person" ? "person" : authorType === "external" ? "external" : "agent";
}

/**
 * The trust class of an operation, from who wrote the messages it cites
 * rather than from what the model says: one class is that class, two or more
 * are `mixed`. With nothing citable the model's word stands, and its silence
 * is `agent`, never `person`, so a fact nobody can trace is never the most
 * trusted kind.
 */
function derivedFromEvidence(
  evidence: readonly number[],
  authors: ReadonlyMap<number, WindowMessage["authorType"]>,
  stated: TrustClass | null,
): MemoryDerivedFrom {
  const classes = new Set(evidence.flatMap((seq) => {
    const authorType = authors.get(seq);
    return authorType ? [trustOf(authorType)] : [];
  }));
  if (classes.size === 0) return stated ?? "agent";
  return classes.size === 1 ? [...classes][0]! : "mixed";
}

/**
 * The flat model shape narrowed to the store's operations. A row the model
 * left incoherent (an `add` with no text, an `update` with no id) is dropped
 * here and counted, rather than refused one hop later under a vaguer code.
 */
function narrowOperation(
  operation: ModelOperation,
  authors: ReadonlyMap<number, WindowMessage["authorType"]>,
): MemorySweepOperation | null {
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
        derivedFrom: derivedFromEvidence(operation.evidence, authors, operation.derivedFrom),
        conflict: operation.conflict,
        confidence: operation.confidence,
        evidence: operation.evidence,
      };
    case "update":
      if (!operation.factId || text.length === 0 || text.length > 600) return null;
      return {
        op: "update",
        factId: operation.factId,
        text,
        validUntil: instant(operation.validUntil),
        derivedFrom: derivedFromEvidence(operation.evidence, authors, operation.derivedFrom),
        evidence: operation.evidence,
      };
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

function conversationOf(target: MemorySweepTarget): MemoryConversation {
  return { parentKind: target.parentKind, parentId: target.parentId, substreamId: target.substreamId };
}

function workspaceObject(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env, env.WORKSPACE_DOS, asWorkspaceId(workspaceId), workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

type SchedulingPort = ReturnType<typeof createSchedulingObjectPort>;
type WorkspaceObject = Awaited<ReturnType<typeof workspaceObject>>;

function settleSweep(
  scheduling: SchedulingPort,
  range: { fromSeq: number; attempt: number },
  toSeq: number,
  wrote: boolean,
) {
  return scheduling.settleMemorySweep({
    fromSeq: range.fromSeq,
    toSeq,
    attempt: range.attempt,
    wrote,
    restFloorMs: MEMORY_SWEEP_REST_FLOOR_MS,
    restCeilingMs: MEMORY_SWEEP_REST_CEILING_MS,
    now: Date.now(),
  });
}

/**
 * Record a range as swept with nothing written and no model call: an empty
 * receipt in `WorkspaceDO`, then the cursor to where the store says it is.
 * The receipt is what keeps the store's fence in step with the cursor; a
 * cursor moved without one would be answered `cursor_ahead` by the next
 * sweep and rewound over the same range. Answers the cursor it settled at.
 */
async function recordUnswept(
  env: Env,
  target: MemorySweepTarget,
  scheduling: SchedulingPort,
  range: { fromSeq: number; toSeq: number; attempt: number },
  workspace?: WorkspaceObject,
): Promise<number> {
  const store = workspace ?? await workspaceObject(env, target.workspaceId);
  const applied = WorkspaceMemoryApplySweepResultSchema.parse(await store.applyMemorySweep({
    workspaceId: target.workspaceId,
    conversation: conversationOf(target),
    fromSeq: range.fromSeq,
    toSeq: range.toSeq,
    operations: [],
    model: NO_MODEL,
    inputTokens: null,
    outputTokens: null,
    factIds: [],
    speakerIds: [],
    candidateFactIds: [],
    now: Date.now(),
  }));
  const settledTo = applied.outcome === "cursor_ahead" ? applied.storedToSeq : applied.receipt.toSeq;
  await settleSweep(scheduling, range, settledTo, false);
  return settledTo;
}

/** Members' display names from the regional directory, so the model names people rather than ids. */
async function personNames(env: Env, userIds: readonly string[]): Promise<Map<string, string | null>> {
  if (userIds.length === 0) return new Map();
  const rows = await env.DB.prepare(`SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(userIds))
    .all<{ id: string; name: string | null }>();
  return new Map(rows.results.map((row) => [row.id, row.name]));
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
  const conversation = conversationOf(target);
  const scheduling = createSchedulingObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId);
  const workspace = await workspaceObject(env, message.workspaceId);
  const settle = (toSeq: number, wrote: boolean) => settleSweep(scheduling, message, toSeq, wrote);
  try {
    const window = await readWindow(env, target, message.fromSeq, message.toSeq);
    const fresh = window.messages.filter((entry) => !entry.context);
    const speakerIds = [...new Set(fresh.filter(isPerson).flatMap((entry) => entry.authorUserId ? [entry.authorUserId] : []))];
    const members = [...new Set(window.messages.flatMap((entry) =>
      entry.authorType === "person" && entry.authorUserId ? [entry.authorUserId] : []))];
    const now = Date.now();
    const [names, candidatesAnswer] = await Promise.all([
      personNames(env, members),
      workspace.memorySweepCandidates({
        workspaceId: message.workspaceId,
        conversation,
        terms: sweepTerms(fresh),
        speakerIds,
        now,
        limit: MEMORY_SWEEP_MAXIMUM_CANDIDATES,
      }),
    ]);
    const candidates = WorkspaceMemorySweepCandidatesResultSchema.parse(candidatesAnswer);
    if (candidates.outcome === "conversation_missing" || fresh.length === 0) {
      await recordUnswept(env, target, scheduling, message, workspace);
      return { status: "nothing_to_sweep" };
    }
    const messages = window.messages.map((entry) => entry.authorType === "person" && entry.authorUserId
      ? { ...entry, authorName: names.get(entry.authorUserId) ?? entry.authorName }
      : entry);
    const authors = new Map(messages.map((entry) => [entry.seq, entry.authorType]));
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
            name: names.get(person.id) ?? messages.find((entry) => entry.authorUserId === person.id)?.authorName ?? null,
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
        messages,
        windowTruncated: window.truncated,
      }),
      schemaName: "memory_sweep",
      jsonSchema: memorySweepJsonSchema,
      parse: (value) => MemorySweepDecisionSchema.parse(value),
    });
    const returned = inference.result.operations;
    const checked = returned.slice(0, MAXIMUM_MEMORY_SWEEP_OPERATIONS).map((operation) => ModelOperationSchema.safeParse(operation));
    const malformed = checked.flatMap((result) => result.success ? [] : [result.error]);
    if (malformed.length > 0 || returned.length > MAXIMUM_MEMORY_SWEEP_OPERATIONS) {
      logWarn(env, "memory_sweep_operation_dropped", {
        workspace_id: message.workspaceId,
        workstream_id: message.parentId,
        substream_id: message.substreamId,
        malformed: malformed.length,
        beyond_limit: Math.max(0, returned.length - MAXIMUM_MEMORY_SWEEP_OPERATIONS),
        reasons: [...new Set(malformed.map((error) => zodDiagnosticCode(error, "memory_sweep_operation")))],
      });
    }
    const operations = checked.flatMap((result) => {
      const narrowed = result.success ? narrowOperation(result.data, authors) : null;
      return narrowed ? [narrowed] : [];
    });
    const dropped = returned.length - operations.length;
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
