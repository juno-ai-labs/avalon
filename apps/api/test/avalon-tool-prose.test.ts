import { describe, expect, it } from "vitest";

import { hasAvalonToolProse } from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";

/**
 * A wire name with no prose fails silently into the humanizer and renders the
 * raw symbol this feature exists to remove, so the registered Avalon tools are
 * walked here rather than trusted to stay in sync by hand.
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

describe("Avalon tool prose coverage", () => {
  it("gives every registered Avalon tool its own transcript prose", () => {
    const tools = __integrationTesting.createAvalonTools(createTestEnv({}), workflowInput());
    const plugins = [
      ...__integrationTesting.createWorkstreamCorePlugins(tools),
      __integrationTesting.createAvalonWorkstreamPlugin(tools),
      __integrationTesting.createAvalonWebPlugin(tools),
    ].filter((plugin) => plugin !== null);

    const wireNames = plugins.flatMap((plugin) =>
      plugin.tools.map((tool) =>
        __integrationTesting.stableWireToolName(plugin.shortWireName ?? "", tool.definition.name)));

    expect(wireNames.length).toBeGreaterThan(0);
    expect(wireNames.filter((name) => !hasAvalonToolProse(name))).toEqual([]);
  });

  it("covers the tools injected outside the plugin builders", () => {
    // `run_subagent` is pushed onto the workstream plugin after construction,
    // and the discovery tools are injected unprefixed by Bind.
    for (const wireName of [
      "run_subagent",
      "list_plugins",
      "search_plugins",
      "load_plugin",
      "memory_recall",
      "memory_remember",
      "memory_forget",
      "table_search",
      "table_describe",
      "table_query",
      "table_create",
      "table_insert_rows",
      "table_update_rows",
      "table_invalidate_rows",
    ]) {
      expect(hasAvalonToolProse(wireName), `${wireName} has no transcript prose`).toBe(true);
    }
  });
});
