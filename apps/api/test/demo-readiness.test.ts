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

function receipt(overrides: Partial<DemoSeedReceipt> & Pick<DemoSeedReceipt, "actionId" | "kind">): DemoSeedReceipt {
  return {
    operationId: OPERATION_ID,
    workspaceId: "00000000-0000-7000-8000-0000000000e1",
    room: null,
    workstreamId: null,
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
  return PLACEHOLDER_DEMO_PACK.steps.map((step) => {
    if (step.kind === "sidekick") {
      return receipt({
        actionId: step.id,
        kind: step.kind,
        sidekickId: `sidekick-${step.id}`,
        ...(step.firstRun ? { sidekickRunId: `sidekick-run-${step.id}`, runOutcome: "completed" as const } : {}),
      });
    }
    const workstreamId = step.room === "decision-memo" ? MEMO_ID : RENEWAL_ID;
    if (step.kind === "create_workstream") {
      return receipt({ actionId: step.id, kind: step.kind, room: step.room, workstreamId, runOutcome: "completed" });
    }
    if (step.kind === "upload") {
      return receipt({ actionId: step.id, kind: step.kind, room: step.room, workstreamId, resourceId: `resource-${step.id}` });
    }
    return receipt({
      actionId: step.id,
      kind: step.kind,
      room: step.room,
      workstreamId,
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
    // Newest first: the renewal room's last step comes after the memo's.
    expect(view?.rooms.map((room) => room.room)).toEqual(["northgate-renewal", "decision-memo"]);
    expect(view?.rooms[0]).toMatchObject({
      workstreamId: RENEWAL_ID,
      harnessStatus: "needs_input",
      elicitationId: "elicitation-renewal-marcus-2",
      creatorUserId: CAST.marcus!.userId,
      // The creator, the two seated, and the presenter by mention.
      participantUserIds: [CAST.marcus!.userId, CAST.dana!.userId, CAST.priya!.userId, CAST.presenter!.userId],
      unseen: true,
      hasUnread: true,
      mentioned: true,
    });
    expect(view?.rooms[1]).toMatchObject({
      workstreamId: MEMO_ID,
      harnessStatus: "completed",
      resourceIds: ["resource-memo-attach"],
      participantUserIds: [CAST.priya!.userId, CAST.marcus!.userId],
      mentioned: false,
    });
    expect(view?.attention).toEqual({ waitingForYou: 1, waitingReason: "mentioned" });
  });

  it("refuses a pack whose rooms were never confirmed", () => {
    const receipts = placeholderReceipts().filter((row) => row.room !== "northgate-renewal");
    expect(() => demoReadinessManifest(PLACEHOLDER_DEMO_PACK, CAST, receipts))
      .toThrow(/demo_readiness_room_unconfirmed|Room "northgate-renewal" has no receipt/u);
  });

  it("refuses a closing question that never opened", () => {
    const receipts = placeholderReceipts().map((row) =>
      row.actionId === "renewal-marcus-2" ? { ...row, elicitationId: null } : row);
    expect(() => demoReadinessManifest(PLACEHOLDER_DEMO_PACK, CAST, receipts))
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
