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
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

const TAYLOR = "00000000-0000-7000-8000-0000000000a1";
const JORDAN = "00000000-0000-7000-8000-0000000000a2";

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "3")}`),
    ),
  ));
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
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
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

  it("seats a whole audience or none of it, and reports what each seating did", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
    await identity(stub, "admitParticipant", {
      userId: TAYLOR, addedByUserId: TAYLOR, reason: "creator", now: 3,
    });

    const seated = await identity(stub, "admitParticipants", {
      userIds: [TAYLOR, JORDAN],
      addedByUserId: null,
      reason: "explicit",
      now: 7,
    });

    // The rows come back from the write, so the caller that publishes a
    // `participant_joined` for each new seating never asks a second time — and
    // `unchanged` is how it tells an arrival from somebody already in the room.
    expect(seated.value).toEqual([
      { userId: TAYLOR, outcome: "unchanged", participationReason: "creator", addedAt: 3 },
      { userId: JORDAN, outcome: "admitted", participationReason: "explicit", addedAt: 7 },
    ]);
    // `addedByUserId: null` is the arriving-member case: nobody else is
    // credited, so each member is recorded as having seated themselves.
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT user_id, added_by_user_id, added_at FROM participants ORDER BY user_id`,
      ).toArray()).toEqual([
        { user_id: TAYLOR, added_by_user_id: TAYLOR, added_at: 3 },
        { user_id: JORDAN, added_by_user_id: JORDAN, added_at: 7 },
      ]);
    });
  });

  it("leaves the whole audience unseated when one of its members cannot be", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      // A row the insert cannot satisfy: the seating below reaches it second,
      // after the first member has already been written in the same
      // transaction. Without that transaction the first would survive the
      // throw, and the retry — recomputing who is new against a roster that
      // now holds them — would never publish their arrival.
      state.storage.sql.exec(
        `CREATE TRIGGER refuse_jordan BEFORE INSERT ON participants
           WHEN NEW.user_id = '${JORDAN}'
           BEGIN SELECT RAISE(ABORT, 'refused'); END`,
      );
    });

    await expect(identity(stub, "admitParticipants", {
      userIds: [TAYLOR, JORDAN],
      addedByUserId: null,
      reason: "explicit",
      now: 7,
    })).rejects.toThrow(/refused/u);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM participants`).one())
        .toEqual({ n: 0 });
    });
  });

  it("moves the creator seat and the reason that goes with it together", async () => {
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
      ).toArray()).toEqual([
        { user_id: TAYLOR, participation_reason: "explicit" },
        { user_id: JORDAN, participation_reason: "creator" },
      ]);
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
