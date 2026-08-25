/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What being added to a work stream puts in the outbox.
 *
 * Adding somebody produced exactly one effect — their directory row — so the
 * person was never told, by any channel, that a room now existed for them. The
 * add now also enqueues an activity event and a notification intent, and the
 * ordering between the three is the part worth proving on real storage: the
 * notification carries a `requiredProjectionVersion` read from the projection
 * key the directory effect has just advanced, and the delivery side refuses to
 * send until the workspace has reached that version. Get the order wrong and
 * the whole thing still "works" in a mock, then tells somebody about a work
 * stream their sidebar cannot show them.
 *
 * This drives the real SubstreamAgent product endpoint against real Durable
 * Object SQLite, so `projection_keys`, the payload hashes, and the outbox rows
 * are the production ones rather than a description of them.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { substreamAgentName, workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import {
  WorkstreamRegionalEffectEnvelopeSchema,
  type WorkstreamRegionalEffectEnvelope,
} from "../src/durable-objects/workstream-regional-effect";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000006a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a2");
const SECOND_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a6");
const CREATOR_ID = "00000000-0000-7000-8000-0000000006a3";
const SESSION_ID = "00000000-0000-7000-8000-0000000006a4";
const INVITEE_ID = "00000000-0000-7000-8000-0000000006a5";

const AUTH = {
  sessionId: SESSION_ID,
  userId: CREATOR_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  // An owner, because removing somebody else is an owner/admin action and the
  // re-add case below has to actually remove them.
  role: "owner" as const,
};

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'owner', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, CREATOR_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, INVITEE_ID),
    env.DB.prepare(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, CREATOR_ID, WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'creator@example.com', 'Creator', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(CREATOR_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'invitee@example.com', 'Invitee', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(INVITEE_ID),
  ]);
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
});

function agentStub(workstreamId = WORKSTREAM_ID): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName("global", WORKSPACE_ID, workstreamId),
  ));
}

async function product(stub: DurableObjectStub, body: unknown): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await stub.fetch("https://object.test/internal/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function openWorkstream(
  stub: DurableObjectStub,
  workstreamId = WORKSTREAM_ID,
  title = "Quarterly planning",
  participantUserIds: readonly string[] = [],
): Promise<void> {
  const opened = await product(stub, {
    operation: "initialize",
    auth: AUTH,
    input: {
      workspaceId: WORKSPACE_ID,
      workstreamId,
      generation: 1,
      title,
      objective: "Draft the quarterly plan",
      descriptionSource: "authored",
      titleStatus: "settled",
      emailAddress: null,
      creatorUserId: CREATOR_ID,
      openingMessage: "starting the plan",
      clientMessageId: `participant-open-${workstreamId}`,
      participantUserIds,
      attachmentIds: [],
      modelOverride: null,
      executionPrincipal: { type: "user", userId: CREATOR_ID },
      reason: "user_message",
    },
  });
  expect(opened.status).toBe(200);
}

/** Every regional effect the object has enqueued and not yet acknowledged. */
async function outbox(stub: DurableObjectStub): Promise<WorkstreamRegionalEffectEnvelope[]> {
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ payload_json: string }>(
      `SELECT payload_json FROM durable_outbox
        WHERE channel = 'regional_effect_v1' ORDER BY created_at, message_id`,
    ).toArray());
  return rows.map((row) => WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
}

/**
 * The notification effects the parent object has taken delivery of.
 *
 * Flushing first is what makes this deterministic: the same RPC the create
 * path uses drains the child outbox on demand instead of waiting for the alarm
 * that would otherwise empty it underneath the assertion.
 */
async function notificationReceipts(
  stub: DurableObjectStub,
  workstreamId = WORKSTREAM_ID,
): Promise<string[]> {
  await (stub as unknown as { flushEffectsToWorkstreamDO(): Promise<unknown> })
    .flushEffectsToWorkstreamDO();
  const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName("global", WORKSPACE_ID, workstreamId),
  ));
  return runInDurableObject(parent, (_instance, state) =>
    state.storage.sql.exec<{ message_id: string }>(
      `SELECT message_id FROM child_effect_receipts
        WHERE message_id LIKE 'effect:participant_added:%' ORDER BY message_id`,
    ).toArray().map((row) => row.message_id));
}

/**
 * Every effect the parent object has taken delivery of, with its payload.
 *
 * The child's own outbox is not a place to read this from: a commit arms its
 * alarm for the current instant, so the drain races any assertion made against
 * it — the more effects a path enqueues, the more reliably the read loses. The
 * parent's outbox holds each envelope until the Queue consumer acknowledges
 * it, which nothing in this suite does, so a flush lands them here to stay.
 */
