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
import { processWorkstreamNotificationIntent } from "../src/services/workstream-regional-effect-service";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000006a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a2");
const SECOND_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a6");
const CREATOR_ID = "00000000-0000-7000-8000-0000000006a3";
const SESSION_ID = "00000000-0000-7000-8000-0000000006a4";
const INVITEE_ID = "00000000-0000-7000-8000-0000000006a5";
const SECOND_INVITEE_ID = "00000000-0000-7000-8000-0000000006a7";
const MISSING_RECIPIENT_ID = "00000000-0000-7000-8000-0000000006a8";

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
      id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`INSERT INTO workspaces(id, name, region) VALUES (?, 'Notification test', 'global')`).bind(WORKSPACE_ID),
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
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, SECOND_INVITEE_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'second@example.com', 'Second Invitee', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(SECOND_INVITEE_ID),
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
  options: {
    workstreamId?: string;
    title?: string;
    participantUserIds?: readonly string[];
    openingMessage?: string;
    mentions?: readonly {
      type: "person";
      userId: string;
      connectorType: null;
      startOffset: number;
      endOffset: number;
    }[];
    /** What `POST /workstreams` sends; a connector ingress sends nothing. */
    notifyParticipants?: boolean;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const workstreamId = options.workstreamId ?? WORKSTREAM_ID;
  const opened = await product(stub, {
    operation: "initialize",
    auth: AUTH,
    input: {
      workspaceId: WORKSPACE_ID,
      workstreamId,
      generation: 1,
      title: options.title ?? "Quarterly planning",
      objective: "Draft the quarterly plan",
      descriptionSource: "authored",
      titleStatus: "settled",
      emailAddress: null,
      creatorUserId: CREATOR_ID,
      openingMessage: options.openingMessage ?? "starting the plan",
      ...(options.mentions ? { mentions: options.mentions } : {}),
      clientMessageId: `participant-open-${workstreamId}`,
      participantUserIds: options.participantUserIds ?? [],
      ...(options.notifyParticipants === undefined
        ? {}
        : { notifyParticipants: options.notifyParticipants }),
      attachmentIds: [],
      modelOverride: null,
      executionPrincipal: { type: "user", userId: CREATOR_ID },
      reason: "user_message",
    },
  });
  expect(opened.status).toBe(200);
  return opened;
}

/**
 * Every effect the parent object has taken delivery of, with its payload.
 *
 * Not read from the child's own outbox: a commit arms the child's alarm for the
 * current instant (`workstream-object-storage.ts`), and the alarm forwards and
 * then DELETEs, so any assertion against that table races the drain — the more
 * effects a path enqueues, the more reliably the read loses. Flushing on demand
 * and reading the parent is the deterministic half.
 *
 * The parent keeps them because nothing here drains it: `wrangler.test.jsonc`
 * declares the activity queue as a producer with no consumer, so no Queue
 * message ever arrives to acknowledge an effect out of `durable_outbox`. Its
 * own alarm only marks rows `inflight`. The one thing that *does* ack without a
 * consumer is `deliverDirectoryEffectsEagerly`, which runs inside
 * `acceptSubstreamEffects` under `waitUntil` and covers directory effects only
 * — so a directory assertion here is read back before that lands rather than
 * guaranteed, and `directoryEffectFor` below waits for it to settle instead.
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

/**
 * The version a recipient's directory row was written at, read from the parent's
 * own `projection_keys` rather than from an outbox row.
 *
 * That table is the one the delivery gate compares against and it is never
 * drained, so this is the same number `requiredProjectionVersion` has to match
 * and it cannot be raced away by the eager directory delivery above.
 */
async function viewerProjectionVersion(
  userId: string,
  workstreamId = WORKSTREAM_ID,
): Promise<number> {
  const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName("global", WORKSPACE_ID, workstreamId),
  ));
  return runInDurableObject(parent, (_instance, state) =>
    Number(state.storage.sql.exec<{ next_version: number }>(
      `SELECT next_version FROM projection_keys WHERE projection_key = ?`,
      `user:${userId}`,
    ).toArray()[0]?.next_version ?? 0) - 1);
}

