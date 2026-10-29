import { AutomationSetEvaluatorRulesInputV1Schema } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

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
  icon: "file-text",
  color: "blue",
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
  it("keeps recommendation mutations out of the authoring tools", () => {
    const names = createAutomationsPlugin(host()).tools.map((tool) => tool.definition.name);
    expect(names).not.toContain("attach");
    expect(names).not.toContain("detach");
  });
  it("rebuilds researched people and resources from replayed search output", () => {
    const people = new Set<string>();
    const resources: AutomationCreatorToolHost["resolvedResources"] = new Map();

    rememberAutomationPeopleSearchResult(
      { you: { id: "person-self" }, people: [{ id: "person-1" }, { id: 42 }] },
      people,
    );
    rememberAutomationResourceSearchResult({
      resources: [{
        id: "resource-1",
        pluginId: "plugin_google",
        resourceType: "gmail_thread",
        sourceBindingKeys: ["google_source", 42],
      }],
    }, resources);

    // `you` is the run's own person, and a replayed search has to restore it
    // alongside the matches: a rule that names the person who asked for it is
    // rejected as unresolved if a resumed run rebuilds this set without them.
    expect(people).toEqual(new Set(["person-self", "person-1"]));
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
      "resources_register",
      "sidekicks_list",
      "submit_draft",
      "set_evaluator_rules",
    ]);
  });

  it("lists what the conversation may edit through the host, and tells the agent to start there", async () => {
    const listed = { sidekicks: [{ sidekickId: "a-1", name: "Standup reminder" }] };
    const state = host({ automationDirectoryPort: { listAutomations: async () => listed } });
    const plugin = createAutomationsPlugin(state);

    await expect(toolNamed(plugin.tools, "sidekicks_list").execute({}, toolContext))
      .resolves.toMatchObject({ output: listed });
    expect(plugin.systemMessage).toContain("read its current definition with sidekick_sidekicks_list first");
    expect(plugin.systemMessage).toContain("submit the whole revised draft");
  });

  it("hands the named automation to the host beside the draft, and never inside it", async () => {
    const targets: Array<{ automationId: string | null; appearance: unknown }> = [];
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
    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, sidekickId: named }, toolContext);
    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, sidekickId: null }, toolContext);
    await toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext);
    // What a model that fills every property puts here: a slash, a nil UUID.
    // Neither names an automation, and handed through they threw from the
    // directory lookup as a bare schema error the model retried identically.
    await toolNamed(tools, "submit_draft").execute({ ...eventDrivenDraft, sidekickId: "/" }, toolContext);
    await toolNamed(tools, "submit_draft")
      .execute({ ...eventDrivenDraft, sidekickId: "00000000-0000-4000-8000-000000000000" }, toolContext);

    const appearance = { icon: "file-text", color: "blue" };
    expect(targets).toEqual([
      { automationId: named, appearance },
      { automationId: null, appearance },
      { automationId: null, appearance },
      { automationId: null, appearance },
      { automationId: null, appearance },
    ]);
    // The draft is the definition an automation stores; the address it is
    // stored at, and the icon and colour it wears, are not part of it.
    expect(drafts.every((draft) => !("sidekickId" in (draft as object)))).toBe(true);
    expect(drafts.every((draft) => !("icon" in (draft as object)) && !("color" in (draft as object)))).toBe(true);
  });

  it("refuses a draft with no icon or colour, or a colour outside the palette, naming the field", async () => {
    const tool = toolNamed(createAutomationsPlugin(host()).tools, "submit_draft");
    const bare: Record<string, unknown> = { ...eventDrivenDraft };
    delete bare.icon;
    delete bare.color;
    const issues = (tool.validateInput?.(bare) as z.ZodError | null)?.issues.map((issue) => issue.path.join("."));
    expect(issues).toEqual(expect.arrayContaining(["icon", "color"]));
    // A retired colour parses, so a Sidekick that wears one can keep it;
    // whether it may is the object's question, about what is stored.
    expect(tool.validateInput?.({ ...eventDrivenDraft, color: "teal" })).toBeNull();
    const unknown = (tool.validateInput?.({ ...eventDrivenDraft, color: "#00ff00" }) as z.ZodError | null)?.issues
      .map((issue) => issue.path.join("."));
    expect(unknown).toEqual(["color"]);
  });

  it("preserves the existing Sidekick scope while explaining its authority", () => {
    const { systemMessage } = createAutomationsPlugin(host());

    // The three scopes, and what each one means for who can manage the result.
    expect(systemMessage).toContain("personal");
    expect(systemMessage).toContain("workspace");
    expect(systemMessage).toContain("workstream");
    expect(systemMessage).toContain("Published scope cannot change");
    expect(systemMessage).toContain("Use the scope already selected");
    expect(systemMessage).toContain("Every scope can use eligible delegates' personal connections");
    expect(systemMessage).toContain("Eligible delegates can use");
    expect(systemMessage).not.toContain("Only the run-as person can use");
    expect(systemMessage).toContain("Do not ask participants to choose it again");
    // The room an automation belongs to is the one it was written in, so an
    // agent offering to deliver somewhere else is offering something that does
    // not exist.
    expect(systemMessage).toContain("Scheduled result delivery to a workstream is limited to the owning workstream");
  });

  it("bounds a scheduled self-review and tells it to report to the absent owner", () => {
    const { systemMessage } = createAutomationsPlugin(host());

    // The notice's first line is the one `renderSidekickReviewNotice` writes;
    // the policy recognizes the review by it.
    expect(systemMessage).toContain("Notice from Rally, not from a person or an agent: a scheduled\nself-review of this Sidekick is due");
    expect(systemMessage).toContain("Plan first, as your first message and before any tool call");
    expect(systemMessage).toContain("Then read only the runs the notice lists");
    expect(systemMessage).toContain("Then decide against your plan");
    expect(systemMessage).toContain("A review never adds a connector, plugin, delivery\ndestination, trigger or capability, never enrols a delegate");
    expect(systemMessage).toContain("Never submit ready=false in a review");
    // The publication to the people the Sidekick works for, and only on a change.
    expect(systemMessage).toContain("post one message there\nwith conversation_post, passing that conversation");
    expect(systemMessage).toContain("Post nothing there when nothing changed");
    expect(systemMessage).toContain("for the owner, who was not present");
    expect(systemMessage).toContain("asking here restores the earlier revision");
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
    // bare `sidekick_evaluator_rules_required` tagged an external fault. A
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
    // object refuses this as a bare `sidekick_activity_source_unbound`, the
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
    // Both labels are invented, so neither is discoverable from a catalog and
    // "they must agree" leaves the model guessing which of the two it typed
    // wrong. The refusal names the set the triggers declare and the rule that
    // sits outside it, which is the whole repair.
    await expect(toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext))
      .rejects.toThrow(/triggers declare notion_source \(plugin_notion\)/u);
    await expect(toolNamed(tools, "submit_draft").execute(eventDrivenDraft, toolContext))
      .rejects.toThrow(/page_created names notion_pages \(plugin_notion\)/u);
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
        kind: "matching",
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

  it("offers the model only `matching`, never the pre-rename `all`, as the predicate kind", () => {
    const definition = AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS.find(
      (candidate) => candidate.name === "set_evaluator_rules",
    );
    if (!definition) throw new Error("set_evaluator_rules definition missing");

    // `all` reads as "all events", which is what the neighbouring `always`
    // means; that collision is the whole reason for the rename, and offering
    // both spellings back to the model would reinstate it. The stored-row
    // compatibility in `automation-evaluators.ts` is a preprocess rather than a
    // third union branch precisely so this schema keeps naming one of them.
    const schema = JSON.stringify(definition.inputSchema);
    expect(schema).toContain("\"const\":\"matching\"");
    expect(schema).toContain("\"const\":\"always\"");
    expect(schema).not.toContain("\"const\":\"all\"");
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
          kind: "matching",
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

describe("set_evaluator_rules echoes the bindings the submitted draft declares", () => {
  const DEPLOY_PLUGIN = {
    pluginId: "plugin_webhook",
    displayName: "Generic webhook",
    icon: "webhook" as const,
    description: "Deliveries on a webhook.",
    scope: "workspace" as const,
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
    }],
    tools: [],
  };
  /** Partial, so it is admitted without rules and leaves its triggers behind. */
  const partialDraft = {
    name: "Deploy watcher",
    description: "Watches deploys.",
    icon: "file-text",
    color: "blue",
    overview: "Watches deploys.",
    instructions: "Report the deploy.",
    triggers: [{
      type: "connector_activity",
      connectorType: "generic_webhook",
      sourceBindingKey: "deploy_hook",
      suggestedSourcePluginId: "plugin_webhook",
      eventTypes: ["deploy.finished"],
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
    ready: false,
  };
  const ruleNaming = (sourceBindingKey: string) => ({
    schemaVersion: 1,
    evaluators: [{
      evaluatorKey: "checkout_deploys",
      source: {
        sourceBindingKey,
        suggestedSourcePluginId: "plugin_webhook",
        event: { kind: "event_type", eventType: "deploy.finished" },
      },
      when: { kind: "always" },
    }],
  });
  function submittedHost(): AutomationCreatorToolHost {
    return host({
      catalog: [DEPLOY_PLUGIN],
      inspectedPluginIds: new Set(["plugin_webhook"]),
      loadedPluginIds: new Set(["plugin_webhook"]),
      draftMutationPort: {
        submitDraft: async () => ({ accepted: true as const }),
        setEvaluatorRules: async () => ({ accepted: true as const }),
      },
    });
  }

  it("names the rule whose binding no trigger declares, without refusing it", async () => {
    const tools = createAutomationsPlugin(submittedHost()).tools;
    await toolNamed(tools, "submit_draft").execute(partialDraft, toolContext);

    // Still staged: rules and triggers are two calls in either order, so a
    // disagreement now may be a draft the model is about to replace. The echo
    // is what makes it visible before `submit_draft` refuses on it.
    await expect(toolNamed(tools, "set_evaluator_rules")
      .execute(ruleNaming("wrong_hook"), toolContext))
      .resolves.toMatchObject({
        output: {
          accepted: true,
          declaredSourceBindings: { deploy_hook: "plugin_webhook" },
          rulesNamingNoTrigger: ["checkout_deploys"],
        },
      });
  });

  it("reports no disagreement when the rule names the trigger's own binding", async () => {
    const tools = createAutomationsPlugin(submittedHost()).tools;
    await toolNamed(tools, "submit_draft").execute(partialDraft, toolContext);

    const result = await toolNamed(tools, "set_evaluator_rules")
      .execute(ruleNaming("deploy_hook"), toolContext);
    expect(result.output).toMatchObject({ declaredSourceBindings: { deploy_hook: "plugin_webhook" } });
    expect(result.output).not.toHaveProperty("rulesNamingNoTrigger");
  });

  it("says nothing about bindings when no draft has been submitted yet", async () => {
    const tools = createAutomationsPlugin(submittedHost()).tools;

    // The first call of a normal drafting run. There is no draft to compare
    // against, which is not a disagreement — reporting one here would tell the
    // model to repair a draft it has not written.
    const result = await toolNamed(tools, "set_evaluator_rules")
      .execute(ruleNaming("deploy_hook"), toolContext);
    expect(result.output).toMatchObject({ accepted: true });
    expect(result.output).not.toHaveProperty("declaredSourceBindings");
    expect(result.output).not.toHaveProperty("rulesNamingNoTrigger");
  });
});

describe("a composed source binding key is enough on its own", () => {
  /**
   * Fireflies' shape: an event the connector declares, and no resource
   * relationship anywhere, so `resources_search` has nothing to return for it.
   */
  const MEETING_PLUGIN = {
    pluginId: "plugin_fireflies",
    displayName: "Fireflies",
    icon: "webhook" as const,
    description: "Meetings the notetaker recorded.",
    scope: "workspace" as const,
    searchAliases: [],
    systemMessage: "",
    activityTriggers: [{
      eventType: "meeting.summarized",
      label: "Meeting summarized",
      description: "Fireflies finished a meeting's AI summary.",
      eventFamilies: [],
      filterFields: [],
      resourceRelationships: [],
      digestible: true,
    }],
    tools: [],
  };
  const composedDraft = {
    name: "Meeting recap emailer",
    description: "Emails a recap when a meeting is summarized.",
    icon: "file-text",
    color: "blue",
    overview: "Watches Fireflies and emails a recap.",
    instructions: "Read the summary and send a recap email.",
    triggers: [{
      type: "connector_activity",
      connectorType: "fireflies",
      // Composed, not looked up: no tool returns this value for any connector,
      // and this one has no bindable resource to have returned it with.
      sourceBindingKey: "fireflies_meetings",
      suggestedSourcePluginId: "plugin_fireflies",
      eventTypes: ["meeting.summarized"],
      deterministicFilters: {},
    }],
    requiredCapabilities: [],
    expectedOutputs: ["A recap email"],
    defaultBehavior: {},
    recommendedPlugins: [],
    memoryTables: [],
    suggestedScope: "workspace",
    followUpQuestion: null,
    elicitation: null,
    ready: true,
  };

  it("admits a ready event draft with no resource behind it", async () => {
    const state = host({
      catalog: [MEETING_PLUGIN],
      inspectedPluginIds: new Set(["plugin_fireflies"]),
      loadedPluginIds: new Set(["plugin_fireflies"]),
      draftMutationPort: {
        submitDraft: async () => ({ accepted: true as const }),
        setEvaluatorRules: async () => ({ accepted: true as const }),
      },
    });
    const tools = createAutomationsPlugin(state).tools;
    await toolNamed(tools, "set_evaluator_rules").execute({
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "summarized",
        source: {
          sourceBindingKey: "fireflies_meetings",
          suggestedSourcePluginId: "plugin_fireflies",
          event: { kind: "event_type", eventType: "meeting.summarized" },
        },
        when: { kind: "always" },
      }],
    }, toolContext);

    // The behaviour the field's description now promises. A connector with no
    // bindable resource was never actually blocked here — the description said
    // the label came from a search, so a drafting run searched, found nothing,
    // and reported a configuration blocker instead of composing one.
    await expect(toolNamed(tools, "submit_draft").execute(composedDraft, toolContext))
      .resolves.toMatchObject({ output: { accepted: true } });
    expect(state.draftState.submitted).not.toBeNull();
  });

  it("does not send the model looking a binding key up", () => {
    const definition = AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS
      .find((candidate) => candidate.name === "submit_draft")!;
    const described = JSON.stringify(definition.inputSchema);

    // Two descriptions contradicted each other: resources_search says to omit
    // resourceId when nothing is bindable, while this field claimed its value
    // came from that same search. The model followed this one.
    expect(described).not.toContain("taken from plugin_inspect or resources_search");
    expect(described).toContain("no tool returns one");
  });
});

describe("a connection whose scope cannot receive its connector's events", () => {
  /** A personal Granola connection: tools work, events do not. */
  function scopeBlockedHost(): AutomationCreatorToolHost {
    return host({
      catalog: [{
        pluginId: "plugin_granola",
        displayName: "Granola",
        icon: "plug",
        description: "Granola meeting notes.",
        scope: "personal",
        searchAliases: [],
        systemMessage: "",
        activityTriggers: [],
        activityRequiresScope: "workspace",
        tools: [],
      }],
      inspectedPluginIds: new Set(["plugin_granola"]),
      loadedPluginIds: new Set(["plugin_granola"]),
      draftMutationPort: {
        submitDraft: async () => ({ accepted: true as const }),
        setEvaluatorRules: async () => ({ accepted: true as const }),
      },
    });
  }

  it("says so in the catalog rather than leaving a zero count to be read as 'no events'", async () => {
    const tools = createAutomationsPlugin(scopeBlockedHost()).tools;

    const listed = await toolNamed(tools, "plugins_list").execute({}, toolContext);
    const entry = (listed.output as {
      plugins: Array<{ activityTriggerCount: number; activityTriggersUnavailable?: string }>;
    }).plugins[0]!;

    // A count of zero beside a healthy plugin reads as "this connector has no
    // events", which is false and sends the drafting run to a timer. The
    // sentence is what it can relay to the person instead.
    expect(entry.activityTriggerCount).toBe(0);
    expect(entry.activityTriggersUnavailable).toMatch(/workspace connection.*this one is personal/u);

    const inspected = await toolNamed(tools, "plugin_inspect")
      .execute({ pluginId: "plugin_granola" }, toolContext);
    expect((inspected.output as { plugin: { activityTriggersUnavailable?: string } }).plugin
      .activityTriggersUnavailable).toMatch(/workspace connection/u);
  });

  it("refuses a rule on its events by naming the scope, not the event name", async () => {
    const tools = createAutomationsPlugin(scopeBlockedHost()).tools;

    // The generic refusal ("this plugin declares no event of that name") reads
    // as a typo the model should correct, so it tries the next event type and
    // then a schedule. Naming the scope is the only correction it can act on.
    await expect(toolNamed(tools, "set_evaluator_rules").execute({
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "note_generated",
        source: {
          sourceBindingKey: "granola_notes",
          suggestedSourcePluginId: "plugin_granola",
          event: { kind: "event_type", eventType: "note.generated" },
        },
        when: { kind: "always" },
      }],
    }, toolContext)).rejects.toThrow(/Granola events reach Rally only through a workspace connection/u);
  });
});
