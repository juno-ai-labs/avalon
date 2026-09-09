import { describe, expect, it } from "vitest";

import {
  CreateProjectRequestSchema,
  PALETTE_INK,
  PALETTE_KEYS,
  PALETTE_RETIRED,
  PROJECT_COLOR_KEYS,
  PROJECT_COLOR_KEYS_STORABLE,
  PROJECT_ICON_KEYS,
  ProjectColorKeySchema,
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
      "rose",
      "red",
      "orange",
      "amber",
      "lime",
      "green",
      "emerald",
      "cyan",
      "blue",
      "indigo",
      "violet",
      "purple",
      "fuchsia",
      "pink",
    ]);
  });

  it("given a colour retired from the picker, when a stored appearance is parsed, then it still reads", () => {
    // Every retired key is live in somebody's workspace. The picker stops
    // offering them; parsing must not stop accepting them, or the read path
    // throws on a row nobody has touched since the palette changed.
    for (const retired of PALETTE_RETIRED) {
      expect(ProjectColorKeySchema.safeParse(retired).success).toBe(true);
      expect((PROJECT_COLOR_KEYS as readonly string[]).includes(retired)).toBe(false);
    }
  });

  it("given the storable vocabulary, when it is compared with the picker, then it is the picker plus the retired keys", () => {
    expect([...PROJECT_COLOR_KEYS_STORABLE]).toEqual([...PALETTE_KEYS]);
    // `black` is storable but not offered: the picker stops showing it, and a
    // work stream that already holds it still parses and still renders. Only
    // the menu narrowed.
    expect(ProjectColorKeySchema.safeParse("black").success).toBe(true);
    expect((PROJECT_COLOR_KEYS as readonly string[]).includes("black")).toBe(false);
    expect(new Set(PROJECT_COLOR_KEYS_STORABLE).size).toBe(PROJECT_COLOR_KEYS_STORABLE.length);
    expect(ProjectColorKeySchema.safeParse("chartreuse").success).toBe(false);
  });

  it("given every storable colour, when the ink table is consulted, then each one has an entry", () => {
    // A missing entry is a crash at render, not a type error: the lookup is by
    // a key that came out of the database.
    for (const key of PALETTE_KEYS) {
      expect(PALETTE_INK[key]).toMatch(/^(white|black)$/);
    }
    expect(Object.keys(PALETTE_INK).sort()).toEqual([...PALETTE_KEYS].sort());
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
