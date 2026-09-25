/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Ready is the presenter's projection matching the pack, not the seeder
 * finishing.
 *
 * The seeder writes through the room objects; what the presenter sees arrives
 * later, through the effect Queue, and this file holds that Queue so the two
 * moments can be told apart. Seeding completes with every room's provisional
 * directory row in place — the room *exists* to the presenter — but the mention,
 * the "new" marker, the open question's state and the home screen's count have
 * not arrived, and the barrier says so by name. Delivering the effects through
 * the real consumer is what makes it Ready, and nothing else does: a fixed wait,
 * an empty outbox, or a first-page count would all have said yes too early.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkstreamId } from "@rally/contracts";
import { DemoPackSchema, PLACEHOLDER_DEMO_PACK } from "../src/services/demo-pack";
import { SpaceService } from "../src/services/space-service";

import type { ParentEffectEnvelope } from "@rally/contracts/conversation-effects";

import { demoReadinessManifest, checkDemoReadiness } from "../src/services/demo-readiness";
import { demoSeedReceipts, demoSeedSpaceId, openDemoSeedSession } from "../src/services/demo-seeder";
import {
  consumeEffectBodies,
  deliverChildEffects,
  parentStubFor,
  pendingParentEffects,
} from "./helpers/conversation-effects";
import {
  DEMO_OPERATION_ID,
  DEMO_PRESENTER_ID,
  DEMO_PRIYA_ID,
  DEMO_MARCUS_ID,
  DEMO_SIDEKICK_PACK,
  DEMO_TWO_ROOM_PACK,
  DEMO_WORKSPACE_ID,
  demoRoomStub,
  demoRunStub,
  demoSeedEnv,
  openDemoTestSession,
  playDemoAction,
  seedDemoWorkspaceControlPlane,
} from "./helpers/demo-workspace-fixture";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";

useOpenRouterDouble(() => ({
  httpError: { status: 503, body: { error: { message: "a seeded run reached the provider" } } },
}));
useSelectedModel();
useHeldEffectQueue();

beforeEach(async () => {
  await reset();
  await seedDemoWorkspaceControlPlane();
}, 30_000);

function directoryRank(kind: ParentEffectEnvelope["effect"]["kind"]): number {
  return kind === "directory_common" ? 0 : 1;
}

/**
 * The child's effects to its parent, then the parent's *directory* effects to
 * the workspace, through the real consumer in the parent's own order.
 *
 * Only the directory kinds. The parent also queues the presenter's mention
 * notification, and the consumer for that reads identity rows and reaches
 * Slack or email — neither of which this Worker has, so it would ask for a
 * retry forever. Readiness never reads a notification; it reads the projection
 * the notification rides beside, and that is what is delivered here. The
 * notification rows stay pending, exactly as an outage would leave them.
 */
async function deliverDirectoryEffects(workstreamId: string): Promise<number> {
  await deliverChildEffects(env, demoRoomStub(workstreamId));
  const parent = parentStubFor(env, "global", {
    workspaceId: DEMO_WORKSPACE_ID,
    parentKind: "workstream",
    parentId: workstreamId,
  });
  const directory = (await pendingParentEffects(parent))
    .filter((envelope) => envelope.effect.kind.startsWith("directory_"))
    .sort((left, right) => directoryRank(left.effect.kind) - directoryRank(right.effect.kind));
  const dbg = await runInDurableObject(parent, async (instance, state) => {
    const rows = state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM parent_outbox WHERE effect_kind LIKE 'directory%'").toArray();
    const envelopes = rows.map((row) => JSON.parse(row.payload_json));
    try {
      const r = await (instance as any).applyWorkstreamDirectoryEffects({ workspaceId: DEMO_WORKSPACE_ID, envelopes });
      return { ok: r, envelopes };
    } catch (error) { return { error: String(error), stack: (error as Error).stack, envelopes }; }
  });
  expect(dbg).toEqual(["DEBUGDIR"]);
  for (const envelope of directory) {
    const result = await consumeEffectBodies(env, [envelope]);
    if (result.retried > 0) throw new Error(`directory effect retried: ${envelope.effect.kind} ${envelope.messageId}`);
  }
  return directory.length;
}

