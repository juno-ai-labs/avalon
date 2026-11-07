import { describe, expect, it } from "vitest";

import { DemoPackSchema, PLACEHOLDER_DEMO_PACK, type DemoCast } from "../src/services/demo-pack";
import { demoReadinessManifest } from "../src/services/demo-readiness";
import type { DemoSeedReceipt } from "../src/services/demo-seeder";

/**
 * The manifest is derived, not discovered: which Canvases and Sidekicks exist,
 * who each is shared with, how each Chat ends, how many versions each
 * artifact reaches and the order the list should hold all come from the pack,
 * and only the ids come from the receipts. A manifest for a pack whose seeding
 * never confirmed something describes a demo nobody asked for, so it is
 * refused.
 */

const CAST: DemoCast = {
  presenter: { userId: "00000000-0000-7000-8000-0000000000a1", displayName: "Maya Presenter" },
  theo: { userId: "00000000-0000-7000-8000-0000000000a2", displayName: "Theo Park" },
  priya: { userId: "00000000-0000-7000-8000-0000000000a3", displayName: "Priya Raman" },
};
const OPERATION_ID = "00000000-0000-7000-8000-0000000000e2";

function receipt(overrides: Partial<DemoSeedReceipt> & Pick<DemoSeedReceipt, "actionId" | "kind">): DemoSeedReceipt {
  return {
    operationId: OPERATION_ID,
    workspaceId: "00000000-0000-7000-8000-0000000000e1",
    canvas: null,
    canvasId: null,
    sidekick: null,
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
  return DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK).steps.map((step) => {
    switch (step.kind) {
      case "sidekick":
        return receipt({
          actionId: step.id, kind: step.kind, sidekick: step.sidekick, sidekickId: `sidekick-${step.sidekick}`,
          ...(step.firstRun ? { sidekickRunId: `run-${step.sidekick}`, runOutcome: "completed" as const } : {}),
          ...(step.canvas ? { canvasId: `canvas-${step.sidekick}`, resourceId: `resource-${step.sidekick}` } : {}),
        });
      case "sidekick_message":
        return receipt({ actionId: step.id, kind: step.kind, sidekick: step.sidekick, sidekickId: `sidekick-${step.sidekick}`, turnId: `turn-${step.id}` });
      case "canvas_artifact":
        // One resource per path: a later version lands on the first's.
        return receipt({ actionId: step.id, kind: step.kind, canvas: step.canvas, canvasId: `canvas-${step.canvas}`, resourceId: `resource-${step.path}` });
      case "upload":
        return receipt({ actionId: step.id, kind: step.kind, canvas: step.canvas, canvasId: `canvas-${step.canvas}`, resourceId: `resource-${step.id}` });
      default:
        return receipt({
          actionId: step.id, kind: step.kind, canvas: step.canvas, canvasId: `canvas-${step.canvas}`,
          ...(step.assistant?.kind === "ask"
            ? { runOutcome: "needs_input" as const, elicitationId: `elicitation-${step.id}` }
            : step.assistant ? { runOutcome: "completed" as const } : {}),
        });
    }
  });
}

describe("the readiness manifest", () => {
  it("derives the presenter's view of the placeholder pack", () => {
    const manifest = demoReadinessManifest(DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK), CAST, placeholderReceipts());
    const [view] = manifest.views;
    expect(view?.viewerUserId).toBe(CAST.presenter!.userId);
    // Most recently active first.
    expect(view?.canvases.map((canvas) => [canvas.canvas, canvas.unread])).toEqual([
      // Theo's Organization Canvas, which the presenter has never opened.
      ["weekly-changelog", true],
      ["launch-plan", true],
      // Their own, whose read state depends on what came after.
      ["q4-review", null],
    ]);
    expect(manifest.canvases.find((canvas) => canvas.canvas === "q4-review")).toMatchObject({
      canvasId: "canvas-q4-review",
      creatorUserId: CAST.presenter!.userId,
      writerSidekickId: null,
      artifacts: [{ resourceId: "resource-q4-revenue-review.md", version: 2 }],
      harnessStatus: "completed",
    });
    expect(manifest.canvases.find((canvas) => canvas.canvas === "launch-plan")).toMatchObject({
      uploadResourceIds: ["resource-launch-checklist"],
      artifacts: [{ resourceId: "resource-launch-plan.md", version: 1 }],
    });
    expect(manifest.canvases.find((canvas) => canvas.canvas === "weekly-changelog")).toMatchObject({
      canvasId: "canvas-weekly-changelog",
      creatorUserId: CAST.theo!.userId,
      writerSidekickId: "sidekick-weekly-changelog",
      artifacts: [{ resourceId: "resource-weekly-changelog", version: 1 }],
      harnessStatus: "idle",
    });
    expect(view?.sidekicks.map((sidekick) => [sidekick.name, sidekick.audience, sidekick.runId])).toEqual([
      ["Weekly changelog", "workspace", "run-weekly-changelog"],
      ["Incident triage", "people", "run-incident-triage"],
    ]);
  });

  it("refuses a pack whose seeding never confirmed a publish or a Sidekick's Canvas", () => {
    const pack = DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK);
    const receipts = placeholderReceipts();
    expect(() => demoReadinessManifest(pack, CAST, receipts.filter((row) => row.actionId !== "q4-v2")))
      .toThrow(expect.objectContaining({ code: "demo_readiness_artifact_unconfirmed" }));
    expect(() => demoReadinessManifest(pack, CAST, receipts.map((row) =>
      row.actionId === "changelog-sidekick" ? { ...row, canvasId: null } : row)))
      .toThrow(expect.objectContaining({ code: "demo_readiness_sidekick_canvas_unconfirmed" }));
  });
});
