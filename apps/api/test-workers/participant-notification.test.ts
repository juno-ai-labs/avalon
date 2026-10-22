import { admitConnectorAudience } from "../src/services/connector-workstream-audience";
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
 * This drives the real SubstreamAgent product boundary against real Durable
 * Object SQLite, so `parent_projection_keys`, the payload hashes, and the outbox rows
 * are the production ones rather than a description of them. Existing-room
 * cases use its system-provision port; create-only cases stop before run activation.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  ParentEffectSchema,
  type ParentEffectEnvelope,
} from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import type { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { processWorkstreamNotificationIntent } from "../src/services/conversation-effect-service";
import { deliverChildEffects, pendingParentEffects } from "./helpers/conversation-effects";
import { hostedParentStub, withHostedParent } from "./helpers/hosted-parent";
import { ConversationService } from "../src/services/conversation-service";
import { SocketService } from "../src/services/socket-service";
import { socketTicketProtocols } from "@rally/contracts/socket-tickets";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000006a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a2");
const SECOND_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006a6");
const SHARED_CHILD_ID = asSubstreamId("00000000-0000-7000-8000-0000000006be");
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
 * The existing-room mention cases still activate their own message run, so
 * each keeps a distinct object identity while its promotion settles. The
 * elicitation case keeps a dedicated identity for its seeded parent receipt.
 * Their setup uses `provisionWorkstream`, not an opening model run; the older
 * initialize-and-wait shape is the race recorded under 33290369991.
 */
const WORKSPACE_VISIBLE_MENTION_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b5");
const CONFIRMED_MENTION_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b6");
const CONFIRMED_MENTION_HISTORY_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b9");
const CONFIRMED_MENTION_DIRECT_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006ba");
const REJECTED_CONFIRMED_MENTION_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b7");
const ELICITATION_ANSWER_ID = asWorkstreamId("00000000-0000-7000-8000-0000000006b8");
const CREATOR_ID = asUserId("00000000-0000-7000-8000-0000000006a3");
const SESSION_ID = "00000000-0000-7000-8000-0000000006a4";
const INVITEE_ID = "00000000-0000-7000-8000-0000000006a5";
const INVITEE_SESSION_ID = "00000000-0000-7000-8000-0000000006ad";
const INVITEE_AUTH: AuthContext = {
  sessionId: INVITEE_SESSION_ID,
  userId: asUserId(INVITEE_ID),
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "member" as const,
};
const SECOND_INVITEE_ID = "00000000-0000-7000-8000-0000000006a7";
const MISSING_RECIPIENT_ID = "00000000-0000-7000-8000-0000000006a8";
const ATTACHMENT_ID = "00000000-0000-7000-8000-0000000006a9";
const ELICITATION_PARENT_RUN_ID = "00000000-0000-7000-8000-0000000006ac";

/**
 * A wall-clock budget: the probes spend Durable Object round trips out of it,
 * so it is sized for a contended run, not for the promotion itself — and it
 * stays well inside the suite's 30s test budget so its own failure reports.
 */
const POLL_BUDGET_MS = 10_000;

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
      id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL,
      analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, name, region) VALUES (?, 'Notification test', 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (access_class TEXT NOT NULL DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'owner', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, CREATOR_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, INVITEE_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, CREATOR_ID, WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(INVITEE_SESSION_ID, INVITEE_ID, WORKSPACE_ID),
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

function agentStub(workstreamId = WORKSTREAM_ID, substreamId = "0"): DurableObjectStub<SubstreamAgent> {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, workstreamId, asSubstreamId(substreamId)),
  ));
}

/** The Organization object that hosts every Channel parent in the workspace. */
function parentStub(): ReturnType<typeof hostedParentStub> {
  return hostedParentStub(env, WORKSPACE_ID);
}

/**
 * Keep an object's outbox readable for the helpers.
 *
 * The drain alarm fires the moment an effect commits and hands the rows to
 * `ACTIVITY_QUEUE`, which nothing in this Worker consumes, so a read placed
 * after the mutation races the drain (docs/testing.md). A producer that
 * refuses makes the drain defer the rows instead of deleting them, and the
 * helpers then hand exactly those rows to the real consumer.
 */
async function parkEffectQueue(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    const parked = {
      send: () => Promise.reject(new Error("effect_queue_parked_by_test")),
      sendBatch: () => Promise.reject(new Error("effect_queue_parked_by_test")),
    };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "ACTIVITY_QUEUE"
        ? parked
        : Reflect.get(current, property, receiver),
    });
  });
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
  stub: DurableObjectStub<SubstreamAgent>,
  options: {
    workstreamId?: string;
    title?: string;
    objective?: string;
    descriptionSource?: "authored" | "derived";
    titleStatus?: "naming" | "settled";
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
): Promise<void> {
  const workstreamId = options.workstreamId ?? WORKSTREAM_ID;
  await parkEffectQueue(stub);
  // These cases assert creation's committed transcript and regional effects,
  // all of which `initialize` owns. The SubstreamAgent endpoint's next step is
  // only an execution-receipt wake. Calling the product service directly keeps
  // that unrelated model run admitted and inert, so a later `reset()` never
  // races an alarm that this file did not need to start.
  await runInDurableObject(stub, async (instance) => {
    const productService = (instance as unknown as { product: WorkstreamObjectProductService }).product;
    return productService.initialize(AUTH, {
      workspaceId: WORKSPACE_ID,
      workstreamId,
      generation: 1,
      title: options.title ?? "Quarterly planning",
      objective: options.objective ?? "Draft the quarterly plan",
      descriptionSource: options.descriptionSource ?? "authored",
      titleStatus: options.titleStatus ?? "settled",
      scope: options.scope ?? "personal",
      emailAddress: null,
      creatorUserId: CREATOR_ID,
      openingMessage: options.openingMessage ?? "starting the plan",
      ...(options.mentions ? { mentions: [...options.mentions] } : {}),
      clientMessageId: `participant-open-${workstreamId}`,
      participantUserIds: [...(options.participantUserIds ?? [])],
      ...(options.notifyParticipants === undefined
        ? {}
        : { notifyParticipants: options.notifyParticipants }),
      attachmentIds: [],
      modelOverride: null,
      executionPrincipal: { type: "user", userId: CREATOR_ID },
      reason: "user_message",
    });
  });
}

/** Establish the system-provisioned existing-room baseline without admitting a run. */
async function provisionWorkstream(
  stub: DurableObjectStub<SubstreamAgent>,
  workstreamId = WORKSTREAM_ID,
  options: { title?: string; scope?: "personal" | "workspace"; substreamId?: string } = {},
): Promise<void> {
  await parkEffectQueue(stub);
  expect((await stub.bootstrapRuntime({
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: workstreamId,
    substreamId: asSubstreamId(options.substreamId ?? "0"),
    generation: 1,
  })).status).toBe(200);
  expect((await stub.executeIdentityOperation({
    workspaceId: WORKSPACE_ID,
    workstreamId,
    substreamId: asSubstreamId(options.substreamId ?? "0"),
    operation: "provision",
    args: [{
      title: options.title ?? "Quarterly planning",
      objective: "Draft the quarterly plan",
      scope: options.scope ?? "personal",
      createdByUserId: CREATOR_ID,
      participantUserIds: [CREATOR_ID],
      harnessStatus: "idle",
      emailAddress: null,
      emailRouteStatus: null,
      systemKind: null,
      automationRunId: null,
      plannedFor: null,
      modelOverride: null,
      now: Date.now(),
    }],
  })).status).toBe(200);
}

