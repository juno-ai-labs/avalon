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

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AuthContext } from "../src/env";
import { substreamAgentName, workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import {
  WorkstreamRegionalEffectEnvelopeSchema,
  type WorkstreamRegionalEffectEnvelope,
} from "../src/durable-objects/workstream-regional-effect";
import { processWorkstreamNotificationIntent } from "../src/services/workstream-regional-effect-service";
import { useOpenRouterDouble } from "./helpers/openrouter-double";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000006a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a2");
const SECOND_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a6");
/**
 * The "who a create is allowed to tell" cases. `initialize` on an already-
 * authoritative root is a silent replay (200, no notifications), so these must
 * not share an id with each other or with `WORKSTREAM_ID`. The replay test
 * shares `CREATE_REPLAY_ID` between its two opens on purpose.
 */
const CREATE_WITHOUT_NOTIFY_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b1");
const CREATE_WITH_NOTIFY_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b2");
const CREATE_REPLAY_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b3");
const CREATE_NAMING_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b4");
/**
 * Mention-confirmation and elicitation cases wait on promotion or a quiet loop.
 * They must not share `WORKSTREAM_ID` with a neighbour's `openWorkstream`: an
 * incomplete `reset()` leaves the object executing, and `waitForCanonicalTurn`
 * / `waitForQuietLoop` then time out — the macOS release `pnpm test` failure
 * on 33290369991. Do not extend this to every test in the file; a live
 * draining object per case is what timed out CI shard 1/2 on #428's first cut.
 */
const WORKSPACE_VISIBLE_MENTION_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b5");
const CONFIRMED_MENTION_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b6");
const REJECTED_CONFIRMED_MENTION_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b7");
const ELICITATION_ANSWER_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b8");
const CREATOR_ID = asUserId("00000000-0000-7000-8000-0000000006a3");
const SESSION_ID = "00000000-0000-7000-8000-0000000006a4";
const INVITEE_ID = "00000000-0000-7000-8000-0000000006a5";
const SECOND_INVITEE_ID = "00000000-0000-7000-8000-0000000006a7";
const MISSING_RECIPIENT_ID = "00000000-0000-7000-8000-0000000006a8";
const ATTACHMENT_ID = "00000000-0000-7000-8000-0000000006a9";

/**
 * A wall-clock budget: the probes spend Durable Object round trips out of it,
 * so it is sized for a contended run, not for the promotion itself — and it
 * stays well inside the suite's 30s test budget so its own failure reports.
 */
const POLL_BUDGET_MS = 10_000;

/**
 * The opening run this file starts reaches inference, so the provider is
 * doubled rather than left to a real outbound request that cannot succeed and
 * does not fail quickly (`docs/testing.md`). One turn of plain text is all the
 * run needs: nothing here asserts on what the model said, only that the loop
 * settles so the elicitation assertions run against a loop at rest.
 */
useOpenRouterDouble(() => ({ say: "Noted." }));

const AUTH: AuthContext = {
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
  // Idempotent: `reset()` is supposed to drop D1's schema, but an incomplete
  // wipe — a sibling file's interleave, or a hung poll that broke the input
  // gate — leaves these tables standing. Plain `CREATE TABLE` then fails as
  // `already exists` and hides the original timeout (33290369991).
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, name, region) VALUES (?, 'Notification test', 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'owner', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, CREATOR_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, INVITEE_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, CREATOR_ID, WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'creator@example.com', 'Creator', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(CREATOR_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'invitee@example.com', 'Invitee', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(INVITEE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, SECOND_INVITEE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'second@example.com', 'Second Invitee', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(SECOND_INVITEE_ID),
  ]);
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // holds every object's gate, so this hook can wait out a full reset before it
  // gets to run at all. The work itself — reset, the D1 seed, and the
  // `initializeWorkspace` RPC — takes milliseconds, so a failure here is a hang,
  // never a slow query.
}, 30_000);

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
    scope?: "personal" | "workspace";
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
      scope: options.scope ?? "personal",
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
 * own alarm only marks rows `inflight`, and `deliverDirectoryEffectsEagerly` —
 * the one other path that reaches these rows, running inside
 * `acceptSubstreamEffects` under `waitUntil` — deliberately delivers without
 * acknowledging (`workstream-do.ts`), leaving the outbox untouched. So a
 * directory assertion here reads rows nothing can take away.
 */
