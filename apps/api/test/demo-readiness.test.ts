import { describe, expect, it } from "vitest";

import { DemoPackSchema, PLACEHOLDER_DEMO_PACK, type DemoCast } from "../src/services/demo-pack";
import { demoReadinessManifest } from "../src/services/demo-readiness";
import type { DemoSeedReceipt } from "../src/services/demo-seeder";

/**
 * The manifest is derived, not discovered: rooms, who is in them, how each
 * ends, and the order they should list in all come from the pack, and only the
 * ids come from the receipts. A manifest for a pack whose seeding never
 * confirmed a room describes a demo nobody asked for, so it is refused.
 */

const CAST: DemoCast = {
  presenter: { userId: "00000000-0000-7000-8000-0000000000a1", displayName: "Adam Presenter" },
  priya: { userId: "00000000-0000-7000-8000-0000000000a2", displayName: "Priya Raman" },
  marcus: { userId: "00000000-0000-7000-8000-0000000000a3", displayName: "Marcus Hale" },
  dana: { userId: "00000000-0000-7000-8000-0000000000a4", displayName: "Dana Okafor" },
};
const OPERATION_ID = "00000000-0000-7000-8000-0000000000e2";
const MEMO_ID = "00000000-0000-7000-8000-0000000000f1";
const RENEWAL_ID = "00000000-0000-7000-8000-0000000000f2";
const PRESS_ID = "00000000-0000-7000-8000-0000000000f3";
const WORKSTREAM_IDS: Record<string, string> = {
  "acme-proposal": MEMO_ID,
  "vendor-selection": RENEWAL_ID,
  "acme-review": PRESS_ID,
  "sales-reviews": "00000000-0000-7000-8000-0000000000f4",
};

function receipt(overrides: Partial<DemoSeedReceipt> & Pick<DemoSeedReceipt, "actionId" | "kind">): DemoSeedReceipt {
  return {
    operationId: OPERATION_ID,
    workspaceId: "00000000-0000-7000-8000-0000000000e1",
    room: null,
    workstreamId: null,
    substream: null,
    substreamId: "0",
    sidekickId: null,
    sidekickRunId: null,
    turnId: null,
    harnessRunId: null,
    runOutcome: null,
    elicitationId: null,
    resourceId: null,
    completedAt: "2026-09-07T12:00:00.000Z",
    ...overrides,
  };
}

/** The placeholder pack's receipts, as the seeder would leave them. */
function placeholderReceipts(): DemoSeedReceipt[] {
  const substreamIds = new Map<string, string>();
  return DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK).steps.map((step) => {
    if (step.kind === "sidekick") {
      // In no room and so in no conversation: both substream columns stay null,
      // which is what the receipts table's own CHECK requires of a Sidekick.
      return receipt({
        actionId: step.id,
        kind: step.kind,
        substreamId: null,
        sidekickId: `sidekick-${step.id}`,
        ...(step.firstRun ? { sidekickRunId: `sidekick-run-${step.id}`, runOutcome: "completed" as const } : {}),
      });
    }
    const workstreamId = WORKSTREAM_IDS[step.room]!;
    if (step.kind === "create_workstream") {
      return receipt({ actionId: step.id, kind: step.kind, room: step.room, workstreamId, runOutcome: "completed" });
    }
    if (step.kind === "create_substream") {
      substreamIds.set(step.substream, `child-${step.substream}`);
      return receipt({
        actionId: step.id, kind: step.kind, room: step.room, workstreamId,
        substream: step.substream, substreamId: `child-${step.substream}`,
      });
    }
    const inChild = step.substream === undefined
      ? {}
      : { substream: step.substream, substreamId: substreamIds.get(step.substream)! };
    if (step.kind === "upload") {
      return receipt({
        actionId: step.id, kind: step.kind, room: step.room, workstreamId,
        resourceId: `resource-${step.id}`, ...inChild,
      });
    }
    return receipt({
      actionId: step.id,
      kind: step.kind,
      room: step.room,
      workstreamId,
      ...inChild,
      ...(step.assistant?.kind === "ask"
        ? { runOutcome: "needs_input", elicitationId: `elicitation-${step.id}` }
        : step.assistant ? { runOutcome: "completed" } : {}),
    });
  });
}

