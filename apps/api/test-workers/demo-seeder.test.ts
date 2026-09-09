/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A pack becomes real history through Rally's own write paths.
 *
 * This drives the seeder against the real creation service, the real room
 * object and its real alarm-driven loop, and the real resource upload, and
 * lets every seeded run execute. The only external system replaced is
 * OpenRouter, and it is replaced twice over on purpose: the seed answers the
 * run's provider requests itself, and `useOpenRouterDouble` stands behind that
 * as the boundary nothing seeded may reach. A seeded run that gets as far as
 * the double has escaped the seam, and the double refuses it so the escape
 * shows up as a failed run *and* a recorded call.
 *
 * What is asserted is what a presenter would find: the cast's lines in order,
 * Rally's scripted prose as an ordinary assistant turn, a real open question at
 * the end, the mentioned presenter seated, the document attached — and no run
 * where the pack said no run, no tool call anywhere, and a receipt per action.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyDemoSeedAction,
  demoSeedReceipts,
  type DemoSeedReceipt,
  type DemoSeedSession,
} from "../src/services/demo-seeder";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import {
  DEMO_MARCUS_ID,
  DEMO_MEMO_TITLE,
  DEMO_OPENING_PROSE,
  DEMO_OPERATION_ID,
  DEMO_PRESENTER_ID,
  DEMO_PRIYA_ID,
  DEMO_QUESTION,
  demoRoomStub,
  demoSeedEnv,
  openDemoTestSession,
  playDemoAction,
  seedDemoWorkspaceControlPlane,
} from "./helpers/demo-workspace-fixture";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";

// The boundary nothing seeded may reach. A request that arrives here is an
// escape from the seam, refused so the run fails rather than pretending.
const provider = useOpenRouterDouble(() => ({
  httpError: { status: 503, body: { error: { message: "a seeded run reached the provider" } } },
}));
useSelectedModel();

beforeEach(async () => {
  await reset();
  await seedDemoWorkspaceControlPlane();
}, 30_000);

function roomClient(seed: DemoSeedSession, workstreamId: string, asUser: string): WorkstreamObjectClient {
  return new WorkstreamObjectClient(demoSeedEnv(), seed.auth.get(asUser)!, workstreamId, "0");
}

