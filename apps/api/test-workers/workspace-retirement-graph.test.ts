/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The object graph retirement walks, and why it is recorded before the walk.
 *
 * Retiring a workspace means retiring everything under it, and the tombstone on
 * WorkspaceDO has to land *before* the descendants are visited — otherwise a
 * call admitted between the first child and the last one writes into a
 * workspace that is half closed. That ordering has a consequence the spike
 * never hit, because its walk was straight-line and best-effort: once the
 * tombstone is down, WorkspaceDO refuses the very directory reads that would
 * tell the walk what to visit.
 *
 * So the enumeration is captured first and persisted, and the walk reads the
 * record rather than the directory. That is also what makes retirement
 * resumable: an interrupted pass reconstructs the same descendant set on the
 * next attempt instead of enumerating a workspace that can no longer answer.
 *
 * The rows are receipts. A node is marked only once its object confirms it, and
 * completion is the absence of unretired rows rather than a flag somebody sets.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import { RETIREMENT_REFUSAL_CODE } from "../src/durable-objects/object-retirement";
import { retireWorkspaceGraph } from "../src/services/workspace-retirement-service";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";

const TEST_ENV: Env = env;

const ACTOR_ID = asUserId("00000000-0000-7000-8000-00000000e002");
const OPERATION_ID = "00000000-0000-7000-8000-00000000e003";
/** The instant the walk is asked to retire at; the register records the same instant. */
const COMPLETED_AT = "2026-09-05T13:00:00.000Z";
const FIRST_ROOM_ID = "00000000-0000-7000-8000-00000000e201";
const SPACE_ID = "00000000-0000-7000-8000-00000000e401";
const SIDEKICK_ID = "00000000-0000-7000-8000-00000000e301";

let workspaceSequence = 0;
function freshWorkspaceId() {
  workspaceSequence += 1;
  const suffix = (0xe100 + workspaceSequence).toString(16).padStart(4, "0");
  return asWorkspaceId(`00000000-0000-7000-8000-00000000${suffix}`);
}

/**
 * The operation table, declared here because this suite's D1 starts empty.
 *
 * The walk writes its receipt on the operation that made the workspace once
 * the graph is closed, which is what the Demos page reads; a workspace with no
 * operation is retired all the same.
 */
async function declareDemoOperations(): Promise<void> {
  await TEST_ENV.DB.prepare(
    `CREATE TABLE IF NOT EXISTS demo_operations (
       operation_id TEXT PRIMARY KEY,
       company_name TEXT NOT NULL,
       presenter_user_id TEXT NOT NULL,
       pack_version TEXT NOT NULL,
       cast_json TEXT NOT NULL,
       workspace_id TEXT UNIQUE,
       status TEXT NOT NULL,
       attempt INTEGER NOT NULL,
       failed_phase TEXT,
       error_code TEXT,
       error_message TEXT,
       ready_at TEXT,
       retired_at TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  ).run();
}

async function publishDemo(workspaceId: string): Promise<void> {
  await declareDemoOperations();
  await TEST_ENV.DB.prepare(
    `INSERT INTO demo_operations
       (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
        status, attempt, ready_at, created_at, updated_at)
     VALUES (?, 'Alto Capital', ?, 'v1', '{}', ?, 'ready', 1,
             '2026-09-05T12:05:00.000Z', '2026-09-05T12:00:00.000Z', '2026-09-05T12:05:00.000Z')
     ON CONFLICT (operation_id) DO NOTHING`,
  ).bind(`op-${workspaceId}`, ACTOR_ID, workspaceId).run();
}

async function registerRetiredAt(workspaceId: string): Promise<string | null> {
  const row = await TEST_ENV.DB.prepare(
    "SELECT retired_at FROM demo_operations WHERE workspace_id = ?",
  ).bind(workspaceId).first<{ retired_at: string | null }>();
  return row?.retired_at ?? null;
}

function workspaceStub(workspaceId: string): DurableObjectStub<WorkspaceDO> {
  const name = workspaceDOName(TEST_ENV.AVALON_REGION, asWorkspaceId(workspaceId));
  return TEST_ENV.WORKSPACE_DOS.get(TEST_ENV.WORKSPACE_DOS.idFromName(name)) as DurableObjectStub<WorkspaceDO>;
}

/** Two rooms and one automation, written the way their projections arrive. */
async function seedDirectory(stub: DurableObjectStub<WorkspaceDO>, workspaceId: string): Promise<void> {
  await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
    state.storage.sql.exec(
      `INSERT INTO workspace_identity
         (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, ?, 'wnam', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      workspaceId,
      TEST_ENV.AVALON_REGION,
      Date.now(),
      Date.now(),
    );
    for (const [index, id] of [
      FIRST_ROOM_ID,
      "00000000-0000-7000-8000-00000000e202",
    ].entries()) {
      state.storage.sql.exec(
        `INSERT INTO channels (
           workstream_id, authority_generation, waterline, source_event_id, payload_hash,
           title, description, preview, scope, exact_state, system_kind, last_activity_at,
           completed_at, archived_at, email_address, origin_type, origin_label,
           created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
           title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
           next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
           source_created_at, source_updated_at, projected_at)
         VALUES (?, 1, 1, ?, 'h', ?, '', '', 'workspace', 'idle', NULL, ?,
                 NULL, NULL, NULL, 'ad_hoc', NULL, NULL, NULL, NULL, NULL,
                 'settled', 0, 0, NULL, NULL, NULL, ?, ?, ?)`,
        id,
        `event-${index}`,
        `Room ${index}`,
        Date.now(),
        Date.now(),
        Date.now(),
        Date.now(),
      );
    }
    state.storage.sql.exec(
      `INSERT INTO automation_directory (
         automation_id, workspace_id, author_user_id, source_version, payload_hash,
         lifecycle, scope, owning_workstream_id, title, description, next_run_at, projected_at)
       VALUES (?, ?, ?, 1, 'h', 'active', 'workspace', NULL, 'Nightly', '', NULL, ?)`,
      SIDEKICK_ID,
      workspaceId,
      ACTOR_ID,
      Date.now(),
    );
    // Archived on purpose. What the graph is about is an object, not a product
    // surface: an archived Space is still a parent holding a hidden main
    // conversation, so enumerating only the active ones would report the
    // Organization closed with one of its objects still answering.
    state.storage.sql.exec(
      `INSERT INTO spaces (
         space_id, title, scope, appearance_json, archived_at, created_by_user_id,
         system_role, authority_generation, source_version, payload_hash, revision,
         created_at, updated_at, source_created_at, source_updated_at)
       VALUES (?, 'Hiring', 'workspace', NULL, ?, ?, NULL, 1, 1, 'h', 1, ?, ?, ?, ?)`,
      SPACE_ID,
      Date.now(),
      ACTOR_ID,
      Date.now(),
      Date.now(),
      Date.now(),
      Date.now(),
    );
    void instance;
  });
}

