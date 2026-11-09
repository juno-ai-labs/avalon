/**
 * Progressive tool disclosure and child-run admission, driven through a real
 * loop instead of called directly.
 *
 * `registry.test.ts` and `activation.test.ts` never see a loop; `children.test.ts`
 * is 39 pure calls to `admitChildRun`. So the questions that actually decide
 * whether disclosure works — *is a plugin activated inside a batch visible to
 * the tools the NEXT turn is offered?* and *do two spawns in one batch both get
 * admitted against the same counter?* — have no coverage anywhere, because each
 * of them is a statement about two modules at once.
 */
import { describe, expect, test } from "vitest";
import type OpenAI from "openai";
import { runToolLoop } from "../loop/tool-loop";
import { createToolRegistry, type PluginSummary } from "../plugins/registry";
import {
  initialActivePlugins,
  partitionPluginCatalog,
  rehydrateActivation,
} from "../plugins/activation";
import { admitChildRun, descendChain, rootChain, type ChainRule } from "../run/children";
import { assistant, loopHarness, toolOutcome } from "../testing";

interface TestPlugin {
  name: string;
  description: string;
  tools: string[];
  isAvailable?: () => boolean;
}

function registryOf(plugins: TestPlugin[], corePlugins: string[] = ["core"]) {
  const registry = createToolRegistry<TestPlugin>({ corePlugins });
  for (const plugin of plugins) registry.register(plugin);
  return registry;
}

/** The tool set a host derives from its active plugins — the real `buildTools`. */
function toolsFor(
  registry: ReturnType<typeof registryOf>,
  active: ReadonlySet<string>,
): OpenAI.ChatCompletionTool[] {
  return [...active]
    .flatMap((name) => registry.get(name)?.tools ?? [])
    .map((tool) => ({
      type: "function" as const,
      function: { name: tool, description: tool, parameters: { type: "object" as const } },
    }));
}

const names = (tools: OpenAI.ChatCompletionTool[]) =>
  tools.map((t) => (t.type === "function" ? t.function.name : "?")).sort();

