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

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { RETIREMENT_REFUSAL_CODE } from "../src/durable-objects/object-retirement";
import { retireWorkspaceGraph } from "../src/services/workspace-retirement-service";
import { workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import type { WorkstreamDO } from "../src/durable-objects/workstream-do";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";

const TEST_ENV: Env = env;

const ACTOR_ID = asUserId("00000000-0000-7000-8000-00000000e002");
const OPERATION_ID = "00000000-0000-7000-8000-00000000e003";
const FIRST_ROOM_ID = "00000000-0000-7000-8000-00000000e201";

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
        `INSERT INTO workspace_workstream_directory (
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
      "00000000-0000-7000-8000-00000000e301",
      workspaceId,
      ACTOR_ID,
      Date.now(),
    );
    void instance;
  });
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
      reason: "operator_retirement",
    });

    // Both rooms and the automation, captured in one pass. An automation is a
    // conversation parent like a room, and the spike's empty automation list is
    // the reason this is asserted rather than assumed.
    expect(begun.nodes.map((node) => node.parentId).sort()).toEqual([
      "00000000-0000-7000-8000-00000000e201",
      "00000000-0000-7000-8000-00000000e202",
      "00000000-0000-7000-8000-00000000e301",
    ]);
    expect(begun.nodes.filter((node) => node.parentKind === "automation")).toHaveLength(1);

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

    for (const node of first.nodes.slice(0, 2)) {
      await stub.recordRetiredNode({ parentKind: node.parentKind, parentId: node.parentId });
    }
    const partial = await stub.workspaceRetirementProgress();
    expect(partial.remaining).toBe(1);
    // A failed child leaves retirement visibly incomplete rather than silently
    // finished, which is what makes the operator's Failed state truthful.
    expect(partial.complete).toBe(false);

    await stub.recordRetiredNode({
      parentKind: first.nodes[2]!.parentKind,
      parentId: first.nodes[2]!.parentId,
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
    // A workspace that was never used has no work streams and no automations,
    // so it records no graph rows. Reading completeness from the row count
    // made that workspace incomplete on the first pass and on every pass after
    // it.
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
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      actorUserId: null,
      reason: "operator_retirement",
    });

    expect(receipt.retiredParents).toBe(0);
    expect(receipt.complete).toBe(true);
  });

  it("closes children before parents and reports the pass", async () => {
    const workspaceId = freshWorkspaceId();
    const stub = workspaceStub(workspaceId);
    await seedDirectory(stub, workspaceId);
    // A real child on one of the parents. Without it every `childrenForRetirement`
    // answers `missing`, `retiredChildren` is zero, and the test named for
    // closing children before parents closes no children at all.
    const room = TEST_ENV.WORKSTREAM_DOS.get(TEST_ENV.WORKSTREAM_DOS.idFromName(
      workstreamDOName(TEST_ENV.AVALON_REGION, workspaceId, asWorkstreamId(FIRST_ROOM_ID)),
    )) as DurableObjectStub<WorkstreamDO>;
    await runInDurableObject(room, (instance: WorkstreamDO, state) => {
      // Its identity and its one child, written the way a projection and a
      // reservation leave them. Going through `reserveChild` would drag in this
      // suite's empty D1, and what is under test here is the walk.
      state.storage.sql.exec(
        `INSERT INTO workstream_metadata
           (id, revision, authority_generation, workspace_id, workstream_id, region, title,
            description, preview, scope, exact_state, system_kind, last_activity_at,
            completed_at, archived_at, email_address, created_by_user_id, title_status,
            latest_attention_ordinal, unread_tracking_start_ordinal, next_wakeup_due_at,
            next_wakeup_prompt, next_terminal_action_at, source_created_at, source_updated_at,
            created_at, updated_at)
         VALUES (1, 1, 1, ?, ?, ?, 'Room 0', '', '', 'workspace', 'idle', NULL, ?,
                 NULL, NULL, NULL, ?, 'settled', 0, 0, NULL, NULL, NULL, ?, ?,
                 unixepoch(), unixepoch())
         ON CONFLICT (id) DO NOTHING`,
        workspaceId,
        FIRST_ROOM_ID,
        TEST_ENV.AVALON_REGION,
        Date.now(),
        ACTOR_ID,
        Date.now(),
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT OR IGNORE INTO conversation_children (substream_id, kind, created_by_user_id, created_at)
         VALUES (?, 'main', ?, ?)`,
        asSubstreamId("0"),
        ACTOR_ID,
        Date.now(),
      );
      void instance;
    });

    const receipt = await retireWorkspaceGraph(TEST_ENV, {
      workspaceId,
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      // An internal actor, never the author of what is being closed. The spike
      // impersonated an automation's author to make its transitions go through,
      // which put a person's name on work they did not do.
      actorUserId: null,
      reason: "operator_retirement",
    });

    expect(receipt.failed).toEqual([]);
    expect(receipt.retiredParents).toBe(3);
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
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      actorUserId: null,
      reason: "operator_retirement",
    });
    expect(again.retiredParents).toBe(0);
    expect(again.complete).toBe(true);
  });
});
