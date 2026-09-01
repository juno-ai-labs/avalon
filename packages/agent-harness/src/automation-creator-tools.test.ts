import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_PLUGIN_ID,
  createAutomationsPlugin,
  type AutomationCreatorToolHost,
} from "./automation-creator-tools";

function host(): AutomationCreatorToolHost {
  return {
    catalog: [],
    inspectedPluginIds: new Set(),
    resolvedResources: new Map(),
    loadedPluginIds: new Set(),
    resolvedPersonIds: new Set(),
    draftState: { submitted: null },
    model: "test/model",
  };
}

describe("the automations plugin", () => {
  it("is deferred, so loading it is the agent's decision and not a preload", () => {
    const plugin = createAutomationsPlugin(host());

    // Discovered through list_plugins and loaded with load_plugin, the way
    // rally:terminal is. Preloading would put drafting tools in every run
    // whether or not anybody asked for an automation.
    expect(plugin.preload).toBe(false);
    expect(plugin.explicit).toBe(false);
    expect(plugin.canonicalId).toBe(AUTOMATIONS_PLUGIN_ID);
  });

  it("carries the drafting tools it already had, and adds none", () => {
    const names = createAutomationsPlugin(host()).tools.map((tool) => tool.definition.name);

    // The same seven the dedicated compiler harness has always used, from one
    // definition rather than a second copy: these tools decide what a draft may
    // say, and two answers to that is two products.
    expect(names).toEqual([
      "plugins_list",
      "plugins_search",
      "plugin_inspect",
      "people_search",
      "resources_search",
      "submit_draft",
      "set_evaluator_rules",
    ]);
  });

  it("tells the agent to ask for a scope it cannot change afterwards", () => {
    const { systemMessage } = createAutomationsPlugin(host());

    // The three scopes, and what each one means for who can manage the result.
    expect(systemMessage).toContain("personal");
    expect(systemMessage).toContain("workspace");
    expect(systemMessage).toContain("workstream");
    expect(systemMessage).toContain("cannot be changed afterwards");
    // The room an automation belongs to is the one it was written in, so an
    // agent offering to deliver somewhere else is offering something that does
    // not exist.
    expect(systemMessage).toContain("never deliver into a different work stream");
  });

  it("never activates anything on its own", () => {
    // Every tool here drafts or researches. Acceptance is a person's act, and
    // an agent that could accept its own proposal would make the card a
    // formality.
    const modes = createAutomationsPlugin(host()).tools
      .map((tool) => tool.definition.name);
    expect(modes).not.toContain("accept_draft");
    expect(modes).not.toContain("activate");
    expect(createAutomationsPlugin(host()).systemMessage)
      .toContain("you never activate one");
  });
});