/** A settled parent identity for an elicitation, with no execution to wake. */
async function seedCompletedRun(
  stub: DurableObjectStub<SubstreamAgent>,
  runId: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const now = Date.now();
    // Keep this minimal fixture aligned with the `runs` table in
    // workstream-object-schema.ts. Successful production terminalization
    // leaves `terminal_reason` null; that column describes exceptional exits.
    state.storage.sql.exec(
      `INSERT INTO runs (
         run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
         model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
         active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
         tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
         terminal_reason, terminalized_at, completed_at, created_at, updated_at
       ) VALUES (?, '0', NULL, 'completed', '{}', 0, 0, '', 0, 0, ?,
                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, ?, ?, ?, ?)`,
      runId,
      now,
      now,
      now,
      now,
      now,
    );
  });
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
 * The outbox is transport, not projection authority: creation recovery can
 * successfully deliver and delete a directory row before this helper parks the
 * parent. Directory assertions therefore read `parent_state_changes`
 * through `viewerProjectionEffect`; this helper is for immutable activity and
 * notification effects that the test deliberately leaves queued.
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
 * What the parent has queued for the workspace once the child's effects reach
 * it: the child leg is driven through the real Queue consumer, and the
 * parent's outbox is read with its own drain parked.
 */
async function deliveredEffects(
  stub: DurableObjectStub,
  workstreamId = WORKSTREAM_ID,
): Promise<ParentEffectEnvelope[]> {
  const parent = parentStub();
  await parkEffectQueue(parent);
  await deliverChildEffects(env, stub);
  return (await pendingParentEffects(parent)).filter((envelope) => envelope.parentId === workstreamId);
}

/** The work stream as the invitee opens it, through the product route. */
async function openedByInvitee(stub: DurableObjectStub): Promise<Record<string, unknown>> {
  const opened = await product(stub, { operation: "get", auth: INVITEE_AUTH });
  expect(opened.status).toBe(200);
  return opened.body;
}

/** A message from the creator, promoted to a canonical turn. */
async function sendAndSettle(
  stub: DurableObjectStub,
  input: Record<string, unknown> & { clientMessageId: string },
): Promise<void> {
  const sent = await product(stub, {
    operation: "create_message",
    auth: AUTH,
    input: { text: "An update", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [], ...input },
  });
  expect(sent.status).toBe(200);
  await waitForCanonicalTurn(stub, (sent.body.turn as { turnId: string }).turnId);
}

async function makeInviteeGuest(): Promise<void> {
  await env.DB.prepare("UPDATE workspace_members SET access_class = 'guest', role = NULL WHERE user_id = ?")
    .bind(INVITEE_ID).run();
}

async function reserveParent(workstreamId: string, scope: "personal" | "workspace" = "personal"): Promise<void> {
  await parentStub().reserveChild({ workspaceId: WORKSPACE_ID, parentId: workstreamId,
    substreamId: asSubstreamId("0"), kind: "main", createdByUserId: CREATOR_ID, authorityGeneration: 1,
    directory: { title: "Quarterly planning", description: "", scope, systemKind: null,
      emailAddress: null, titleStatus: "settled", createdAt: new Date().toISOString() } });
}

/** Proves edge admission and the conversation's applied grant revision, including the original sharer. */
async function expectParticipantCanOpen(workstreamId: string, auth: AuthContext, substreamId = "0"): Promise<void> {
  const ticket = await new ConversationService(env, auth).socketTicket(workstreamId, substreamId, 0);
  const upgraded = await new SocketService(env).upgrade(workstreamId, substreamId, undefined,
    new Request(ticket.url.replace("wss:", "https:"), { headers: { Upgrade: "websocket", Origin: "app://rallywithai",
      "Sec-WebSocket-Protocol": socketTicketProtocols(ticket.ticket).join(", ") } }));
  expect(upgraded.status).toBe(101);
  const socket = upgraded.webSocket!;
  const snapshot = new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
    socket.addEventListener("close", () => reject(new Error("conversation_closed_before_snapshot")), { once: true });
  });
  socket.accept();
  try {
    expect(await snapshot).toMatchObject({ type: "snapshot" });
  } finally {
    socket.close(1000, "test complete");
  }
}

interface FeedActivity {
  body: string;
  actorUserId: string | null;
  digestible: number;
  dedupeKey: string;
  targets: { userId: string; relation: string }[];
}

/**
 * The participant-added rows in the Organization's activity feed.
 *
 * Read from `workspace_activity_events` rather than the outbox: a hosted
 * parent writes the feed row in the same transaction as the add, so an
 * activity event with no mention to snapshot never waits in the outbox.
 */
async function participantAddedActivity(workstreamId = WORKSTREAM_ID): Promise<FeedActivity[]> {
  return runInDurableObject(parentStub(), (_instance, state) => state.storage.sql.exec<{
    event_id: string; body: string; actor_user_id: string | null; digestible: number; dedupe_key: string;
  }>(
    `SELECT event_id, body, actor_user_id, digestible, dedupe_key FROM workspace_activity_events
      WHERE audience_workstream_id = ? AND event_type = 'workstream_participant_added' ORDER BY body`,
    workstreamId,
  ).toArray().map((row) => ({
    body: row.body,
    actorUserId: row.actor_user_id,
    digestible: row.digestible,
    dedupeKey: row.dedupe_key,
    targets: state.storage.sql.exec<{ user_id: string; relation: string }>(
      `SELECT user_id, relation FROM workspace_activity_event_targets WHERE event_id = ? ORDER BY user_id`,
      row.event_id,
    ).toArray().map((target) => ({ userId: target.user_id, relation: target.relation })),
  })));
}

/**
 * The version a recipient's directory row was written at, read from the parent's
 * own `parent_projection_keys` rather than from an outbox row.
 *
 * That table is the one the delivery gate compares against and it is never
 * drained, so this is the same number `requiredProjectionVersion` has to match
 * and it cannot be raced away by the eager directory delivery above.
 */
async function viewerProjectionVersion(
  userId: string,
  workstreamId = WORKSTREAM_ID,
): Promise<number> {
  return runInDurableObject(parentStub(), (_instance, state) =>
    Number(state.storage.sql.exec<{ next_version: number }>(
      `SELECT next_version FROM parent_projection_keys WHERE parent_id = ? AND projection_key = ?`,
      workstreamId,
      `user:${userId}`,
    ).toArray()[0]?.next_version ?? 0) - 1);
}

