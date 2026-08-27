import { describe, expect, it } from "vitest";

import {
  PROJECT_COLOR_KEYS,
  PROJECT_ICON_KEYS,
  CreateProjectRequestSchema,
  ProjectSnapshotSchema,
  ProjectSummarySchema,
} from "./projects";

describe("project contracts", () => {
  it("given the V1 picker, when its registries are read, then it exposes exactly 25 icons and 12 colors", () => {
    expect(PROJECT_ICON_KEYS).toEqual([
      "briefcase",
      "target",
      "calendar-days",
      "list-checks",
      "clipboard-list",
      "file-text",
      "folder",
      "lightbulb",
      "star",
      "flag",
      "rocket",
      "chart-no-axes-combined",
      "calculator",
      "coins",
      "users",
      "user-search",
      "handshake",
      "megaphone",
      "palette",
      "image",
      "pen-tool",
      "package",
      "building-2",
      "globe-2",
      "heart",
    ]);
    expect(PROJECT_COLOR_KEYS).toEqual([
      "gray",
      "brown",
      "red",
      "orange",
      "yellow",
      "green",
      "teal",
      "cyan",
      "blue",
      "indigo",
      "purple",
      "pink",
    ]);
  });

  it("given custom presentation values, when project creation is parsed, then the closed contract refuses them", () => {
    const base = { name: "Hiring", iconKey: "briefcase", colorKey: "blue", scope: "personal" };

    expect(CreateProjectRequestSchema.safeParse({ ...base, iconKey: "code" }).success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ ...base, colorKey: "#123456" }).success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("given a project response, when unknown server fields arrive, then the client contract fails closed", () => {
    expect(ProjectSummarySchema.safeParse({
      id: "00000000-0000-7000-8000-000000000001",
      name: "Hiring",
      iconKey: "briefcase",
      colorKey: "blue",
      scope: "personal",
      status: "active",
      presentationRevision: 1,
      audienceGeneration: 1,
      lifecycleGeneration: 1,
      participants: [{
        userId: "00000000-0000-7000-8000-000000000002",
        state: "active",
        generation: 1,
      }],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      unexpected: "drift",
    }).success).toBe(false);
  });

  it("given one project authority snapshot, when active and inactive waterlines differ, then it is rejected", () => {
    expect(ProjectSnapshotSchema.safeParse({
      active: { waterline: 2, items: [] },
      inactive: { waterline: 1, items: [] },
    }).success).toBe(false);
    expect(ProjectSnapshotSchema.safeParse({
      active: { waterline: 2, items: [] },
      inactive: { waterline: 2, items: [] },
    }).success).toBe(true);
  });
});
