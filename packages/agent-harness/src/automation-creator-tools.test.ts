import { AutomationSetEvaluatorRulesInputV1Schema } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_PLUGIN_ID,
  createAutomationsPlugin,
  rememberAutomationPeopleSearchResult,
  rememberAutomationResourceSearchResult,
  type AutomationCreatorToolHost,
} from "./automation-creator-tools";
import { AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS } from "./index";

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

    const named = "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f";
    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, automationId: named }, toolContext);
    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, automationId: null }, toolContext);
    await toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext);
    // What a model that fills every property puts here: a slash, a nil UUID.
    // Neither names an automation, and handed through they threw from the
    // directory lookup as a bare schema error the model retried identically.
    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, automationId: "/" }, toolContext);
    await toolNamed(tools, "submit_draft")
      .execute({ ...eventDrivenDraft, automationId: "00000000-0000-4000-8000-000000000000" }, toolContext);

    expect(targets).toEqual([
      { automationId: named },
      { automationId: null },
      { automationId: null },
      { automationId: null },
      { automationId: null },
    ]);
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

  it("publishes ready submissions without a separate activation tool", () => {
    // Publication belongs to the authorized host submission boundary.
    const modes = createAutomationsPlugin(host()).tools
      .map((tool) => tool.definition.name);
    expect(modes).not.toContain("accept_draft");
    expect(modes).not.toContain("activate");
    expect(createAutomationsPlugin(host()).systemMessage)
      .toContain("A ready submission saves and activates immediately");
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

describe("set_evaluator_rules and a resource the rule is not about", () => {
  const pageCreated = {
    eventType: "notion.page.created",
    label: "Page created",
    description: "A page was created.",
    eventFamilies: [],
    filterFields: [],
    resourceRelationships: [{ relationship: "page" as const, resourceType: "notion_page" }],
    digestible: true,
  };

  function ruleHost(resolvedResources: AutomationCreatorToolHost["resolvedResources"] = new Map()) {
    const staged: unknown[] = [];
    const state = host({
      catalog: [{
        pluginId: "plugin_notion",
        displayName: "Notion",
        icon: "brand-notion",
        description: "Notion pages.",
        scope: "workspace",
        searchAliases: [],
        systemMessage: "",
        activityTriggers: [pageCreated],
        tools: [],
      }],
      inspectedPluginIds: new Set(["plugin_notion"]),
      loadedPluginIds: new Set(["plugin_notion"]),
      resolvedResources,
      draftMutationPort: {
        submitDraft: async () => ({ accepted: true as const }),
        setEvaluatorRules: async (rules) => {
          staged.push(rules);
          return { accepted: true as const };
        },
      },
    });
    return { state, staged };
  }

  function rule(resourceId?: string) {
    return {
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "page_created",
        source: {
          sourceBindingKey: "notion_source",
          suggestedSourcePluginId: "plugin_notion",
          ...(resourceId === undefined ? {} : { resourceId }),
          event: { kind: "event_type", eventType: "notion.page.created" },
        },
        when: { kind: "always" },
      }],
    };
  }

  it("treats the nil and max UUIDs as no resource rather than an unknown one", async () => {
    const { state, staged } = ruleHost();
    const tools = createAutomationsPlugin(state).tools;

    // Some models fill every declared property; `resourceId` is optional and
    // the sentinel is what they reach for. It passed the id pattern, so the
    // rule was refused for a resource the rule never needed.
    for (const sentinel of ["00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", ""]) {
      await expect(toolNamed(tools, "set_evaluator_rules").execute(rule(sentinel), toolContext))
        .resolves.toMatchObject({ output: { accepted: true } });
    }
    expect(staged).toHaveLength(3);
    for (const rules of staged) {
      expect((rules as { evaluators: Array<{ source: Record<string, unknown> }> }).evaluators[0]!.source)
        .not.toHaveProperty("resourceId");
    }
  });

  it("still refuses an id that names a resource nobody searched for", async () => {
    const { state, staged } = ruleHost();
    const tools = createAutomationsPlugin(state).tools;

    await expect(toolNamed(tools, "set_evaluator_rules")
      .execute(rule("11111111-1111-4111-8111-111111111111"), toolContext))
      .rejects.toThrow(/not one this plugin can watch/u);
    expect(staged).toHaveLength(0);
  });

  it("accepts a searched resource whose plugin matches even when the search named no binding keys", async () => {
    const { state, staged } = ruleHost(new Map([[
      "22222222-2222-4222-8222-222222222222",
      { pluginId: "plugin_notion", resourceType: "notion_page", sourceBindingKeys: [] },
    ]]));
    const tools = createAutomationsPlugin(state).tools;

    // A search result that names binding keys narrows the check; one that
    // names none is not a refusal of every binding key.
    await expect(toolNamed(tools, "set_evaluator_rules")
      .execute(rule("22222222-2222-4222-8222-222222222222"), toolContext))
      .resolves.toMatchObject({ output: { accepted: true } });
    expect(staged).toHaveLength(1);
  });
});

