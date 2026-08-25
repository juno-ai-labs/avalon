import { describe, expect, it } from "vitest";

import { toolActivityName } from "@rally/agent-harness";
import { __integrationTesting } from "../src/services/integrations";
import { createTestConnectorRegistry } from "./helpers/connector-registry";

/**
 * Every connector tool, walked from the registry rather than listed by hand.
 *
 * A transcript row that falls through to "Reviewed <connector>" is not a
 * cosmetic miss: it is the only description a person gets of what the run did
 * to their account, and it reads as passive even when the call sent a message
 * or created a record. That happened in production for `gmail.create_draft`,
 * and when it was fixed for Gmail alone the same fallthrough was still live on
 * 39 other tools — a leaf-keyed verb lookup that only worked for the two
 * connectors naming a tool `<object>_<verb>`.
 *
 * Walking the registry is what makes this a standing guard rather than a
 * snapshot: a connector added next year fails here until it either names its
 * tools with a recognized verb or declares its own prose.
 */
function everyConnectorTool(): {
  connector: string;
  tool: string;
  mode: "read" | "write";
  wireName: string;
  displayName: string;
}[] {
  const registry = createTestConnectorRegistry();
  return registry.list().flatMap((manifest) => {
    const adapter = registry.get(manifest.type);
    return adapter.agentPlugin.tools.map((definition) => ({
      connector: manifest.type,
      tool: definition.name,
      mode: definition.mode,
      wireName: __integrationTesting.stableWireToolName(adapter.agentPlugin.wireNamePrefix, definition.name),
      displayName: manifest.displayName,
    }));
  });
}

describe("connector transcript prose", () => {
  it("names what every connector tool did, rather than falling back to the connector", () => {
    const tools = everyConnectorTool();
    expect(tools.length).toBeGreaterThan(40);

    const generic = tools.filter(({ wireName, connector, displayName }) => {
      const label = toolActivityName({
        toolName: wireName,
        status: "completed",
        plugin: { pluginId: `plugin_${connector}`, displayName },
      });
      return label === `Reviewed ${displayName}`;
    });

    expect(generic.map((entry) => `${entry.connector}.${entry.tool}`)).toEqual([]);
  });

  it("says a write happened, on the tools that write, in both tenses", () => {
    // The failure this guards is narrower than the one above and worse: a row
    // that says "Reviewed" for a call that sent, created, or changed something
    // understates it to the only person who could object. Every verb that
    // *reads* is listed, not a sample of them, and both lifecycle states are
    // checked — a passive `started` label is on screen for as long as the call
    // takes, which is exactly when someone might still stop it.
    const passive = new RegExp(
      `^(${[
        "Review", "Read", "Search", "List", "Fetch", "Check", "Look",
        "Query", "Queried", "Download", "Export", "Browse", "View", "Inspect",
      ].join("|")})`,
      "u",
    );
    const writes = everyConnectorTool().filter((entry) => entry.mode === "write");

    expect(writes.length).toBeGreaterThan(5);
    const understated = writes.flatMap(({ wireName, connector, displayName, tool }) =>
      (["started", "completed"] as const)
        .map((status) => ({
          status,
          label: toolActivityName({
            toolName: wireName,
            status,
            plugin: { pluginId: `plugin_${connector}`, displayName },
          }),
        }))
        .filter(({ label }) => passive.test(label))
        .map(({ status, label }) => `${connector}.${tool} (${status}): ${label}`));

    expect(understated).toEqual([]);
  });
});
