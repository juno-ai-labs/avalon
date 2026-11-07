/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A pack becomes real history through Rally's own write paths.
 *
 * This drives the seeder against the real Canvas creation, the real Chat
 * object and its alarm-driven loop, the Terminal's real resource bridge, the
 * real upload, and the real Sidekick publication and run, and lets every
 * seeded run execute. The only external system replaced is OpenRouter, and it
 * is replaced twice over on purpose: the seed answers the run's provider
 * requests itself, and `useOpenRouterDouble` stands behind that as the
 * boundary nothing seeded may reach.
 *
 * What is asserted is what a presenter would find: the cast's lines in order,
 * Rally's scripted prose as an ordinary assistant turn, a real open question
 * at the end, an artifact at its second version attributed to Rally's run, the
 * document attached, the Canvas shared with whom the pack named — and a
 * Sidekick shared with the presenter whose run's row sits in its conversation
 * and whose Canvas it writes.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkstreamId } from "@rally/contracts";

import { AutomationService } from "../src/services/automation-service";
import { CanvasService } from "../src/services/canvas-service";
import {
  applyDemoSeedAction,
  demoSeedReceipts,
  type DemoSeedReceipt,
} from "../src/services/demo-seeder";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import {
  DEMO_BRIEFING_CANVAS,
  DEMO_BRIEFING_PROSE,
  DEMO_MARCUS_ID,
  DEMO_OPENING_PROSE,
  DEMO_OPERATION_ID,
  DEMO_PRESENTER_ID,
  DEMO_PRIYA_ID,
  DEMO_QUESTION,
  DEMO_SIDEKICK_NAME,
  DEMO_SIDEKICK_PACK,
  demoConversationStub,
  demoSeedEnv,
  demoWorkspaceStub,
  openDemoTestSession,
  playDemoAction,
  seedDemoWorkspaceControlPlane,
} from "./helpers/demo-workspace-fixture";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { useSidekickRunProvisionConsumer } from "./helpers/sidekick";

// The boundary nothing seeded may reach. A request that arrives here is an
// escape from the seam, refused so the run fails rather than pretending.
const provider = useOpenRouterDouble(() => ({
  httpError: { status: 503, body: { error: { message: "a seeded run reached the provider" } } },
}));
useSelectedModel();
useSidekickRunProvisionConsumer();

beforeEach(async () => {
  await reset();
  await seedDemoWorkspaceControlPlane();
}, 30_000);

