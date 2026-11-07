import { runInDurableObject } from "cloudflare:test";
import {
  asWorkspaceId,
  ConversationEffectEnvelopeSchema,
  ParentEffectEnvelopeSchema,
  type ConversationEffectEnvelope,
  type ParentEffectEnvelope,
} from "@rally/contracts";
import type { Env } from "../../src/env";
import { workspaceDOName } from "../../src/durable-objects/names";
import { consumeActivityQueue } from "../../src/queues/activity-consumer";

/**
 * Drives the two effect legs by hand.
 *
 * The test Worker binds `ACTIVITY_QUEUE` as a producer only, so a drained
 * outbox goes nowhere on its own. These helpers read what an object has
 * queued, hand exactly that to the real consumer, and remove the rows the way
 * a successful `sendBatch` would. What the *real* drain does with the rows is
 * proved once, in `conversation-effect-queue.test.ts`; every other test only
 * needs the effects to arrive.
 */

type OutboxRow = {
  message_id: string;
  payload_json: string;
};

/**
 * The outbox a stub keeps: a conversation's and a Sidekick's `durable_outbox`,
 * or the `parent_outbox` the Organization object keeps for every Channel and
 * Space parent it hosts.
 */
function outboxTable(state: DurableObjectState, kind: "conversation_effect" | "parent_effect"): string {
  if (kind === "conversation_effect") return "durable_outbox";
  return state.storage.sql.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'parent_outbox'",
  ).toArray().length > 0 ? "parent_outbox" : "durable_outbox";
}

async function pendingRows(stub: DurableObjectStub, kind: "conversation_effect" | "parent_effect"): Promise<OutboxRow[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<OutboxRow>(
      `SELECT message_id, payload_json FROM ${outboxTable(state, kind)}
        WHERE state IN ('pending', 'inflight')
          AND json_extract(payload_json, '$.kind') = ?
        ORDER BY created_at, message_id`,
      kind,
    ).toArray());
}

async function deleteRows(stub: DurableObjectStub, rows: OutboxRow[], kind: "conversation_effect" | "parent_effect"): Promise<void> {
  if (rows.length === 0) return;
  await runInDurableObject(stub, (_instance, state) => {
    const table = outboxTable(state, kind);
    for (const row of rows) {
      state.storage.sql.exec(`DELETE FROM ${table} WHERE message_id = ?`, row.message_id);
    }
  });
}

