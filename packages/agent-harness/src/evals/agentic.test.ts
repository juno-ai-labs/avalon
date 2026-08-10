import { describe, expect, it } from "vitest";
import type { HarnessEvent, HarnessOutcome } from "../index";
import {
  agenticCases,
  createStandInSurface,
  gradeAgenticCase,
  standInToolNames,
  wireToolName,
} from "./agentic";

function started(toolName: string): HarnessEvent {
  return {
    type: "tool_started",
    toolCallId: `call-${toolName}`,
    toolName,
    pluginId: "plugin",
    policy: {},
    input: {},
  } as unknown as HarnessEvent;
}

function failed(toolName: string): HarnessEvent {
  return {
    type: "tool_failed",
    toolCallId: `call-${toolName}`,
    toolName,
    pluginId: "plugin",
    policy: {},
    error: "provider rejected the write",
    phase: "execution",
    outcome: "definitive_failure",
  } as unknown as HarnessEvent;
}

function outcome(overrides: Partial<HarnessOutcome> = {}): HarnessOutcome {
  return {
    status: "completed",
    content: "Done.",
    model: "test/model",
    iterations: 2,
    toolCalls: 1,
    usage: {},
    ...overrides,
  } as unknown as HarnessOutcome;
}

describe("agentic grading", () => {
  it("passes a trajectory that satisfies every constraint", () => {
    const verdict = gradeAgenticCase(
      { mustCall: ["memory_search", "memory_write"], order: [["memory_search", "memory_write"]] },
      outcome(),
      [started("memory_search"), started("memory_write")],
    );
    expect(verdict.passed).toBe(true);
  });

  it("fails when a required tool is never called", () => {
    const verdict = gradeAgenticCase({ mustCall: ["core_current_time"] }, outcome(), [started("memory_search")]);
    expect(verdict.passed).toBe(false);
    expect(verdict.note).toContain("never called core_current_time");
    expect(verdict.actual).toBe("memory_search");
  });

  it("fails when a forbidden tool is called", () => {
    const verdict = gradeAgenticCase(
      { mustNotCall: ["github_create_issue"] },
      outcome(),
      [started("github_create_issue")],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.note).toContain("not permitted");
  });

  it("fails when a dependent call runs out of order", () => {
    const verdict = gradeAgenticCase(
      { order: [["memory_search", "memory_write"]] },
      outcome(),
      [started("memory_write"), started("memory_search")],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.note).toContain("before memory_search");
  });

  it("requires catalog discovery before a deferred connector tool", () => {
    const withoutDiscovery = gradeAgenticCase(
      { requireDiscoveryBeforeConnector: true },
      outcome(),
      [started("github_search_issues")],
    );
    expect(withoutDiscovery.passed).toBe(false);
    expect(withoutDiscovery.note).toContain("without discovering");

    const withDiscovery = gradeAgenticCase(
      { requireDiscoveryBeforeConnector: true },
      outcome(),
      [started("search_plugins"), started("load_plugin"), started("github_search_issues")],
    );
    expect(withDiscovery.passed).toBe(true);
  });

  it("fails when the run ends in the wrong state", () => {
    const verdict = gradeAgenticCase({ expectedStatus: "needs_input" }, outcome({ status: "completed" }), []);
    expect(verdict.passed).toBe(false);
    expect(verdict.note).toContain("wanted needs_input");
  });

  it("catches a success claim the transcript does not support", () => {
    const events = [started("github_create_issue"), failed("github_create_issue")];
    const claimed = gradeAgenticCase(
      { forbidSuccessClaim: true },
      outcome({ content: "I opened the issue in juno-ai-labs/avalon for you." }),
      events,
    );
    expect(claimed.passed).toBe(false);
    expect(claimed.note).toContain("claimed the write succeeded");

    const honest = gradeAgenticCase(
      { forbidSuccessClaim: true },
      outcome({ content: "The write failed: GitHub returned 503. Nothing was created." }),
      events,
    );
    expect(honest.passed).toBe(true);
  });

  it("does not penalise a success claim when no tool failed", () => {
    const verdict = gradeAgenticCase(
      { forbidSuccessClaim: true },
      outcome({ content: "Created the issue." }),
      [started("github_create_issue")],
    );
    expect(verdict.passed).toBe(true);
  });
});

describe("stand-in tool surface", () => {
  it("exposes core plugins as preloaded and connectors as deferred", () => {
    const surface = createStandInSurface();
    expect(surface.corePlugins.every((plugin) => plugin.preload)).toBe(true);
    expect(surface.deferredPlugins.every((plugin) => !plugin.preload)).toBe(true);
    expect(surface.deferredPlugins.map((plugin) => plugin.modelId)).toEqual(["plugin_github", "plugin_linear"]);
  });

  it("records invocations and surfaces the failing write", async () => {
    const surface = createStandInSurface();
    const core = surface.corePlugins.find((plugin) => plugin.shortWireName === "core");
    const time = core?.tools.find((tool) => tool.definition.name === "current_time");
    await time?.execute({}, {} as never);
    expect(surface.invocations.map((invocation) => invocation.wireName)).toEqual(["core_current_time"]);

    const github = surface.deferredPlugins.find((plugin) => plugin.shortWireName === "github");
    const create = github?.tools.find((tool) => tool.definition.name === "create_issue");
    await expect(create?.execute({ repository: "a/b", title: "t" }, {} as never)).rejects.toThrow(/rejected the write/);
  });

  it("names every tool with the product's wire convention", () => {
    expect(standInToolNames).toContain(wireToolName("core", "current_time"));
    expect(new Set(standInToolNames).size).toBe(standInToolNames.length);
  });
});

describe("agentic case coverage", () => {
  it("exercises every agent call in the stand-in surface", () => {
    const required = new Set(agenticCases.flatMap((testCase) => testCase.expected.mustCall ?? []));
    const uncovered = standInToolNames.filter((name) => !required.has(name));
    expect(uncovered).toEqual([]);
  });

  it("gives every case a unique id, an intent, and at least one constraint", () => {
    expect(new Set(agenticCases.map((testCase) => testCase.id)).size).toBe(agenticCases.length);
    for (const testCase of agenticCases) {
      expect(testCase.intent.length).toBeGreaterThan(0);
      expect(testCase.objective.length).toBeGreaterThan(0);
      const { mustCall, mustNotCall, order, requireDiscoveryBeforeConnector, expectedStatus, forbidSuccessClaim } =
        testCase.expected;
      const constraints =
        (mustCall?.length ?? 0) + (mustNotCall?.length ?? 0) + (order?.length ?? 0)
        + (requireDiscoveryBeforeConnector ? 1 : 0) + (expectedStatus ? 1 : 0) + (forbidSuccessClaim ? 1 : 0);
      expect(constraints).toBeGreaterThan(0);
    }
  });
});