describe("seeding a pack", () => {
  it("writes the conversation, the prose, the document and the question through production paths, reaching no provider", async () => {
    const seed = await openDemoTestSession();
    const receipts: DemoSeedReceipt[] = [];
    for (const action of seed.actions) receipts.push(await playDemoAction(seed, action));

    // Nothing seeded reached the provider boundary.
    expect(provider.calls).toEqual([]);

    expect(receipts.map((receipt) => [receipt.kind, receipt.runOutcome])).toEqual([
      ["create_workstream", "completed"],
      ["upload", null],
      ["message", null],
      ["message", null],
      ["message", "needs_input"],
    ]);
    const workstreamId = receipts[0]!.workstreamId;
    expect(receipts.every((receipt) => receipt.workstreamId === workstreamId)).toBe(true);
    expect(receipts[1]!.resourceId).not.toBeNull();
    expect(receipts[4]!.elicitationId).not.toBeNull();
    expect(await demoSeedReceipts(env.DB, DEMO_OPERATION_ID)).toHaveLength(5);

    // Read as Marcus — a participant, not the presenter whose unopened state
    // the pack preserves.
    const { workstream, transcript } = await roomClient(seed, workstreamId, DEMO_MARCUS_ID).boot();
    expect(workstream.harnessStatus).toBe("needs_input");
    // A real elicitation, addressed to the room.
    expect(workstream.openElicitations).toHaveLength(1);
    expect(workstream.openElicitations[0]).toMatchObject({
      id: receipts[4]!.elicitationId,
      prompt: DEMO_QUESTION,
      responseType: "radio",
      targetUserId: null,
      status: "open",
    });
    // The confirmed mention seated the presenter; the upload is attached.
    expect(workstream.participants.map((participant) => participant.user.id)).toEqual(
      expect.arrayContaining([DEMO_PRIYA_ID, DEMO_MARCUS_ID, DEMO_PRESENTER_ID]),
    );
    expect(workstream.resources.map((resource) => resource.title)).toEqual([DEMO_MEMO_TITLE]);

    // The canonical transcript, from the object's own authority rather than
    // from the opening snapshot's viewer-relative windows.
    const canonical = await runInDurableObject(demoRoomStub(workstreamId), (_instance, state) =>
      state.storage.sql.exec<{ sequence_number: number; role: string; author_user_id: string | null; content: string | null }>(
        `SELECT sequence_number, role, author_user_id, content
           FROM canonical_conversation_turn_details ORDER BY sequence_number`,
      ).toArray());
    expect(canonical.slice(0, 5).map((turn) => [turn.role, turn.author_user_id])).toEqual([
      ["user", DEMO_PRIYA_ID],
      ["assistant", null],
      ["user", DEMO_MARCUS_ID],
      ["user", DEMO_PRIYA_ID],
      ["user", DEMO_MARCUS_ID],
    ]);
    // Rally's prose is the ordinary assistant turn an ordinary run reserved.
    expect(canonical[1]?.content).toBe(DEMO_OPENING_PROSE);
    // The mention was rewritten to its durable form by the object, not by the pack.
    expect(canonical[3]?.content).toContain("[@Member](person://");
    // Whatever follows the question is the question's own run: nothing human.
    expect(canonical.slice(5).every((turn) => turn.role === "assistant")).toBe(true);
    // The one tool call in seeded history is the real elicitation; no
    // connector call, recorded or replayed, appears anywhere.
    const toolNames = transcript.ranges.flatMap((range) => range.turns)
      .flatMap((turn) => turn.blocks.flatMap((block) => block.type === "tool" ? [block.toolName] : []));
    expect(new Set(toolNames)).toEqual(new Set(["core_request_elicitation"]));

    // Two runs: the opening and the question. The two lines the pack marked as
    // starting none started none, in a room with three people in it — which
    // is exactly the room where admission would otherwise have asked a model.
    const runs = await runInDurableObject(demoRoomStub(workstreamId), (_instance, state) =>
      state.storage.sql.exec<{ origin: string; status: string }>(
        `SELECT origin, status FROM runs ORDER BY created_at`,
      ).toArray());
    expect(runs).toEqual([
      { origin: "demo_seed", status: "completed" },
      { origin: "demo_seed", status: "needs_input" },
    ]);
  }, 60_000);

  it("replays a confirmed or half-confirmed action without writing it twice", async () => {
    const seed = await openDemoTestSession();
    const [open, upload, marcus] = seed.actions;
    const opened = await playDemoAction(seed, open!);
    await playDemoAction(seed, upload!);
    const said = await playDemoAction(seed, marcus!);

    // A recorded action is answered from its receipt: nothing touches the room.
    expect(await applyDemoSeedAction(demoSeedEnv(), seed, open!)).toEqual({ state: "confirmed", receipt: opened });

    // An action whose write landed but whose receipt did not — the crash
    // between the two — meets the room's own admission receipt for the same
    // client message id and comes back as the turn it already wrote.
    await env.DB.prepare(`DELETE FROM demo_seed_receipts WHERE operation_id = ? AND action_id = ?`)
      .bind(DEMO_OPERATION_ID, marcus!.actionId).run();
    const replayed = await playDemoAction(seed, marcus!);
    expect(replayed.turnId).toBe(said.turnId);

    const { transcript } = await roomClient(seed, opened.workstreamId, DEMO_MARCUS_ID).boot();
    const humans = transcript.ranges.flatMap((range) => range.turns)
      .filter((turn) => turn.entryKind === "conversation" && turn.actor === "human");
    expect(humans).toHaveLength(2);
    expect(provider.calls).toEqual([]);
  }, 60_000);
});