/**
 * A Channel parent's identity and its one Main child, written the way a
 * projection and a reservation leave them. Going through `reserveChild` would
 * drag in this suite's empty D1, and what is under test here is the walk.
 */
async function seedMainChild(stub: DurableObjectStub<WorkspaceDO>, workspaceId: string): Promise<void> {
  await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
    state.storage.sql.exec(
      `INSERT INTO parent_metadata
         (parent_id, parent_kind, workspace_id, region, authority_generation, revision,
          created_at, updated_at)
       VALUES (?, 'workstream', ?, ?, 1, 1, ?, ?)
       ON CONFLICT (parent_id) DO NOTHING`,
      FIRST_ROOM_ID,
      workspaceId,
      TEST_ENV.AVALON_REGION,
      Date.now(),
      Date.now(),
    );
    state.storage.sql.exec(
      `INSERT OR IGNORE INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at)
       VALUES (?, ?, 'main', ?, ?)`,
      FIRST_ROOM_ID,
      asSubstreamId("0"),
      ACTOR_ID,
      Date.now(),
    );
    void instance;
  });
}

/**
 * The real conversation namespace, counting `retireObject` calls and refusing
 * every one after `allowed` the way an overloaded object does. The overload is
 * the platform's failure and cannot be produced here, so only that call is
 * stood in for.
 */
function countingEnv(allowed: number) {
  const agents = TEST_ENV.SUBSTREAM_AGENTS;
  const counter = { retires: 0 };
  const namespace = {
    idFromName: (name: string) => agents.idFromName(name),
    idFromString: (id: string) => agents.idFromString(id),
    jurisdiction: () => namespace,
    get: (id: DurableObjectId) => {
      const real = agents.get(id);
      return {
        retireObject: (tombstone: Parameters<typeof real.retireObject>[0]) => {
          counter.retires += 1;
          return counter.retires > allowed
            ? Promise.reject(new Error("durable_object_overloaded"))
            : real.retireObject(tombstone);
        },
      };
    },
  };
  const proxied = new Proxy(TEST_ENV, {
    get: (target, property, receiver) => property === "SUBSTREAM_AGENTS"
      ? namespace
      : Reflect.get(target, property, receiver),
  });
  return { env: proxied, counter };
}