describe("the readiness barrier", () => {
  it("plays the shipped pack and rejects wrong Space placement and state until repaired", async () => {
    const danaId = asUserId("00000000-0000-7000-8000-00000000d5a7");
    await env.DB.prepare(`INSERT INTO users (id, email, name, timezone, created_at)
      VALUES (?, 'dana@example.com', 'Dana Park', 'UTC', '2026-01-01T00:00:00.000Z')`).bind(danaId).run();
    await env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role)
      VALUES (?, ?, 'active', 'member')`).bind(DEMO_WORKSPACE_ID, danaId).run();
    const pack = DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK);
    const seed = await openDemoSeedSession(demoSeedEnv(), {
      operationId: DEMO_OPERATION_ID, workspaceId: DEMO_WORKSPACE_ID, pack,
      roles: { presenter: DEMO_PRESENTER_ID, priya: DEMO_PRIYA_ID, marcus: DEMO_MARCUS_ID, dana: danaId },
    });
    for (const action of seed.actions) await playDemoAction(seed, action);
    const receipts = await demoSeedReceipts(env.DB, DEMO_OPERATION_ID);
    expect(receipts).toHaveLength(pack.steps.length);
    const manifest = demoReadinessManifest(pack, seed.cast, receipts);
    for (const receipt of receipts.filter((item) => item.kind === "create_substream")) {
      await deliverChildEffects(env, demoRoomStub(receipt.workstreamId!, receipt.substreamId!));
    }
    for (const room of manifest.views[0]!.rooms) await deliverDirectoryEffects(room.workstreamId);
    const published = receipts.find((receipt) => receipt.kind === "sidekick")!;
    await deliverChildEffects(env, demoRunStub(published.sidekickId!, published.sidekickRunId!));
    const sidekick = parentStubFor(env, "global", {
      workspaceId: DEMO_WORKSPACE_ID, parentKind: "automation", parentId: published.sidekickId!,
    });
    for (const envelope of await pendingParentEffects(sidekick)) {
      if (envelope.effect.kind.startsWith("directory_")) {
        expect((await consumeEffectBodies(env, [envelope])).retried).toBe(0);
      }
    }
    const check = () => checkDemoReadiness(demoSeedEnv(), {
      operationId: DEMO_OPERATION_ID, workspaceId: DEMO_WORKSPACE_ID, manifest,
    });
    expect((await check()).gaps).toEqual([]);
    const service = new SpaceService(demoSeedEnv(), seed.auth.get(DEMO_MARCUS_ID)!);
    const acmeId = await demoSeedSpaceId(DEMO_OPERATION_ID, "acme");
    const proposalId = asWorkstreamId(receipts.find((receipt) => receipt.actionId === "proposal-open")!.workstreamId!);
    const general = await service.ensureGeneral();
    await service.addChannel(general.id, proposalId);
    await service.removeChannel(acmeId, proposalId);
    expect((await check()).gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ room: "acme-proposal", code: "space_membership" }),
    ]));
    await service.addChannel(acmeId, proposalId);
    await service.removeChannel(general.id, proposalId);
    await service.updatePresentation(acmeId, { name: "Wrong account", iconKey: "handshake", colorKey: "blue" });
    expect((await check()).gaps.filter((gap) => gap.code === "space_state").map((gap) => gap.room).sort())
      .toEqual(["acme-proposal", "acme-review"]);
    await service.updatePresentation(acmeId, { name: "Customer: Acme", iconKey: "handshake", colorKey: "blue" });
    expect(await check()).toMatchObject({ ready: true, gaps: [] });
  }, 90_000);

  it("waits for the presenter's projection and is Ready only once the effects have landed", async () => {
    const seed = await openDemoTestSession(DEMO_TWO_ROOM_PACK);
    for (const action of seed.actions) await playDemoAction(seed, action);
    const manifest = demoReadinessManifest(
      DEMO_TWO_ROOM_PACK,
      seed.cast,
      await demoSeedReceipts(env.DB, DEMO_OPERATION_ID),
    );
    // Newest first: the memo room's last step comes after the aside's only step.
    expect(manifest.views[0]!.rooms.map((expected) => expected.room)).toEqual(["memo", "aside"]);
    const [room, aside] = manifest.views[0]!.rooms;

    // Seeding is done and the room is listed — its provisional row arrived
    // through the creation service's own RPC — but nothing that rides the
    // Queue has: the presenter is not yet mentioned, the room is not yet new to
    // them, the question has not parked it, and the home screen counts nothing.
    const before = await checkDemoReadiness(demoSeedEnv(), { operationId: DEMO_OPERATION_ID, workspaceId: DEMO_WORKSPACE_ID, manifest });
    expect(before.ready).toBe(false);
    expect(before.gaps.map((gap) => gap.code)).not.toContain("room_missing");
    expect(before.gaps.map((gap) => [gap.room, gap.code])).toEqual(expect.arrayContaining([
      [room!.room, "mentioned"],
      [room!.room, "unseen"],
      [null, "attention"],
    ]));

    // Both legs, through the real consumer. The projection is what was held.
    expect(await deliverDirectoryEffects(room!.workstreamId)).toBeGreaterThan(0);
    expect(await deliverDirectoryEffects(aside!.workstreamId)).toBeGreaterThan(0);

    const after = await checkDemoReadiness(demoSeedEnv(), { operationId: DEMO_OPERATION_ID, workspaceId: DEMO_WORKSPACE_ID, manifest });
    expect(after.gaps).toEqual([]);
    expect(after.ready).toBe(true);
  }, 60_000);

  it("waits for a seeded Sidekick to reach the presenter's library and its briefing to reach its history", async () => {
    const seed = await openDemoTestSession(DEMO_SIDEKICK_PACK);
    for (const action of seed.actions) await playDemoAction(seed, action);
    const receipts = await demoSeedReceipts(env.DB, DEMO_OPERATION_ID);
    const manifest = demoReadinessManifest(DEMO_SIDEKICK_PACK, seed.cast, receipts);
    const published = receipts.find((receipt) => receipt.kind === "sidekick")!;
    // The presenter is neither its author nor in any room with it; it is on
    // their list because it is the workspace's.
    expect(manifest.views[0]!.sidekicks.map((sidekick) => [sidekick.name, sidekick.scope])).toEqual([
      ["Morning briefing", "workspace"],
    ]);

    // Publication and the briefing are both done, and neither has reached the
    // presenter: a Sidekick's directory row rides the same Queue a room's does.
    const before = await checkDemoReadiness(demoSeedEnv(), { operationId: DEMO_OPERATION_ID, workspaceId: DEMO_WORKSPACE_ID, manifest });
    expect(before.ready).toBe(false);
    expect(before.gaps.map((gap) => gap.code)).toContain("sidekick_missing");

    // The run's own conversation reports up to the Sidekick, and the Sidekick
    // to the workspace — the same two legs a room's projection travels.
    await deliverChildEffects(env, demoRunStub(published.sidekickId!, published.sidekickRunId!));
    const sidekick = parentStubFor(env, "global", {
      workspaceId: DEMO_WORKSPACE_ID,
      parentKind: "automation",
      parentId: published.sidekickId!,
    });
    for (const envelope of await pendingParentEffects(sidekick)) {
      if (!envelope.effect.kind.startsWith("directory_")) continue;
      const result = await consumeEffectBodies(env, [envelope]);
      if (result.retried > 0) throw new Error(`sidekick effect retried: ${envelope.effect.kind}`);
    }
    for (const room of manifest.views[0]!.rooms) await deliverDirectoryEffects(room.workstreamId);

    const after = await checkDemoReadiness(demoSeedEnv(), { operationId: DEMO_OPERATION_ID, workspaceId: DEMO_WORKSPACE_ID, manifest });
    expect(after.gaps).toEqual([]);
    expect(after.ready).toBe(true);
  }, 90_000);
});
