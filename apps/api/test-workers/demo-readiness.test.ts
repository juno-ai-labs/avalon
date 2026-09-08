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
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { ParentEffectEnvelope } from "@rally/contracts/conversation-effects";

import { demoReadinessManifest, checkDemoReadiness } from "../src/services/demo-readiness";
import { demoSeedReceipts } from "../src/services/demo-seeder";
import {
  consumeEffectBodies,
  deliverChildEffects,
  parentStubFor,
  pendingParentEffects,
} from "./helpers/conversation-effects";
import {
  DEMO_OPERATION_ID,
  DEMO_TWO_ROOM_PACK,
  DEMO_WORKSPACE_ID,
  demoRoomStub,
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
  for (const envelope of directory) {
    const result = await consumeEffectBodies(env, [envelope]);
    if (result.retried > 0) throw new Error(`directory effect retried: ${envelope.effect.kind} ${envelope.messageId}`);
  }
  return directory.length;
}

describe("the readiness barrier", () => {
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
});
