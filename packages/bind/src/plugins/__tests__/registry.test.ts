import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createToolRegistry } from "../registry";
import type { ToolPlugin } from "../tool";

type Ctx = { tenant: string };

function plugin(
  name: string,
  overrides: Partial<ToolPlugin<Ctx>> = {},
): ToolPlugin<Ctx> {
  return {
    name,
    description: `${name} description`,
    icon: "puzzle-piece",
    tools: [
      { name: "do_it", description: "does it", parameters: z.object({}) },
    ],
    execute: async () => ({ success: true, data: null }),
    ...overrides,
  };
}

describe("createToolRegistry", () => {
  test("registers and resolves by name", () => {
    const registry = createToolRegistry<ToolPlugin<Ctx>>({ corePlugins: [] });
    registry.register(plugin("messaging"));
    expect(registry.get("messaging")?.name).toBe("messaging");
    expect(registry.get("nope")).toBeUndefined();
  });

  test("resolves a legacy name through an alias", () => {
    const registry = createToolRegistry<ToolPlugin<Ctx>>({
      corePlugins: [],
      aliases: { "sub-agents": "orchestration" },
    });
    registry.register(plugin("orchestration"));
    expect(registry.get("sub-agents")?.name).toBe("orchestration");
    expect(registry.canonicalizeName("sub-agents")).toBe("orchestration");
    expect(registry.canonicalizeName("messaging")).toBe("messaging");
  });

  test("does not read an alias through Object.prototype", () => {
    // A bare `aliases[name]` returns an inherited function for these names, so
    // a plugin legitimately called "constructor" or "toString" would resolve to
    // one — and the result flows on as a plugin name.
    const registry = createToolRegistry<ToolPlugin<Ctx>>({
      corePlugins: [],
      aliases: { "sub-agents": "orchestration" },
    });
    for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(registry.canonicalizeName(name)).toBe(name);
    }
  });

  test("falls back to the input when a host's alias map holds a non-string", () => {
    // Hosts supply this map, and one built from JSON or another untyped source
    // can carry anything. Returning it would hand a non-string downstream to
    // every caller that treats the result as a plugin name.
    const registry = createToolRegistry<ToolPlugin<Ctx>>({
      corePlugins: [],
      // The declared type forbids these; the runtime does not.
      aliases: JSON.parse('{"a": {"nested": 1}, "b": 123, "c": null}'),
    });
    expect(registry.canonicalizeName("a")).toBe("a");
    expect(registry.canonicalizeName("b")).toBe("b");
    expect(registry.canonicalizeName("c")).toBe("c");
  });

  test("an unavailable plugin stays registered but does not resolve", () => {
    const registry = createToolRegistry<ToolPlugin<Ctx>>({ corePlugins: [] });
    registry.register(plugin("gated", { isAvailable: () => false }));
    expect(registry.get("gated")).toBeUndefined();
    // Still present for configuration projection / cross-cutting checks.
    expect(registry.all().map((p) => p.name)).toEqual(["gated"]);
    expect(registry.summaries()).toEqual([]);
    expect(registry.availableNames()).toEqual([]);
  });

  test("availability is re-evaluated per call, not cached at registration", () => {
    let open = false;
    const registry = createToolRegistry<ToolPlugin<Ctx>>({ corePlugins: [] });
    registry.register(plugin("toggle", { isAvailable: () => open }));
    expect(registry.get("toggle")).toBeUndefined();
    open = true;
    expect(registry.get("toggle")?.name).toBe("toggle");
  });

  test("marks core plugins in summaries and de-duplicates the core list", () => {
    const registry = createToolRegistry<ToolPlugin<Ctx>>({
      corePlugins: ["messaging", "messaging", "memory"],
    });
    registry.register(plugin("messaging"));
    registry.register(plugin("canvas"));
    expect(registry.corePlugins()).toEqual(["messaging", "memory"]);
    expect(registry.isCoreName("messaging")).toBe(true);
    expect(registry.isCoreName("canvas")).toBe(false);
    expect(registry.summaries()).toEqual([
      { name: "messaging", description: "messaging description", isCorePlugin: true },
      { name: "canvas", description: "canvas description", isCorePlugin: false },
    ]);
  });

  test("summaries() preserve registration order — a host's prompt-cache prefix depends on it", () => {
    // Not incidental: a host renders this list into its system prompt, and an
    // unstable order rewrites the cached prefix on every call for no visible
    // reason. Re-registering an existing name must keep its original slot
    // rather than moving it to the end.
    const registry = createToolRegistry<ToolPlugin<Ctx>>({ corePlugins: [] });
    for (const name of ["zeta", "alpha", "mid"]) registry.register(plugin(name));
    expect(registry.summaries().map((s) => s.name)).toEqual(["zeta", "alpha", "mid"]);
    expect(registry.availableNames()).toEqual(["zeta", "alpha", "mid"]);

    registry.register(plugin("zeta", { description: "replaced" }));
    expect(registry.summaries().map((s) => s.name)).toEqual(["zeta", "alpha", "mid"]);
  });

  test("onRegister fires once per registration with the plugin", () => {
    const seen: string[] = [];
    const registry = createToolRegistry<ToolPlugin<Ctx>>({
      corePlugins: [],
      onRegister: (p) => seen.push(p.name),
    });
    registry.register(plugin("a"));
    registry.register(plugin("b"));
    expect(seen).toEqual(["a", "b"]);
  });

  test("two registries are independent — no shared module state", () => {
    const first = createToolRegistry<ToolPlugin<Ctx>>({ corePlugins: [] });
    const second = createToolRegistry<ToolPlugin<Ctx>>({ corePlugins: [] });
    first.register(plugin("only-in-first"));
    expect(first.get("only-in-first")).toBeDefined();
    expect(second.get("only-in-first")).toBeUndefined();
  });

  test("re-registering the same name replaces the earlier plugin", () => {
    const registry = createToolRegistry<ToolPlugin<Ctx>>({ corePlugins: [] });
    registry.register(plugin("dup", { description: "first" }));
    registry.register(plugin("dup", { description: "second" }));
    expect(registry.all()).toHaveLength(1);
    expect(registry.get("dup")?.description).toBe("second");
  });
});
