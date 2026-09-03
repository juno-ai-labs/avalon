import { runInDurableObject } from "cloudflare:test";
import {
  asAutomationId,
  asWorkspaceId,
  asWorkstreamId,
  ConversationEffectEnvelopeSchema,
  ParentEffectEnvelopeSchema,
  type ConversationEffectEnvelope,
  type ParentEffectEnvelope,
} from "@rally/contracts";
import type { Env } from "../../src/env";
import { automationDOName, workstreamDOName } from "../../src/durable-objects/names";
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

async function pendingRows(stub: DurableObjectStub, kind: "conversation_effect" | "parent_effect"): Promise<OutboxRow[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<OutboxRow>(
      `SELECT message_id, payload_json FROM durable_outbox
        WHERE state IN ('pending', 'inflight')
          AND json_extract(payload_json, '$.kind') = ?
        ORDER BY created_at, message_id`,
      kind,
    ).toArray());
}

async function deleteRows(stub: DurableObjectStub, rows: OutboxRow[]): Promise<void> {
  if (rows.length === 0) return;
  await runInDurableObject(stub, (_instance, state) => {
    for (const row of rows) {
      state.storage.sql.exec(`DELETE FROM durable_outbox WHERE message_id = ?`, row.message_id);
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

/** Child outbox → consumer → parent `receiveChildEffects`. Returns what was delivered. */
export async function deliverChildEffects(env: Env, child: DurableObjectStub): Promise<ConversationEffectEnvelope[]> {
  const rows = await pendingRows(child, "conversation_effect");
  const envelopes = rows.map((row) => ConversationEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  if (envelopes.length === 0) return envelopes;
  const result = await consumeEffectBodies(env, envelopes);
  if (result.retried > 0) throw new Error(`conversation effect delivery retried ${result.retried} message(s)`);
  await deleteRows(child, rows);
  return envelopes;
}

/** Parent outbox → consumer → WorkspaceDO. Returns what was delivered. */
export async function deliverParentEffects(env: Env, parent: DurableObjectStub): Promise<ParentEffectEnvelope[]> {
  const rows = await pendingRows(parent, "parent_effect");
  const envelopes = rows.map((row) => ParentEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  if (envelopes.length === 0) return envelopes;
  const result = await consumeEffectBodies(env, envelopes);
  if (result.retried > 0) throw new Error(`parent effect delivery retried ${result.retried} message(s)`);
  await deleteRows(parent, rows);
  return envelopes;
}

export function parentStubFor(
  env: Env,
  region: "global" | "eu",
  parent: { workspaceId: string; parentKind: "workstream" | "automation"; parentId: string },
): DurableObjectStub {
  if (parent.parentKind === "automation") {
    return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
      automationDOName(region, asWorkspaceId(parent.workspaceId), asAutomationId(parent.parentId)),
    ));
  }
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName(region, asWorkspaceId(parent.workspaceId), asWorkstreamId(parent.parentId)),
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
  region: "global" | "eu" = "global",
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