describe("a plugin loaded mid-batch reaches the next turn's tool set", () => {
  test("activation from the serial phase is visible to buildTools on turn 2", async () => {
    // The claim progressive disclosure rests on, composed: a real registry, a
    // real active set, and `buildTools` reading both. `activePlugins` (the set
    // the loop reads) and `activatePlugins` (the port it calls) are separate
    // parameters with nothing binding them to one object — a host that passes a
    // copy gets a run where loading a plugin appears to work and silently
    // changes nothing.
    const registry = registryOf([
      { name: "core", description: "core", tools: ["load_plugin"] },
      { name: "calendar", description: "calendar", tools: ["list_events", "create_event"] },
    ]);
    const active = new Set(initialActivePlugins(registry.corePlugins()));
    const toolSets: string[][] = [];

    const { params } = loopHarness([], {
      activePlugins: active,
      activatePlugins: (pluginNames) => {
        for (const name of pluginNames) active.add(registry.canonicalizeName(name));
      },
      buildTools: () => {
        const tools = toolsFor(registry, active);
        toolSets.push(names(tools));
        return tools;
      },
      runsSerially: (tc) => tc.type === "function" && tc.function.name === "load_plugin",
      runToolCall: async (tc) => ({
        ...toolOutcome(tc.id),
        loadedPluginName: "calendar",
      }),
      callModel: async () =>
        toolSets.length === 1
          ? {
              message: assistant("loading", [{ id: "l1", name: "load_plugin" }]),
              inputTokens: 1,
              outputTokens: 1,
              costCents: 0,
            }
          : { message: assistant("done"), inputTokens: 1, outputTokens: 1, costCents: 0 },
    });

    await runToolLoop(params);

    expect(toolSets[0]).toEqual(["load_plugin"]);
    expect(toolSets[1]).toEqual(["create_event", "list_events", "load_plugin"]);
  });

  test("a plugin loaded from the CONCURRENT phase is dropped, by design", async () => {
    // `loadedPluginName` is honoured only from the serial phase — a call that
    // reached the concurrent phase has already missed its window, because a
    // sibling may be running. Pinned because the field exists on every outcome
    // and its being ignored is invisible: the tool succeeds, the plugin does not
    // activate, and the model is simply never offered the tools it asked for.
    const registry = registryOf([
      { name: "core", description: "core", tools: ["noop"] },
      { name: "calendar", description: "calendar", tools: ["list_events"] },
    ]);
    const active = new Set(initialActivePlugins(registry.corePlugins()));
    const toolSets: string[][] = [];

    const { params } = loopHarness([], {
      activePlugins: active,
      activatePlugins: (pluginNames) => {
        for (const name of pluginNames) active.add(name);
      },
      buildTools: () => {
        const tools = toolsFor(registry, active);
        toolSets.push(names(tools));
        return tools;
      },
      // Nothing runs serially — the load lands in the concurrent phase.
      runsSerially: () => false,
      runToolCall: async (tc) => ({ ...toolOutcome(tc.id), loadedPluginName: "calendar" }),
      callModel: async () =>
        toolSets.length === 1
          ? {
              message: assistant("loading", [{ id: "l1", name: "load_plugin" }]),
              inputTokens: 1,
              outputTokens: 1,
              costCents: 0,
            }
          : { message: assistant("done"), inputTokens: 1, outputTokens: 1, costCents: 0 },
    });

    await runToolLoop(params);
    expect(toolSets[1]).toEqual(["noop"]);
    expect(active.has("calendar")).toBe(false);
  });

  test("a dependent tool in the SAME batch sees the plugin its predecessor loaded", async () => {
    // The whole point of the two-phase batch. The serial call activates, then
    // the concurrent phase runs — and a host checking `activePlugins` inside
    // `runToolCall` must already see it.
    const registry = registryOf([
      { name: "core", description: "core", tools: ["load_plugin", "use_it"] },
      { name: "calendar", description: "calendar", tools: ["list_events"] },
    ]);
    const active = new Set(initialActivePlugins(registry.corePlugins()));
    const sawCalendar: Array<[string, boolean]> = [];

    const { params } = loopHarness([], {
      activePlugins: active,
      activatePlugins: (pluginNames) => {
        for (const name of pluginNames) active.add(name);
      },
      buildTools: () => toolsFor(registry, active),
      runsSerially: (tc) => tc.type === "function" && tc.function.name === "load_plugin",
      runToolCall: async (tc) => {
        const name = tc.type === "function" ? tc.function.name : "?";
        sawCalendar.push([name, active.has("calendar")]);
        return name === "load_plugin"
          ? { ...toolOutcome(tc.id), loadedPluginName: "calendar" }
          : toolOutcome(tc.id);
      },
      callModel: async () =>
        sawCalendar.length === 0
          ? {
              message: assistant("batch", [
                { id: "dep", name: "use_it" },
                { id: "load", name: "load_plugin" },
              ]),
              inputTokens: 1,
              outputTokens: 1,
              costCents: 0,
            }
          : { message: assistant("done"), inputTokens: 1, outputTokens: 1, costCents: 0 },
    });

    await runToolLoop(params);
    // The serial load runs first even though it is second in the batch, so the
    // dependent call sees the plugin active.
    expect(sawCalendar).toEqual([
      ["load_plugin", false],
      ["use_it", true],
    ]);
  });

  test("the catalog the model is shown tracks the same set the loop mutates", async () => {
    // `partitionPluginCatalog` is what a host renders into the system prompt.
    // If it reads a different set than `buildTools` does, the model is told a
    // plugin is loadable while its tools are already present — or the reverse.
    const registry = registryOf([
      { name: "core", description: "core", tools: ["load_plugin"] },
      { name: "calendar", description: "calendar", tools: ["list_events"] },
      { name: "email", description: "email", tools: ["send"] },
    ]);
    const active = new Set(initialActivePlugins(registry.corePlugins()));
    const catalogs: Array<{ active: string[]; loadable: string[] }> = [];
    const summaries: PluginSummary[] = registry.summaries();

    const { params } = loopHarness([], {
      activePlugins: active,
      activatePlugins: (pluginNames) => {
        for (const name of pluginNames) active.add(name);
      },
      buildTools: () => {
        const partition = partitionPluginCatalog(active, summaries);
        catalogs.push({
          active: partition.active.map((p) => p.name),
          loadable: partition.loadable.map((p) => p.name),
        });
        return toolsFor(registry, active);
      },
      runsSerially: () => true,
      runToolCall: async (tc) => ({ ...toolOutcome(tc.id), loadedPluginName: "calendar" }),
      callModel: async () =>
        catalogs.length === 1
          ? {
              message: assistant("loading", [{ id: "l", name: "load_plugin" }]),
              inputTokens: 1,
              outputTokens: 1,
              costCents: 0,
            }
          : { message: assistant("done"), inputTokens: 1, outputTokens: 1, costCents: 0 },
    });

    await runToolLoop(params);
    expect(catalogs[0]).toEqual({ active: ["core"], loadable: ["calendar", "email"] });
    expect(catalogs[1]).toEqual({ active: ["core", "calendar"], loadable: ["email"] });
  });
});

