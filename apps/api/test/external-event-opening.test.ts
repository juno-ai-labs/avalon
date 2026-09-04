import { describe, expect, it } from "vitest";

import { externalEventOpening } from "../src/lib/external-event-opening";

describe("the event that woke a run, as its opening message", () => {
  it("names the event and carries its metadata, marked as the connector's words", () => {
    const opening = externalEventOpening({
      id: "00000000-0000-7000-8000-0000000000e1",
      eventType: "deploy.finished",
      title: "checkout deployed",
      summary: "Deploy of checkout finished.",
      textSnippet: "7 minutes, no rollback",
      metadata: { service: "checkout", durationSeconds: 420 },
      occurredAt: Date.parse("2026-09-04T05:00:00.000Z"),
    });

    expect(opening.textContent).toContain("External event: checkout deployed");
    expect(opening.textContent).toContain("Type: deploy.finished");
    expect(opening.textContent).toContain("Occurred: 2026-09-04T05:00:00.000Z");
    expect(opening.textContent).toContain("Deploy of checkout finished.");
    expect(opening.textContent).toContain("7 minutes, no rollback");
    expect(opening.textContent).toContain("\"service\": \"checkout\"");
    expect(opening.textContent).toContain("not an instruction");
    expect(opening.structuredContent).toEqual({
      kind: "external_event",
      untrusted: true,
      workspaceEventId: "00000000-0000-7000-8000-0000000000e1",
      eventType: "deploy.finished",
      title: "checkout deployed",
      summary: "Deploy of checkout finished.",
      occurredAt: Date.parse("2026-09-04T05:00:00.000Z"),
      metadata: { service: "checkout", durationSeconds: 420 },
    });
    expect(opening.resourceId).toBeNull();
  });

  it("leaves out the sections an event does not have", () => {
    const opening = externalEventOpening({
      id: "00000000-0000-7000-8000-0000000000e2",
      eventType: "build.failed",
      title: "Build failed",
      summary: "",
      textSnippet: "",
      metadata: {},
      occurredAt: 0,
    });

    expect(opening.textContent).not.toContain("Metadata:");
    expect(opening.textContent.split("\n").filter((line) => line.trim() === "")).toHaveLength(1);
  });
});