/**
 * Wait for a pending message's promotion to land its canonical turn. Admission
 * stores immutable pending input; the loop's activation alarm delivers it a
 * beat later, so canonical rows — the turn, its mentions, the seat a confirmed
 * target gets — are not observable the instant `create_message` returns.
 *
 * The suite's 30s test budget also covers each caller's `openWorkstream`,
 * request and assertions, so this poll's tighter budget is what fails
 * legibly when promotion never lands.
 */
async function waitForCanonicalTurn(stub: DurableObjectStub, turnId: string): Promise<void> {
  // Read-only, so the probe can neither advance nor duplicate the promotion; a
  // turn that never lands fails as the poll's own `expected 0 to be 1`.
  await expect.poll(
    () => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`,
        turnId,
      ).one().count),
    { timeout: POLL_BUDGET_MS, interval: 50 },
  ).toBe(1);
}

/**
 * Wait for the substream loop to have nothing left to run.
 *
 * `answerElicitation` returns an activation request only when the loop it
 * would activate is at rest (`workstream-object-product.ts`: `remaining === 0
 * && after.status === "idle" ? … : null`), and the run `openWorkstream`
 * starts drives that loop through `executing` and back. Nothing in these
 * tests made the precondition true — it just usually was by the time the
 * answer ran, and sometimes was not.
 *
 * Waiting on the loop's status alone is not enough, and finding that out is
 * what this shape is for: a status-only poll caught the loop still `idle`
 * *before* the opening run was admitted, and by the time the answer ran it
 * was `executing` — the instrumented reproduction reported exactly that
 * (`loopBefore.status = "executing"`, no pending elicitation left). So this
 * waits on both: no run still admitted or running, and a loop back at rest.
 * Together they are a state the loop cannot leave on its own. Read-only, so
 * the probe cannot advance what it is waiting on.
 */
async function waitForQuietLoop(stub: DurableObjectStub): Promise<void> {
  await expect.poll(
    () => runInDurableObject(stub, (_instance, state) => {
      const active = Number(state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE status IN ('admitted', 'running')`,
      ).one().n);
      const status = state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM substream_loops WHERE id = 1`,
      ).toArray()[0]?.status ?? "idle";
      return `${status}:${active}`;
    }),
    { timeout: POLL_BUDGET_MS, interval: 50 },
  ).toBe("idle:0");
}

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
  it("claims an indexed notification row through typed RPC and refuses generic SQL", async () => {
    const intentId = `mention:00000000-0000-7000-8000-0000000006a9:${MISSING_RECIPIENT_ID}`;
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO workstream_notification_intents
          (intent_id, workspace_id, workstream_id, recipient_user_id,
           source_message_id, source_generation, source_version,
           required_directory_version, notification_kind, payload_json,
           payload_hash, state, attempts, lease_id, lease_expires_at,
           last_error_code, created_at, updated_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, 1, 'mention', '{}', 'claim-witness-hash',
                 'pending', 0, NULL, NULL, NULL, ?, ?, NULL)`,
        intentId,
        WORKSPACE_ID,
        WORKSTREAM_ID,
        MISSING_RECIPIENT_ID,
        "00000000-0000-7000-8000-0000000006a9",
        "2026-08-25T20:00:00.000Z",
        "2026-08-25T20:00:00.000Z",
      );
    });
    const genericRead = await workspace.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000006aa",
      statements: [{
        sql: "SELECT intent_id FROM workstream_notification_intents WHERE intent_id = ?",
        params: [intentId],
      }],
    });
    expect(genericRead.status).toBe(409);
    expect(genericRead.bodyJson).toContain(
      "workspace_runtime_table_requires_typed_rpc:workstream_notification_intents",
    );

    // The claim still changes indexed columns, but the public result is now a
    // domain outcome produced inside WorkspaceDO; no caller receives or can
    // interpret workerd's physical write count. Release it through the typed
    // transition as well so the delivery service can claim the same row next.
    const firstClaim = await workspace.claimWorkstreamNotificationIntent({
      workspaceId: WORKSPACE_ID,
      intentId,
    });
    expect(firstClaim).toMatchObject({
      outcome: "claimed",
      intent: { intentId, state: "processing" },
    });
    if (firstClaim.outcome !== "claimed") throw new Error("expected typed claim");
    await expect(workspace.transitionWorkstreamNotificationIntent({
      workspaceId: WORKSPACE_ID,
      intentId,
      leaseId: firstClaim.leaseId,
      transition: "defer",
      errorCode: "test_release",
    })).resolves.toEqual({ outcome: "applied", intentId });

    await expect(processWorkstreamNotificationIntent(env, WORKSPACE_ID, intentId))
      .resolves.toBe("skipped");
    await expect(workspace.claimWorkstreamNotificationIntent({
      workspaceId: WORKSPACE_ID,
      intentId,
    })).resolves.toMatchObject({
      outcome: "terminal",
      intent: { intentId, state: "skipped" },
    });
    await runInDurableObject(workspace, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string; attempts: number; lease_id: string | null }>(
        `SELECT state, attempts, lease_id FROM workstream_notification_intents WHERE intent_id = ?`,
        intentId,
      ).one()).toEqual({ state: "skipped", attempts: 2, lease_id: null });
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
  it("does not seat the raw target of a rejected opening mention", async () => {
    const stub = agentStub();
    await openWorkstream(stub, {
      openingMessage: "No person is named",
      mentions: [{
        type: "person",
        userId: INVITEE_ID,
        connectorType: null,
        startOffset: 0,
        endOffset: 2,
      }],
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participants WHERE user_id = ?`,
        INVITEE_ID,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_mentions WHERE target_user_id = ?`,
        INVITEE_ID,
      ).one().count).toBe(0);
    });
    const envelopes = await deliveredEffects(stub);
    expect(envelopes.some((envelope) => (
      "userId" in envelope.effect && envelope.effect.userId === INVITEE_ID
    ))).toBe(false);
    expect(envelopes.some((envelope) => (
      envelope.effect.kind === "mention_notification"
      && envelope.effect.recipientUserId === INVITEE_ID
    ))).toBe(false);
  });

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
           FROM canonical_conversation_turn_details part
           JOIN participant_transcript_mentions mention ON mention.turn_id = part.id
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
      const partId = state.storage.sql.exec<{ id: string }>(
        `SELECT turn_id AS id FROM participant_transcript_turns WHERE client_message_id = ?`,
        `participant-open-${WORKSTREAM_ID}`,
      ).one().id;
      state.storage.sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, ?, 0, 'message_attachment', ?, ?, ?)`,
        ATTACHMENT_ID,
        CREATOR_ID,
        JSON.stringify({
          id: ATTACHMENT_ID,
          title: "sonar.png",
          mimeType: "image/png",
          contentRef: "uploads/sonar.png",
          metadata: { size: 1024 },
        }),
        Date.parse("2026-08-26T12:00:00.000Z"),
        Date.parse("2026-08-26T12:00:00.000Z"),
      );
      state.storage.sql.exec(
        `INSERT INTO participant_transcript_attachments (turn_id, resource_id, position, attachment_json)
         VALUES (?, ?, 0, ?)`,
        partId,
        ATTACHMENT_ID,
        JSON.stringify({ attachedAt: "2026-08-26T12:00:00.000Z" }),
      );
      const transcript = new WorkstreamTranscriptStorage(state.storage)
        .createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null });
      expect(transcript.ranges[0]!.turns[0]).toMatchObject({
        authorUserId: CREATOR_ID,
        blocks: [{
          type: "text",
          mentions: [{ type: "person", userId: INVITEE_ID }],
          attachments: [{
            id: ATTACHMENT_ID,
            fileName: "sonar.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            contentAvailable: true,
            createdAt: "2026-08-26T12:00:00.000Z",
          }],
        }],
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

describe("confirming a nonparticipant mention on an existing work stream", () => {
  it("persists a workspace-visible mention without seating or confirming the recipient", async () => {
    const stub = agentStub(WORKSPACE_VISIBLE_MENTION_ID);
    await openWorkstream(stub, { workstreamId: WORKSPACE_VISIBLE_MENTION_ID, scope: "workspace" });
    const sent = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "Ask @Invitee to review",
        clientMessageId: "workspace-visible-mention-message",
        mentions: [{
          type: "person",
          userId: INVITEE_ID,
          connectorType: null,
          startOffset: 4,
          endOffset: 12,
        }],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });
    expect(sent.status).toBe(200);
    await waitForCanonicalTurn(stub, (sent.body.turn as { turnId: string }).turnId);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participants WHERE user_id = ?`,
        INVITEE_ID,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ target_user_id: string }>(
        `SELECT target_user_id FROM participant_transcript_mentions WHERE turn_id = ?`,
        (sent.body.turn as { turnId: string }).turnId,
      ).one().target_user_id).toBe(INVITEE_ID);
    });
    const envelopes = await deliveredEffects(stub, WORKSPACE_VISIBLE_MENTION_ID);
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "mention_notification"
      && envelope.effect.recipientUserId === INVITEE_ID
    ))).toHaveLength(1);
  });

  it("seats the accepted target and emits only the specific mention notification", async () => {
    const stub = agentStub(CONFIRMED_MENTION_ID);
    await openWorkstream(stub, { workstreamId: CONFIRMED_MENTION_ID });
    const sent = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "Ask @Invitee to review",
        clientMessageId: "confirmed-mention-message",
        mentions: [{
          type: "person",
          userId: INVITEE_ID,
          connectorType: null,
          startOffset: 4,
          endOffset: 12,
        }],
        confirmedParticipantUserIds: [INVITEE_ID],
        attachmentIds: [],
      },
    });
    expect(sent.status).toBe(200);
    await waitForCanonicalTurn(stub, (sent.body.turn as { turnId: string }).turnId);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM participants WHERE user_id = ?`, INVITEE_ID,
      ).one().status).toBe("active");
      expect(state.storage.sql.exec<{ target_user_id: string }>(
        `SELECT target_user_id FROM participant_transcript_mentions WHERE turn_id = ?`,
        (sent.body.turn as { turnId: string }).turnId,
      ).one().target_user_id).toBe(INVITEE_ID);
    });
    const envelopes = await deliveredEffects(stub, CONFIRMED_MENTION_ID);
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "mention_notification"
      && envelope.effect.recipientUserId === INVITEE_ID
    ))).toHaveLength(1);
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "participant_notification"
      && envelope.effect.recipientUserId === INVITEE_ID
    ))).toHaveLength(0);
  });

  it("does not let confirmation seat the raw target of a rejected mention", async () => {
    const stub = agentStub(REJECTED_CONFIRMED_MENTION_ID);
    await openWorkstream(stub, { workstreamId: REJECTED_CONFIRMED_MENTION_ID });
    const sent = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "No person is named",
        clientMessageId: "rejected-confirmed-mention-message",
        mentions: [{
          type: "person",
          userId: INVITEE_ID,
          connectorType: null,
          startOffset: 0,
          endOffset: 2,
        }],
        confirmedParticipantUserIds: [INVITEE_ID],
        attachmentIds: [],
      },
    });
    expect(sent.status).toBe(200);
    await waitForCanonicalTurn(stub, (sent.body.turn as { turnId: string }).turnId);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participants WHERE user_id = ?`,
        INVITEE_ID,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_mentions WHERE target_user_id = ?`,
        INVITEE_ID,
      ).one().count).toBe(0);
    });
  });
});

describe("answering an elicitation in the ordered transcript", () => {
  it("keeps the attributed response pending until the loop can promote it", async () => {
    const stub = agentStub(ELICITATION_ANSWER_ID);
    const opened = await openWorkstream(stub, { workstreamId: ELICITATION_ANSWER_ID });
    const runId = String(opened.body.harnessRunId);
    const elicitationId = "00000000-0000-7000-8000-0000000006aa";
    const messageId = "00000000-0000-7000-8000-0000000006ab";
    const createdAt = "2026-08-26T12:00:00.000Z";
    const question = await stub.fetch("https://object.test/internal/scheduling", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        workstreamId: ELICITATION_ANSWER_ID,
        operation: "openElicitation",
        args: [{
          elicitationId,
          runId,
          toolCallId: `${runId}:turn:1:tool:0`,
          prompt: "Which environment?",
          responseType: "text",
          optionsJson: "[]",
          minimumSelections: 0,
          maximumSelections: null,
          targetUserId: null,
          messageId,
          structuredContentJson: JSON.stringify({
            kind: "elicitation",
            elicitation: {
              id: elicitationId,
              workstreamId: ELICITATION_ANSWER_ID,
              harnessRunId: runId,
              prompt: "Which environment?",
              responseType: "text",
              options: [],
              minimumSelections: 0,
              maximumSelections: null,
              targetUserId: null,
              status: "open",
              answer: null,
              answeredByUserId: null,
              createdAt,
              answeredAt: null,
            },
          }),
          now: Date.parse(createdAt),
        }],
      }),
    });
    expect(question.status).toBe(200);

    // The activation request below exists only for a loop at rest with nothing
    // left to run, and the run `openWorkstream` started may still be settling.
    await waitForQuietLoop(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const productService = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      const before = state.storage.sql.exec<{
        next_transcript_sequence: number;
        next_attention_ordinal: number;
      }>(
        `SELECT counter.next_transcript_sequence, root.next_attention_ordinal
           FROM transcript_counters counter CROSS JOIN workstream root
          WHERE counter.id = 1 AND root.id = 1`,
      ).one();
      const answered = await productService.answerElicitation(
        AUTH,
        elicitationId,
        { answer: "staging" },
      );
      expect(answered).toMatchObject({
        elicitation: { id: elicitationId, status: "answered", answer: "staging" },
        activationRequest: {
          kind: "activate_substream_loop",
          cause: "pending_input",
          inputId: answered.responsePartId,
        },
      });
      const pending = state.storage.sql.exec<{
        actor: string;
        author_user_id: string;
        author_name_snapshot: string;
        client_message_id: string;
        message_type: string;
        prepared_payload_json: string;
        authorization_json: string;
      }>(
        `SELECT actor, author_user_id, author_name_snapshot, client_message_id,
                message_type, prepared_payload_json, authorization_json
           FROM pending_loop_inputs WHERE input_id = ?`,
        answered.responsePartId,
      ).one();
      expect(pending).toMatchObject({
        actor: "human",
        author_user_id: CREATOR_ID,
        author_name_snapshot: "Creator",
        client_message_id: `elicitation-response:${elicitationId}`,
        message_type: "elicitation",
      });
      expect(JSON.parse(pending.prepared_payload_json)).toMatchObject({
        role: "user",
        structuredContent: {
          kind: "elicitation_response",
          elicitation: { id: elicitationId, status: "answered", answer: "staging" },
        },
      });
      expect(JSON.parse(pending.authorization_json)).toMatchObject({
        reason: "elicitation_answer",
        elicitationId,
        parentHarnessRunId: runId,
      });
      const transcript = new WorkstreamTranscriptStorage(state.storage)
        .createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null });
      const response = transcript.ranges[0]!.turns.find(
        (turn) => turn.clientMessageId === `elicitation-response:${elicitationId}`,
      );
      expect(response).toBeUndefined();
      expect(state.storage.sql.exec<{
        next_transcript_sequence: number;
        next_attention_ordinal: number;
      }>(
        `SELECT counter.next_transcript_sequence, root.next_attention_ordinal
           FROM transcript_counters counter CROSS JOIN workstream root
          WHERE counter.id = 1 AND root.id = 1`,
      ).one()).toEqual(before);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs WHERE origin = 'elicitation_answer'`,
      ).one().count).toBe(0);
    });
  });
});