describe("a persisted activation set crossing a run boundary", () => {
  test("a plugin that went unavailable leaves no stale tool in the next run", async () => {
    // Run 1 activates `calendar`; between runs the integration is disconnected.
    // Rehydration must drop it AND the tool set must follow — a host that
    // restores the names but builds tools from the persisted list rather than
    // the rehydrated one offers the model a tool whose backend is gone.
    let calendarAvailable = true;
    const registry = registryOf([
      { name: "core", description: "core", tools: ["load_plugin"] },
      {
        name: "calendar",
        description: "calendar",
        tools: ["list_events"],
        isAvailable: () => calendarAvailable,
      },
    ]);

    const persisted = ["core", "calendar"];
    calendarAvailable = false;

    const restored = await rehydrateActivation(persisted, {
      canonicalizeName: (name) => registry.canonicalizeName(name),
      resolve: (name) => (registry.get(name) === undefined ? "unavailable" : true),
    });

    expect(restored.active).toEqual(["core"]);
    expect(restored.dropped).toEqual([{ name: "calendar", reason: "unavailable" }]);

    const active = new Set(restored.active);
    const toolSets: string[][] = [];
    const { params } = loopHarness([{ message: assistant("nothing to do") }], {
      activePlugins: active,
      buildTools: () => {
        const tools = toolsFor(registry, active);
        toolSets.push(names(tools));
        return tools;
      },
    });
    await runToolLoop(params);

    expect(toolSets[0]).toEqual(["load_plugin"]);
  });

  test("a renamed plugin survives through its alias rather than being stripped", async () => {
    // The reason aliases exist: persisted state stores names, so a rename would
    // otherwise silently remove a capability from every live session.
    const registry = createToolRegistry<TestPlugin>({
      corePlugins: ["core"],
      aliases: { agenda: "calendar" },
    });
    registry.register({ name: "core", description: "core", tools: ["noop"] });
    registry.register({ name: "calendar", description: "calendar", tools: ["list_events"] });

    const restored = await rehydrateActivation(["agenda", "calendar"], {
      canonicalizeName: (name) => registry.canonicalizeName(name),
      resolve: (name) => (registry.get(name) === undefined ? "unavailable" : true),
    });

    // Both names collapse to one plugin rather than activating it twice.
    expect(restored.active).toEqual(["calendar"]);
    expect(toolsFor(registry, new Set(restored.active)).length).toBe(1);
  });

  test("a resolver that throws drops the entry rather than failing the restore", async () => {
    const errors: string[] = [];
    const restored = await rehydrateActivation(["good", "explodes"], {
      canonicalizeName: (name) => name,
      resolve: (name) => {
        if (name === "explodes") throw new Error("connection refused");
        return true;
      },
      onResolveError: (name) => errors.push(name),
    });
    expect(restored.active).toEqual(["good"]);
    expect(errors).toEqual(["explodes"]);
  });
});