/** The latest durable viewer projection, independent of whether its outbox row already drained. */
async function viewerProjectionEffect(
  userId: string,
  workstreamId = WORKSTREAM_ID,
): Promise<Extract<ParentEffectEnvelope["effect"], { kind: "directory_user" }> | null> {
  return runInDurableObject(parentStub(), (_instance, state) => {
    const row = state.storage.sql.exec<{ state_json: string }>(
      `SELECT state_json FROM parent_state_changes
        WHERE parent_id = ? AND state_key = ? ORDER BY waterline DESC LIMIT 1`,
      workstreamId,
      `user:${userId}`,
    ).toArray()[0];
    if (!row) return null;
    const effect = ParentEffectSchema.parse(JSON.parse(row.state_json));
    return effect.kind === "directory_user" ? effect : null;
  });
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
  await deliverChildEffects(env, stub);
  return runInDurableObject(parentStub(), (_instance, state) =>
    state.storage.sql.exec<{ message_id: string }>(
      `SELECT message_id FROM parent_child_receipts
        WHERE parent_id = ? AND message_id LIKE 'effect:participant_added:%' ORDER BY message_id`,
      workstreamId,
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

  it("admits two people with one shared profile read and preserves revocation on replay", async () => {
    const stub = agentStub();
    await provisionWorkstream(stub);
    const observed = await runInDurableObject(stub, async (instance, state) => {
      // Observe real binding reads; no result or storage is substituted. The source can accept the parent's callback
      // while its initiating admission is awaiting the parent.
      const target = instance as unknown as { env: Env; product: { env: Env } };
      const originalEnv = target.env;
      const originalProductEnv = target.product.env;
      let profileQueries = 0;
      const database = new Proxy(originalProductEnv.DB, { get(current, property) {
        if (property === "prepare") return (sql: string) => {
          if (sql.includes("FROM users")) profileQueries++;
          return current.prepare(sql);
        };
        const value = Reflect.get(current, property);
        return typeof value === "function" ? value.bind(current) : value;
      } });
      target.env = new Proxy(originalEnv, { get: (current, property) => property === "DB" ? database : Reflect.get(current, property) });
      target.product.env = target.env;
      try {
        const request = { target: { kind: "conversation" as const, workspaceId: WORKSPACE_ID,
          parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0") }, actorUserId: CREATOR_ID,
          participants: [
            { userId: asUserId(INVITEE_ID), operationId: "00000000-0000-7000-8000-0000000006d1" },
            { userId: asUserId(SECOND_INVITEE_ID), operationId: "00000000-0000-7000-8000-0000000006d2" },
          ] };
        const admitted = await parentStub().admitParticipants(request);
        const active = () => state.storage.sql.exec<{ user_id: string }>(
          "SELECT user_id FROM participants WHERE status = 'active' ORDER BY user_id",
        ).toArray().map((row) => row.user_id);
        const initiallyActive = active();
        const firstQueries = profileQueries;
        const removed = await parentStub().mutateParticipantGrant({ ...request.participants[0]!,
          target: request.target, actorUserId: CREATOR_ID, active: false,
          operationId: "00000000-0000-7000-8000-0000000006d3" });
        const removalQueries = profileQueries - firstQueries;
        const replay = await parentStub().admitParticipants(request);
        return { admitted, initiallyActive, profileQueries: firstQueries,
          removed: removed.status, removalQueries, replay, afterReplay: active() };
      } finally {
        target.env = originalEnv;
        target.product.env = originalProductEnv;
      }
    });
    expect(observed).toEqual({
      admitted: { status: "ready" }, initiallyActive: [CREATOR_ID, INVITEE_ID, SECOND_INVITEE_ID],
      profileQueries: 1,
      removed: "committed", removalQueries: 0, replay: { status: "denied" },
      afterReplay: [CREATOR_ID, SECOND_INVITEE_ID],
    });
  });

  it("authorizes a manual add once and checks the recipient membership", async () => {
    const stub = agentStub();
    await provisionWorkstream(stub);
    const observed = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as { product: { env: Env } };
      const originalEnv = target.product.env;
      let membershipReads = 0;
      const database = new Proxy(originalEnv.DB, { get(current, property) {
        if (property === "prepare") return (sql: string) => {
          if (sql.includes("FROM workspace_members")) membershipReads++;
          return current.prepare(sql);
        };
        const value = Reflect.get(current, property);
        return typeof value === "function" ? value.bind(current) : value;
      } });
      target.product.env = new Proxy(originalEnv, { get: (current, property) => property === "DB" ? database : Reflect.get(current, property) });
      try {
        const response = await instance.fetch(new Request("https://object.test/internal/product", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "add_participant", auth: AUTH, userId: INVITEE_ID }),
        }));
        const body = await response.json<{ user?: unknown }>();
        return { membershipReads, status: response.status, participant: body.user };
      } finally {
        target.product.env = originalEnv;
      }
    });
    expect(observed.membershipReads).toBe(2);
    expect(observed.status).toBe(200);
    expect(observed.participant).toMatchObject({ id: INVITEE_ID, name: "Invitee" });
  });

  it("enqueues their directory row, an activity event, and a notification behind it", async () => {
    const stub = agentStub();
    await provisionWorkstream(stub);

    const added = await product(stub, {
      operation: "add_participant",
      auth: AUTH,
      userId: INVITEE_ID,
    });
    expect(added.status).toBe(200);

    const envelopes = await deliveredEffects(stub);
    const viewer = await viewerProjectionEffect(INVITEE_ID);
    // The activity row is in the feed already, written with the add; only
    // the notification waits in the outbox, for the Queue that delivers it.
    const activity = await participantAddedActivity();
    const notification = envelopes.filter((envelope) => envelope.effect.kind === "participant_notification");
    expect(viewer).toMatchObject({ kind: "directory_user", userId: INVITEE_ID });
    expect(envelopes.filter((envelope) => envelope.effect.kind === "activity_event")).toEqual([]);
    expect([activity.length, notification.length]).toEqual([1, 1]);

    const activityEffect = activity[0]!;
    expect(activityEffect.targets).toEqual([{ userId: INVITEE_ID, relation: "added" }]);
    expect(activityEffect.actorUserId).toBe(CREATOR_ID);
    expect(activityEffect.digestible).toBe(1);
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
    await provisionWorkstream(stub);

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
    await provisionWorkstream(first);
    await provisionWorkstream(second, SECOND_WORKSTREAM_ID, { title: "Hiring loop" });

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
    await provisionWorkstream(stub);

    const added = await product(stub, {
      operation: "add_participant",
      auth: AUTH,
      userId: CREATOR_ID,
    });
    expect(added.status).toBe(200);

    const envelopes = await deliveredEffects(stub);
    expect(envelopes.filter((envelope) => envelope.effect.kind === "participant_notification")).toHaveLength(0);
    expect(await participantAddedActivity()).toHaveLength(0);
  });

  it("does not let an implicit public reader manufacture sharing authority by narrowing", async () => {
    const stub = agentStub();
    await openWorkstream(stub, { scope: "workspace" });
    const narrowed = await product(stub, { operation: "update", auth: INVITEE_AUTH, input: { scope: "personal" } });
    expect(narrowed.status).toBe(403);
    expect(narrowed.body).toMatchObject({ error: "workstream_scope_narrow_forbidden" });
  });

  it("leaves only the latest message unread for somebody added by another person", async () => {
    const stub = agentStub();
    await openWorkstream(stub);
    await sendAndSettle(stub, { clientMessageId: "history-second" });

    const added = await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect(added.status).toBe(200);

    // The earlier history was written before they were here, so it is read;
    // the newest message stays unread so the Channel still badges for them.
    expect(await openedByInvitee(stub)).toMatchObject({
      latestAttentionSequenceNumber: 2,
      readThroughSequenceNumber: 1,
      firstUnreadSequenceNumber: 2,
      hasUnread: true,
    });
  });

  it("leaves the only message unread for somebody added to a one-message Channel", async () => {
    const stub = agentStub();
    await openWorkstream(stub);

    await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });

    expect(await openedByInvitee(stub)).toMatchObject({
      latestAttentionSequenceNumber: 1,
      readThroughSequenceNumber: 0,
      firstUnreadSequenceNumber: 1,
      hasUnread: true,
    });
  });

  it("moves a re-added person's cursor forward and drops their old unread mark", async () => {
    const stub = agentStub();
    await provisionWorkstream(stub);
    await sendAndSettle(stub, { clientMessageId: "before-first-add" });
    await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    const marked = await product(stub, { operation: "mark_unread", auth: INVITEE_AUTH });
    expect(marked.status).toBe(200);
    const removed = await product(stub, { operation: "remove_participant", auth: AUTH, userId: INVITEE_ID });
    expect(removed.status).toBe(200);
    await sendAndSettle(stub, { clientMessageId: "while-removed" });

    await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });

    expect(await openedByInvitee(stub)).toMatchObject({
      latestAttentionSequenceNumber: 2,
      readThroughSequenceNumber: 1,
      manualUnreadFromSequenceNumber: null,
      manualUnreadGeneration: 2,
      firstUnreadSequenceNumber: 2,
    });
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
    expect(await viewerProjectionEffect(INVITEE_ID)).toBeNull();
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

    const canonical = `[@Invitee](person://${INVITEE_ID})`;
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
    const viewer = await viewerProjectionEffect(INVITEE_ID);
    expect(mentionNotifications).toHaveLength(1);
    expect(participantNotifications).toHaveLength(0);
    expect(viewer).toMatchObject({
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
    const viewer = await viewerProjectionEffect(INVITEE_ID);
    const activity = await participantAddedActivity();
    const notification = envelopes.filter((envelope) => envelope.effect.kind === "participant_notification");
    expect(viewer).toMatchObject({ kind: "directory_user", userId: INVITEE_ID });
    expect([activity.length, notification.length]).toEqual([1, 1]);

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

    const activityEffect = activity[0]!;
    expect(activityEffect.targets).toEqual([{ userId: INVITEE_ID, relation: "added" }]);
    expect(activityEffect.body).toBe("Creator added Invitee to this work stream.");

    // Armed by this recipient's own directory row: the delivery gate refuses to
    // send until the workspace has reached that version, so nobody is told
    // about a work stream their sidebar cannot yet show them. Read from the
    // parent's `parent_projection_keys` — the table the gate itself compares against.
    expect(notification[0]!.requiredProjectionVersion)
      .toBe(await viewerProjectionVersion(INVITEE_ID));
    expect(notification[0]!.requiredProjectionVersion).toBeGreaterThan(0);
  });

  it("says nothing to the creator about their own work stream", async () => {
    const stub = agentStub();
    await openWorkstream(stub);

    const envelopes = await deliveredEffects(stub);
    expect(envelopes.filter((envelope) => envelope.effect.kind === "participant_notification")).toHaveLength(0);
    expect(await participantAddedActivity()).toHaveLength(0);
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

describe("mentioning a nonparticipant on an existing conversation", () => {
  it.each([["queued", false], ["direct", false], ["queued", true], ["direct", true]] as const)("seats a workspace-visible mention recipient without confirmation (%s, transferred=%s)", async (mode, transferred) => {
    const stub = agentStub(WORKSPACE_VISIBLE_MENTION_ID);
    await provisionWorkstream(stub, WORKSPACE_VISIBLE_MENTION_ID, { scope: "workspace" });
    await sendAndSettle(stub, {
      clientMessageId: "workspace-history-before-mention",
      seed: { packVersion: "test", actionId: "workspace-history", assistant: null },
    });
    if (transferred) {
      await deliveredEffects(stub, WORKSPACE_VISIBLE_MENTION_ID);
      const parent = hostedParentStub(env, WORKSPACE_ID);
      await withHostedParent(parent, WORKSPACE_VISIBLE_MENTION_ID, (hosted) => {
        hosted["registerChild"]("0", "main", null, Date.now());
      });
      expect((await parent.beginMainParticipantMigration({ workspaceId: WORKSPACE_ID, parentId: WORKSPACE_VISIBLE_MENTION_ID })).status).toBe("complete");
      await withHostedParent(parent, WORKSPACE_VISIBLE_MENTION_ID, async (hosted) => {
        await hosted["runMainParticipantMigration"]();
      });
    }
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
        ...(mode === "direct" ? {
          seed: { packVersion: "test", actionId: "workspace-mention", assistant: null },
        } : {}),
      },
    });
    expect(sent.status).toBe(200);
    expect(sent.body.deliveryState).toBe(mode === "queued" ? "pending" : "canonical");
    await waitForCanonicalTurn(stub, (sent.body.turn as { turnId: string }).turnId);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string; first_opened_at: number | null }>(
        `SELECT status, first_opened_at FROM participants WHERE user_id = ?`,
        INVITEE_ID,
      ).one()).toMatchObject({ status: "active", first_opened_at: null });
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
    expect(envelopes.filter((envelope) => (
      envelope.effect.kind === "participant_notification"
      && envelope.effect.recipientUserId === INVITEE_ID
    ))).toHaveLength(0);
    expect(await openedByInvitee(stub)).toMatchObject({
      firstUnreadSequenceNumber: 2,
      readThroughSequenceNumber: 1,
    });
  });

  it.each(["personal", "workspace"] as const)("requires confirmation and establishes usable guest access for a %s mention", async (scope) => {
    const stub = agentStub(WORKSPACE_VISIBLE_MENTION_ID);
    await reserveParent(WORKSPACE_VISIBLE_MENTION_ID, scope);
    await provisionWorkstream(stub, WORKSPACE_VISIBLE_MENTION_ID, { scope });
    await makeInviteeGuest();
    const input = {
      text: "Ask @Invitee to review", clientMessageId: "guest-mention",
      mentions: [{ type: "person", userId: INVITEE_ID, connectorType: null, startOffset: 4, endOffset: 12 }],
      confirmedParticipantUserIds: [], attachmentIds: [],
      seed: { packVersion: "test", actionId: "guest-mention", assistant: null },
    };
    const rejected = await product(stub, { operation: "create_message", auth: AUTH, input });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "participant_confirmation_required" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT user_id FROM participants WHERE user_id = ?", INVITEE_ID).toArray()).toEqual([]);
    });
    await sendAndSettle(stub, { ...input, clientMessageId: "confirmed-guest-mention", confirmedParticipantUserIds: [INVITEE_ID] });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM participants WHERE user_id = ?", INVITEE_ID).one().status).toBe("active");
    });
    await expectParticipantCanOpen(WORKSPACE_VISIBLE_MENTION_ID, { ...INVITEE_AUTH, role: null, accessClass: "guest" });
    await expectParticipantCanOpen(WORKSPACE_VISIBLE_MENTION_ID, AUTH);
    const main = { kind: "conversation" as const, workspaceId: WORKSPACE_ID,
      parentId: WORKSPACE_VISIBLE_MENTION_ID, substreamId: asSubstreamId("0") };
    expect(await parentStub().readScopeAccess({ target: main, userId: asUserId(INVITEE_ID) }))
      .toMatchObject({ allowed: true, workspaceMemberAccess: false });
    expect(await parentStub().readScopeAccess({ target: { kind: "workstream", workspaceId: WORKSPACE_ID,
      parentId: WORKSPACE_VISIBLE_MENTION_ID }, userId: asUserId(INVITEE_ID) })).toMatchObject({ allowed: false });
  });

  it("manual guest additions establish grant access and revocation prevents reopening", async () => {
    const stub = agentStub();
    await reserveParent(WORKSTREAM_ID);
    await provisionWorkstream(stub);
    await makeInviteeGuest();
    const guest = { ...INVITEE_AUTH, role: null, accessClass: "guest" as const };
    expect((await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID })).status).toBe(200);
    await expectParticipantCanOpen(WORKSTREAM_ID, guest);
    await expectParticipantCanOpen(WORKSTREAM_ID, AUTH);
    expect((await product(stub, { operation: "remove_participant", auth: AUTH, userId: INVITEE_ID })).status).toBe(200);
    await expect(new ConversationService(env, guest).socketTicket(WORKSTREAM_ID))
      .rejects.toMatchObject({ code: "conversation_not_found" });
    expect((await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID })).status).toBe(200);
    await expectParticipantCanOpen(WORKSTREAM_ID, guest);
  });

  it.each(["member", "guest"] as const)("confirmed Breakout mentions establish parent-owned access for a %s without sharing Main", async (accessClass) => {
    await reserveParent(WORKSTREAM_ID);
    await parentStub().reserveChild({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID,
      substreamId: SHARED_CHILD_ID, kind: "child", createdByUserId: CREATOR_ID, authorityGeneration: 1 });
    await withHostedParent(parentStub(), WORKSTREAM_ID, (_hosted, state) => {
      state.storage.sql.exec(`INSERT INTO parent_breakout_members
        (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
        VALUES (?, ?, ?, 1, 1, ?, ?, ?)`, WORKSTREAM_ID, SHARED_CHILD_ID, CREATOR_ID, CREATOR_ID, Date.now(), Date.now());
    });
    const stub = agentStub(WORKSTREAM_ID, SHARED_CHILD_ID);
    await provisionWorkstream(stub, WORKSTREAM_ID, { substreamId: SHARED_CHILD_ID });
    if (accessClass === "guest") await makeInviteeGuest();
    await sendAndSettle(stub, { clientMessageId: "child-mention", text: "Ask @Invitee to review",
      mentions: [{ type: "person", userId: INVITEE_ID, connectorType: null, startOffset: 4, endOffset: 12 }],
      confirmedParticipantUserIds: [INVITEE_ID], seed: { packVersion: "test", actionId: "child-mention", assistant: null } });
    const auth = { ...INVITEE_AUTH, role: accessClass === "guest" ? null : "member" as const, accessClass };
    await expectParticipantCanOpen(WORKSTREAM_ID, auth, SHARED_CHILD_ID);
    await expectParticipantCanOpen(WORKSTREAM_ID, AUTH, SHARED_CHILD_ID);
    await expect(new ConversationService(env, auth).socketTicket(WORKSTREAM_ID))
      .rejects.toMatchObject({ code: "conversation_not_found" });
  });

  it.each(["participant", "mention"] as const)("creation-time guest %s access survives initialization replay", async (kind) => {
    const stub = agentStub();
    await reserveParent(WORKSTREAM_ID);
    await makeInviteeGuest();
    const options = kind === "participant" ? { participantUserIds: [INVITEE_ID] } : {
      openingMessage: "Ask @Invitee to review", mentions: [{ type: "person" as const, userId: INVITEE_ID,
        connectorType: null, startOffset: 4, endOffset: 12 }],
    };
    await openWorkstream(stub, options);
    await openWorkstream(stub, options);
    await expectParticipantCanOpen(WORKSTREAM_ID, { ...INVITEE_AUTH, role: null, accessClass: "guest" });
    await expectParticipantCanOpen(WORKSTREAM_ID, AUTH);
  });

  it("re-seats a removed Organization member when they are tagged again", async () => {
    const stub = agentStub(WORKSPACE_VISIBLE_MENTION_ID);
    await provisionWorkstream(stub, WORKSPACE_VISIBLE_MENTION_ID, { scope: "workspace" });
    await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect((await product(stub, { operation: "remove_participant", auth: AUTH, userId: INVITEE_ID })).status).toBe(200);
    await sendAndSettle(stub, {
      clientMessageId: "re-seat-mention", text: "Ask @Invitee to review",
      mentions: [{ type: "person", userId: INVITEE_ID, connectorType: null, startOffset: 4, endOffset: 12 }],
      seed: { packVersion: "test", actionId: "re-seat", assistant: null },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM participants WHERE user_id = ?", INVITEE_ID).one().status).toBe("active");
    });
  });

  it.each(["preparing", "queued"] as const)("refuses narrowing visibility while a mention is %s", async (stage) => {
    const stub = agentStub(WORKSPACE_VISIBLE_MENTION_ID);
    await provisionWorkstream(stub, WORKSPACE_VISIBLE_MENTION_ID, { scope: "workspace" });
    await sendAndSettle(stub, { clientMessageId: "scope-history", seed: { packVersion: "test", actionId: "scope-history", assistant: null } });
    const input = { text: "Ask @Invitee to review", clientMessageId: "scope-mention",
      mentions: [{ type: "person" as const, userId: INVITEE_ID, connectorType: null, startOffset: 4, endOffset: 12 }],
      confirmedParticipantUserIds: [], attachmentIds: [] };
    await runInDurableObject(stub, async (instance, state) => {
      const service = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const release = new Promise<void>((resolve) => { resume = resolve; });
      const originalEnv = service["env"];
      if (stage === "preparing") Reflect.set(service, "env", new Proxy(originalEnv, {
        get(target, property, receiver) {
          if (property !== "DB") return Reflect.get(target, property, receiver);
          return new Proxy(target.DB, { get(db, key) {
            if (key !== "prepare") return Reflect.get(db, key, db);
            return (sql: string) => {
              const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(stmt, method) {
                if (method === "bind") return (...values: unknown[]) => wrap(stmt.bind(...values));
                if (method === "all" && sql.includes("SELECT user.id, user.name")) return async () => {
                  enter();
                  await release;
                  return stmt.all();
                };
                const value = Reflect.get(stmt, method, stmt);
                return typeof value === "function" ? value.bind(stmt) : value;
              } });
              return wrap(db.prepare(sql));
            };
          } });
        },
      }));
      const sending = service.createMessage(AUTH, input);
      try {
        if (stage === "preparing") await entered;
        else await sending;
        await expect(service.update(AUTH, { scope: "personal" })).rejects.toMatchObject({ code: "conversation_message_pending" });
        expect(state.storage.sql.exec<{ scope: string }>("SELECT scope FROM workstream WHERE id = 1").one().scope).toBe("workspace");
      } finally {
        resume();
        await sending;
        Reflect.set(service, "env", originalEnv);
      }
    });
    // Replay through the real product boundary to activate and drain the
    // admitted input. Do not leave its recovery alarm racing the next reset.
    const sent = await product(stub, { operation: "create_message", auth: AUTH, input });
    expect(sent.status).toBe(200);
    await waitForCanonicalTurn(stub, (sent.body.turn as { turnId: string }).turnId);
    expect((await product(stub, { operation: "update", auth: AUTH, input: { scope: "personal" } })).status).toBe(200);
  });

  it("seats the accepted target and emits only the specific mention notification", async () => {
    const stub = agentStub(CONFIRMED_MENTION_ID);
    await provisionWorkstream(stub, CONFIRMED_MENTION_ID);
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

  it("makes the message that seats them their first unread, not the history before it", async () => {
    const stub = agentStub(CONFIRMED_MENTION_HISTORY_ID);
    await provisionWorkstream(stub, CONFIRMED_MENTION_HISTORY_ID);
    const earlier = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "Notes before anybody else is here",
        clientMessageId: "history-before-seat",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });
    expect(earlier.status).toBe(200);
    await waitForCanonicalTurn(stub, (earlier.body.turn as { turnId: string }).turnId);
    const sent = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "Ask @Invitee to review",
        clientMessageId: "seat-after-history",
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

    expect(await openedByInvitee(stub)).toMatchObject({
      firstUnreadSequenceNumber: 2,
      readThroughSequenceNumber: 1,
    });
  });

  it("makes a message that seats them without starting a run their first unread", async () => {
    // Two people already in the room and a message that starts no run: this
    // one is written directly rather than queued for the loop to promote.
    const stub = agentStub(CONFIRMED_MENTION_DIRECT_ID);
    await provisionWorkstream(stub, CONFIRMED_MENTION_DIRECT_ID);
    await product(stub, { operation: "add_participant", auth: AUTH, userId: SECOND_INVITEE_ID });
    const seed = { packVersion: "test", actionId: "no-run", assistant: null };
    await sendAndSettle(stub, { clientMessageId: "direct-history", seed });
    await sendAndSettle(stub, {
      clientMessageId: "direct-seat",
      text: "Ask @Invitee to review",
      mentions: [{ type: "person", userId: INVITEE_ID, connectorType: null, startOffset: 4, endOffset: 12 }],
      confirmedParticipantUserIds: [INVITEE_ID],
      seed: { ...seed, actionId: "no-run-seat" },
    });

    expect(await openedByInvitee(stub)).toMatchObject({
      firstUnreadSequenceNumber: 2,
      readThroughSequenceNumber: 1,
    });
  });

  it.each(["personal", "workspace"] as const)("does not seat the raw target of a rejected mention (%s)", async (scope) => {
    const stub = agentStub(REJECTED_CONFIRMED_MENTION_ID);
    await provisionWorkstream(stub, REJECTED_CONFIRMED_MENTION_ID, { scope });
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

/** A Channel with one open text question from a settled run, ready to answer. */
async function openQuestion(): Promise<{
  stub: DurableObjectStub<SubstreamAgent>;
  runId: string;
  elicitationId: string;
}> {
  const stub = agentStub(ELICITATION_ANSWER_ID);
  await provisionWorkstream(stub, ELICITATION_ANSWER_ID);
  // `openElicitation` stores the parent run as correlation identity; it does
  // not require that run to be executing locally. This test is about the
  // answer's pending input and activation request, so a settled row satisfies
  // the foreign key without starting unrelated inference first.
  const runId = ELICITATION_PARENT_RUN_ID;
  await seedCompletedRun(stub, runId);
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
  return { stub, runId, elicitationId };
}

describe("answering an elicitation in the ordered transcript", () => {
  it("keeps the attributed response pending until the loop can promote it", async () => {
    const { stub, runId, elicitationId } = await openQuestion();

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

  it("carries the Slack message that answered into the run the answer starts", async () => {
    const { stub, elicitationId } = await openQuestion();
    const slackOrigin = {
      teamId: "T1", actorSlackUserId: "U_ANSWER", channelId: "C1", channelName: null, threadTs: "1.0",
      invocationType: "app_mention", channelType: "public", matchedAvalonUserId: CREATOR_ID,
      nearbyMessagesStatus: "not_applicable", nearbyMessages: [], attachments: [],
      reactionAnchor: { channelId: "C1", messageTs: "9.0" },
    };
    const answered = await product(stub, {
      operation: "answer_elicitation",
      auth: AUTH,
      elicitationId,
      input: { answer: "staging" },
      slackOrigin,
    });
    expect(answered.status).toBe(200);

    await runInDurableObject(stub, (_instance, state) => {
      const started = state.storage.sql.exec<{ execution_context_json: string }>(
        `SELECT execution_context_json FROM runs WHERE origin = 'elicitation_answer'`,
      ).one();
      expect(JSON.parse(started.execution_context_json)).toMatchObject({
        reason: "elicitation_answer",
        slackOrigin,
      });
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
    expect(await participantAddedActivity(CREATE_WITHOUT_NOTIFY_ID)).toHaveLength(0);
    // Seated all the same: not telling somebody is not leaving them out.
    await expect(Promise.all([
      viewerProjectionEffect(INVITEE_ID, CREATE_WITHOUT_NOTIFY_ID),
      viewerProjectionEffect(SECOND_INVITEE_ID, CREATE_WITHOUT_NOTIFY_ID),
    ])).resolves.toEqual([
      expect.objectContaining({ kind: "directory_user", userId: INVITEE_ID }),
      expect.objectContaining({ kind: "directory_user", userId: SECOND_INVITEE_ID }),
    ]);
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
    expect((await participantAddedActivity(CREATE_WITH_NOTIFY_ID)).map((row) => row.body)).toEqual([
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
    // already-authoritative root is a silent replay, not a second create. The
    // direct product call must still complete: the replay branch re-enqueues
    // the directory snapshot and nothing else because a notification re-emitted
    // against a moved root would be refused as a hash conflict and wedge the
    // create. The single receipt assertion below proves no notification replayed.
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
    await openWorkstream(stub, {
      workstreamId: CREATE_NAMING_ID,
      title: "Can someone dig into why the self-serve funnel dropped this week",
      objective: "Can someone dig into why the self-serve funnel dropped this week",
      descriptionSource: "derived",
      titleStatus: "naming",
      openingMessage: "Can someone dig into why the self-serve funnel dropped this week",
      participantUserIds: [INVITEE_ID],
      notifyParticipants: true,
    });
    const notification = (await deliveredEffects(stub, CREATE_NAMING_ID))
      .flatMap((envelope) => envelope.effect.kind === "participant_notification" ? [envelope.effect] : []);
    expect(notification).toHaveLength(1);
    // The delivery templates read this to pick copy that does not quote a
    // placeholder title as if it were the work stream's name.
    expect(notification[0]!.titleIsProvisional).toBe(true);
  });
});


it.each(["workstream", "conversation"] as const)("converges an existing %s grant authority without importing stale seats and uses grants for connectors", async (kind) => {
  const stub = agentStub();
  await provisionWorkstream(stub);
  // A populated pre-cutover source and an already-live grant ledger. This
  // source row must be reconciled away, never promoted into a new grant.
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM participant_authority_transfer");
    state.storage.sql.exec("DELETE FROM participant_projection_revisions");
    state.storage.sql.exec(`INSERT INTO participants
      (user_id, participation_reason, added_by_user_id, status, participant_epoch, added_at, first_opened_at, updated_at)
      VALUES (?, 'explicit', ?, 'active', 0, 0, NULL, 0)`, INVITEE_ID, CREATOR_ID);
  });
  const parent = parentStub();
  await withHostedParent(parent, WORKSTREAM_ID, (_hosted, state) => {
    state.storage.sql.exec("DELETE FROM parent_participant_migrations WHERE parent_id = ?", WORKSTREAM_ID);
    state.storage.sql.exec("DELETE FROM parent_participant_targets WHERE parent_id = ?", WORKSTREAM_ID);
    state.storage.sql.exec("DELETE FROM parent_participant_deliveries WHERE parent_id = ?", WORKSTREAM_ID);
    if (kind === "conversation") {
      state.storage.sql.exec("DELETE FROM parent_grants WHERE parent_id = ?", WORKSTREAM_ID);
      const store = _hosted["scopeGrants"]({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID });
      expect(store.mutate({ target: { kind: "conversation", workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID,
        substreamId: asSubstreamId("0") }, userId: CREATOR_ID, actorUserId: CREATOR_ID,
        active: true, expectedRevision: 0, operationId: crypto.randomUUID() }, "existing-member").status).toBe("committed");
    }
  });
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`CREATE TRIGGER refuse_initial_projection BEFORE INSERT ON participant_projection_revisions
      BEGIN SELECT RAISE(ABORT, 'participant_projection_temporarily_unavailable'); END`);
  });
  await expect(runInDurableObject(parent, (instance) => instance.ensureParticipantAuthority({
    workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0"),
  }))).rejects.toThrow("participant_projection_temporarily_unavailable");
  // Isolate ticket-driven recovery from the alarm alternative while the
  // destination is still refusing delivery.
  await runInDurableObject(parent, async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM _internal_durable_alarms WHERE kind IN ('parent_participant_migration', 'parent_participant_projection')");
    await state.storage.deleteAlarm();
  });
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("DROP TRIGGER refuse_initial_projection"); });
  // Ticket authorization must finish outstanding projection delivery itself,
  // without waiting for a product GET or a recovery alarm.
  expect(await parent.authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID,
    substreamId: asSubstreamId("0"), userId: CREATOR_ID })).toMatchObject({ authorized: true });
  await expect(new ConversationService(env, INVITEE_AUTH).socketTicket(WORKSTREAM_ID, "0"))
    .rejects.toMatchObject({ code: "conversation_not_found" });
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT status FROM participants WHERE user_id = ?", INVITEE_ID).one())
      .toEqual({ status: "removed" });
  });
  const request = { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, eventId: "canonical-connector-event",
    userIds: [asUserId(INVITEE_ID)], addedByUserId: CREATOR_ID };
  expect(await parent.admitConnectorParticipants(request)).toEqual({ status: "ready" });
  await expectParticipantCanOpen(WORKSTREAM_ID, INVITEE_AUTH);
  const removed = await product(stub, { operation: "remove_participant", auth: AUTH, userId: INVITEE_ID });
  expect(removed.status).toBe(200);
  expect(await parent.admitConnectorParticipants(request)).toEqual({ status: "ready" });
  await expect(new ConversationService(env, INVITEE_AUTH).socketTicket(WORKSTREAM_ID, "0"))
    .rejects.toMatchObject({ code: "conversation_not_found" });
});

