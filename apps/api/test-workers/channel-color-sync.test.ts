/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A thread and its Breakouts carry their Channel's colour, on real workerd.
 *
 * What this proves is WorkspaceDO's half (`channel-color-sync.ts`): that the
 * triggers mark a thread on the writes that can move its colour and not on the
 * ones that cannot, and that the consumer's two RPCs answer the colour and the
 * conversations to write it into and settle only the revision they were sent.
 * The last case runs the Queue consumer against a real Main conversation;
 * `recolor` itself is proved in `identity-authority.test.ts`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type SpaceColorKey,
  type SpaceId,
  type WorkstreamId,
} from "@rally/contracts";
import {
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";

import { conversationObjectName } from "../src/durable-objects/names";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { nextChannelColorSyncAt, publishChannelColorSync } from "../src/durable-objects/channel-color-sync";
import { hostedParentStub } from "./helpers/hosted-parent";
import { boot, seedWorkstreamRoot } from "./helpers/substream-fixture";
import { placeMembership } from "./helpers/space-membership";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000e700");
const OWNER = asUserId("00000000-0000-7000-8000-00000000e701");
const THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e702");
const BREAKOUT = asSubstreamId("00000000-0000-7000-8000-00000000e703");

const workspace = () => hostedParentStub(env, WORKSPACE_ID);

let effectSequence = 0;

function messageId(): string {
  effectSequence += 1;
  return `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}e7`;
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'owner', 'member')`)
      .bind(WORKSPACE_ID, OWNER),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

function commonEffect(archivedAt: string | null = null): ParentEffect {
  return {
    kind: "directory_common",
    title: "Launch plan",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-10-12T00:00:00.000Z",
    completedAt: null,
    archivedAt,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    resourceLinks: [],
  };
}

/** A thread's (or, with `substreamId`, a Breakout's) projection, as the directory receives it. */
async function project(sourceVersion: number, substreamId?: string, archivedAt: string | null = null): Promise<void> {
  const effect = commonEffect(archivedAt);
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: THREAD,
      ...(substreamId ? { substreamId } : {}),
      generation: 1,
      messageId: messageId(),
      partitionKey: "common",
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })],
  });
}

async function reserve(name: string, colorKey: SpaceColorKey): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    space: { name, iconKey: "briefcase", colorKey, scope: "workspace" },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  return result.space.id as SpaceId;
}

async function recolorChannel(spaceId: SpaceId, name: string, colorKey: SpaceColorKey): Promise<void> {
  await workspace().noteSpacePresentation({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    spaceId,
    presentation: { name, iconKey: "briefcase", colorKey },
  });
}

/** The thread's mark, or `null` when nothing is waiting to recolour it. */
async function marked(workstreamId: WorkstreamId = THREAD): Promise<number | null> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ revision: number }>(
    "SELECT revision FROM channel_color_sync WHERE workstream_id = ?", workstreamId,
  ).toArray()[0]?.revision ?? null);
}

/** How many times the alarm has sent the thread's mark to the Queue. */
async function attempts(): Promise<number> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ attempts: number }>(
    "SELECT attempts FROM channel_color_sync WHERE workstream_id = ?", THREAD,
  ).toArray()[0]?.attempts ?? 0);
}

function message(revision: number) {
  return { type: "channel_color_sync" as const, region: "global" as const, workspaceId: WORKSPACE_ID, workstreamId: THREAD, revision };
}

/** Settle whatever is marked, as the consumer would after writing it. */
async function settle(): Promise<void> {
  const revision = await marked();
  if (revision !== null) await workspace().completeChannelColorSync(message(revision));
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
});

describe("a thread carries its Channel's colour", () => {
  it("answers the Channel's colour for Main and each open Breakout once the thread is placed", async () => {
    const launch = await reserve("Launch", "red");
    await project(1);
    await project(1, BREAKOUT);
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });

    const revision = await marked();
    expect(revision).not.toBeNull();
    expect(await workspace().channelColorWork(message(revision!))).toEqual({ color: "red", substreamIds: ["0", BREAKOUT] });
    expect(await workspace().completeChannelColorSync(message(revision!))).toBe(true);
    expect(await marked()).toBeNull();
  });

  it("marks the Channel's threads when its colour changes, and not when only its name does", async () => {
    const launch = await reserve("Launch", "red");
    await project(1);
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });
    await settle();

    await recolorChannel(launch, "Launch week", "red");
    expect(await marked()).toBeNull();

    await runInDurableObject(workspace(), (_instance, state) => state.storage.deleteAlarm());
    await recolorChannel(launch, "Launch week", "green");
    // The write arms the alarm itself, so the lane claims the thread without
    // waiting on an unrelated wake.
    await vi.waitFor(async () => expect(await attempts()).toBeGreaterThan(0), { timeout: 10_000 });
    const revision = await marked();
    expect(revision).not.toBeNull();
    expect(await workspace().channelColorWork(message(revision!))).toEqual({ color: "green", substreamIds: ["0"] });
  });

  it("marks a thread when a Breakout first appears under it", async () => {
    const launch = await reserve("Launch", "red");
    await project(1);
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });
    await settle();

    await project(1, BREAKOUT);

    expect(await marked()).not.toBeNull();
  });

  it("leaves a newer mark for the message that carries it", async () => {
    const launch = await reserve("Launch", "red");
    await project(1);
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });
    const sent = (await marked())!;
    await recolorChannel(launch, "Launch", "green");

    expect(await workspace().channelColorWork(message(sent))).toBeNull();
    expect(await workspace().completeChannelColorSync(message(sent))).toBe(false);
    expect(await marked()).toBeGreaterThan(sent);
  });

  it("numbers a mark made after the last one settled above it, so a late completion cannot take it", async () => {
    const launch = await reserve("Launch", "red");
    await project(1);
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });
    const settledRevision = (await marked())!;
    await settle();

    await recolorChannel(launch, "Launch", "green");

    const fresh = (await marked())!;
    expect(fresh).toBeGreaterThan(settledRevision);
    // The finished job's own completion arriving late leaves the new mark alone.
    expect(await workspace().completeChannelColorSync(message(settledRevision))).toBe(false);
    expect(await marked()).toBe(fresh);
  });

  it("settles a thread with nothing to write: in no Channel, or archived", async () => {
    await project(1);
    const unplaced = (await marked())!;
    expect(await workspace().channelColorWork(message(unplaced))).toBeNull();
    expect(await marked()).toBeNull();

    const launch = await reserve("Launch", "red");
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });
    await project(2, undefined, "2026-10-12T01:00:00.000Z");
    const archived = (await marked())!;
    expect(await workspace().channelColorWork(message(archived))).toBeNull();
    expect(await marked()).toBeNull();

    // Restoring it marks it again, since its Channel may have changed meanwhile.
    await project(3);
    expect(await marked()).not.toBeNull();
  });

  it("writes the colour into Main when the Queue delivers the thread, and settles it", async () => {
    const launch = await reserve("Launch", "red");
    await project(1);
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });
    const main = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, THREAD, asSubstreamId("0")),
    ));
    await boot(main);
    await runInDurableObject(main, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: THREAD });
      state.storage.sql.exec(`UPDATE workstream SET appearance_json = '{"icon":"rocket","color":"green"}' WHERE id = 1`);
    });

    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: message((await marked())!),
    }]);
    await consumeActivityQueue(batch, env);
    await getQueueResult(batch, createExecutionContext());

    await runInDurableObject(main, (_instance, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ appearance_json: string }>(
        "SELECT appearance_json FROM workstream WHERE id = 1",
      ).one().appearance_json)).toEqual({ icon: "rocket", color: "red" });
    });
    expect(await marked()).toBeNull();
  }, 60_000);

  it("recolours Main and every open Breakout when the Channel's colour changes, keeping each icon", async () => {
    const launch = await reserve("Launch", "red");
    await project(1);
    await project(1, BREAKOUT);
    await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: launch, workstreamId: THREAD });
    await settle();
    const conversation = (substreamId: string) => env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, THREAD, asSubstreamId(substreamId)),
    ));
    const seeded = [{ substreamId: "0", icon: "rocket" }, { substreamId: BREAKOUT, icon: "flag" }];
    for (const { substreamId, icon } of seeded) {
      const stub = conversation(substreamId);
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: THREAD });
        state.storage.sql.exec("UPDATE workstream SET appearance_json = ? WHERE id = 1", JSON.stringify({ icon, color: "red" }));
        // The fixture seeds a main conversation; a Breakout's object names its own substream.
        state.storage.sql.exec("UPDATE substream_agent_identity SET external_substream_id = ? WHERE id = 1", substreamId);
      });
    }

    await recolorChannel(launch, "Launch", "purple");
    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: message((await marked())!),
    }]);
    await consumeActivityQueue(batch, env);
    await getQueueResult(batch, createExecutionContext());

    for (const { substreamId, icon } of seeded) {
      await runInDurableObject(conversation(substreamId), (_instance, state) => {
        expect(JSON.parse(state.storage.sql.exec<{ appearance_json: string }>(
          "SELECT appearance_json FROM workstream WHERE id = 1",
        ).one().appearance_json)).toEqual({ icon, color: "purple" });
      });
    }
    expect(await marked()).toBeNull();
  }, 60_000);

  it("keeps one batch in flight: later threads wait until the batch settles or is released", async () => {
    const [first, second, later] = ["e711", "e712", "e713"].map((suffix) => `00000000-0000-7000-8000-00000000${suffix}`);
    // Staged straight into the table: what is under test is the lane's pacing,
    // not which writes mark a thread (the cases above).
    // Rows staged together land in one object event: the object's alarm can
    // run the lane between two events and claim the first alone as its batch.
    const stage = (...workstreamIds: string[]) => runInDurableObject(workspace(), (_instance, state) => {
      for (const workstreamId of workstreamIds) {
        state.storage.sql.exec(
          "INSERT INTO channel_color_sync(workstream_id, revision, attempts, not_before) VALUES (?, 1, 0, 0)",
          workstreamId,
        );
      }
    });
    // The object's own alarm may run the lane too (settling arms it), so each
    // step asserts on what the rows say rather than on which run sent them.
    const publish = () => runInDurableObject(workspace(), async (_instance, state) => {
      const now = Date.now();
      await publishChannelColorSync({
        sql: state.storage.sql,
        queue: { sendBatch: async () => undefined },
        workspaceId: WORKSPACE_ID,
        region: "global",
        now,
        retryAt: () => now + 60_000,
      });
    });
    const claims = (workstreamId: string) => runInDurableObject(workspace(), (_instance, state) => state.storage.sql
      .exec<{ attempts: number }>("SELECT attempts FROM channel_color_sync WHERE workstream_id = ?", workstreamId)
      .toArray()[0]?.attempts ?? null);
    const settled = (workstreamId: string) => ({ ...message(1), workstreamId });
    await runInDurableObject(workspace(), (_instance, state) => { state.storage.sql.exec("DELETE FROM channel_color_sync"); });
    await stage(first!, second!);

    await publish();
    expect([await claims(first!), await claims(second!)]).toEqual([1, 1]);
    await stage(later!);
    await publish();
    expect(await claims(later!)).toBe(0);
    // The wake waits for the batch's gate, not for the waiting row that is due now.
    expect(await runInDurableObject(workspace(), (_instance, state) => nextChannelColorSyncAt(state.storage.sql)))
      .toBeGreaterThan(Date.now());

    expect(await workspace().completeChannelColorSync(settled(first!))).toBe(true);
    await publish();
    expect(await claims(later!)).toBe(0);
    expect(await workspace().releaseChannelColorSync(settled(second!))).toBe(true);
    await publish();
    expect(await claims(later!)).toBe(1);
  });
});
