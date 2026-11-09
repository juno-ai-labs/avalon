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

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { RETIREMENT_REFUSAL_CODE } from "../src/durable-objects/object-retirement";
import { retireWorkspaceGraph } from "../src/services/workspace-retirement-service";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";

const TEST_ENV: Env = env;

const ACTOR_ID = asUserId("00000000-0000-7000-8000-00000000e002");
const OPERATION_ID = "00000000-0000-7000-8000-00000000e003";
/** The instant the walk is asked to retire at; the register records the same instant. */
const COMPLETED_AT = "2026-09-05T13:00:00.000Z";
const CANVAS_IDS = ["00000000-0000-7000-8000-00000000e201", "00000000-0000-7000-8000-00000000e202"] as const;
const SIDEKICK_ID = "00000000-0000-7000-8000-00000000e301";

let workspaceSequence = 0;
function freshWorkspaceId() {
  workspaceSequence += 1;
  const suffix = (0xe100 + workspaceSequence).toString(16).padStart(4, "0");
  return asWorkspaceId(`00000000-0000-7000-8000-00000000${suffix}`);
}

function workspaceStub(workspaceId: string): DurableObjectStub<WorkspaceDO> {
  const name = workspaceDOName(TEST_ENV.AVALON_REGION, asWorkspaceId(workspaceId));
  return TEST_ENV.WORKSPACE_DOS.get(TEST_ENV.WORKSPACE_DOS.idFromName(name)) as DurableObjectStub<WorkspaceDO>;
}

/** One Sidekick, written the way its projection arrives. */
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
    void instance;
  });
}

/** Two Canvases beside the Sidekick, made the way the product makes them. */
async function seedCanvases(stub: DurableObjectStub<WorkspaceDO>, workspaceId: string): Promise<void> {
  for (const [index, canvasId] of CANVAS_IDS.entries()) {
    await stub.canvasCreate({ workspaceId, canvasId, title: `Canvas ${index}`, createdByUserId: ACTOR_ID, authorityGeneration: 1 });
  }
}

/**
 * The real conversation namespace, counting `retireObject` calls and refusing
 * every one after `allowed` the way an overloaded object does. The overload is
 * the platform's failure and cannot be produced here, so only that call is
 * stood in for.
 */
