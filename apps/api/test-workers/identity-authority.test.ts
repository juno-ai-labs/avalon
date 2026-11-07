/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable work-stream identity authority, on real workerd.
 *
 * The Node suite proves what the SQL decides. This proves what the runtime
 * does: that a provision and every later identity write commit their row and
 * the directory projection the sidebar reads in one step, that reads commit
 * nothing, and that the compare-and-swaps this authority holds decide inside
 * the transaction rather than by a row count read afterwards.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedWorkspaceControlPlane,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: TAYLOR, sessionId: crypto.randomUUID() });
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

const TAYLOR = "00000000-0000-7000-8000-0000000000a1";
const JORDAN = "00000000-0000-7000-8000-0000000000a2";

/** The real Main address: parent-driven handoff routes back to this object. */
function agent(): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId("0")));
}

/** Call the real endpoint, exactly as the Worker's port does. */
async function identity(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<{ status: number; value: unknown; error?: string }> {
  const { status, body } = await post(stub, "/internal/identity", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  const parsed = body as { value?: unknown; error?: string } | null;
  return { status, value: parsed?.value ?? null, ...(parsed?.error ? { error: parsed.error } : {}) };
}

/** A root in the state `bootstrapRuntimeAuthority` leaves behind. */
function seedBootstrappedRoot(state: DurableObjectState): void {
  seedWorkstreamRoot(state);
  state.storage.sql.exec(
    `UPDATE workstream SET state_reason_code = 'runtime_bootstrap' WHERE id = 1`,
  );
}

function provisionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Daily brief",
    objective: "Write the brief",
    scope: "personal",
    originType: "automation",
    createdByUserId: TAYLOR,
    participantUserIds: [TAYLOR],
    harnessStatus: "scheduled",
    emailAddress: "brief@automation.with-avalon.com",
    emailRouteStatus: "reserved",
    systemKind: null,
    automationSubscriptionId: "00000000-0000-7000-8000-0000000000b1",
    automationRunId: "00000000-0000-7000-8000-0000000000b2",
    plannedFor: 5,
    modelOverride: null,
    now: 2,
    ...overrides,
  };
}