it("projects connector audience through grants and does not restore a revoked member on event replay", async () => {
  const stub = agentStub();
  await provisionWorkstream(stub);
  const request = { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
    eventId: "connector-admission-service", userIds: [INVITEE_ID, SECOND_INVITEE_ID], addedByUserId: CREATOR_ID };
  await admitConnectorAudience(env, request);
  await expectParticipantCanOpen(WORKSTREAM_ID, INVITEE_AUTH);
  expect((await product(stub, { operation: "remove_participant", auth: AUTH, userId: INVITEE_ID })).status).toBe(200);
  await admitConnectorAudience(env, request);
  await expect(new ConversationService(env, INVITEE_AUTH).socketTicket(WORKSTREAM_ID, "0"))
    .rejects.toMatchObject({ code: "conversation_not_found" });
});

it("arms durable recovery before attempting a fallible participant transfer", async () => {
  const stub = agentStub();
  await provisionWorkstream(stub);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM participant_authority_transfer");
    state.storage.sql.exec("DELETE FROM participant_projection_revisions");
    state.storage.sql.exec(`CREATE TRIGGER refuse_transfer_prepare BEFORE INSERT ON participant_authority_transfer
      BEGIN SELECT RAISE(ABORT, 'transfer_prepare_unavailable_test'); END`);
  });
  const result = await withHostedParent(parentStub(), WORKSTREAM_ID, async (hosted, state) => {
    state.storage.sql.exec("DELETE FROM parent_participant_migrations WHERE parent_id = ?", WORKSTREAM_ID);
    state.storage.sql.exec("DELETE FROM _internal_durable_alarms");
    await state.storage.deleteAlarm();
    const host = hosted["host"];
    const arm = host.armNextAlarm;
    let armed = false;
    host.armNextAlarm = async () => { await arm(); armed = await state.storage.getAlarm() !== null; };
    try {
      await hosted.ensureParticipantAuthority({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0") });
      throw new Error("expected_transfer_failure");
    } catch (error) {
      return { armed, error: error instanceof Error ? error.message : String(error) };
    } finally { host.armNextAlarm = arm; }
  });
  expect(result).toMatchObject({ armed: true, error: expect.stringContaining("transfer_prepare_unavailable_test") });
});

