import { AutomationSetEvaluatorRulesInputV1Schema } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_PLUGIN_ID,
  createAutomationsPlugin,
  rememberAutomationPeopleSearchResult,
  rememberAutomationResourceSearchResult,
  type AutomationCreatorToolHost,
} from "./automation-creator-tools";

function host(overrides: Partial<AutomationCreatorToolHost> = {}): AutomationCreatorToolHost {
  return {
    catalog: [],
    inspectedPluginIds: new Set(),
    resolvedResources: new Map(),
    loadedPluginIds: new Set(),
    resolvedPersonIds: new Set(),
    draftState: { submitted: null },
    model: "test/model",
    ...overrides,
  };
}

/** A ready draft whose one trigger needs evaluator rules. */
const eventDrivenDraft = {
  name: "Report on new pages",
  description: "Report when a page is created.",
  overview: "Reports newly created pages.",
  instructions: "Report the page.",
  triggers: [{
    type: "connector_activity",
    connectorType: "notion",
    sourceBindingKey: "notion_source",
    suggestedSourcePluginId: "plugin_notion",
    eventTypes: ["notion.page.created"],
    deterministicFilters: {},
  }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: "personal",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

/** Rules that name the draft's one trigger, so a ready submission is admitted. */
const eventDrivenRules = {
  schemaVersion: 1,
  evaluators: [{
    evaluatorKey: "page_created",
    source: {
      sourceBindingKey: "notion_source",
      suggestedSourcePluginId: "plugin_notion",
      event: { kind: "event_type", eventType: "notion.page.created" },
    },
    when: { kind: "always" },
  }],
};

const toolContext = { toolCallId: "call-1" } as never;

function toolNamed(tools: ReturnType<typeof createAutomationsPlugin>["tools"], name: string) {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("the automations plugin", () => {
  it("rebuilds researched people and resources from replayed search output", () => {
    const people = new Set<string>();
    const resources: AutomationCreatorToolHost["resolvedResources"] = new Map();

    rememberAutomationPeopleSearchResult({ people: [{ id: "person-1" }, { id: 42 }] }, people);
    rememberAutomationResourceSearchResult({
      resources: [{
        id: "resource-1",
        pluginId: "plugin_google",
        resourceType: "gmail_thread",
        sourceBindingKeys: ["google_source", 42],
      }],
    }, resources);

    expect(people).toEqual(new Set(["person-1"]));
    expect(resources).toEqual(new Map([[
      "resource-1",
      {
        pluginId: "plugin_google",
        resourceType: "gmail_thread",
        sourceBindingKeys: ["google_source"],
      },
    ]]));
  });

  it("is deferred, so loading it is the agent's decision and not a preload", () => {
    const plugin = createAutomationsPlugin(host());

    // Discovered through list_plugins and loaded with load_plugin, the way
    // rally:terminal is. Preloading would put drafting tools in every run
    // whether or not anybody asked for an automation.
    expect(plugin.preload).toBe(false);
    expect(plugin.explicit).toBe(false);
    expect(plugin.canonicalId).toBe(AUTOMATIONS_PLUGIN_ID);
  });

  it("carries the drafting tools from one definition, plus the list an edit starts from", () => {
    const names = createAutomationsPlugin(host()).tools.map((tool) => tool.definition.name);

    // From one definition rather than a second copy: these tools decide what a
    // draft may say, and two answers to that is two products. The list is the
    // one addition: an edit starts from a definition the conversation owns.
    expect(names).toEqual([
      "plugins_list",
      "plugins_search",
      "plugin_inspect",
      "people_search",
      "resources_search",
      "automations_list",
      "submit_draft",
      "set_evaluator_rules",
    ]);
  });

  it("lists what the conversation may edit through the host, and tells the agent to start there", async () => {
    const listed = { automations: [{ automationId: "a-1", name: "Standup reminder" }] };
    const state = host({ automationDirectoryPort: { listAutomations: async () => listed } });
    const plugin = createAutomationsPlugin(state);

    await expect(toolNamed(plugin.tools, "automations_list").execute({}, toolContext))
      .resolves.toMatchObject({ output: listed });
    expect(plugin.systemMessage).toContain("call automations_list");
    expect(plugin.systemMessage).toContain("with its automationId");
  });

  it("hands the named automation to the host beside the draft, and never inside it", async () => {
    const targets: Array<{ automationId: string | null }> = [];
    const drafts: unknown[] = [];
    const state = host({
      loadedPluginIds: new Set(["plugin_notion"]),
      inspectedPluginIds: new Set(["plugin_notion"]),
      draftMutationPort: {
        submitDraft: async (draft, _context, target) => {
          drafts.push(draft);
          targets.push(target);
          return { accepted: true as const };
        },
        setEvaluatorRules: async () => ({ accepted: true as const }),
      },
    });
    // Staged on the host as `set_evaluator_rules` leaves them; that tool's own
    // vocabulary check is its own test.
    state.draftState.evaluatorRules = AutomationSetEvaluatorRulesInputV1Schema.parse(eventDrivenRules);
    const tools = createAutomationsPlugin(state).tools;

    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, automationId: "a-1" }, toolContext);
    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, automationId: null }, toolContext);
    await toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext);

    expect(targets).toEqual([{ automationId: "a-1" }, { automationId: null }, { automationId: null }]);
    // The draft is the definition an automation stores; the address it is
    // stored at is not part of it.
    expect(drafts.every((draft) => !("automationId" in (draft as object)))).toBe(true);
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

describe("submitting a draft that needs evaluator rules", () => {
  /**
   * A host whose plugin is loaded and inspected, so the submission reaches the
   * evaluator check rather than stopping at the plugin one above it.
   */
  function readyHost(): AutomationCreatorToolHost {
    return host({
      loadedPluginIds: new Set(["plugin_notion"]),
      inspectedPluginIds: new Set(["plugin_notion"]),
      draftMutationPort: {
        submitDraft: async () => ({ accepted: true as const }),
        setEvaluatorRules: async () => ({ accepted: true as const }),
      },
    });
  }

  it("tells the model which tool to call rather than handing it an error code", async () => {
    const tools = createAutomationsPlugin(readyHost()).tools;

    // AutomationAgent refuses this too, but its message reaches the model as a
    // bare `automation_evaluator_rules_required` tagged an external fault. A
    // model given that resubmits the same draft; the sentence names the tool.
    await expect(toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext))
      .rejects.toThrow(/Call set_evaluator_rules .* before submitting a ready draft/u);
  });

  it("admits the same draft once the rules have been set", async () => {
    const state = readyHost();
    const tools = createAutomationsPlugin(state).tools;
    await toolNamed(tools, "set_evaluator_rules").execute({
      schemaVersion: 1,
      evaluators: [],
    }, toolContext);

    // An empty set is the tool's documented way to *clear* rules, so it must
    // not satisfy the requirement either.
    await expect(toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext))
      .rejects.toThrow(/Call set_evaluator_rules/u);
  });

  it("names the disagreement when a rule binds a source the triggers do not declare", async () => {
    const state = readyHost();
    // Rules staged for a binding key the draft's trigger does not carry: the
    // object refuses this as a bare `automation_activity_source_unbound`, the
    // second code the pre-check exists to phrase. The sentence has to name the
    // tool and the repair, or the model resubmits the same draft. Staged on
    // the host directly, as `set_evaluator_rules` leaves them: that tool also
    // validates the rule against the inspected plugin's vocabulary, which is
    // its own test and not the disagreement under test here.
    state.draftState.evaluatorRules = AutomationSetEvaluatorRulesInputV1Schema.parse({
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "page_created",
        source: {
          sourceBindingKey: "notion_pages",
          suggestedSourcePluginId: "plugin_notion",
          event: { kind: "event_type", eventType: "notion.page.created" },
        },
        when: { kind: "always" },
      }],
    });
    const tools = createAutomationsPlugin(state).tools;

    await expect(toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext))
      .rejects.toThrow(/sourceBindingKey and suggestedSourcePluginId must match .* Call set_evaluator_rules again/u);
    expect(state.draftState.submitted).toBeNull();
  });

  it("leaves a partial draft and a draft with no event trigger alone", async () => {
    const tools = createAutomationsPlugin(readyHost()).tools;

    // The clarifying-question flow: rules are not chosen yet, and the object
    // refuses a non-ready draft at acceptance on `ready` alone anyway.
    await expect(toolNamed(tools, "submit_draft")
      .execute({ ...eventDrivenDraft, ready: false }, toolContext)).resolves.toMatchObject({
        output: { accepted: true },
      });
    await expect(toolNamed(tools, "submit_draft").execute({
      ...eventDrivenDraft,
      triggers: [{ type: "manual" }],
    }, toolContext)).resolves.toMatchObject({ output: { accepted: true } });
  });
});