describe("workspace retirement graph", () => {
  it("records every parent before the tombstone, and keeps answering after it", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);

    const begun = await stub.beginWorkspaceRetirement({
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "demo_replaced",
    });

    // Both rooms and the automation, captured in one pass. An automation is a
    // conversation parent like a room, and the spike's empty automation list is
    // the reason this is asserted rather than assumed.
    expect(begun.nodes.map((node) => node.parentId).sort()).toEqual([
      "00000000-0000-7000-8000-00000000e201",
      "00000000-0000-7000-8000-00000000e202",
      "00000000-0000-7000-8000-00000000e301",
      SPACE_ID,
    ]);
    expect(begun.nodes.filter((node) => node.parentKind === "automation")).toHaveLength(1);
    // A Space is enumerated as its own kind rather than as a work stream, so
    // the receipt names what was closed; its hosted parent lives in this
    // object, but its hidden main conversation is still its own object.
    expect(begun.nodes.filter((node) => node.parentKind === "space")
      .map((node) => node.parentId)).toEqual([SPACE_ID]);

    // The workspace is closed from this moment. A product read is refused...
    let refusal: unknown;
    try {
      await stub.listAutomationDirectory({ workspaceId });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { code?: string } | undefined)?.code).toBe(RETIREMENT_REFUSAL_CODE);

    // ...while the walk's own reads keep working, which is the whole reason the
    // graph is recorded rather than re-derived from a directory that now refuses.
    const progress = await stub.workspaceRetirementProgress();
    expect(progress.remaining).toBe(4);
    expect(progress.complete).toBe(false);
  });

  it("is idempotent, resumable, and complete only when every node is receipted", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);

    const first = await stub.beginWorkspaceRetirement({
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "demo_replaced",
    });
    // A resumed operation re-enters here. It must find the same graph rather
    // than a second, emptier one read from a directory that now refuses.
    const resumed = await stub.beginWorkspaceRetirement({
      retiredAt: Date.now() + 5_000,
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "demo_replaced",
    });
    expect(resumed.nodes).toEqual(first.nodes);

    // Everything but the Space, which is the interruption this is about: a
    // pass that closed the Channels and the Sidekick and died before it
    // reached the Space must not let the Organization report itself closed.
    const spaceNode = first.nodes.find((node) => node.parentKind === "space");
    expect(spaceNode).toBeDefined();
    for (const node of first.nodes.filter((node) => node.parentKind !== "space")) {
      await stub.recordRetiredNode({ parentKind: node.parentKind, parentId: node.parentId });
    }
    const partial = await stub.workspaceRetirementProgress();
    expect(partial.remaining).toBe(1);
    // A node left unreceipted leaves retirement visibly incomplete rather than
    // silently finished, which is what makes the operator's Failed state
    // truthful.
    expect(partial.complete).toBe(false);

    await stub.recordRetiredNode({
      parentKind: spaceNode!.parentKind,
      parentId: spaceNode!.parentId,
    });
    const done = await stub.workspaceRetirementProgress();
    expect(done.remaining).toBe(0);
    expect(done.complete).toBe(true);

    // Receipts are terminal: replaying one does not reopen a finished walk.
    await stub.recordRetiredNode({
      parentKind: first.nodes[0]!.parentKind,
      parentId: first.nodes[0]!.parentId,
    });
    expect((await stub.workspaceRetirementProgress()).complete).toBe(true);
  });

  it("reports an empty workspace closed rather than permanently unfinished", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await publishDemo(workspaceId);
    // A demo whose preparation failed before it seeded anything has no work
    // streams and no automations, so it records no graph rows. Reading
    // completeness from the row count made that workspace incomplete on the
    // first pass and on every pass after it, and its register row could never
    // be marked retired.
    await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_identity
           (id, workspace_id, region, placement_affinity, created_at, updated_at)
         VALUES (1, ?, ?, 'wnam', ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        workspaceId,
        TEST_ENV.AVALON_REGION,
        Date.now(),
        Date.now(),
      );
      void instance;
    });

    const receipt = await retireWorkspaceGraph(TEST_ENV, {
      workspaceId,
      retiredAt: Date.parse(COMPLETED_AT),
      operationId: OPERATION_ID,
      actorUserId: null,
      reason: "demo_replaced",
    });

    expect(receipt.retiredParents).toBe(0);
    expect(receipt.complete).toBe(true);
    expect(await registerRetiredAt(workspaceId)).toBe(COMPLETED_AT);
  });

  it("resumes over a parent that was retired but never receipted", async () => {
    // The gap a pass can die in: the parent's tombstone is written, then the
    // receipt is not. The next pass has to ask that parent for its children
    // again — a refusal there left the node unreceipted on every pass, so the
    // operator saw "incomplete, retire again" forever.
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await declareDemoOperations();
    await seedDirectory(stub, workspaceId);
    const tombstone = { retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: null, reason: "operator_retirement" };
    await stub.beginWorkspaceRetirement(tombstone);
    // Every parent is closed with the Organization object above, and no
    // `recordRetiredNode` has run, which is exactly the state an interrupted
    // pass leaves behind.
    expect((await stub.workspaceRetirementProgress()).remaining).toBe(4);

    const receipt = await retireWorkspaceGraph(TEST_ENV, { workspaceId, ...tombstone });
    expect(receipt.failed).toEqual([]);
    expect(receipt.complete).toBe(true);
    expect(receipt.remaining).toBe(0);
    expect(receipt.parents).toBe(4);
  });

  it("leaves a parent whose child could not be closed unreceipted, names why, and finishes on the next pass", async () => {
    // The one outcome that is a failure, and the only path that produces a
    // non-empty `failed`, the receipt shape the route and the Ace page render.
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await declareDemoOperations();
    await seedDirectory(stub, workspaceId);
    await seedMainChild(stub, workspaceId);
    const tombstone = { retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: null, reason: "operator_retirement" } as const;

    const failed = await retireWorkspaceGraph(countingEnv(0).env, { workspaceId, ...tombstone });
    expect(failed.complete).toBe(false);
    expect(failed.remaining).toBe(1);
    expect(failed.failed).toEqual([
      { parentKind: "workstream", parentId: FIRST_ROOM_ID, error: "durable_object_overloaded" },
    ]);

    const resumed = await retireWorkspaceGraph(TEST_ENV, { workspaceId, ...tombstone });
    expect(resumed.failed).toEqual([]);
    expect(resumed.retiredChildren).toBe(1);
    expect(resumed.complete).toBe(true);
  });

  it("keeps the children a cut-off pass closed, and the next pass wakes only the rest", async () => {
    // Cut off after one child: the next object call does not come back.
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await declareDemoOperations();
    await seedDirectory(stub, workspaceId);
    await seedMainChild(stub, workspaceId);
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT OR IGNORE INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at)
         VALUES (?, ?, 'child', ?, ?)`,
        FIRST_ROOM_ID,
        asSubstreamId("00000000-0000-7000-8000-00000000e501"),
        ACTOR_ID,
        Date.now() + 1,
      );
    });

    const tombstone = { retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: null, reason: "operator_retirement" } as const;

    const cut = countingEnv(1);
    const first = await retireWorkspaceGraph(cut.env, { workspaceId, ...tombstone });
    expect(first.complete).toBe(false);
    expect(first.retiredChildren).toBe(1);
    expect(cut.counter.retires).toBe(2);

    const resumed = countingEnv(Number.POSITIVE_INFINITY);
    const second = await retireWorkspaceGraph(resumed.env, { workspaceId, ...tombstone });
    expect(second.failed).toEqual([]);
    expect(second.complete).toBe(true);
    // Only the child the first pass did not finish. Without the per-child
    // receipt this pass wakes both again.
    expect(resumed.counter.retires).toBe(1);
    expect(second.retiredChildren).toBe(1);
  });

  it("closes children before parents and reports the pass", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await publishDemo(workspaceId);
    await seedDirectory(stub, workspaceId);
    // A real child on one of the parents. Without it every `childrenForRetirement`
    // answers `missing`, `retiredChildren` is zero, and the test named for
    // closing children before parents closes no children at all.
    await seedMainChild(stub, workspaceId);

    const receipt = await retireWorkspaceGraph(TEST_ENV, {
      workspaceId,
      retiredAt: Date.parse(COMPLETED_AT),
      operationId: OPERATION_ID,
      // An internal actor, never the author of what is being closed. The spike
      // impersonated an automation's author to make its transitions go through,
      // which put a person's name on work they did not do.
      actorUserId: null,
      reason: "demo_replaced",
    });

    expect(receipt.failed).toEqual([]);
    expect(receipt.parents).toBe(4);
    expect(receipt.retiredParents).toBe(4);
    // The child was found and closed, which is only possible because it was
    // asked for before its parent was tombstoned.
    expect(receipt.retiredChildren).toBe(1);
    expect(receipt.complete).toBe(true);
    expect(receipt.remaining).toBe(0);

    // Every parent is closed, and the workspace with them.
    const progress = await stub.workspaceRetirementProgress();
    expect(progress.nodes.every((node) => node.retired)).toBe(true);
    expect((await stub.objectRetirementState()).retired).toBe(true);

    // Re-running a finished retirement is a no-op rather than a second walk.
    const again = await retireWorkspaceGraph(TEST_ENV, {
      workspaceId,
      retiredAt: Date.parse(COMPLETED_AT),
      operationId: OPERATION_ID,
      actorUserId: null,
      reason: "demo_replaced",
    });
    expect(again.retiredParents).toBe(0);
    expect(again.complete).toBe(true);
    // The register's retired instant is the first pass's, not the replay's.
    expect(await registerRetiredAt(workspaceId)).toBe(COMPLETED_AT);
  });
});