describe("child-run admission from inside a tool batch", () => {
  test("DOCUMENTED RACE: two spawns in one batch both admit past a chain budget of one", async () => {
    // `children.ts` names this race in prose and cannot enforce against it: both
    // calls read `runsInChain` before either has created a run, so both see the
    // pre-batch count. This drives it through the real loop so the breach is a
    // failing number rather than a caveat — a chain capped at 2 runs produces 3.
    let runsInChain = 1; // the parent
    const admitted: string[] = [];
    const parent = rootChain();

    const { params } = loopHarness([], {
      callModel: async () =>
        admitted.length === 0
          ? {
              message: assistant("spawning", [
                { id: "s1", name: "spawn" },
                { id: "s2", name: "spawn" },
              ]),
              inputTokens: 1,
              outputTokens: 1,
              costCents: 0,
            }
          : { message: assistant("done"), inputTokens: 1, outputTokens: 1, costCents: 0 },
      runToolCall: async (tc) => {
        // Exactly what a spawn tool does: read the counts (a round trip — hence
        // the await, and hence the race), admit, then create the run.
        // The read is the round trip, and it is where the race lives: both
        // calls capture the count before either has created its run.
        const observed = await Promise.resolve(runsInChain);
        const rules: ChainRule[] = [
          { kind: "chain_budget", runsInChain: observed, maxRuns: 2 },
          { kind: "depth", parentDepth: parent.depth, maxDepth: 5 },
        ];
        const decision = admitChildRun(rules);
        if (decision.admitted) {
          admitted.push(tc.id);
          runsInChain += 1; // ...after both have already measured
        }
        return toolOutcome(tc.id, { admitted: decision.admitted });
      },
    });

    await runToolLoop(params);

    // The budget said one more run; two were admitted.
    expect(admitted).toEqual(["s1", "s2"]);
    expect(runsInChain).toBe(3);
  });

  test("the same pair, measured serially, admits exactly one", async () => {
    // The control that makes the race legible: nothing is wrong with the rule.
    let runsInChain = 1;
    const admitted: string[] = [];
    for (const id of ["s1", "s2"]) {
      const decision = admitChildRun([{ kind: "chain_budget", runsInChain, maxRuns: 2 }]);
      if (decision.admitted) {
        admitted.push(id);
        runsInChain += 1;
      }
    }
    expect(admitted).toEqual(["s1"]);
  });

  test("a refusal reaches the model as its own call's answer, with its reason", async () => {
    // The refusal has to be addressable: the model needs to know WHICH spawn was
    // refused, or it re-asks for the one that succeeded.
    const { params, state } = loopHarness([], {
      callModel: async () =>
        state.messages.some((m) => m.role === "tool")
          ? { message: assistant("ok"), inputTokens: 1, outputTokens: 1, costCents: 0 }
          : {
              message: assistant("spawning", [
                { id: "deep", name: "spawn" },
                { id: "fine", name: "spawn" },
              ]),
              inputTokens: 1,
              outputTokens: 1,
              costCents: 0,
            },
      runToolCall: async (tc) => {
        const decision = admitChildRun([
          {
            kind: "depth",
            parentDepth: tc.id === "deep" ? 5 : 0,
            maxDepth: 5,
          },
        ]);
        return toolOutcome(
          tc.id,
          decision.admitted ? { ok: true } : { ok: false, error: decision.reason },
        );
      },
    });

    await runToolLoop(params);
    const answers = state.messages.filter((m) => m.role === "tool");
    const deep = answers.find((m) => m.role === "tool" && m.tool_call_id === "deep");
    expect(String(deep?.content)).toContain("false");
    const fine = answers.find((m) => m.role === "tool" && m.tool_call_id === "fine");
    expect(String(fine?.content)).toContain("true");
  });

  test("lineage descends correctly across generations, so each one measures itself", async () => {
    // `descendChain` is what makes the depth rule mean anything on the child's
    // own next spawn, and the root-id fallback is the part hosts get wrong: a
    // depth-1 child adopts its parent's *id*, a grandchild adopts the root the
    // parent already carries. Backwards, every generation starts a fresh chain
    // and every per-chain bound counts the wrong set — silently, because the
    // counts stay reassuringly small.
    let chain = rootChain();
    const depths: number[] = [];
    const roots: Array<string | null> = [];
    for (let generation = 0; generation < 8; generation++) {
      const decision = admitChildRun([
        { kind: "depth", parentDepth: chain.depth, maxDepth: 5 },
      ]);
      if (!decision.admitted) break;
      chain = descendChain(`run_${generation}`, chain);
      depths.push(chain.depth);
      roots.push(chain.rootRunId);
    }
    // The rule rejects once the CHILD would reach maxDepth, so a maxDepth of 5
    // permits parents at depth 0..3 and the deepest child lands at 4 — five runs
    // counting the root, which is what the rule's own docstring says and one
    // fewer than "children reach depth 5" reads like.
    expect(depths).toEqual([1, 2, 3, 4]);
    // Every generation carries the SAME root — the first spawner.
    expect(roots).toEqual(["run_0", "run_0", "run_0", "run_0"]);
    expect(chain.parentRunId).toBe("run_3");
  });
});