function countingEnv(allowed: number) {
  const agents = TEST_ENV.SUBSTREAM_AGENTS;
  const counter = { retires: 0, inFlight: 0, maxInFlight: 0 };
  const namespace = {
    idFromName: (name: string) => agents.idFromName(name),
    idFromString: (id: string) => agents.idFromString(id),
    jurisdiction: () => namespace,
    get: (id: DurableObjectId) => {
      const real = agents.get(id);
      return {
        retireObject: async (tombstone: Parameters<typeof real.retireObject>[0]) => {
          counter.retires += 1;
          if (counter.retires > allowed) throw new Error("durable_object_overloaded");
          counter.inFlight += 1;
          counter.maxInFlight = Math.max(counter.maxInFlight, counter.inFlight);
          try {
            return await real.retireObject(tombstone);
          } finally {
            counter.inFlight -= 1;
          }
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

/** A further conversation under a Canvas, beside its Chat. */
async function seedCanvasChild(stub: DurableObjectStub<WorkspaceDO>, canvasId: string, substreamId: string, createdAt: number): Promise<void> {
  await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec(
      `INSERT OR IGNORE INTO sidekick_children (sidekick_id, substream_id, kind, created_by_user_id, created_at)
       VALUES (?, ?, 'child', ?, ?)`,
      canvasId,
      substreamId,
      ACTOR_ID,
      createdAt,
    );
  });
}

describe("workspace retirement graph", () => {
  it("records every parent before the tombstone, and keeps answering after it", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);
    await seedCanvases(stub, workspaceId);

    const begun = await stub.beginWorkspaceRetirement({
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "operator_retirement",
    });

    // Both Canvases and the Sidekick, captured in one pass. A Sidekick is a
    // conversation parent like a Canvas, and the spike's empty automation list
    // is the reason this is asserted rather than assumed.
    expect(begun.nodes.map((node) => node.parentId).sort()).toEqual([...CANVAS_IDS, SIDEKICK_ID].sort());
    expect(begun.nodes.filter((node) => node.parentKind === "automation")).toHaveLength(1);
    expect(begun.nodes.filter((node) => node.parentKind === "canvas").map((node) => node.parentId).sort())
      .toEqual([...CANVAS_IDS]);

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
    expect(progress.remaining).toBe(3);
    expect(progress.complete).toBe(false);
  });

  it("is idempotent, resumable, and complete only when every node is receipted", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);
    await seedCanvases(stub, workspaceId);

    const first = await stub.beginWorkspaceRetirement({
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "operator_retirement",
    });
    // A resumed operation re-enters here. It must find the same graph rather
    // than a second, emptier one read from a directory that now refuses.
    const resumed = await stub.beginWorkspaceRetirement({
      retiredAt: Date.now() + 5_000,
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "operator_retirement",
    });
    expect(resumed.nodes).toEqual(first.nodes);

    // Everything but one Canvas, which is the interruption this is about: a
    // pass that closed the rest and died before it reached that Canvas must
    // not let the Organization report itself closed.
    const lastNode = first.nodes.find((node) => node.parentId === CANVAS_IDS[1]);
    expect(lastNode).toBeDefined();
    for (const node of first.nodes.filter((node) => node !== lastNode)) {
      await stub.recordRetiredNode({ parentKind: node.parentKind, parentId: node.parentId });
    }
    const partial = await stub.workspaceRetirementProgress();
    expect(partial.remaining).toBe(1);
    // A node left unreceipted leaves retirement visibly incomplete rather than
    // silently finished, which is what makes the operator's Failed state
    // truthful.
    expect(partial.complete).toBe(false);

    await stub.recordRetiredNode({
      parentKind: lastNode!.parentKind,
      parentId: lastNode!.parentId,
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
    // A workspace with no work streams and no automations records no graph
    // rows. Reading completeness from the row count made it incomplete on
    // the first pass and on every pass after it.
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
      reason: "operator_retirement",
    });

    expect(receipt.retiredParents).toBe(0);
    expect(receipt.complete).toBe(true);
  });

  it("resumes over a parent that was retired but never receipted", async () => {
    // The gap a pass can die in: the parent's tombstone is written, then the
    // receipt is not. The next pass has to ask that parent for its children
    // again — a refusal there left the node unreceipted on every pass, so the
    // operator saw "incomplete, retire again" forever.
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);
    await seedCanvases(stub, workspaceId);
    const tombstone = { retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: null, reason: "operator_retirement" };
    await stub.beginWorkspaceRetirement(tombstone);
    // Every parent is closed with the Organization object above, and no
    // `recordRetiredNode` has run, which is exactly the state an interrupted
    // pass leaves behind.
    expect((await stub.workspaceRetirementProgress()).remaining).toBe(3);

    const receipt = await retireWorkspaceGraph(TEST_ENV, { workspaceId, ...tombstone });
    expect(receipt.failed).toEqual([]);
    expect(receipt.complete).toBe(true);
    expect(receipt.remaining).toBe(0);
    expect(receipt.parents).toBe(3);
  });


  it("closes a Canvas's Chat with the Organization", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);
    const canvasId = "00000000-0000-7000-8000-00000000e501";
    await stub.canvasCreate({ workspaceId, canvasId, title: "Plan", createdByUserId: ACTOR_ID, authorityGeneration: 1 });
    const chat = TEST_ENV.SUBSTREAM_AGENTS.get(TEST_ENV.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName(TEST_ENV.AVALON_REGION, workspaceId, canvasId, "0")));

    const receipt = await retireWorkspaceGraph(TEST_ENV, { workspaceId, retiredAt: Date.now(), operationId: OPERATION_ID,
      actorUserId: null, reason: "operator_retirement" });

    expect(receipt.failed).toEqual([]);
    expect(receipt.complete).toBe(true);
    expect((await stub.workspaceRetirementProgress()).nodes)
      .toContainEqual({ parentKind: "canvas", parentId: canvasId, retired: true });
    // The Chat's own object holds the tombstone, so nothing reaches it again.
    expect(await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ reason: string }>(
      "SELECT reason FROM object_retirement WHERE id = 1").toArray())).toEqual([{ reason: "operator_retirement" }]);
  });

  it("keeps the children a cut-off pass closed, and the next pass wakes only the rest", async () => {
    // Cut off after one child: the next object call does not come back.
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);
    const canvasId = "00000000-0000-7000-8000-00000000e502";
    await stub.canvasCreate({ workspaceId, canvasId, title: "Plan", createdByUserId: ACTOR_ID, authorityGeneration: 1 });
    // A second conversation under the Canvas, after its Chat.
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT OR IGNORE INTO sidekick_children (sidekick_id, substream_id, kind, created_by_user_id, created_at)
         VALUES (?, ?, 'child', ?, ?)`,
        canvasId,
        "00000000-0000-7000-8000-00000000e601",
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

  it("closes one parent's children several at a time, never more than the limit", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);
    const canvasId = "00000000-0000-7000-8000-00000000e510";
    await stub.canvasCreate({ workspaceId, canvasId, title: "Plan", createdByUserId: ACTOR_ID, authorityGeneration: 1 });
    // Two more conversations under the Canvas, beside its Chat.
    await seedCanvasChild(stub, canvasId, "00000000-0000-7000-8000-00000000e511", Date.now() + 1);
    await seedCanvasChild(stub, canvasId, "00000000-0000-7000-8000-00000000e512", Date.now() + 2);
    const tombstone = { retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: null, reason: "operator_retirement" } as const;

    const tracked = countingEnv(Number.POSITIVE_INFINITY);
    const receipt = await retireWorkspaceGraph(tracked.env, { workspaceId, ...tombstone, childConcurrency: 2 });

    expect(receipt.failed).toEqual([]);
    expect(receipt.retiredChildren).toBe(3);
    expect(receipt.complete).toBe(true);
    expect(tracked.counter.maxInFlight).toBe(2);
  });
});