/**
 * The notification effects the parent object has taken delivery of.
 *
 * Receipts rather than outbox rows: they are kept for their whole retention
 * window and keyed by the effect's own message id, so they survive the drain
 * and answer "was this person told, and how many times" directly.
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

describe("adding somebody to a work stream", () => {
  it("claims an indexed notification row by its returned lease rather than physical write count", async () => {
    const intentId = `mention:00000000-0000-7000-8000-0000000006a9:${MISSING_RECIPIENT_ID}`;
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const inserted = await workspace.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000006aa",
      statements: [{
        sql: `INSERT INTO workstream_notification_intents
          (intent_id, workspace_id, workstream_id, recipient_user_id,
           source_message_id, source_generation, source_version,
           required_directory_version, notification_kind, payload_json,
           payload_hash, state, attempts, lease_id, lease_expires_at,
           last_error_code, created_at, updated_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, 1, 'mention', '{}', 'claim-witness-hash',
                 'pending', 0, NULL, NULL, NULL, ?, ?, NULL)`,
        params: [
          intentId,
          WORKSPACE_ID,
          WORKSTREAM_ID,
          MISSING_RECIPIENT_ID,
          "00000000-0000-7000-8000-0000000006a9",
          "2026-08-25T20:00:00.000Z",
          "2026-08-25T20:00:00.000Z",
        ],
      }],
    });
    expect(inserted.status).toBe(200);

    // `state`, `lease_expires_at`, and `updated_at` participate in two indexes,
    // so workerd reports several physical writes for the one logical claim.
    // The old `meta.changes === 1` branch returned `busy` here after writing its
    // own lease and never reached this missing-recipient terminal decision.
    await expect(processWorkstreamNotificationIntent(env, WORKSPACE_ID, intentId))
      .resolves.toBe("skipped");
    await runInDurableObject(workspace, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string; attempts: number; lease_id: string | null }>(
        `SELECT state, attempts, lease_id FROM workstream_notification_intents WHERE intent_id = ?`,
        intentId,
      ).one()).toEqual({ state: "skipped", attempts: 1, lease_id: null });
    });
  });

  it("enqueues their directory row, an activity event, and a notification behind it", async () => {
    const stub = agentStub();
    await openWorkstream(stub);

    const added = await product(stub, {
      operation: "add_participant",
      auth: AUTH,
      userId: INVITEE_ID,
    });
    expect(added.status).toBe(200);

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

    // The dependency, and the reason the notification is enqueued after the
    // viewer effect: it is gated on the version that row was written at, so the
    // workspace cannot deliver it before the row lands.
    expect(notification[0]!.requiredProjectionVersion)
      .toBe(await viewerProjectionVersion(INVITEE_ID));
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
    await openWorkstream(second, { workstreamId: SECOND_WORKSTREAM_ID, title: "Hiring loop" });

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

    const envelopes = await deliveredEffects(stub);
    expect(envelopes.filter((envelope) => envelope.effect.kind === "participant_notification")).toHaveLength(0);
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "activity_event"
      && envelope.effect.eventType === "workstream_participant_added"
    ))).toHaveLength(0);
  });
});

describe("naming somebody when the work stream is created", () => {
  it("stores an identity-bearing opening mention and emits only its specific notification", async () => {
    const stub = agentStub();
    await openWorkstream(stub, {
      openingMessage: "Ask @Invitee to review",
      participantUserIds: [INVITEE_ID],
      notifyParticipants: true,
      mentions: [{
        type: "person",
        userId: INVITEE_ID,
        connectorType: null,
        startOffset: 4,
        endOffset: 12,
      }],
    });

    const canonical = `[@Invitee](person:${INVITEE_ID})`;
    await runInDurableObject(stub, (_instance, state) => {
      const stored = state.storage.sql.exec<{
        content: string;
        mention_kind: string;
        target_user_id: string;
        start_offset: number;
        end_offset: number;
      }>(
        `SELECT part.content, mention.mention_kind, mention.target_user_id,
                mention.start_offset, mention.end_offset
           FROM parts part JOIN part_mentions mention ON mention.part_id = part.id
          WHERE part.client_message_id = ?`,
        `participant-open-${WORKSTREAM_ID}`,
      ).one();
      expect(stored.content).toBe(`Ask ${canonical} to review`);
      expect(stored.mention_kind).toBe("person");
      expect(stored.target_user_id).toBe(INVITEE_ID);
      expect(stored.content.slice(stored.start_offset, stored.end_offset)).toBe(canonical);
      expect(state.storage.sql.exec<{
        seen_attention_ordinal: number;
        latest_mention_attention_ordinal: number;
      }>(
        `SELECT seen_attention_ordinal, latest_mention_attention_ordinal
           FROM member_attention WHERE user_id = ?`,
        INVITEE_ID,
      ).one()).toEqual({
        seen_attention_ordinal: 0,
        latest_mention_attention_ordinal: 1,
      });
    });

    const envelopes = await deliveredEffects(stub);
    const mentionNotifications = envelopes.filter((envelope) => (
      envelope.effect.kind === "mention_notification"
      && envelope.effect.recipientUserId === INVITEE_ID
    ));
    const participantNotifications = envelopes.filter((envelope) => (
      envelope.effect.kind === "participant_notification"
      && envelope.effect.recipientUserId === INVITEE_ID
    ));
    const viewer = envelopes.find((envelope) => (
      envelope.effect.kind === "directory_user" && envelope.effect.userId === INVITEE_ID
    ));
    expect(mentionNotifications).toHaveLength(1);
    expect(participantNotifications).toHaveLength(0);
    expect(viewer?.effect).toMatchObject({
      kind: "directory_user",
      userId: INVITEE_ID,
      youAreMentioned: true,
      latestMentionAttentionOrdinal: 1,
    });

    const notification = mentionNotifications[0]!.effect;
    if (notification.kind !== "mention_notification") throw new Error("expected mention notification");
    expect(notification.messageText).toBe(`Ask ${canonical} to review`);
    expect(notification.intentId).toBe(`mention:${notification.messageId}:${INVITEE_ID}`);
    expect(mentionNotifications[0]!.requiredProjectionVersion)
      .toBe(await viewerProjectionVersion(INVITEE_ID));
  });

  it("tells them the same way adding them afterwards does", async () => {
    const stub = agentStub();
    await openWorkstream(stub, { participantUserIds: [INVITEE_ID], notifyParticipants: true });

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

    // Armed by this recipient's own directory row: the delivery gate refuses to
    // send until the workspace has reached that version, so nobody is told
    // about a work stream their sidebar cannot yet show them. Read from the
    // parent's `projection_keys` — the table the gate itself compares against.
    expect(notification[0]!.requiredProjectionVersion)
      .toBe(await viewerProjectionVersion(INVITEE_ID));
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
    await openWorkstream(stub, { participantUserIds: [INVITEE_ID], notifyParticipants: true });

    const added = await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect(added.status).toBe(200);

    expect(await notificationReceipts(stub))
      .toEqual([`effect:participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`]);
  });
});

describe("who a create is allowed to tell", () => {
  it("says nothing when the caller did not ask for it", async () => {
    const stub = agentStub();
    // The shape a connector ingress sends. `slack-agent-service.ts` hands
    // `participantUserIds` a Slack channel's resolved roster — which
    // `CreateWorkstreamRequestSchema` says "can be hundreds" — and nobody in
    // that channel was added by anybody, so nobody is DMed about it.
    await openWorkstream(stub, { participantUserIds: [INVITEE_ID, SECOND_INVITEE_ID] });

    const envelopes = await deliveredEffects(stub);
    expect(envelopes.filter((envelope) => envelope.effect.kind === "participant_notification"))
      .toHaveLength(0);
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "activity_event"
      && envelope.effect.eventType === "workstream_participant_added"
    ))).toHaveLength(0);
    // Seated all the same: not telling somebody is not leaving them out.
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "directory_user"
      && (envelope.effect.userId === INVITEE_ID || envelope.effect.userId === SECOND_INVITEE_ID)
    ))).toHaveLength(2);
  });

  it("tells every person named, once each, gated on their own row", async () => {
    const stub = agentStub();
    await openWorkstream(stub, {
      participantUserIds: [INVITEE_ID, SECOND_INVITEE_ID],
      notifyParticipants: true,
    });

    const envelopes = await deliveredEffects(stub);
    const notifications = envelopes.flatMap((envelope) => (
      envelope.effect.kind === "participant_notification"
        ? [{ effect: envelope.effect, required: envelope.requiredProjectionVersion }]
        : []
    ));
    expect(notifications.map((entry) => entry.effect.recipientUserId).sort())
      .toEqual([INVITEE_ID, SECOND_INVITEE_ID].sort());
    expect(notifications.map((entry) => entry.effect.intentId).sort()).toEqual([
      `participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`,
      `participant_added:${WORKSTREAM_ID}:${SECOND_INVITEE_ID}:0`,
    ].sort());
    // Each is gated on its *own* recipient's projection, not on whichever
    // viewer effect happened to be written last.
    for (const entry of notifications) {
      expect(entry.required).toBe(await viewerProjectionVersion(entry.effect.recipientUserId));
    }
    expect(envelopes.flatMap((envelope) => (
      envelope.effect.kind === "activity_event"
      && envelope.effect.eventType === "workstream_participant_added"
        ? [envelope.effect.body] : []
    )).sort()).toEqual([
      "Creator added Invitee to this work stream.",
      "Creator added Second Invitee to this work stream.",
    ]);
  });

  it("replays the create without telling the person a second time", async () => {
    const stub = agentStub();
    await openWorkstream(stub, { participantUserIds: [INVITEE_ID], notifyParticipants: true });
    // The ambiguous-response retry, on the same `clientMessageId`. It must
    // still answer 200: the whole reason the replay branch re-enqueues the
    // directory snapshot and nothing else is that a notification re-emitted
    // against a moved root would be refused as a hash conflict and wedge the
    // create. `openWorkstream` asserts the status.
    await openWorkstream(stub, { participantUserIds: [INVITEE_ID], notifyParticipants: true });

    expect(await notificationReceipts(stub))
      .toEqual([`effect:participant_added:${WORKSTREAM_ID}:${INVITEE_ID}:0`]);
  });

  it("does not name a work stream the naming agent has not named yet", async () => {
    const stub = agentStub();
    // What `POST /workstreams` actually sends: the desktop client supplies no
    // title, so creation writes the opening message's first line and leaves
    // `titleStatus` at `naming` until the naming pass lands.
    const opened = await product(stub, {
      operation: "initialize",
      auth: AUTH,
      input: {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        generation: 1,
        title: "Can someone dig into why the self-serve funnel dropped this week",
        objective: "Can someone dig into why the self-serve funnel dropped this week",
        descriptionSource: "derived",
        titleStatus: "naming",
        emailAddress: null,
        creatorUserId: CREATOR_ID,
        openingMessage: "Can someone dig into why the self-serve funnel dropped this week",
        clientMessageId: "participant-open-naming",
        participantUserIds: [INVITEE_ID],
        notifyParticipants: true,
        attachmentIds: [],
        modelOverride: null,
        executionPrincipal: { type: "user", userId: CREATOR_ID },
        reason: "user_message",
      },
    });
    expect(opened.status).toBe(200);

    const notification = (await deliveredEffects(stub))
      .flatMap((envelope) => envelope.effect.kind === "participant_notification" ? [envelope.effect] : []);
    expect(notification).toHaveLength(1);
    // The delivery templates read this to pick copy that does not quote a
    // placeholder title as if it were the work stream's name.
    expect(notification[0]!.titleIsProvisional).toBe(true);
  });
});
