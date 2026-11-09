import { describe, expect, test } from "vitest";
import { codeSkillResourceRefs, createSkillRegistry, toCodeSkillSummary } from "../registry";
import type { SkillDef, SkillWarn } from "../types";

function recorder() {
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const onWarn: SkillWarn = (message, fields) => warnings.push({ message, fields });
  return { warnings, onWarn };
}

const def = (overrides: Partial<SkillDef> = {}): SkillDef => ({
  name: "triage",
  description: "Triage inbound work.",
  whenToUse: "When the queue is long.",
  render: () => "Sort by risk.",
  ...overrides,
});

describe("createSkillRegistry", () => {
  test("is an instance, not shared state", () => {
    const a = createSkillRegistry();
    const b = createSkillRegistry();
    a.registerPlatform(def());
    expect(a.get("triage")).toBeDefined();
    expect(b.get("triage")).toBeUndefined();
  });

  test("a platform skill is unowned even if its def claims an owner", () => {
    const { warnings, onWarn } = recorder();
    const registry = createSkillRegistry({ onWarn });
    registry.registerPlatform(def({ ownerPlugin: "documents" }));
    expect(registry.get("triage")?.ownerPlugin).toBeNull();
    expect(registry.get("triage")?.origin).toBe("platform");
    expect(warnings[0]?.message).toContain("declared an ownerPlugin");
  });

  test("a plugin skill takes its owner from the registration, not the def", () => {
    const registry = createSkillRegistry();
    registry.registerPlugin("documents", def({ ownerPlugin: "impostor" }));
    const registered = registry.get("triage");
    expect(registered?.ownerPlugin).toBe("documents");
    expect(registered?.origin).toBe("plugin");
    expect(registered?.def.ownerPlugin).toBe("documents");
  });

  test("re-registering the same def is silent; a different one warns and wins", () => {
    const { warnings, onWarn } = recorder();
    const registry = createSkillRegistry({ onWarn });
    const first = def();
    registry.registerPlatform(first);
    registry.registerPlatform(first);
    expect(warnings).toHaveLength(0);

    registry.registerPlatform(def({ render: () => "Sort by age." }));
    expect(warnings[0]?.message).toContain("name collision");
    expect(registry.get("triage")?.def.render()).toBe("Sort by age.");
    expect(registry.all()).toHaveLength(1);
  });

  test("content hashes differ by owner and by body, and cover resources", () => {
    const registry = createSkillRegistry();
    registry.registerPlatform(def({ name: "a" }));
    registry.registerPlugin("documents", def({ name: "b" }));
    registry.registerPlatform(
      def({
        name: "c",
        resources: [
          {
            path: "references/spec.md",
            kind: "reference",
            contentType: "text/markdown",
            render: () => "spec",
          },
        ],
      }),
    );
    const shas = ["a", "b", "c"].map((name) => registry.get(name)?.contentSha);
    expect(new Set(shas).size).toBe(3);
    expect(shas.every((sha) => sha?.length === 64)).toBe(true);
  });

  test("summaries gate plugin skills on the run's available plugins", () => {
    const registry = createSkillRegistry();
    registry.registerPlatform(def({ name: "everyone" }));
    registry.registerPlugin("documents", def({ name: "docs-only" }));

    expect(registry.summaries().map((s) => s.name).sort()).toEqual(["docs-only", "everyone"]);
    expect(registry.summaries({ availablePlugins: [] }).map((s) => s.name)).toEqual(["everyone"]);
    expect(
      registry
        .summaries({ availablePlugins: ["documents"] })
        .map((s) => s.name)
        .sort(),
    ).toEqual(["docs-only", "everyone"]);
  });

  test("projects to a namespaced Tier-1 summary", () => {
    const registry = createSkillRegistry();
    registry.registerPlugin("documents", def());
    const registered = registry.get("triage");
    expect(registered && toCodeSkillSummary(registered)).toEqual({
      ref: "platform:triage",
      name: "triage",
      description: "Triage inbound work.",
      whenToUse: "When the queue is long.",
      ownerPlugin: "documents",
      origin: "plugin",
    });
  });

  test("resource sizes are UTF-8 bytes", () => {
    const refs = codeSkillResourceRefs(
      def({
        resources: [
          {
            path: "references/spec.md",
            kind: "reference",
            contentType: "text/markdown",
            render: () => "é😀",
          },
        ],
      }),
    );
    expect(refs).toEqual([{ path: "references/spec.md", kind: "reference", bytes: 6 }]);
  });

  test("clear() empties the instance", () => {
    const registry = createSkillRegistry();
    registry.registerPlatform(def());
    registry.clear();
    expect(registry.all()).toEqual([]);
  });
});