describe("seeding a pack", () => {
  it("writes the Canvas, its Chat, its artifact's versions, the document and the question through production paths, reaching no provider", async () => {
    const seed = await openDemoTestSession();
    const receipts: DemoSeedReceipt[] = [];
    for (const action of seed.actions) receipts.push(await playDemoAction(seed, action));
    expect(provider.calls).toEqual([]);

    expect(receipts.map((receipt) => [receipt.kind, receipt.runOutcome])).toEqual([
      ["create_canvas", "completed"],
      ["canvas_artifact", null],
      ["canvas_artifact", null],
      ["upload", null],
      ["canvas_message", null],
      ["canvas_message", "needs_input"],
      ["create_canvas", "completed"],
    ]);
    const canvasId = receipts[0]!.canvasId!;
    expect(receipts.slice(0, 6).every((receipt) => receipt.canvasId === canvasId)).toBe(true);
    // Both versions are Rally's, in the run its opening started.
    expect(receipts[1]!.harnessRunId).toBe(receipts[0]!.harnessRunId);
    expect(receipts[2]!.resourceId).toBe(receipts[1]!.resourceId);
    expect(await demoSeedReceipts(env.DB, DEMO_OPERATION_ID)).toHaveLength(7);

    // Shared with Marcus, as the pack said, and not with the presenter.
    const priya = seed.auth.get(DEMO_PRIYA_ID)!;
    const detail = await new CanvasService(demoSeedEnv(), priya).detail(asWorkstreamId(canvasId));
    expect(detail).toMatchObject({
      title: "Insights pricing",
      createdByUserId: DEMO_PRIYA_ID,
      visibility: "participants",
      participantUserIds: [DEMO_MARCUS_ID],
      lastEditor: { kind: "rally", id: null },
      artifacts: [{ resourceId: receipts[1]!.resourceId, kind: "file", version: 2 }],
    });
    const presenterList = await new CanvasService(demoSeedEnv(), seed.auth.get(DEMO_PRESENTER_ID)!).list();
    expect(presenterList.map((row) => row.title)).toEqual(["Renewal plan"]);

    // Read as Marcus, who is in it.
    const chat = WorkstreamObjectClient.forParent(demoSeedEnv(), seed.auth.get(DEMO_MARCUS_ID)!, "canvas", canvasId, "0");
    const { workstream, transcript } = await chat.boot();
    expect(workstream.harnessStatus).toBe("needs_input");
    expect(workstream.openElicitations).toHaveLength(1);
    expect(workstream.openElicitations[0]).toMatchObject({ id: receipts[5]!.elicitationId, prompt: DEMO_QUESTION, status: "open" });
    expect(workstream.resources.map((resource) => resource.id)).toEqual(expect.arrayContaining([receipts[3]!.resourceId]));

    const canonical = await runInDurableObject(demoConversationStub(canvasId), (_instance, state) =>
      state.storage.sql.exec<{ role: string; author_user_id: string | null; content: string | null }>(
        `SELECT role, author_user_id, content FROM canonical_conversation_turn_details ORDER BY sequence_number`,
      ).toArray());
    expect(canonical.slice(0, 5).map((turn) => [turn.role, turn.author_user_id])).toEqual([
      ["user", DEMO_PRIYA_ID],
      ["assistant", null],
      ["user", DEMO_MARCUS_ID], // Attachment-only upload turn.
      ["user", DEMO_MARCUS_ID],
      ["user", DEMO_MARCUS_ID],
    ]);
    expect(canonical[1]?.content).toBe(DEMO_OPENING_PROSE);
    // The one tool call in seeded history is the real elicitation.
    const toolNames = transcript.ranges.flatMap((range) => range.turns)
      .flatMap((turn) => turn.blocks.flatMap((block) => block.type === "tool" ? [block.toolName] : []));
    expect(new Set(toolNames)).toEqual(new Set(["request_elicitation"]));
    // Two runs: the opening and the question; the line the pack marked as
    // starting none started none, in a Canvas with two people in it.
    const runs = await runInDurableObject(demoConversationStub(canvasId), (_instance, state) =>
      state.storage.sql.exec<{ origin: string; status: string }>(`SELECT origin, status FROM runs ORDER BY created_at`).toArray());
    expect(runs).toEqual([
      { origin: "demo_seed", status: "completed" },
      { origin: "demo_seed", status: "needs_input" },
    ]);
  }, 90_000);

  it("replays a confirmed or half-confirmed action without writing it twice", async () => {
    const seed = await openDemoTestSession();
    const [open, v1, , upload, marcus] = seed.actions;
    const opened = await playDemoAction(seed, open!);
    const published = await playDemoAction(seed, v1!);
    await playDemoAction(seed, seed.actions[2]!);
    const uploaded = await playDemoAction(seed, upload!);
    const said = await playDemoAction(seed, marcus!);

    // A recorded action is answered from its receipt: nothing touches the Canvas.
    expect(await applyDemoSeedAction(demoSeedEnv(), seed, open!)).toEqual({ state: "confirmed", receipt: opened });

    // Writes that landed without their receipts meet the production path's own
    // receipt for the same request and come back as what they already wrote.
    for (const action of [open!, v1!, upload!, marcus!]) {
      await env.DB.prepare(`DELETE FROM demo_seed_receipts WHERE operation_id = ? AND action_id = ?`)
        .bind(DEMO_OPERATION_ID, action.actionId).run();
    }
    const reopened = await applyDemoSeedAction(demoSeedEnv(), seed, open!);
    expect(reopened.state).toBe("run_pending");
    expect(reopened.state === "run_pending" && reopened.canvasId).toBe(opened.canvasId);
    // The opening's run already completed; record it as the seeder would.
    await playDemoAction(seed, open!);
    expect((await playDemoAction(seed, marcus!)).turnId).toBe(said.turnId);
    const replayedUpload = await playDemoAction(seed, upload!);
    expect(replayedUpload).toMatchObject({ turnId: uploaded.turnId, resourceId: uploaded.resourceId });
    // A republished first version is the publication it already was, not a third version.
    expect((await playDemoAction(seed, v1!)).resourceId).toBe(published.resourceId);
    const detail = await new CanvasService(demoSeedEnv(), seed.auth.get(DEMO_PRIYA_ID)!).detail(asWorkstreamId(opened.canvasId!));
    expect(detail.artifacts).toMatchObject([{ resourceId: published.resourceId }]);

    const { transcript } = await WorkstreamObjectClient.forParent(demoSeedEnv(), seed.auth.get(DEMO_MARCUS_ID)!,
      "canvas", opened.canvasId!, "0").boot();
    const humans = transcript.ranges.flatMap((range) => range.turns)
      .filter((turn) => turn.entryKind === "conversation" && turn.actor === "human");
    expect(humans).toHaveLength(3);
    expect(provider.calls).toEqual([]);
  }, 90_000);

  it("publishes a Sidekick shared with the presenter, with one run, the Canvas it wrote, and a line in its conversation", async () => {
    const seed = await openDemoTestSession(DEMO_SIDEKICK_PACK);
    const receipts: DemoSeedReceipt[] = [];
    for (const action of seed.actions) receipts.push(await playDemoAction(seed, action));
    const [published, reply] = receipts.slice(-2);
    expect(published).toMatchObject({ kind: "sidekick", sidekick: "briefing", canvas: null, runOutcome: "completed" });
    expect(reply).toMatchObject({ kind: "sidekick_message", sidekickId: published!.sidekickId });

    // Published, its schedule armed in the zone the pack named, and shared
    // with the presenter alone besides its author.
    const author = new AutomationService(demoSeedEnv(), seed.auth.get(DEMO_PRIYA_ID)!);
    const detail = await author.detail(published!.sidekickId!);
    expect(detail).toMatchObject({ name: DEMO_SIDEKICK_NAME, lifecycle: "active", audience: "people", sharedWithUserIds: [DEMO_PRESENTER_ID] });
    expect(detail.nextRunAt).not.toBeNull();
    expect(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(detail.nextRunAt!))).toBe("09:00");

    // The run is an ordinary run of the Sidekick, answered from the pack.
    const turns = await runInDurableObject(demoConversationStub(published!.sidekickId!, published!.sidekickRunId!),
      (_instance, state) => state.storage.sql.exec<{ role: string; content: string | null }>(
        `SELECT role, content FROM canonical_conversation_turn_details ORDER BY sequence_number`,
      ).toArray());
    expect(turns.filter((turn) => turn.role === "assistant").map((turn) => turn.content)).toEqual([DEMO_BRIEFING_PROSE]);

    // The Canvas the run wrote: made by the run's principal, written by the
    // Sidekick, its artifact attributed to the run, and open to the presenter
    // because the Sidekick is.
    const presenter = new CanvasService(demoSeedEnv(), seed.auth.get(DEMO_PRESENTER_ID)!);
    const canvas = await presenter.detail(asWorkstreamId(published!.canvasId!));
    expect(canvas).toMatchObject({
      title: DEMO_BRIEFING_CANVAS, createdByUserId: DEMO_PRIYA_ID, writerSidekickId: published!.sidekickId,
      lastEditor: { kind: "sidekick", id: published!.sidekickId },
      artifacts: [{ resourceId: published!.resourceId, version: 1 }],
    });
    const authorship = await runInDurableObject(demoWorkspaceStub(), (_instance, state) =>
      state.storage.sql.exec<{ version: number; author_kind: string; author_run_id: string | null }>(
        `SELECT version, author_kind, author_run_id FROM resource_versions WHERE resource_id = ?`, published!.resourceId,
      ).toArray());
    expect(authorship).toEqual([{ version: 1, author_kind: "agent", author_run_id: published!.harnessRunId }]);
    expect((await author.detail(published!.sidekickId!)).canvases).toMatchObject([{ id: published!.canvasId }]);

    // Priya's line sits in the shared conversation and started no run.
    const shared = await runInDurableObject(demoConversationStub(published!.sidekickId!), (_instance, state) =>
      state.storage.sql.exec<{ role: string; author_user_id: string | null; content: string | null }>(
        `SELECT role, author_user_id, content FROM canonical_conversation_turn_details WHERE role = 'user' ORDER BY sequence_number`,
      ).toArray());
    expect(shared).toEqual([{ role: "user", author_user_id: DEMO_PRIYA_ID, content: "Member, Northgate is yours." }]);
    expect(provider.calls).toEqual([]);
  }, 120_000);
});