/** Feeds bodies to the real consumer as one batch; a thrown message is reported, not retried. */
export async function consumeEffectBodies(env: Env, bodies: unknown[]): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  const messages = bodies.map((body, index) => ({
    id: `test-effect-${index}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => { acked += 1; },
    retry: () => { retried += 1; },
  })) satisfies Message<unknown>[];
  await consumeActivityQueue({
    messages,
    queue: "avalon-do-runtime-test-activity",
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    retryAll: () => { retried += messages.length; },
    ackAll: () => { acked += messages.length; },
  } as unknown as MessageBatch<unknown>, env);
  return { acked, retried };
}

/** What a conversation object has queued for its parent, without delivering it. */
export async function pendingChildEffects(stub: DurableObjectStub): Promise<ConversationEffectEnvelope[]> {
  const rows = await pendingRows(stub, "conversation_effect");
  return rows.map((row) => ConversationEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
}

/** What a parent has queued for the workspace, without delivering it. */
export async function pendingParentEffects(stub: DurableObjectStub): Promise<ParentEffectEnvelope[]> {
  const rows = await pendingRows(stub, "parent_effect");
  return rows.map((row) => ParentEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
}

/**
 * Deliver a batch the way the Queue does: again, until nothing asks to be.
 *
 * `consumeActivityQueue` processes a batch with `Promise.all`, so the effects in
 * one delivery are applied concurrently and in no particular order. A
 * `directory_user` effect that reaches the workspace before the
 * `directory_common` effect creating the row it references fails its foreign key
 * and retries — which is the Queue's designed recovery, not a defect, and the
 * next delivery applies it. Treating the first retry as fatal asserted an
 * ordering the system does not promise, and failed roughly one full suite run in
 * four, on whichever interleaving the scheduler happened to pick.
 *
 * Bounded, because a message that never settles is a real failure and the point
 * of a test helper is to say so: the effects here converge in two deliveries.
 */
async function deliverUntilSettled(env: Env, envelopes: unknown[], label: string): Promise<void> {
  for (let delivery = 1; delivery <= 3; delivery += 1) {
    const result = await consumeEffectBodies(env, envelopes);
    if (result.retried === 0) return;
  }
  throw new Error(`${label} effect delivery never settled in 3 deliveries`);
}

/** Child outbox → consumer → parent `receiveChildEffects`. Returns what was delivered. */
export async function deliverChildEffects(env: Env, child: DurableObjectStub): Promise<ConversationEffectEnvelope[]> {
  const rows = await pendingRows(child, "conversation_effect");
  const envelopes = rows.map((row) => ConversationEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  if (envelopes.length === 0) return envelopes;
  await deliverUntilSettled(env, envelopes, "conversation");
  await deleteRows(child, rows, "conversation_effect");
  return envelopes;
}

/** Parent outbox → consumer → WorkspaceDO. Returns what was delivered. */
export async function deliverParentEffects(env: Env, parent: DurableObjectStub): Promise<ParentEffectEnvelope[]> {
  const rows = await pendingRows(parent, "parent_effect");
  const envelopes = rows.map((row) => ParentEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  if (envelopes.length === 0) return envelopes;
  await deliverUntilSettled(env, envelopes, "parent");
  await deleteRows(parent, rows, "parent_effect");
  return envelopes;
}

export function parentStubFor(
  env: Env,
  region: string,
  parent: { workspaceId: string; parentKind: string; parentId: string },
): DurableObjectStub {
  // Every parent (Channel, Space, Sidekick) is hosted by the Organization object.
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName(region, asWorkspaceId(parent.workspaceId)),
  ));
}

/**
 * Both legs: the child's effects reach its parent, then everything the parent
 * queued in response reaches the workspace. Returns the parent envelopes,
 * which is what a directory or notification assertion reads next.
 */
export async function deliverEffectsToWorkspace(
  env: Env,
  child: DurableObjectStub,
  region: string = "global",
): Promise<{ child: ConversationEffectEnvelope[]; parent: ParentEffectEnvelope[] }> {
  const childEnvelopes = await deliverChildEffects(env, child);
  const parents = new Map<string, DurableObjectStub>();
  for (const envelope of childEnvelopes) {
    const key = `${envelope.parentKind}:${envelope.parentId}`;
    if (!parents.has(key)) parents.set(key, parentStubFor(env, region, envelope));
  }
  const parentEnvelopes: ParentEffectEnvelope[] = [];
  for (const parent of parents.values()) {
    parentEnvelopes.push(...await deliverParentEffects(env, parent));
  }
  return { child: childEnvelopes, parent: parentEnvelopes };
}

function parentDrainRank(kind: ParentEffectEnvelope["effect"]["kind"]): number {
  if (kind === "directory_common") return 0;
  if (kind === "directory_user" || kind === "directory_automation") return 1;
  return 2;
}

/**
 * Parent outbox → consumer → WorkspaceDO, one message at a time, in the order
 * the parent's own drain sends them: common rows, then viewer rows, then the
 * rest.
 *
 * The Queue promises no order, and the workspace refuses a viewer row for a
 * work stream it has not seen yet (the row references the directory row), so
 * in production that message waits for its redelivery. `deliverParentEffects`
 * consumes a batch concurrently and reports that redelivery as a failure,
 * which is right for a test about one effect and wrong for one that walks a
 * whole creation through: the common row and its viewer rows leave the parent
 * together, and which one the consumer finishes first is a coin toss.
 */
export async function deliverParentEffectsInOrder(
  env: Env,
  parent: DurableObjectStub,
): Promise<ParentEffectEnvelope[]> {
  const rows = await pendingRows(parent, "parent_effect");
  const ordered = rows
    .map((row) => ({ row, envelope: ParentEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)) }))
    .sort((left, right) => parentDrainRank(left.envelope.effect.kind) - parentDrainRank(right.envelope.effect.kind));
  const delivered: ParentEffectEnvelope[] = [];
  for (const { row, envelope } of ordered) {
    const result = await consumeEffectBodies(env, [envelope]);
    if (result.retried > 0) {
      throw new Error(`parent effect delivery retried ${envelope.effect.kind} ${envelope.messageId}`);
    }
    await deleteRows(parent, [row], "parent_effect");
    delivered.push(envelope);
  }
  return delivered;
}

/** `deliverEffectsToWorkspace`, with the parent leg walked in the parent's own order. */
export async function deliverEffectsToWorkspaceInOrder(
  env: Env,
  child: DurableObjectStub,
  region: string = "global",
): Promise<{ child: ConversationEffectEnvelope[]; parent: ParentEffectEnvelope[] }> {
  const childEnvelopes = await deliverChildEffects(env, child);
  const parents = new Map<string, DurableObjectStub>();
  for (const envelope of childEnvelopes) {
    const key = `${envelope.parentKind}:${envelope.parentId}`;
    if (!parents.has(key)) parents.set(key, parentStubFor(env, region, envelope));
  }
  const parentEnvelopes: ParentEffectEnvelope[] = [];
  for (const parent of parents.values()) {
    parentEnvelopes.push(...await deliverParentEffectsInOrder(env, parent));
  }
  return { child: childEnvelopes, parent: parentEnvelopes };
}
