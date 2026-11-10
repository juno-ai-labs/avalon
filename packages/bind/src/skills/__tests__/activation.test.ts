import { describe, expect, test } from "vitest";
import { createSkillActivation, type SkillStore } from "../activation";
import { admitSkillLoad, estimateSkillBodyTokens } from "../admission";
import type { SkillSummary, SkillWarn } from "../types";

const available: SkillSummary[] = [
  {
    ref: "platform:triage",
    name: "triage",
    description: "d",
    whenToUse: null,
    ownerPlugin: null,
    origin: "platform",
  },
  {
    ref: "skl_house",
    name: "house-style",
    description: "d",
    whenToUse: null,
    ownerPlugin: null,
    origin: "tenant",
  },
];

function harness(store?: Partial<SkillStore>) {
  const activeSkills = new Set<string>();
  const loadedSkillShas: Record<string, string> = {};
  const applied: string[][] = [];
  const resolveCalls: string[][] = [];
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const onWarn: SkillWarn = (message, fields) => warnings.push({ message, fields });

  const activation = createSkillActivation({
    availableSkills: available,
    activeSkills,
    loadedSkillShas,
    applyInstructions: (instructions) => applied.push(instructions),
    onWarn,
    store: {
      resolveActiveInstructions: async (refs) => {
        resolveCalls.push([...refs]);
        return {
          instructions: refs.map((ref) => `<body ${ref}>`),
          shas: Object.fromEntries(refs.map((ref) => [ref, `${ref}-sha`])),
        };
      },
      ...store,
    },
  });

  return { activation, activeSkills, loadedSkillShas, applied, resolveCalls, warnings };
}

describe("createSkillActivation", () => {
  test("admits a catalog ref, resolves the whole set, and pins its hashes", async () => {
    const h = harness();
    await h.activation.activateSkills(["platform:triage"]);
    expect([...h.activeSkills]).toEqual(["platform:triage"]);
    expect(h.applied).toEqual([["<body platform:triage>"]]);
    expect(h.loadedSkillShas).toEqual({ "platform:triage": "platform:triage-sha" });
  });

  test("resolves the full active set on each activation, not the delta", async () => {
    const h = harness();
    await h.activation.activateSkills(["platform:triage"]);
    await h.activation.activateSkills(["skl_house"]);
    expect(h.resolveCalls).toEqual([["platform:triage"], ["platform:triage", "skl_house"]]);
    expect(h.applied[1]).toEqual(["<body platform:triage>", "<body skl_house>"]);
  });

  test("re-activating an already-active ref is a no-op", async () => {
    const h = harness();
    await h.activation.activateSkills(["platform:triage"]);
    await h.activation.activateSkills(["platform:triage"]);
    expect(h.resolveCalls).toHaveLength(1);
    expect(h.applied).toHaveLength(1);
  });

  test("refuses a ref outside the catalog and never resolves for it", async () => {
    const h = harness();
    await h.activation.activateSkills(["platform:not-offered"]);
    expect([...h.activeSkills]).toEqual([]);
    expect(h.resolveCalls).toEqual([]);
    expect(h.warnings[0]?.message).toContain("refusing to activate unavailable skill");
  });

  test("a batch admits its valid refs and drops the rest", async () => {
    const h = harness();
    await h.activation.activateSkills(["platform:not-offered", "skl_house"]);
    expect([...h.activeSkills]).toEqual(["skl_house"]);
    expect(h.applied).toHaveLength(1);
  });

  test("a failed resolve leaves the caller's state untouched, so a retry still works", async () => {
    let failNext = true;
    const h = harness({
      resolveActiveInstructions: async (refs) => {
        if (failNext) {
          failNext = false;
          throw new Error("store unavailable");
        }
        return {
          instructions: refs.map((ref) => `<body ${ref}>`),
          shas: Object.fromEntries(refs.map((ref) => [ref, `${ref}-sha`])),
        };
      },
    });

    await expect(h.activation.activateSkills(["platform:triage"])).rejects.toThrow(
      "store unavailable",
    );
    // Committing the ref before the resolve succeeded would make the retry a
    // no-op, leaving the catalog claiming a skill whose body never reached the
    // prompt.
    expect([...h.activeSkills]).toEqual([]);
    expect(h.loadedSkillShas).toEqual({});
    expect(h.applied).toEqual([]);

    await h.activation.activateSkills(["platform:triage"]);
    expect([...h.activeSkills]).toEqual(["platform:triage"]);
    expect(h.applied).toEqual([["<body platform:triage>"]]);
  });

  test("resolves against the would-be set, not the set before the call", async () => {
    const h = harness();
    await h.activation.activateSkills(["platform:triage", "skl_house"]);
    expect(h.resolveCalls).toEqual([["platform:triage", "skl_house"]]);
  });

  test("mutates the caller's set and pin map in place so a terminal path can persist them", async () => {
    const activeSkills = new Set<string>(["platform:triage"]);
    const loadedSkillShas: Record<string, string> = { "platform:triage": "seeded" };
    const activation = createSkillActivation({
      availableSkills: available,
      activeSkills,
      loadedSkillShas,
      applyInstructions: () => {},
      store: {
        resolveActiveInstructions: async (refs) => ({
          instructions: [],
          shas: Object.fromEntries(refs.map((ref) => [ref, `${ref}-fresh`])),
        }),
      },
    });
    await activation.activateSkills(["skl_house"]);
    expect([...activeSkills]).toEqual(["platform:triage", "skl_house"]);
    expect(loadedSkillShas).toEqual({
      "platform:triage": "platform:triage-fresh",
      skl_house: "skl_house-fresh",
    });
  });
});

describe("admitSkillLoad", () => {
  test("admits under both bounds", () => {
    expect(
      admitSkillLoad({ activeCount: 2, maxActive: 12, projectedBodyTokens: 100, maxBodyTokens: 40_000 }),
    ).toEqual({ admitted: true });
  });

  test("refuses at the count cap with an identifier-free noun phrase", () => {
    const decision = admitSkillLoad({ activeCount: 12, maxActive: 12 });
    expect(decision.admitted).toBe(false);
    if (decision.admitted) return;
    expect(decision.refusal).toEqual({ kind: "active_count", active: 12, max: 12 });
    expect(decision.reason).toBe(
      "active-skill limit reached (12 loaded). Work from the skills already loaded rather than loading more.",
    );
  });

  test("refuses over the body-token budget even when the count is fine", () => {
    const decision = admitSkillLoad({
      activeCount: 1,
      projectedBodyTokens: 41_000,
      maxBodyTokens: 40_000,
    });
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) expect(decision.refusal.kind).toBe("active_body_tokens");
  });

  test("an omitted measurement omits its bound", () => {
    expect(admitSkillLoad({})).toEqual({ admitted: true });
    expect(admitSkillLoad({ projectedBodyTokens: 41_000, maxBodyTokens: 40_000 }).admitted).toBe(
      false,
    );
  });

  test("a broken measurement refuses rather than admits", () => {
    expect(admitSkillLoad({ activeCount: Number.NaN }).admitted).toBe(false);
    expect(admitSkillLoad({ activeCount: -1 }).admitted).toBe(false);
    expect(admitSkillLoad({ projectedBodyTokens: Number.NaN }).admitted).toBe(false);
  });

  test("estimateSkillBodyTokens sums the resolved set", () => {
    expect(estimateSkillBodyTokens(["a".repeat(8), "b".repeat(4)])).toBe(3);
    expect(estimateSkillBodyTokens([])).toBe(0);
  });
});
