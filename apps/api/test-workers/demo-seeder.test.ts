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
  demoSeedSpaceId,
  type DemoSeedReceipt,
  type DemoSeedSession,
} from "../src/services/demo-seeder";
import { asUserId, asWorkstreamId } from "@rally/contracts";
import { workspaceDOName } from "../src/durable-objects/names";
import { DemoPackSchema } from "../src/services/demo-pack";
import { SpaceService } from "../src/services/space-service";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { AutomationService } from "../src/services/automation-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import {
  DEMO_BRIEFING_PROSE,
  DEMO_CHILD_PROSE,
  DEMO_MARCUS_ID,
  DEMO_MEMO_TITLE,
  DEMO_OPENING_PROSE,
  DEMO_OPERATION_ID,
  DEMO_WORKSPACE_ID,
  DEMO_PRESENTER_ID,
  DEMO_PRIYA_ID,
  DEMO_QUESTION,
  DEMO_SIDEKICK_NAME,
  DEMO_SIDEKICK_PACK,
  DEMO_STARTING_CONTEXT,
  DEMO_SUBSTREAM_PACK,
  demoRoomStub,
  demoRunStub,
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

function roomClient(
  seed: DemoSeedSession,
  workstreamId: string,
  asUser: string,
  substreamId = "0",
): WorkstreamObjectClient {
  return new WorkstreamObjectClient(demoSeedEnv(), seed.auth.get(asUser)!, workstreamId, substreamId);
}

