import { describe, expect, it } from "vitest";

import { CANVAS_FILTERS, ELSEWHERE_CANVAS_FACTS, canvasFilterFacts, matchesCanvasFilter } from "./canvas-filters";

const sidekick = (status: "active" | "paused", triggerKinds: ("manual" | "schedule" | "external_event")[]) => ({ status, triggerKinds });

describe("canvasFilterFacts", () => {
  it("reads Reactive only from an active Sidekick that wakes on its own", () => {
    const base = { hasStoredData: false, createdByUserId: "u1", sharedWithMe: false };
    expect(canvasFilterFacts({ ...base, sidekicks: [sidekick("active", ["schedule"])] }, "u1").reactive).toBe(true);
    expect(canvasFilterFacts({ ...base, sidekicks: [sidekick("active", ["external_event"])] }, "u1").reactive).toBe(true);
    expect(canvasFilterFacts({ ...base, sidekicks: [sidekick("paused", ["schedule"])] }, "u1").reactive).toBe(false);
    expect(canvasFilterFacts({ ...base, sidekicks: [sidekick("active", ["manual"])] }, "u1").reactive).toBe(false);
  });

  it("reads Made by me against the viewer, and Data backed and Shared from the row", () => {
    const row = { hasStoredData: true, createdByUserId: "u1", sharedWithMe: true };
    expect(canvasFilterFacts(row, "u1")).toEqual({ reactive: false, dataBacked: true, mine: true, sharedWithMe: true });
    expect(canvasFilterFacts(row, "u2").mine).toBe(false);
    expect(canvasFilterFacts(row, undefined).mine).toBe(false);
  });
});

describe("matchesCanvasFilter", () => {
  it("keeps a Canvas from another Organization under All and Shared with me only", () => {
    expect(CANVAS_FILTERS.map(([filter]) => filter).filter((filter) => matchesCanvasFilter(ELSEWHERE_CANVAS_FACTS, filter))).toEqual(["all", "shared"]);
  });
});
