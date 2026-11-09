import { describe, expect, test } from "vitest";
import { compareSkillSummaries, partitionSkillCatalog } from "../catalog";
import type { SkillSummary } from "../types";

const summary = (overrides: Partial<SkillSummary> & { name: string }): SkillSummary => ({
  ref: `platform:${overrides.name}`,
  description: "A skill.",
  whenToUse: null,
  ownerPlugin: null,
  origin: "platform",
  ...overrides,
});

describe("compareSkillSummaries", () => {
  test("orders by origin, then name, then ref", () => {
    const skills = [
      summary({ name: "b", origin: "tenant", ref: "skl_b" }),
      summary({ name: "a", origin: "plugin", ownerPlugin: "p" }),
      summary({ name: "b", origin: "platform" }),
      summary({ name: "a", origin: "platform" }),
    ];
    expect([...skills].sort(compareSkillSummaries).map((s) => `${s.origin}:${s.name}`)).toEqual([
      "platform:a",
      "platform:b",
      "plugin:a",
      "tenant:b",
    ]);
  });

  test("is total — a name collision still sorts deterministically", () => {
    const a = summary({ name: "same", origin: "tenant", ref: "skl_aaa" });
    const b = summary({ name: "same", origin: "tenant", ref: "skl_bbb" });
    expect(compareSkillSummaries(a, b)).toBeLessThan(0);
    expect(compareSkillSummaries(b, a)).toBeGreaterThan(0);
  });
});

describe("partitionSkillCatalog", () => {
  const available = [
    summary({ name: "alpha" }),
    summary({ name: "beta" }),
    summary({ name: "gamma", origin: "tenant", ref: "skl_gamma" }),
  ];

  test("splits active from loadable and renders both in catalog order", () => {
    const partition = partitionSkillCatalog(new Set(["platform:beta"]), available);
    expect(partition.active.map((s) => s.name)).toEqual(["beta"]);
    expect(partition.loadable.map((entry) => entry.summary.name)).toEqual(["alpha", "gamma"]);
    expect(partition.truncated).toBe(0);
  });

  test("order does not depend on the order the caller passed", () => {
    const forward = partitionSkillCatalog(new Set(), available);
    const backward = partitionSkillCatalog(new Set(), [...available].reverse());
    expect(backward.loadable.map((e) => e.summary.name)).toEqual(
      forward.loadable.map((e) => e.summary.name),
    );
  });

  test("demotes the overflow to names only rather than dropping it", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      summary({
        name: `skill-${String(index).padStart(2, "0")}`,
        description: "d".repeat(200),
      }),
    );
    const partition = partitionSkillCatalog(new Set(), many, { tokenBudget: 100 });
    expect(partition.loadable).toHaveLength(40);
    expect(partition.truncated).toBeGreaterThan(0);
    expect(partition.loadable.filter((e) => e.detail === "full").length).toBe(
      40 - partition.truncated,
    );
    // The demotion is a suffix: the budget is spent in catalog order.
    const firstDemoted = partition.loadable.findIndex((e) => e.detail === "name_only");
    expect(partition.loadable.slice(firstDemoted).every((e) => e.detail === "name_only")).toBe(true);
  });

  test("active entries are charged to the budget but never demoted", () => {
    const heavy = summary({ name: "heavy", description: "d".repeat(4000) });
    const other = summary({ name: "other", description: "d".repeat(400) });
    const partition = partitionSkillCatalog(new Set(["platform:heavy"]), [heavy, other], {
      tokenBudget: 100,
    });
    expect(partition.active.map((s) => s.name)).toEqual(["heavy"]);
    expect(partition.loadable[0]?.detail).toBe("name_only");
  });

  test("a host cost function overrides the default estimate", () => {
    const partition = partitionSkillCatalog(new Set(), available, {
      tokenBudget: 10,
      cost: (_summary, detail) => (detail === "full" ? 6 : 1),
    });
    expect(partition.loadable.map((e) => e.detail)).toEqual(["full", "name_only", "name_only"]);
    expect(partition.truncated).toBe(2);
  });

  test("an empty catalog partitions to nothing", () => {
    expect(partitionSkillCatalog(new Set(), [])).toEqual({
      active: [],
      loadable: [],
      truncated: 0,
    });
  });
});