describe("identity authority on real workerd", () => {
  it("commits the provision, its creator and the directory projection in one step", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedBootstrappedRoot(state));

    const result = await identity(stub, "provision", provisionInput());

    expect(result.status).toBe(200);
    expect(result.value).toEqual({ outcome: "provisioned" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT title, scope, exact_state, state_reason_code, created_by_user_id, email_address
           FROM workstream WHERE id = 1`,
      ).one()).toMatchObject({
        title: "Daily brief",
        scope: "personal",
        exact_state: "scheduled",
        state_reason_code: "run_scheduled",
        created_by_user_id: TAYLOR,
        email_address: "brief@automation.with-avalon.com",
      });
      expect(state.storage.sql.exec(
        `SELECT user_id, participation_reason FROM participants`,
      ).toArray()).toEqual([{ user_id: TAYLOR, participation_reason: "creator" }]);
      // A provision is what makes a system-created work stream appear in a
      // sidebar. A row whose listing projection is a second commit can be
      // written and never shown.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM projection_keys WHERE projection_key = 'common'`,
      ).one().count).toBe(1);
    });
  });

  it("answers a replayed provision without touching what the first run advanced", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedBootstrappedRoot(state));
    await identity(stub, "provision", provisionInput());
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE workstream SET next_sequence_number = 7 WHERE id = 1`);
    });

    const replay = await identity(stub, "provision", provisionInput({ title: "Different" }));

    // A producer that died between the runtime bootstrap and this call retries
    // the pair, and by then the root is authoritative and a run may already
    // have moved its counters. Re-running the write would reset them.
    expect(replay.value).toEqual({ outcome: "already_provisioned" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT title, next_sequence_number FROM workstream WHERE id = 1`,
      ).one()).toEqual({ title: "Daily brief", next_sequence_number: 7 });
    });
  });

  it.each([false, true])("stores the Channel colour and preserves an existing appearance (existing=%s)", async (existing) => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedBootstrappedRoot(state);
      if (existing) state.storage.sql.exec(`UPDATE workstream SET appearance_json = '{"icon":"database","color":"blue"}' WHERE id = 1`);
    });
    await identity(stub, "provision", provisionInput({ color: "purple" }));
    const appearance = await runInDurableObject(stub, (_instance, state) =>
      JSON.parse(String(state.storage.sql.exec("SELECT appearance_json FROM workstream WHERE id = 1").one().appearance_json)));
    expect(appearance).toEqual(existing ? { icon: "database", color: "blue" } : { icon: null, color: "purple" });
  });

  it("leaves no projection behind for a read", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const result = await identity(stub, "identity");

    // Reads are most of this port's traffic — an archive gate on every inbound
    // email, a model pin on every run. Committing a projection for each would
    // republish the sidebar on all of them.
    expect(result.value).toMatchObject({ workstream_key: WORKSTREAM_ID });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM projection_keys`).one().count)
        .toBe(0);
    });
  });

  it("puts the Channel's colour on a conversation, keeps its icon, and refuses an older revision", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec(
        `UPDATE workstream SET appearance_json = '{"icon":"rocket","color":"green"}' WHERE id = 1`,
      );
    });

    const first = await identity(stub, "recolor", { color: "red", revision: 5, now: 3 });

    expect(first.value).toEqual({ outcome: "recolored" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ appearance_json: string }>(
        "SELECT appearance_json FROM workstream WHERE id = 1",
      ).one().appearance_json)).toEqual({ icon: "rocket", color: "red" });
      // The colour reaches the sidebar through the projection committed with it.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM projection_keys WHERE projection_key = 'common'`,
      ).one().count).toBe(1);
    });
    expect((await identity(stub, "recolor", { color: "red", revision: 6, now: 4 })).value).toEqual({ outcome: "unchanged" });
    // A job that stalled behind a newer one: its older colour is not written back.
    expect((await identity(stub, "recolor", { color: "green", revision: 4, now: 5 })).value).toEqual({ outcome: "superseded" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ appearance_json: string }>(
        "SELECT appearance_json FROM workstream WHERE id = 1",
      ).one().appearance_json)).toEqual({ icon: "rocket", color: "red" });
    });
  });

  it("takes an address once, and tells the second reservation it lost", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const first = await identity(stub, "adoptEmailAddress", {
      emailAddress: "first@automation.with-avalon.com",
      now: 3,
    });
    const second = await identity(stub, "adoptEmailAddress", {
      emailAddress: "second@automation.with-avalon.com",
      now: 4,
    });

    // `WHERE email_address IS NULL` was the routed statement's guard against
    // two reservations racing for one work stream. The caller compares what
    // came back against what it reserved either way, and an address it did not
    // reserve is a conflict rather than a success.
    expect(first.value).toEqual({ outcome: "adopted" });
    expect(second.value).toEqual({ outcome: "already_addressed" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT email_address, email_route_status FROM workstream WHERE id = 1`,
      ).one()).toEqual({
        email_address: "first@automation.with-avalon.com",
        email_route_status: "reserved",
      });
    });
  });

  it("readmits a removed participant with this admission's reason and adder", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => { seedWorkstreamRoot(state); state.storage.sql.exec("UPDATE workstream SET parent_kind = 'automation'"); });
    await identity(stub, "admitParticipant", {
      userId: TAYLOR, addedByUserId: TAYLOR, reason: "creator", now: 3,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE participants SET status = 'removed', removed_at = 4 WHERE user_id = ?`,
        TAYLOR,
      );
    });

    const readmitted = await identity(stub, "admitParticipant", {
      userId: TAYLOR, addedByUserId: JORDAN, reason: "message", now: 5,
    });
    const again = await identity(stub, "admitParticipant", {
      userId: TAYLOR, addedByUserId: JORDAN, reason: "explicit", now: 6,
    });

    // The three `CASE WHEN … removed_at IS NOT NULL` arms of the retired upsert,
    // as the branch they stood in for: somebody who was removed comes back on
    // the terms of *this* admission, and somebody already seated keeps theirs.
    expect(readmitted.value).toEqual({ outcome: "readmitted" });
    expect(again.value).toEqual({ outcome: "unchanged" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT participation_reason, added_by_user_id, added_at, removed_at, status
           FROM participants WHERE user_id = ?`,
        TAYLOR,
      ).one()).toEqual({
        participation_reason: "message",
        added_by_user_id: JORDAN,
        added_at: 5,
        removed_at: null,
        status: "active",
      });
    });
  });

  it("leaves the newest message unread only for somebody another person seats", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec("UPDATE workstream SET parent_kind = 'automation'");
      // Four messages with attention ordinals 1 to 4.
      state.storage.sql.exec(`UPDATE workstream SET next_attention_ordinal = 5 WHERE id = 1`);
    });

    await identity(stub, "admitParticipant", {
      userId: TAYLOR, addedByUserId: JORDAN, reason: "explicit", now: 3,
    });
    // A null adder is each member seating themselves.
    await identity(stub, "admitParticipant", {
      userId: JORDAN, addedByUserId: JORDAN, reason: "explicit", now: 4,
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT user_id, seen_attention_ordinal FROM member_attention ORDER BY user_id`,
      ).toArray()).toEqual([
        { user_id: TAYLOR, seen_attention_ordinal: 3 },
        { user_id: JORDAN, seen_attention_ordinal: 4 },
      ]);
    });
  });

  it("updates creator attribution without independently granting participants", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
    await identity(stub, "adoptCreator", {
      userId: TAYLOR,
      previousAssignedUserId: null,
      mayCorrectVerifiedCreator: false,
      now: 3,
    });

    const corrected = await identity(stub, "adoptCreator", {
      userId: JORDAN,
      previousAssignedUserId: TAYLOR,
      mayCorrectVerifiedCreator: true,
      now: 4,
    });

    // The promotion and the demotion are one fact about who this work stream
    // belongs to. Two creators, or none, is what a partial batch leaves behind.
    expect(corrected.value).toEqual({ outcome: "adopted" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT created_by_user_id FROM workstream WHERE id = 1`,
      ).one().created_by_user_id).toBe(JORDAN);
      expect(state.storage.sql.exec(
        `SELECT user_id, participation_reason FROM participants ORDER BY user_id`,
      ).toArray()).toEqual([]);
    });
  });

  it("refuses an identity write once the object's authority is fenced", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec(`UPDATE workstream SET authority_generation = 0 WHERE id = 1`);
    });

    const { status, body } = await post(stub, "/internal/identity", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "rename",
      args: [{ title: "Renamed", from: "settled", to: "settled", now: 1 }],
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_runtime_authority_fenced" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT title FROM workstream WHERE id = 1`).one().title)
        .toBe("Fixture");
    });
  });

  it("refuses an operation that is not on the contract", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/identity", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "dropEverything",
      args: [],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_identity_operation" });
  });
});
