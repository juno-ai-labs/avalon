/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Space intents staged before WorkspaceDO migration 94, finished in place.
 *
 * Every Space operation is one transaction of WorkspaceDO now, so nothing
 * stages an intent any more. A row a Worker left unsettled at the deploy is
 * still finished — by the alarm, or by a `space_intent_resume` message
 * already on the Queue — through `resumeLegacyIntent`, from the fences on the
 * row, with no Channel asked anything. The rows below are written the way the
 * staging Worker wrote them, because no live code path writes them.
 *
 * Real workerd because the property is the alarm and the transaction: a
 * resume that half-applied would leave a membership `joining` or an intent
 * pending, and both are read back from real storage.
 *
 * The Queue delivery of a Space default is here too, because it shares the
 * fixture: it acts as the person who staged it, never as a Space participant.
 */
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ParentEffect,
  type SpaceId,
  type WorkstreamId,
} from "@rally/contracts";
import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceSpaceIntentKind } from "../src/durable-objects/workspace-space-storage";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { placeMembership, withSpaceStorage } from "./helpers/space-membership";
import { changeRelationships } from "./helpers/workspace-relationship-events";

/** Its own workspace id: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ba00");
const OWNER = asUserId("00000000-0000-7000-8000-00000000ba01");
const SESSION_ID = "00000000-0000-7000-8000-00000000ba02";
/** The second member: the requester a Queue resume can find suspended. */
const MEMBER = asUserId("00000000-0000-7000-8000-00000000ba03");
const MEMBER_SESSION_ID = "00000000-0000-7000-8000-00000000ba04";
const CHANNEL = asWorkstreamId("00000000-0000-7000-8000-00000000ba05");
const RESOURCE_ID = "00000000-0000-7000-8000-00000000ba06";

function workspace() {
  return env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare("INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')")
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'owner', 'member')`)
      .bind(WORKSPACE_ID, OWNER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'member', 'member')`)
      .bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, OWNER, WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(MEMBER_SESSION_ID, MEMBER, WORKSPACE_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

let effectSequence = 0;

/** One Channel published into the Organization's Channel directory. */
async function publishChannel(workstreamId: WorkstreamId): Promise<void> {
  effectSequence += 1;
  const effect: ParentEffect = {
    kind: "directory_common",
    title: "Member Channel",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-09-19T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    resourceLinks: [],
  };
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      generation: 1,
      messageId: `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}ba`,
      partitionKey: "common",
      sourceVersion: 1,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })],
  });
}

async function reserve(name: string): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    space: { name, iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  return asSpaceId(result.space.id);
}

async function place(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<void> {
  await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId });
}

/**
 * An intent at rest, as the staging Worker left one: at the Space's current
 * revision, due later, so the test decides when the alarm runs. A `joining`
 * target row is written with it when the kind staged one.
 */
