import { describe, expect, test } from "vitest";
import {
  initialActivePlugins,
  partitionPluginCatalog,
  rehydrateActivation,
} from "../activation";
import type { PluginSummary } from "../registry";

const identity = (name: string) => name;

describe("rehydrateActivation", () => {
  test("keeps everything that resolves, in order", async () => {
    const result = await rehydrateActivation(["a", "b", "c"], {
      canonicalizeName: identity,
      resolve: () => true,
    });
    expect(result.active).toEqual(["a", "b", "c"]);
    expect(result.dropped).toEqual([]);
  });

  test("canonicalizes legacy names so a rename does not strip capabilities", async () => {
    const result = await rehydrateActivation(["sub-agents"], {
      canonicalizeName: (n) => (n === "sub-agents" ? "orchestration" : n),
      resolve: () => true,
    });
    expect(result.active).toEqual(["orchestration"]);
  });

  test("collapses two legacy names that canonicalize to the same plugin", async () => {
    const calls: string[] = [];
    const result = await rehydrateActivation(
      ["sub-agents", "orchestration"],
      {
        canonicalizeName: (n) => (n === "sub-agents" ? "orchestration" : n),
        resolve: (n) => {
          calls.push(n);
          return true;
        },
      },
    );
    expect(result.active).toEqual(["orchestration"]);
    // Resolution is attempted once — a reconnect is not paid twice.
    expect(calls).toEqual(["orchestration"]);
  });

  test("drops unresolvable entries with their reason instead of failing", async () => {
    const result = await rehydrateActivation(["good", "gone", "gated"], {
      canonicalizeName: identity,
      resolve: (n) => {
        if (n === "gone") return "unknown";
        if (n === "gated") return "unavailable";
        return true;
      },
    });
    expect(result.active).toEqual(["good"]);
    expect(result.dropped).toEqual([
      { name: "gone", reason: "unknown" },
      { name: "gated", reason: "unavailable" },
    ]);
  });

  test("supports an async resolver — the reconnect case", async () => {
    const result = await rehydrateActivation(["mcp-live", "mcp-dead"], {
      canonicalizeName: identity,
      resolve: async (n) =>
        n === "mcp-live" ? true : ("unreachable" as const),
    });
    expect(result.active).toEqual(["mcp-live"]);
    expect(result.dropped).toEqual([
      { name: "mcp-dead", reason: "unreachable" },
    ]);
  });

  test("a throwing resolver costs its own entry, not the whole restore", async () => {
    // The contract the try/catch exists for: restoration is best-effort, and a
    // host resolver that reaches a database or decrypts a credential can reject
    // transiently. Failing the walk would strip a resumed session of every
    // other capability it had.
    const result = await rehydrateActivation(["good", "boom", "also-good"], {
      canonicalizeName: identity,
      resolve: (n) => {
        if (n === "boom") throw new Error("credential store timed out");
        return true;
      },
    });
    expect(result.active).toEqual(["good", "also-good"]);
    expect(result.dropped).toEqual([{ name: "boom", reason: "error" }]);
  });

  test("a rejecting async resolver drops the same way", async () => {
    const result = await rehydrateActivation(["boom", "fine"], {
      canonicalizeName: identity,
      resolve: (n) =>
        n === "boom" ? Promise.reject(new Error("nope")) : Promise.resolve(true),
    });
    expect(result.active).toEqual(["fine"]);
    expect(result.dropped).toEqual([{ name: "boom", reason: "error" }]);
  });

  test("reports the failure to the host, once, with the thrown value", async () => {
    const seen: Array<{ name: string; message: string }> = [];
    const error = new Error("credential store timed out");
    const result = await rehydrateActivation(["boom", "fine"], {
      canonicalizeName: identity,
      resolve: (n) => {
        if (n === "boom") throw error;
        return true;
      },
      onResolveError: (name, err) => {
        seen.push({ name, message: (err as Error).message });
      },
    });
    expect(seen).toEqual([{ name: "boom", message: "credential store timed out" }]);
    expect(result.active).toEqual(["fine"]);
  });

  test("an observer that throws does not defeat the guarantee it reports on", async () => {
    const result = await rehydrateActivation(["boom", "fine"], {
      canonicalizeName: identity,
      resolve: (n) => {
        if (n === "boom") throw new Error("resolve failed");
        return true;
      },
      onResolveError: () => {
        throw new Error("the host's logger choked");
      },
    });
    expect(result.active).toEqual(["fine"]);
    expect(result.dropped).toEqual([{ name: "boom", reason: "error" }]);
  });

  test("an empty persisted set rehydrates to nothing", async () => {
    const result = await rehydrateActivation([], {
      canonicalizeName: identity,
      resolve: () => true,
    });
    expect(result).toEqual({ active: [], dropped: [] });
  });
});

describe("initialActivePlugins", () => {
  test("de-duplicates the core list", () => {
    expect(initialActivePlugins(["a", "b", "a"])).toEqual(["a", "b"]);
  });
});

describe("partitionPluginCatalog", () => {
  const summaries: PluginSummary[] = [
    { name: "messaging", description: "send messages", isCorePlugin: true },
    { name: "canvas", description: "edit canvases", isCorePlugin: false },
    { name: "web", description: "fetch pages", isCorePlugin: false },
  ];

  test("splits active from loadable, preserving input order", () => {
    const { active, loadable } = partitionPluginCatalog(
      new Set(["messaging", "web"]),
      summaries,
    );
    expect(active.map((s) => s.name)).toEqual(["messaging", "web"]);
    expect(loadable.map((s) => s.name)).toEqual(["canvas"]);
  });

  test("an empty active set puts everything in loadable", () => {
    const { active, loadable } = partitionPluginCatalog(new Set(), summaries);
    expect(active).toEqual([]);
    expect(loadable).toHaveLength(3);
  });
});
