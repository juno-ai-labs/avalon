import { describe, expect, it } from "vitest";

import {
  AVALON_CORE_PLUGIN_ID,
  AVALON_MEMORY_PLUGIN_ID,
  AVALON_TABLES_PLUGIN_ID,
  type HarnessPlugin,
} from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";

/**
 * The always-active plugins are the ones a model cannot load, unload, or choose
 * between, so a wire prefix on them buys nothing and costs a name the model has
 * to read. `rally:core` drops it; `rally:memory` and `rally:tables` cannot,
 * because their canonical names are plugin-local verbs that collide.
 */
const workflowInput = (): WorkstreamWorkflowInput => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  parentKind: "workstream",
  parentId: "00000000-0000-4000-8000-000000000002",
  loopId: "workstream:00000000-0000-4000-8000-000000000002:substream:0:loop",
  harnessRunId: "00000000-0000-4000-8000-000000000003",
  region: "global",
  reason: "human_message",
  executionPrincipal: { type: "user", userId: "00000000-0000-4000-8000-000000000000" },
} as WorkstreamWorkflowInput);

function corePlugins(): HarnessPlugin[] {
  return __integrationTesting.createWorkstreamCorePlugins(
    __integrationTesting.createAvalonTools(createTestEnv({}), workflowInput()),
  );
}

function corePlugin(canonicalId: string): HarnessPlugin {
  const plugin = corePlugins().find((candidate) => candidate.canonicalId === canonicalId);
  if (!plugin) throw new Error(`${canonicalId} is not registered as a core plugin`);
  return plugin;
}

function wireNames(plugin: HarnessPlugin): string[] {
  return plugin.tools
    .map((tool) => __integrationTesting.stableWireToolName(plugin.shortWireName ?? "", tool.definition.name))
    .sort();
}

describe("core plugin wire names", () => {
  it("advertises every rally:core tool under its canonical name", () => {
    expect(wireNames(corePlugin(AVALON_CORE_PLUGIN_ID))).toEqual([
      "current_time",
      "get_connector_connection_state",
      "request_elicitation",
      "show_connector_connection",
    ]);
  });

  it("names each core tool in its instructions by the wire name the model will call", () => {
    const core = corePlugin(AVALON_CORE_PLUGIN_ID);
    for (const wireName of wireNames(core)) {
      expect(core.systemMessage, `${wireName} is not named in the core instructions`)
        .toContain(wireName);
      expect(core.systemMessage, `the core instructions still say core_${wireName}`)
        .not.toContain(`core_${wireName}`);
    }
  });

  it("keeps the prefix where the canonical names are local verbs that collide", () => {
    const memory = corePlugin(AVALON_MEMORY_PLUGIN_ID);
    const tables = corePlugin(AVALON_TABLES_PLUGIN_ID);
    expect(memory.shortWireName).toBe("memory");
    expect(tables.shortWireName).toBe("table");

    // Why they keep it: unprefixed, both plugins advertise `search`, and Bind
    // rejects a duplicate always-active wire name outright. The rest reach the
    // model as bare verbs — `add`, `create`, `update` — which is the naming
    // `docs/agent-tools.md` exists to prevent.
    const canonical = [memory, tables].flatMap((plugin) =>
      plugin.tools.map((tool) => tool.definition.name));
    expect(new Set(canonical).size).toBeLessThan(canonical.length);
  });
});