describe("the readiness manifest", () => {
  it("derives the presenter's view of the placeholder pack", () => {
    const manifest = demoReadinessManifest(PLACEHOLDER_DEMO_PACK, CAST, placeholderReceipts());
    expect(manifest.views).toHaveLength(1);
    const [view] = manifest.views;
    expect(view?.viewerUserId).toBe(CAST.presenter!.userId);
    expect(view?.rooms.map((room) => room.room))
      .toEqual(["acme-proposal", "sales-reviews", "acme-review", "vendor-selection"]);
    expect(view?.rooms[0]).toMatchObject({
      workstreamId: MEMO_ID,
      harnessStatus: "completed",
      resourceIds: ["resource-proposal-brief", "resource-proposal-v1", "resource-proposal-technical-note", "resource-proposal-v2"],
      participantUserIds: [CAST.marcus!.userId, CAST.priya!.userId, CAST.presenter!.userId],
      mentioned: true, unseen: true,
    });
    expect(view?.rooms[2]).toMatchObject({
      workstreamId: PRESS_ID, harnessStatus: "completed",
      resourceIds: ["resource-review-transcript", "resource-review-guide", "resource-review-v1", "resource-review-v2"],
      participantUserIds: [CAST.marcus!.userId, CAST.priya!.userId, CAST.dana!.userId],
      mentioned: false,
    });
    expect(view?.rooms[3]).toMatchObject({
      workstreamId: RENEWAL_ID, harnessStatus: "completed", elicitationId: null,
      participantUserIds: [CAST.marcus!.userId, CAST.priya!.userId, CAST.dana!.userId],
    });
    expect(view?.attention).toEqual({ waitingForYou: 1, waitingReason: "mentioned" });
  });

  it("refuses a pack whose rooms were never confirmed", () => {
    const receipts = placeholderReceipts().filter((row) => row.room !== "vendor-selection");
    expect(() => demoReadinessManifest(PLACEHOLDER_DEMO_PACK, CAST, receipts))
      .toThrow(/demo_readiness_room_unconfirmed|Room "vendor-selection" has no receipt/u);
  });

  it("refuses a closing question that never opened", () => {
    const pack = DemoPackSchema.parse({ ...PLACEHOLDER_DEMO_PACK, steps: [
      ...PLACEHOLDER_DEMO_PACK.steps,
      { kind: "message", id: "test-question", room: "acme-proposal", as: "marcus", text: "Choose.",
        assistant: { kind: "ask", prompt: "Which?", options: ["One", "Two"] } },
    ] });
    expect(() => demoReadinessManifest(pack, CAST, placeholderReceipts()))
      .toThrow(/has no confirmed question/u);
  });
});

describe("a pack's viewer expectations", () => {
  const steps = [
    {
      kind: "create_workstream", id: "open", room: "private", as: "priya", title: "A private room",
      participants: ["marcus"], scope: "personal", openingMessage: "Start.",
      assistant: { kind: "say", text: "Done." },
    },
  ];

  it("must list exactly the rooms the viewer will see", () => {
    const outsider = DemoPackSchema.safeParse({
      version: "test", roles: ["presenter", "priya", "marcus"], steps,
      expect: [{ viewer: "presenter", attention: { waitingForYou: 0, waitingReason: null }, rooms: {
        private: { unseen: false, hasUnread: false, mentioned: false },
      } }],
    });
    expect(outsider.success).toBe(false);
    expect(outsider.error?.issues.map((issue) => issue.message)).toContain(
      'Viewer "presenter" will not see room "private"',
    );
    const insider = DemoPackSchema.safeParse({
      version: "test", roles: ["presenter", "priya", "marcus"], steps,
      expect: [{ viewer: "marcus", attention: { waitingForYou: 1, waitingReason: "unseen" }, rooms: {} }],
    });
    expect(insider.error?.issues.map((issue) => issue.message)).toContain(
      'Viewer "marcus" will see room "private", which is not expected',
    );
  });

  it("refuses a pack that names no viewer, rather than reporting Ready unchecked", () => {
    const silent = DemoPackSchema.parse({ ...PLACEHOLDER_DEMO_PACK, expect: [] });
    expect(() => demoReadinessManifest(silent, CAST, placeholderReceipts()))
      .toThrow(expect.objectContaining({ code: "demo_pack_expects_nothing" }));
  });
});