async function deliveredEffects(
  stub: DurableObjectStub,
  workstreamId = WORKSTREAM_ID,
): Promise<WorkstreamRegionalEffectEnvelope[]> {
  await (stub as unknown as { flushEffectsToWorkstreamDO(): Promise<unknown> })
    .flushEffectsToWorkstreamDO();
  const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName("global", WORKSPACE_ID, workstreamId),
  ));
  const rows = await runInDurableObject(parent, (_instance, state) =>
    state.storage.sql.exec<{ payload_json: string }>(
      `SELECT payload_json FROM durable_outbox ORDER BY created_at, message_id`,
    ).toArray());
  return rows.map((row) => WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
}

describe("adding somebody to a work stream", () => {
  it("enqueues their directory row, an activity event, and a notification behind it", async () => {
    const stub = agentStub();
    await openWorkstream(stub);

    const added = await product(stub, {
      operation: "add_participant",
      auth: AUTH,
      userId: INVITEE_ID,
    });
    expect(added.status).toBe(200);

    const envelopes = await outbox(stub);
    const viewer = envelopes.filter((envelope) => (
      envelope.effect.kind === "directory_user" && envelope.effect.userId === INVITEE_ID
    ));
    const activity = envelopes.filter((envelope) => (
      envelope.effect.kind === "activity_event"
      && envelope.effect.eventType === "workstream_participant_added"
    ));
    const notification = envelopes.filter((envelope) => envelope.effect.kind === "participant_notification");
    expect([viewer.length, activity.length, notification.length]).toEqual([1, 1, 1]);

    const activityEffect = activity[0]!.effect;
    if (activityEffect.kind !== "activity_event") throw new Error("expected an activity event");
    expect(activityEffect.targets).toEqual([{ userId: INVITEE_ID, relation: "added" }]);
    expect(activityEffect.actorUserId).toBe(CREATOR_ID);
    expect(activityEffect.digestible).toBe(true);
    expect(activityEffect.body).toBe("Creator added Invitee to this work stream.");

    const notificationEffect = notification[0]!.effect;
    if (notificationEffect.kind !== "participant_notification") {
      throw new Error("expected a participant notification");
    }
    // The work stream is in both identities on purpose: the intents table and
    // the activity log's dedupe key are workspace-wide, while the epoch below
    // is object-local and starts at zero in every room. Without it, adding one
    // person to a second work stream reuses the first one's identity and the
    // effect is refused as a conflict rather than delivered.
    expect(notificationEffect.intentId).toBe(`participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`);
    expect(notificationEffect.sourceId).toBe(`participant:${WORKSTREAM_ID}:${INVITEE_ID}:0`);
    expect(activityEffect.dedupeKey).toBe(`participant:${WORKSTREAM_ID}:${INVITEE_ID}:0`);
    expect(notificationEffect.recipientUserId).toBe(INVITEE_ID);
    expect(notificationEffect.actorUserId).toBe(CREATOR_ID);
    expect(notificationEffect.actorNameSnapshot).toBe("Creator");
    expect(notificationEffect.workstreamTitleSnapshot).toBe("Quarterly planning");
    expect(notificationEffect.workstreamObjectiveSnapshot).toBe("Draft the quarterly plan");

    // The dependency, and the reason the notification is enqueued last: it is
    // gated on the version the viewer effect above was written at, so the
    // workspace cannot deliver it before that row lands.
    expect(notification[0]!.requiredProjectionVersion).toBe(viewer[0]!.sourceVersion);
    expect(notification[0]!.requiredProjectionVersion).toBeGreaterThan(0);
  });

  it("keeps a second add of the same person to one intent, and a re-add to a new one", async () => {
    const stub = agentStub();
    await openWorkstream(stub);

    await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    // Asserted on the parent's receipts rather than on this object's outbox:
    // the outbox is drained by the alarm the moment an effect lands in it, so
    // counting rows there races the delivery it is supposed to be describing.
    // Receipts are kept for their whole retention window and are keyed by the
    // message id, which is the effect's identity.
    expect(await notificationReceipts(stub))
      .toEqual([`effect:participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`]);

    // Removing bumps the participant epoch, so being brought back is a new
    // thing to say rather than a redelivery of the first one.
    const removed = await product(stub, {
      operation: "remove_participant", auth: AUTH, userId: INVITEE_ID,
    });
    expect(removed.status).toBe(200);
    await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect(await notificationReceipts(stub)).toEqual([
      `effect:participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`,
      `effect:participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:2`,
    ]);
  });

  it("keeps one person's adds to two work streams apart", async () => {
    const first = agentStub();
    const second = agentStub(SECOND_WORKSTREAM_ID);
    await openWorkstream(first);
    await openWorkstream(second, SECOND_WORKSTREAM_ID, "Hiring loop");

    await product(first, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    await product(second, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });

    // The ordinary use of the feature, and the one an object-local identity
    // gets wrong: `participant_epoch` is zero in both rooms, so an identity
    // without the work stream in it makes these two adds one identity. The
    // workspace holds both — `workspace_workstream_effect_receipts.message_id`
    // is a primary key, `workspace_activity_events.dedupe_key` is unique, and
    // the intents table is fenced on the source — so the second add would be
    // refused as a hash conflict and retried forever instead of delivered.
    expect(await notificationReceipts(first))
      .toEqual([`effect:participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`]);
    expect(await notificationReceipts(second, SECOND_WORKSTREAM_ID))
      .toEqual([`effect:participant_added:${SECOND_WORKSTREAM_ID}:${INVITEE_ID}:0`]);
  });

  it("says nothing when somebody adds themselves", async () => {
    const stub = agentStub();
    await openWorkstream(stub);

    const added = await product(stub, {
      operation: "add_participant",
      auth: AUTH,
      userId: CREATOR_ID,
    });
    expect(added.status).toBe(200);

    const envelopes = await outbox(stub);
    expect(envelopes.filter((envelope) => envelope.effect.kind === "participant_notification")).toHaveLength(0);
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "activity_event"
      && envelope.effect.eventType === "workstream_participant_added"
    ))).toHaveLength(0);
  });
});