it("converges scope receipts after outbox deletion and accepts an identical scope retry", async () => {
  const stub = agentStub();
  await provisionWorkstream(stub);
  const result = await runInDurableObject(stub, async (instance, state) => {
    const source = instance as unknown as { product: WorkstreamObjectProductService;
      objectStore: WorkstreamObjectStore };
    const commit = source.objectStore.commitWithRegionalEffects.bind(source.objectStore);
    source.objectStore.commitWithRegionalEffects = async (...args) => {
      const committed = await commit(...args);
      // The durable sender owns deletion and may win this race before update resumes.
      state.storage.sql.exec("DELETE FROM durable_outbox WHERE json_extract(payload_json, '$.effect.kind') = 'directory_common'");
      return committed;
    };
    try {
      const changed = await source.product.update(AUTH, { scope: "workspace" });
      const repeated = await source.product.update(AUTH, { scope: "workspace" });
      return { changed: changed.workstream.scope, repeated: repeated.workstream.scope,
        repeatEvents: repeated.events, viewer: await parentStub().authorizeViewer({ workspaceId: WORKSPACE_ID,
          parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0"), userId: asUserId(INVITEE_ID) }) };
    } finally { source.objectStore.commitWithRegionalEffects = commit; }
  });
  expect(result).toMatchObject({ changed: "workspace", repeated: "workspace", repeatEvents: [], viewer: { authorized: true } });
});

it("persists creation notifications and activity before a failed handoff and retains them on retry", async () => {
  const stub = agentStub(CREATE_WITH_NOTIFY_ID);
  await runInDurableObject(stub, (instance) => {
    const source = instance as unknown as { product: WorkstreamObjectProductService };
    source.product.ensureParticipantAuthority = async () => { throw new Error("handoff_unavailable_test"); };
  });
  const options = { workstreamId: CREATE_WITH_NOTIFY_ID, participantUserIds: [INVITEE_ID, SECOND_INVITEE_ID],
    notifyParticipants: true, openingMessage: "Ask @Invitee to review", mentions: [
      { type: "person" as const, userId: INVITEE_ID, connectorType: null, startOffset: 4, endOffset: 12 },
    ] };
  try {
    await expect(openWorkstream(stub, options)).rejects.toThrow("handoff_unavailable_test");
    const effects = await deliveredEffects(stub, CREATE_WITH_NOTIFY_ID);
    expect(effects.filter(({ effect }) => effect.kind === "participant_notification")).toHaveLength(1);
    expect(effects.filter(({ effect }) => effect.kind === "mention_notification")).toHaveLength(1);
    expect(effects.filter(({ effect }) => effect.kind === "activity_event")).toHaveLength(1);
  } finally {
    await runInDurableObject(stub, (instance) => {
      const source = instance as unknown as { product: WorkstreamObjectProductService };
      delete (source.product as unknown as { ensureParticipantAuthority?: unknown }).ensureParticipantAuthority;
    });
  }
  await openWorkstream(stub, options);
  const effects = await deliveredEffects(stub, CREATE_WITH_NOTIFY_ID);
  expect(effects.filter(({ effect }) => effect.kind === "participant_notification")).toHaveLength(1);
  expect(effects.filter(({ effect }) => effect.kind === "mention_notification")).toHaveLength(1);
});

it("joins a public first-post author before granting their mentioned audience", async () => {
  const stub = agentStub();
  await provisionWorkstream(stub, WORKSTREAM_ID, { scope: "workspace" });
  const sent = await product(stub, { operation: "create_message", auth: INVITEE_AUTH,
    input: { text: "Ask @Second Invitee to review", clientMessageId: "first-post-mention",
      mentions: [{ type: "person", userId: SECOND_INVITEE_ID, connectorType: null, startOffset: 4, endOffset: 19 }],
      confirmedParticipantUserIds: [], attachmentIds: [], seed: { packVersion: "test", actionId: "first-post-mention", assistant: null } } });
  expect(sent.status).toBe(200);
  expect(sent.body.deliveryState).toBe("canonical");
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(
    "SELECT user_id FROM participants WHERE status = 'active' ORDER BY user_id",
  ).toArray())).toEqual([{ user_id: CREATOR_ID }, { user_id: INVITEE_ID }, { user_id: SECOND_INVITEE_ID }]);
});

it("removes owning-Thread grants without weakening conversation-only removal or the last-participant guard", async () => {
  const stub = agentStub();
  await openWorkstream(stub, { participantUserIds: [INVITEE_ID] });
  const conversationOnly = await product(stub, { operation: "remove_participant", auth: AUTH, userId: INVITEE_ID });
  expect(conversationOnly.status).toBe(409);
  const removed = await product(stub, { operation: "remove_participant", auth: AUTH, userId: INVITEE_ID, owningThread: true });
  expect(removed.status).toBe(200);
  await expect(new ConversationService(env, INVITEE_AUTH).socketTicket(WORKSTREAM_ID, "0"))
    .rejects.toMatchObject({ code: "conversation_not_found" });
  const last = await product(stub, { operation: "remove_participant", auth: AUTH, userId: CREATOR_ID, owningThread: true });
  expect(last.status).toBe(409);
  await expectParticipantCanOpen(WORKSTREAM_ID, AUTH);
});

it("leaves a Thread atomically when the person has both owning and Main grants", async () => {
  const stub = agentStub();
  await openWorkstream(stub, { participantUserIds: [INVITEE_ID] });
  const target = { kind: "conversation" as const, workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0") };
  const granted = await parentStub().mutateParticipantGrant({ target, operationId: crypto.randomUUID(),
    actorUserId: asUserId(CREATOR_ID), userId: asUserId(INVITEE_ID), active: true });
  expect(granted.status).toBe("committed");
  const removed = await product(stub, { operation: "remove_participant", auth: INVITEE_AUTH, userId: INVITEE_ID, owningThread: true });
  expect(removed.status).toBe(200);
  await expect(new ConversationService(env, INVITEE_AUTH).socketTicket(WORKSTREAM_ID, "0"))
    .rejects.toMatchObject({ code: "conversation_not_found" });
  expect(await runInDurableObject(parentStub(), (_instance, state) => state.storage.sql.exec(
    "SELECT json_extract(grant_json, '$.active') AS active FROM parent_grants WHERE parent_id = ? AND user_id = ? ORDER BY scope_kind",
    WORKSTREAM_ID, INVITEE_ID).toArray())).toEqual([{ active: 0 }, { active: 0 }]);
});

describe("posting subscribes the author to a conversation", () => {
  it.each(["0", "00000000-0000-7000-8000-0000000006fe"])("seats an unmentioned author posting in conversation %s", async (substreamId) => {
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000006fd");
    if (substreamId !== "0") {
      await reserveParent(workstreamId, "workspace");
      await withHostedParent(parentStub(), workstreamId, (hosted, state) => {
        hosted["registerChild"](substreamId, "child", CREATOR_ID, Date.now());
        state.storage.sql.exec(`INSERT INTO parent_breakout_members
          (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
          VALUES (?, ?, ?, 1, 1, ?, 0, 0), (?, ?, ?, 1, 1, ?, 0, 0)`,
          workstreamId, substreamId, CREATOR_ID, CREATOR_ID, workstreamId, substreamId, INVITEE_ID, CREATOR_ID);
      });
    }
    const stub = agentStub(workstreamId, substreamId);
    await provisionWorkstream(stub, workstreamId, { scope: "workspace", substreamId });
    if (substreamId !== "0") await parentStub().ensureParticipantAuthority({
      workspaceId: WORKSPACE_ID, parentId: workstreamId, substreamId: asSubstreamId(substreamId),
    });
    const sent = await product(stub, {
      operation: "create_message", auth: INVITEE_AUTH,
      input: { text: "I will follow up", clientMessageId: "join-by-post", mentions: [],
        confirmedParticipantUserIds: [], attachmentIds: [], seed: { packVersion: "test", actionId: "join-by-post", assistant: null } },
    });
    expect(sent.status).toBe(200);
    await waitForCanonicalTurn(stub, (sent.body.turn as { turnId: string }).turnId);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string; participation_reason: string }>(
        `SELECT status, participation_reason FROM participants WHERE user_id = ?`, INVITEE_ID,
      ).one()).toEqual({ status: "active", participation_reason: substreamId === "0" ? "message" : "explicit" });
    });
  });
});