async function storedIntent(input: {
  kind: WorkspaceSpaceIntentKind;
  spaceId: SpaceId;
  workstreamId?: WorkstreamId;
  joining?: boolean;
  sourceSpaceId?: SpaceId;
  requestedByUserId?: string;
  operationId?: string;
}): Promise<{ operationId: string; spaceRevision: number }> {
  const operationId = input.operationId ?? crypto.randomUUID();
  const spaceRevision = await withSpaceStorage(workspace(), (storage) => {
    const space = storage.spaceRevision(input.spaceId);
    const source = input.sourceSpaceId ? storage.spaceRevision(input.sourceSpaceId) : null;
    if (space === null) throw new Error("intent Space missing");
    storage.recordIntent({
      operationId,
      kind: input.kind,
      spaceId: input.spaceId,
      workstreamId: input.workstreamId ?? null,
      spaceRevision: space,
      membershipGeneration: input.workstreamId ? 1 : null,
      sourceSpaceId: input.sourceSpaceId ?? null,
      sourceSpaceRevision: source,
      sourceMembershipGeneration: input.sourceSpaceId ? 1 : null,
      deliveryGeneration: null,
      requestedByUserId: input.requestedByUserId ?? OWNER,
      notBefore: Date.now() + 60_000,
    });
    return space;
  });
  if (input.joining) {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
         VALUES (?, ?, 'joining', 1, 1, 1, NULL)`,
        input.spaceId,
        input.workstreamId,
      );
    });
  }
  return { operationId, spaceRevision };
}

/**
 * One alarm with every unsettled intent due, which is how an interrupted
 * operation is finished: the alarm resumes it in place, as its requester.
 */
async function resumeOnAlarm(): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("UPDATE space_intents SET not_before = 0 WHERE state IN ('pending', 'applied')");
  });
  await runDurableObjectAlarm(workspace());
}

async function intentRow(operationId: string) {
  return (await workspace().runInspectionSql({
    sql: "SELECT state, receipts_json, last_error_code FROM space_intents WHERE operation_id = ?",
    bindings: [operationId],
  })).rows[0];
}

async function memberships(workstreamId: WorkstreamId) {
  return (await workspace().runInspectionSql({
    sql: "SELECT space_id, state FROM space_channel_memberships WHERE workstream_id = ? ORDER BY space_id",
    bindings: [workstreamId],
  })).rows;
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
}, 60_000);

describe("a stored add, resumed in place", () => {
  it("given an add whose membership is still joining, when the alarm resumes it, then the membership activates and the Space's defaults are staged for it", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL);
    await expect(workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "resource", targetId: RESOURCE_ID,
    })).resolves.toMatchObject({ ok: true });
    const { operationId } = await storedIntent({ kind: "add", spaceId, workstreamId: CHANNEL, joining: true });

    await resumeOnAlarm();

    expect(await memberships(CHANNEL)).toEqual([{ space_id: spaceId, state: "active" }]);
    expect((await workspace().runInspectionSql({
      sql: "SELECT target_id, membership_generation, state FROM space_default_targets WHERE workstream_id = ?",
      bindings: [CHANNEL],
    })).rows).toEqual([{ target_id: RESOURCE_ID, membership_generation: 1, state: "pending" }]);
    expect(await intentRow(operationId))
      .toMatchObject({ state: "settled", receipts_json: '["membership_finalized"]' });
  }, 60_000);

  it("given a requester who is no longer an active member, when the alarm reaches their add, then nothing runs as them and the reason is on the row", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL);
    const { operationId } = await storedIntent({
      kind: "add", spaceId, workstreamId: CHANNEL, joining: true, requestedByUserId: MEMBER,
    });
    await changeRelationships(env, WORKSPACE_ID, [MEMBER],
      env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ? AND user_id = ?")
        .bind(WORKSPACE_ID, MEMBER));

    await resumeOnAlarm();

    expect(await memberships(CHANNEL)).toEqual([{ space_id: spaceId, state: "joining" }]);
    expect(await intentRow(operationId))
      .toMatchObject({ state: "pending", last_error_code: "space_intent_requester_inactive" });
  }, 60_000);
});

describe("a stored move, resumed in place", () => {
  it("given a move still at its fences, when the alarm resumes it, then the memberships switch in one step", async () => {
    const source = await reserve("Source");
    const target = await reserve("Target");
    await publishChannel(CHANNEL);
    await place(source, CHANNEL);
    const { operationId } = await storedIntent({
      kind: "move", spaceId: target, sourceSpaceId: source, workstreamId: CHANNEL, joining: true,
    });

    await resumeOnAlarm();

    expect(await memberships(CHANNEL)).toEqual(expect.arrayContaining([
      { space_id: source, state: "removed" },
      { space_id: target, state: "active" },
    ]));
    expect(await intentRow(operationId)).toMatchObject({ state: "settled" });
  }, 60_000);

  it("given two stored moves from one placement, when the alarm resumes both, then the first wins and the other target never activates", async () => {
    const source = await reserve("Source");
    const winner = await reserve("Winner");
    const older = await reserve("Older");
    await publishChannel(CHANNEL);
    await place(source, CHANNEL);
    // Equally due, so the alarm takes them in operation id order.
    const winning = await storedIntent({
      kind: "move", spaceId: winner, sourceSpaceId: source, workstreamId: CHANNEL, joining: true,
      operationId: "00000000-0000-7000-8000-00000000ba10",
    });
    const losing = await storedIntent({
      kind: "move", spaceId: older, sourceSpaceId: source, workstreamId: CHANNEL, joining: true,
      operationId: "00000000-0000-7000-8000-00000000ba11",
    });

    await resumeOnAlarm();

    expect(await memberships(CHANNEL)).toEqual(expect.arrayContaining([
      { space_id: source, state: "removed" },
      { space_id: winner, state: "active" },
      { space_id: older, state: "removed" },
    ]));
    expect(await intentRow(winning.operationId)).toMatchObject({ state: "settled" });
    expect(await intentRow(losing.operationId)).toMatchObject({ state: "cancelled" });
  }, 60_000);
});

describe("a stored resume from the Queue", () => {
  it("given a requester who is no longer an active member, when the consumer reaches their intent, then nothing runs as them and the reason is on the row", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL);
    const { operationId, spaceRevision } = await storedIntent({
      kind: "add", spaceId, workstreamId: CHANNEL, joining: true, requestedByUserId: MEMBER,
    });
    await changeRelationships(env, WORKSPACE_ID, [MEMBER],
      env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ? AND user_id = ?")
        .bind(WORKSPACE_ID, MEMBER));

    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "space_intent_resume",
        region: "global",
        workspaceId: WORKSPACE_ID,
        operationId,
        kind: "add",
        spaceId,
        workstreamId: CHANNEL,
        spaceRevision,
        membershipGeneration: 1,
        cursor: null,
        requestedByUserId: MEMBER,
      },
    }]);
    await consumeActivityQueue(batch, env);
    await getQueueResult(batch, createExecutionContext());

    // Nobody acted as them: the membership is still the one they staged, and
    // the row says why rather than leaving only a log line behind.
    expect(await memberships(CHANNEL)).toEqual([{ space_id: spaceId, state: "joining" }]);
    expect(await intentRow(operationId))
      .toMatchObject({ state: "pending", last_error_code: "space_intent_requester_inactive" });
  }, 60_000);
});

describe("a Space default on the Queue", () => {
  it("given a requester who is no longer an active member, when the default is delivered, then it fails by name rather than acting as a Space participant", async () => {
    const spaceId = await reserve("Company");
    await publishChannel(CHANNEL);
    await place(spaceId, CHANNEL);
    const added = await workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, kind: "resource", targetId: RESOURCE_ID,
    });
    if (!added.ok) throw new Error(added.code);
    // The Space's own participant (its creator) stays active; the person who
    // staged this delivery does not.
    await changeRelationships(env, WORKSPACE_ID, [MEMBER],
      env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ? AND user_id = ?")
        .bind(WORKSPACE_ID, MEMBER));

    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "space_default",
        region: "global",
        workspaceId: WORKSPACE_ID,
        requestedByUserId: MEMBER,
        ...added.targets[0]!,
      },
    }]);
    await consumeActivityQueue(batch, env);
    await getQueueResult(batch, createExecutionContext());

    expect((await workspace().runInspectionSql({
      sql: "SELECT state, last_error_code FROM space_default_targets WHERE workstream_id = ?",
      bindings: [CHANNEL],
    })).rows).toEqual([{ state: "terminal", last_error_code: "space_default_requester_inactive" }]);
  }, 60_000);
});