describe("naming somebody when the work stream is created", () => {
  it("tells them the same way adding them afterwards does", async () => {
    const stub = agentStub();
    await openWorkstream(stub, WORKSTREAM_ID, "Quarterly planning", [INVITEE_ID]);

    const envelopes = await deliveredEffects(stub);
    const viewer = envelopes.filter((envelope) => (
      envelope.effect.kind === "directory_user" && envelope.effect.userId === INVITEE_ID
    ));
    const activity = envelopes.filter((envelope) => (
      envelope.effect.kind === "activity_event"
      && envelope.effect.eventType === "workstream_participant_added"
    ));
    const notification = envelopes.filter((envelope) => envelope.effect.kind === "participant_notification");
    expect([viewer.length, activity.length, notification.length]).toEqual([1, 1, 1]);

    const notificationEffect = notification[0]!.effect;
    if (notificationEffect.kind !== "participant_notification") {
      throw new Error("expected a participant notification");
    }
    // The same identity the add-afterwards path mints, so the two cannot
    // notify one person about one participation twice.
    expect(notificationEffect.intentId).toBe(`participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`);
    expect(notificationEffect.sourceId).toBe(`participant:${WORKSTREAM_ID}:${INVITEE_ID}:0`);
    expect(notificationEffect.recipientUserId).toBe(INVITEE_ID);
    expect(notificationEffect.actorUserId).toBe(CREATOR_ID);
    expect(notificationEffect.actorNameSnapshot).toBe("Creator");
    expect(notificationEffect.workstreamTitleSnapshot).toBe("Quarterly planning");
    expect(notificationEffect.workstreamObjectiveSnapshot).toBe("Draft the quarterly plan");

    const activityEffect = activity[0]!.effect;
    if (activityEffect.kind !== "activity_event") throw new Error("expected an activity event");
    expect(activityEffect.targets).toEqual([{ userId: INVITEE_ID, relation: "added" }]);
    expect(activityEffect.body).toBe("Creator added Invitee to this work stream.");

    // Armed by the viewer effect emitted immediately before it, exactly as on
    // the add-afterwards path: nobody is told about a work stream their own
    // sidebar row has not reached the workspace yet.
    expect(notification[0]!.requiredProjectionVersion).toBe(viewer[0]!.sourceVersion);
    expect(notification[0]!.requiredProjectionVersion).toBeGreaterThan(0);
  });

  it("says nothing to the creator about their own work stream", async () => {
    const stub = agentStub();
    await openWorkstream(stub);

    const envelopes = await deliveredEffects(stub);
    expect(envelopes.filter((envelope) => envelope.effect.kind === "participant_notification")).toHaveLength(0);
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "activity_event"
      && envelope.effect.eventType === "workstream_participant_added"
    ))).toHaveLength(0);
  });

  it("does not tell somebody twice when they are also added afterwards", async () => {
    const stub = agentStub();
    await openWorkstream(stub, WORKSTREAM_ID, "Quarterly planning", [INVITEE_ID]);

    const added = await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect(added.status).toBe(200);

    expect(await notificationReceipts(stub))
      .toEqual([`effect:participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`]);
  });
});