describe("set_evaluator_rules on a trigger whose filter fields are open", () => {
  function hostWithTrigger(descriptor: Record<string, unknown>) {
    const staged: unknown[] = [];
    const state = host({
      catalog: [{
        pluginId: "plugin_webhook",
        displayName: "Generic webhook",
        icon: "webhook",
        description: "Deliveries on a webhook.",
        scope: "workspace",
        searchAliases: [],
        systemMessage: "",
        activityTriggers: [{
          eventType: "deploy.finished",
          label: "deploy.finished",
          description: "A delivery of deploy.finished on this webhook.",
          eventFamilies: [],
          filterFields: [],
          resourceRelationships: [],
          digestible: false,
          ...descriptor,
        }],
        tools: [],
      }],
      inspectedPluginIds: new Set(["plugin_webhook"]),
      loadedPluginIds: new Set(["plugin_webhook"]),
      draftMutationPort: {
        submitDraft: async () => ({ accepted: true as const }),
        setEvaluatorRules: async (rules) => {
          staged.push(rules);
          return { accepted: true as const };
        },
      },
    });
    return { state, staged };
  }
  const serviceIsCheckout = {
    schemaVersion: 1,
    evaluators: [{
      evaluatorKey: "checkout_deploys",
      source: {
        sourceBindingKey: "deploy_hook",
        suggestedSourcePluginId: "plugin_webhook",
        event: { kind: "event_type", eventType: "deploy.finished" },
      },
      when: {
        kind: "all",
        allOf: [{ kind: "string", attribute: "service", operator: "equals", value: "checkout" }],
      },
    }],
  };

  it("lets a rule name a payload key nobody declared", async () => {
    const { state, staged } = hostWithTrigger({ openFilterFields: true });

    // The accept-side evaluator checks an open descriptor's leaves for shape
    // only. The drafting check has to agree, or the one rule a webhook is for
    // (a condition on the caller's own keys) is refused before it is written.
    await expect(toolNamed(createAutomationsPlugin(state).tools, "set_evaluator_rules")
      .execute(serviceIsCheckout, toolContext))
      .resolves.toMatchObject({ output: { accepted: true } });
    expect(staged).toHaveLength(1);
  });

  it("still holds a closed descriptor to its declared fields", async () => {
    const { state, staged } = hostWithTrigger({});

    await expect(toolNamed(createAutomationsPlugin(state).tools, "set_evaluator_rules")
      .execute(serviceIsCheckout, toolContext))
      .rejects.toThrow(/not one the plugin declares/u);
    expect(staged).toHaveLength(0);
  });

  it("does not advertise the nil or max UUID as a legal id in the tool's schema", () => {
    const definition = AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS.find(
      (candidate) => candidate.name === "set_evaluator_rules",
    );
    if (!definition) throw new Error("set_evaluator_rules definition missing");

    // Zod's UUID pattern lists both as alternatives. A model reading that
    // pattern took them as values to send rather than an id to leave out.
    const schema = JSON.stringify(definition.inputSchema);
    expect(schema).toContain("pattern");
    expect(schema).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(schema).not.toContain("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });
});

describe("set_evaluator_rules and a resourceId a rule cannot use", () => {
  function webhookHost() {
    const staged: unknown[] = [];
    const state = host({
      catalog: [{
        pluginId: "plugin_webhook",
        displayName: "Generic webhook",
        icon: "webhook",
        description: "Deliveries on a webhook.",
        scope: "workspace",
        searchAliases: [],
        systemMessage: "",
        activityTriggers: [{
          eventType: "deploy.finished",
          label: "deploy.finished",
          description: "A delivery of deploy.finished on this webhook.",
          eventFamilies: [],
          filterFields: [],
          resourceRelationships: [],
          openFilterFields: true,
          digestible: false,
        }],
        tools: [],
      }],
      inspectedPluginIds: new Set(["plugin_webhook"]),
      loadedPluginIds: new Set(["plugin_webhook"]),
      draftMutationPort: {
        submitDraft: async () => ({ accepted: true as const }),
        setEvaluatorRules: async (rules) => {
          staged.push(rules);
          return { accepted: true as const };
        },
      },
    });
    return { state, staged };
  }
  function rule(resourceId: string, attribute = "service") {
    return {
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "checkout_deploys",
        source: {
          sourceBindingKey: "deploy_hook",
          suggestedSourcePluginId: "plugin_webhook",
          resourceId,
          event: { kind: "event_type", eventType: "deploy.finished" },
        },
        when: {
          kind: "all",
          allOf: [{ kind: "string", attribute, operator: "equals", value: "checkout" }],
        },
      }],
    };
  }

  it("drops any id on a trigger that declares no resource relationship", async () => {
    const { state, staged } = webhookHost();
    const tools = createAutomationsPlugin(state).tools;

    // Once the schema stopped advertising the nil UUID the model reshaped its
    // placeholder to fit the pattern; chasing each new one is a losing race.
    // A webhook delivery cannot be about one resource, so on this trigger the
    // field is noise whatever it holds.
    for (const id of [
      "00000000-0000-4000-8000-000000000000",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "00000000-0000-1000-8000-000000000000",
      "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f",
    ]) {
      await expect(toolNamed(tools, "set_evaluator_rules").execute(rule(id), toolContext))
        .resolves.toMatchObject({ output: { accepted: true } });
    }
    expect(staged).toHaveLength(4);
    for (const rules of staged) {
      expect((rules as { evaluators: Array<{ source: Record<string, unknown> }> }).evaluators[0]!.source)
        .not.toHaveProperty("resourceId");
    }
  });

  it("refuses a dotted key on an open descriptor, since the payload's keys are bare", async () => {
    const { state, staged } = webhookHost();
    const tools = createAutomationsPlugin(state).tools;

    // A dotted attribute would compile and then never match anything: the
    // event context indexes metadata by its bare keys.
    await expect(toolNamed(tools, "set_evaluator_rules")
      .execute(rule("00000000-0000-4000-8000-000000000000", "metadata.service"), toolContext))
      .rejects.toThrow(/without a metadata\. prefix/u);
    expect(staged).toHaveLength(0);
  });
});