describe("seeding a pack", () => {
  it("places prepared and scripted Channels in one replayable named Space", async () => {
    const pack = DemoPackSchema.parse({
      version: "spaces-test", roles: ["presenter", "priya", "marcus"],
      roleLabels: { priya: "Engineer", marcus: "Sales" },
      spaces: { account: { as: "priya", name: "Customer: Acme", iconKey: "handshake", colorKey: "blue" } },
      steps: [
        { kind: "create_workstream", id: "first", room: "first", as: "priya", title: "Proposal",
          space: "account", execution: "history", scope: "workspace", participants: ["marcus"],
          openingMessage: "Prior work.", assistant: { kind: "say", text: "Prior answer." } },
        { kind: "create_workstream", id: "second", room: "second", as: "marcus", title: "Review",
          space: "account", scope: "workspace", participants: [],
          openingMessage: "Review this.", assistant: { kind: "say", text: "Review complete." } },
      ],
    });
    const seed = await openDemoTestSession(pack);
    const first = await playDemoAction(seed, seed.actions[0]!);
    // The creation write survived, the orchestration receipt did not.
    await env.DB.prepare("DELETE FROM demo_seed_receipts WHERE operation_id = ? AND action_id = ?")
      .bind(DEMO_OPERATION_ID, "first").run();
    const replay = await playDemoAction(seed, seed.actions[0]!);
    expect(replay.workstreamId).toBe(first.workstreamId);
    const second = await playDemoAction(seed, seed.actions[1]!);
    const id = await demoSeedSpaceId(DEMO_OPERATION_ID, "account");
    const service = new SpaceService(demoSeedEnv(), seed.auth.get(DEMO_PRIYA_ID)!);
    expect(await service.summary(id)).toMatchObject({ name: "Customer: Acme", scope: "workspace", channelCount: 2 });
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName("global", DEMO_WORKSPACE_ID));
    for (const workstreamId of [first.workstreamId!, second.workstreamId!]) {
      expect(await workspace.channelSpaces({ workspaceId: DEMO_WORKSPACE_ID,
        userId: asUserId(DEMO_PRESENTER_ID), workstreamId: asWorkstreamId(workstreamId) }))
        .toEqual({ spaceIds: [id] });
    }
    expect(await runInDurableObject(workspace, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM workspace_space_directory WHERE title = ?", "Customer: Acme").one().count))
      .toBe(1);
    expect(provider.calls).toEqual([]);
  });

  it("names a malformed participant field across the product RPC without disclosing its value", async () => {
    const seed = await openDemoTestSession();
    const opened = await playDemoAction(seed, seed.actions[0]!);
    await env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?")
      .bind("private-rejected-value", DEMO_PRIYA_ID).run();
    await expect(roomClient(seed, opened.workstreamId!, DEMO_MARCUS_ID).get()).rejects.toMatchObject({
      code: expect.stringMatching(/^workstream_product_invalid:participants\.[0-9]+\.user.createdAt:invalid_format/u),
      message: "The work stream could not be loaded",
    });
  });

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
    const workstreamId = receipts[0]!.workstreamId!;
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
    expect(canonical.slice(0, 6).map((turn) => [turn.role, turn.author_user_id])).toEqual([
      ["user", DEMO_PRIYA_ID],
      ["assistant", null],
      ["user", DEMO_PRIYA_ID], // Attachment-only upload turn.
      ["user", DEMO_MARCUS_ID],
      ["user", DEMO_PRIYA_ID],
      ["user", DEMO_MARCUS_ID],
    ]);
    // Rally's prose is the ordinary assistant turn an ordinary run reserved.
    expect(canonical[1]?.content).toBe(DEMO_OPENING_PROSE);
    // The mention was rewritten to its durable form by the object, not by the pack.
    expect(canonical[4]?.content).toContain("[@Member](person://");
    // Whatever follows the question is the question's own run: nothing human.
    expect(canonical.slice(6).every((turn) => turn.role === "assistant")).toBe(true);
    // The one tool call in seeded history is the real elicitation; no
    // connector call, recorded or replayed, appears anywhere.
    const toolNames = transcript.ranges.flatMap((range) => range.turns)
      .flatMap((turn) => turn.blocks.flatMap((block) => block.type === "tool" ? [block.toolName] : []));
    expect(new Set(toolNames)).toEqual(new Set(["request_elicitation"]));

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
    const uploaded = await playDemoAction(seed, upload!);
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

    // A claimed draft and its attachment-only message must replay together
    // even when the separate orchestration receipt was lost.
    await env.DB.prepare(`DELETE FROM demo_seed_receipts WHERE operation_id = ? AND action_id = ?`)
      .bind(DEMO_OPERATION_ID, upload!.actionId).run();
    const replayedUpload = await playDemoAction(seed, upload!);
    expect(replayedUpload.turnId).toBe(uploaded.turnId);
    expect(replayedUpload.resourceId).toBe(uploaded.resourceId);

    const { transcript } = await roomClient(seed, opened.workstreamId!, DEMO_MARCUS_ID).boot();
    const humans = transcript.ranges.flatMap((range) => range.turns)
      .filter((turn) => turn.entryKind === "conversation" && turn.actor === "human");
    expect(humans).toHaveLength(3);
    expect(provider.calls).toEqual([]);
  }, 60_000);

  it("refuses a personal room rather than seeding one that is Organization-wide", async () => {
    const seed = await openDemoTestSession();
    const open = seed.actions.find((action) => action.kind === "create_workstream");
    expect(open).toBeDefined();

    // Every Channel is born in a Space, and a create that names none lands in
    // General — which is Organization-wide, so the audience it unions in makes
    // the Channel Organization-wide whatever the pack asked for. A seeded
    // `personal` room would be a lie the readiness barrier then waits on
    // forever, comparing the scope the pack stated against one that can never
    // arrive.
    await expect(applyDemoSeedAction(
      demoSeedEnv(),
      seed,
      { ...open!, scope: "personal" },
    )).rejects.toThrow(/demo_seed_personal_room_unsupported/u);

    // Nothing was written for it: the refusal is in front of the creation, so
    // there is no half-seeded room and no receipt to replay.
    expect(await demoSeedReceipts(env.DB, DEMO_OPERATION_ID)).toHaveLength(0);
  }, 30_000);

  it("publishes a scheduled Sidekick, offers it to every member, and gives it one briefing", async () => {
    const seed = await openDemoTestSession(DEMO_SIDEKICK_PACK);
    const receipts: DemoSeedReceipt[] = [];
    for (const action of seed.actions) receipts.push(await playDemoAction(seed, action));
    const published = receipts.at(-1)!;
    expect(published).toMatchObject({
      kind: "sidekick",
      room: null,
      workstreamId: null,
      runOutcome: "completed",
    });
    expect(published.sidekickId).not.toBeNull();
    expect(published.sidekickRunId).not.toBeNull();

    // Published, not merely drafted, and its schedule armed rather than just
    // accepted: the next run is the pack's 9am, read in the zone the pack
    // named rather than in anybody's account setting. The directory row a
    // member is offered arrives afterwards through the effect Queue, which is
    // the readiness barrier's wait, not this one.
    const author = new AutomationService(demoSeedEnv(), seed.auth.get(DEMO_PRIYA_ID)!);
    const detail = await author.detail(published.sidekickId!);
    expect(detail).toMatchObject({ name: DEMO_SIDEKICK_NAME, scope: "workspace", lifecycle: "active" });
    expect(detail.acceptedDefinitionRevision).toBe(1);
    expect(detail.currentDefinition?.triggers).toEqual([{
      type: "calendar",
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      timezone: "America/Los_Angeles",
      summary: "Every weekday at 9:00am Pacific",
    }]);
    expect(detail.nextRunAt).not.toBeNull();
    expect(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(detail.nextRunAt!))).toBe("09:00");

    // The briefing is an ordinary run of the Sidekick, answered from the pack
    // rather than from the provider the double stands behind.
    const turns = await runInDurableObject(
      demoRunStub(published.sidekickId!, published.sidekickRunId!),
      (_instance, state) => state.storage.sql.exec<{ role: string; content: string | null }>(
        `SELECT role, content FROM canonical_conversation_turn_details ORDER BY sequence_number`,
      ).toArray(),
    );
    expect(turns.filter((turn) => turn.role === "assistant").map((turn) => turn.content))
      .toEqual([DEMO_BRIEFING_PROSE]);
    expect(provider.calls).toEqual([]);
  }, 90_000);

  it("opens a substream on the pack's own starting context, with its own roster and its own loop", async () => {
    const seed = await openDemoTestSession(DEMO_SUBSTREAM_PACK);
    const receipts: DemoSeedReceipt[] = [];
    for (const action of seed.actions) receipts.push(await playDemoAction(seed, action));

    // Creation's one inference — the handoff summary a model would write — was
    // answered from the pack, so nothing about opening this child left the
    // machine either.
    expect(provider.calls).toEqual([]);

    const [open, child] = receipts;
    const workstreamId = open!.workstreamId!;
    expect(child).toMatchObject({ kind: "create_substream", room: "memo", substream: "aside" });
    expect(child!.substreamId).not.toBe("0");
    const substreamId = child!.substreamId!;
    // Every later action addressed the child by the id creation minted.
    expect(receipts.slice(2).map((receipt) => [receipt.substream, receipt.substreamId, receipt.runOutcome]))
      .toEqual([["aside", substreamId, null], ["aside", substreamId, "completed"]]);

    // The child starts from the pack's words, not a model's.
    const context = await runInDurableObject(demoRoomStub(workstreamId, substreamId), (_instance, state) =>
      JSON.stringify(new WorkstreamTranscriptStorage(state.storage).initialContext()));
    expect(context).toContain(DEMO_STARTING_CONTEXT.split("\n")[0]);

    // The presenter is in the child without being in its parent, which is the
    // shape the shipped pack uses: the private conversation is the only place
    // a demo's presenter meets this room before they open it.
    const childDetail = await roomClient(seed, workstreamId, DEMO_MARCUS_ID, substreamId).get();
    expect(childDetail.participants.map((participant) => participant.user.id).sort())
      .toEqual([DEMO_PRIYA_ID, DEMO_MARCUS_ID, DEMO_PRESENTER_ID].sort());
    const parentDetail = await roomClient(seed, workstreamId, DEMO_PRIYA_ID).get();
    expect(parentDetail.participants.map((participant) => participant.user.id))
      .not.toContain(DEMO_PRESENTER_ID);

    // The child ran its own loop, and the parent's main conversation did not
    // hear about any of it: the opening turn and Rally's opening prose, and
    // nothing after them.
    const childRuns = await runInDurableObject(demoRoomStub(workstreamId, substreamId), (_instance, state) =>
      state.storage.sql.exec<{ origin: string; status: string }>(
        `SELECT origin, status FROM runs ORDER BY created_at`,
      ).toArray());
    expect(childRuns).toEqual([{ origin: "demo_seed", status: "completed" }]);
    const childTurns = await runInDurableObject(demoRoomStub(workstreamId, substreamId), (_instance, state) =>
      state.storage.sql.exec<{ role: string; author_user_id: string | null; content: string | null }>(
        `SELECT role, author_user_id, content FROM canonical_conversation_turn_details ORDER BY sequence_number`,
      ).toArray());
    expect(childTurns.map((turn) => [turn.role, turn.author_user_id])).toEqual([
      ["user", DEMO_MARCUS_ID],
      ["user", DEMO_PRIYA_ID],
      ["assistant", null],
    ]);
    expect(childTurns[2]?.content).toBe(DEMO_CHILD_PROSE);
    const parentTurns = await runInDurableObject(demoRoomStub(workstreamId), (_instance, state) =>
      state.storage.sql.exec<{ role: string }>(
        `SELECT role FROM canonical_conversation_turn_details ORDER BY sequence_number`,
      ).toArray());
    expect(parentTurns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  }, 60_000);
});