describe("who a create is allowed to tell", () => {
  it("says nothing when the caller did not ask for it", async () => {
    const stub = agentStub(CREATE_WITHOUT_NOTIFY_ID);
    // The shape a connector ingress sends. `slack-agent-service.ts` hands
    // `participantUserIds` a Slack channel's resolved roster — which
    // `CreateWorkstreamRequestSchema` says "can be hundreds" — and nobody in
    // that channel was added by anybody, so nobody is DMed about it.
    await openWorkstream(stub, {
      workstreamId: CREATE_WITHOUT_NOTIFY_ID,
      participantUserIds: [INVITEE_ID, SECOND_INVITEE_ID],
    });

    const envelopes = await deliveredEffects(stub, CREATE_WITHOUT_NOTIFY_ID);
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
    const stub = agentStub(CREATE_WITH_NOTIFY_ID);
    await openWorkstream(stub, {
      workstreamId: CREATE_WITH_NOTIFY_ID,
      participantUserIds: [INVITEE_ID, SECOND_INVITEE_ID],
      notifyParticipants: true,
    });

    const envelopes = await deliveredEffects(stub, CREATE_WITH_NOTIFY_ID);
    const notifications = envelopes.flatMap((envelope) => (
      envelope.effect.kind === "participant_notification"
        ? [{ effect: envelope.effect, required: envelope.requiredProjectionVersion }]
        : []
    ));
    expect(notifications.map((entry) => entry.effect.recipientUserId).sort())
      .toEqual([INVITEE_ID, SECOND_INVITEE_ID].sort());
    expect(notifications.map((entry) => entry.effect.intentId).sort()).toEqual([
      `participant_added:${CREATE_WITH_NOTIFY_ID}:${INVITEE_ID}:0`,
      `participant_added:${CREATE_WITH_NOTIFY_ID}:${SECOND_INVITEE_ID}:0`,
    ].sort());
    // Each is gated on its *own* recipient's projection, not on whichever
    // viewer effect happened to be written last.
    for (const entry of notifications) {
      expect(entry.required).toBe(
        await viewerProjectionVersion(entry.effect.recipientUserId, CREATE_WITH_NOTIFY_ID),
      );
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
    const stub = agentStub(CREATE_REPLAY_ID);
    await openWorkstream(stub, {
      workstreamId: CREATE_REPLAY_ID,
      participantUserIds: [INVITEE_ID],
      notifyParticipants: true,
    });
    // The ambiguous-response retry, on this test's own workstream id and
    // `clientMessageId`. Other cases must not share either — initialize on an
    // already-authoritative root is a silent replay, not a second create. It
    // must still answer 200: the whole reason the replay branch re-enqueues the
    // directory snapshot and nothing else is that a notification re-emitted
    // against a moved root would be refused as a hash conflict and wedge the
    // create. `openWorkstream` asserts the status.
    await openWorkstream(stub, {
      workstreamId: CREATE_REPLAY_ID,
      participantUserIds: [INVITEE_ID],
      notifyParticipants: true,
    });

    expect(await notificationReceipts(stub, CREATE_REPLAY_ID))
      .toEqual([`effect:participant_added:${CREATE_REPLAY_ID}:${INVITEE_ID}:0`]);
  });

  it("does not name a work stream the naming agent has not named yet", async () => {
    const stub = agentStub(CREATE_NAMING_ID);
    // What `POST /workstreams` actually sends: the desktop client supplies no
    // title, so creation writes the opening message's first line and leaves
    // `titleStatus` at `naming` until the naming pass lands.
    const opened = await product(stub, {
      operation: "initialize",
      auth: AUTH,
      input: {
        workspaceId: WORKSPACE_ID,
        workstreamId: CREATE_NAMING_ID,
        generation: 1,
        title: "Can someone dig into why the self-serve funnel dropped this week",
        objective: "Can someone dig into why the self-serve funnel dropped this week",
        descriptionSource: "derived",
        titleStatus: "naming",
        emailAddress: null,
        creatorUserId: CREATOR_ID,
        openingMessage: "Can someone dig into why the self-serve funnel dropped this week",
        clientMessageId: `participant-open-${CREATE_NAMING_ID}`,
        participantUserIds: [INVITEE_ID],
        notifyParticipants: true,
        attachmentIds: [],
        modelOverride: null,
        executionPrincipal: { type: "user", userId: CREATOR_ID },
        reason: "user_message",
      },
    });
    expect(opened.status).toBe(200);

    const notification = (await deliveredEffects(stub, CREATE_NAMING_ID))
      .flatMap((envelope) => envelope.effect.kind === "participant_notification" ? [envelope.effect] : []);
    expect(notification).toHaveLength(1);
    // The delivery templates read this to pick copy that does not quote a
    // placeholder title as if it were the work stream's name.
    expect(notification[0]!.titleIsProvisional).toBe(true);
  });
});
