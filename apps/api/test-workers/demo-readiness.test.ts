/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Ready is every verified viewer's lists and every seeded Canvas and Sidekick
 * matching the pack, not the seeder finishing.
 *
 * The seeder writes through the conversation objects; what the presenter sees
 * of a Sidekick's run — its state in the run history, and its row in the
 * shared conversation — arrives later, when the run's conversation reports up
 * through the effect Queue and the Organization object projects the run. This
 * file holds that Queue so the two moments can be told apart: seeding is done
 * and every Canvas is listed, but the run has not landed, and the barrier says
 * so by name. Delivering the effects through the real consumer is what makes
 * it Ready, and nothing else does.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { checkDemoReadiness, demoReadinessManifest } from "../src/services/demo-readiness";
import { demoSeedReceipts } from "../src/services/demo-seeder";
import { deliverChildEffects } from "./helpers/conversation-effects";
import {
  DEMO_OPERATION_ID,
  DEMO_SIDEKICK_PACK,
  DEMO_TEST_PACK,
  DEMO_WORKSPACE_ID,
  demoConversationStub,
  demoSeedEnv,
  demoWorkspaceStub,
  openDemoTestSession,
  playDemoAction,
  seedDemoWorkspaceControlPlane,
} from "./helpers/demo-workspace-fixture";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useSidekickRunProvisionConsumer } from "./helpers/sidekick";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";

useOpenRouterDouble(() => ({
  httpError: { status: 503, body: { error: { message: "a seeded run reached the provider" } } },
}));
useSelectedModel();
useHeldEffectQueue();
useSidekickRunProvisionConsumer();

beforeEach(async () => {
  await reset();
  await seedDemoWorkspaceControlPlane();
}, 30_000);

const check = (manifest: ReturnType<typeof demoReadinessManifest>) =>
  checkDemoReadiness(demoSeedEnv(), { operationId: DEMO_OPERATION_ID, workspaceId: DEMO_WORKSPACE_ID, manifest });

/** Every seeded conversation's held effects, through the real consumer. */
async function deliverEverything(receipts: Awaited<ReturnType<typeof demoSeedReceipts>>): Promise<void> {
  for (const canvasId of new Set(receipts.flatMap((receipt) => receipt.canvas ? [receipt.canvasId!] : []))) {
    await deliverChildEffects(env, demoConversationStub(canvasId));
  }
  for (const receipt of receipts.filter((row) => row.kind === "sidekick")) {
    if (receipt.sidekickRunId) await deliverChildEffects(env, demoConversationStub(receipt.sidekickId!, receipt.sidekickRunId));
    await deliverChildEffects(env, demoConversationStub(receipt.sidekickId!));
  }
  // The run row's projection into the shared conversation is the
  // Organization object's alarm.
  await runDurableObjectAlarm(demoWorkspaceStub());
}

describe("the readiness barrier", () => {
  it("lists the presenter's Canvases as the pack says and names one it should not see, or an artifact a version behind", async () => {
    const seed = await openDemoTestSession(DEMO_TEST_PACK);
    for (const action of seed.actions) await playDemoAction(seed, action);
    const receipts = await demoSeedReceipts(env.DB, DEMO_OPERATION_ID);
    const manifest = demoReadinessManifest(DEMO_TEST_PACK, seed.cast, receipts);
    // The presenter is offered the Organization's Canvas and not the private one.
    expect(manifest.views[0]!.canvases.map((canvas) => [canvas.canvas, canvas.unread])).toEqual([["plan", true]]);
    await deliverEverything(receipts);
    expect((await check(manifest)).gaps).toEqual([]);

    // A Canvas shared with the presenter that the pack never shared with them
    // is a listing the barrier names, as is an artifact short of a version.
    const memo = manifest.canvases.find((canvas) => canvas.canvas === "memo")!;
    await runInDurableObject(demoWorkspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'workspace' WHERE canvas_id = ?`, memo.canvasId);
    });
    const wrong = await check({ ...manifest, canvases: manifest.canvases.map((canvas) => canvas === memo
      ? { ...canvas, artifacts: canvas.artifacts.map((artifact) => ({ ...artifact, version: 3 })) }
      : canvas) });
    expect(wrong.ready).toBe(false);
    expect(wrong.gaps.map((gap) => [gap.room, gap.code])).toEqual(expect.arrayContaining([
      [null, "canvas_unexpected"],
      ["memo", "artifact_version"],
    ]));
  }, 120_000);

  it("waits for a seeded Sidekick's run to reach its history and its row to reach its conversation", async () => {
    const seed = await openDemoTestSession(DEMO_SIDEKICK_PACK);
    for (const action of seed.actions) await playDemoAction(seed, action);
    const receipts = await demoSeedReceipts(env.DB, DEMO_OPERATION_ID);
    const manifest = demoReadinessManifest(DEMO_SIDEKICK_PACK, seed.cast, receipts);
    // Shared with the presenter, so it and its Canvas are on their lists.
    expect(manifest.views[0]!.sidekicks.map((sidekick) => [sidekick.name, sidekick.audience])).toEqual([["Morning briefing", "people"]]);
    expect(manifest.views[0]!.canvases.map((canvas) => canvas.canvas)).toEqual(["briefing", "plan"]);

    // Seeding is done and the Sidekick is listed, but its run's report has not
    // crossed the Queue.
    const before = await check(manifest);
    expect(before.ready).toBe(false);
    const codes = before.gaps.map((gap) => gap.code);
    expect(codes).not.toContain("sidekick_missing");
    expect(codes).not.toContain("canvas_missing");
    expect(codes).toContain("sidekick_run_state");

    await deliverEverything(receipts);
    const after = await check(manifest);
    expect(after.gaps).toEqual([]);
    expect(after.ready).toBe(true);
  }, 120_000);
});
