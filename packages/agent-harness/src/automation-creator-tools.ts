import { z } from "zod";

import {
  AutomationSetEvaluatorRulesInputV1Schema,
  automationActivitySourcePluginIds,
  automationDraftAcceptanceBlocker,
  type AutomationDraft,
  type AutomationSetEvaluatorRulesInputV1,
} from "@rally/contracts";

import {
  asRecord,
  executeAutomationCreatorDiscoveryTool,
  parseAutomationSubmission,
  AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS,
  automationSubmissionTarget,
  type AutomationCreatorPluginCatalogEntry,
  type HarnessTool,
  type HarnessToolContext,
  type StructuredModelDiagnostic,
} from "./index";

/**
 * Everything the automation-drafting tools need from whoever is hosting them.
 *
 * The dedicated compiler harness passes its own state; a work-stream run passes
 * the equivalents. Extracted so there is one definition of these tools rather
 * than a second copy that drifts — the tools decide what a draft may say, and
 * two answers to that is two products.
 */
export interface AutomationCreatorToolHost {
  catalog: AutomationCreatorPluginCatalogEntry[];
  /**
   * Which plugins the model has inspected this run. Shared mutable state: the
   * evaluator tool refuses a rule naming a plugin whose schema the model never
   * read, and inspection is what fills this.
   */
  inspectedPluginIds: Set<string>;
  /** Resources the model resolved, for binding an activity trigger to one. */
  resolvedResources: Map<string, {
    pluginId: string;
    resourceType: string;
    sourceBindingKeys: readonly string[];
  }>;
  /** Which plugins the model loaded, so a submission can name only those. */
  loadedPluginIds: Set<string>;
  /** People the model resolved, for an evaluator rule that names one. */
  resolvedPersonIds: Set<string>;
  /**
   * The draft as it currently stands; `submit_draft` replaces it.
   *
   * `evaluatorRules` is what `set_evaluator_rules` last sent. The host keeps
   * its own copy to hand to the submission, but `submit_draft` needs to see it
   * too: it is the difference between telling the model to call a tool and
   * handing it a bare error code.
   */
  draftState: {
    submitted: AutomationDraft | null;
    evaluatorRules?: AutomationSetEvaluatorRulesInputV1 | null;
  };
  model: string;
  draftResearchPort?: {
    searchPeople(query: string): Promise<unknown>;
    searchResources(query: string): Promise<unknown>;
  };
  /** The automations this conversation may edit, each with its current definition. */
  automationDirectoryPort?: {
    listAutomations(): Promise<unknown>;
  };
  draftMutationPort?: {
    /** `target` names an automation from `listAutomations`; null creates one. */
    submitDraft(
      draft: AutomationDraft,
      context: HarnessToolContext,
      target: { automationId: string | null },
    ): Promise<unknown>;
    setEvaluatorRules(
      rules: unknown,
      context: HarnessToolContext,
    ): Promise<{ accepted: true }>;
  };
  onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
}

export function rememberAutomationPeopleSearchResult(
  output: unknown,
  resolvedPersonIds: Set<string>,
): void {
  const people = asRecord(output).people;
  if (!Array.isArray(people)) return;
  for (const person of people) {
    const id = asRecord(person).id;
    if (typeof id === "string") resolvedPersonIds.add(id);
  }
}

export function rememberAutomationResourceSearchResult(
  output: unknown,
  resolvedResources: AutomationCreatorToolHost["resolvedResources"],
): void {
  const resources = asRecord(output).resources;
  if (!Array.isArray(resources)) return;
  for (const resource of resources) {
    const row = asRecord(resource);
    if (
      typeof row.id === "string"
      && typeof row.pluginId === "string"
      && typeof row.resourceType === "string"
    ) {
      resolvedResources.set(row.id, {
        pluginId: row.pluginId,
        resourceType: row.resourceType,
        sourceBindingKeys: Array.isArray(row.sourceBindingKeys)
          ? row.sourceBindingKeys.filter((value): value is string => typeof value === "string")
          : [],
      });
    }
  }
}

export function createAutomationCreatorTools(input: AutomationCreatorToolHost): HarnessTool[] {
  const catalog = input.catalog;
  const inspectedAutomationPluginIds = input.inspectedPluginIds;
  const resolvedAutomationResources = input.resolvedResources;
  const loadedAutomationPluginIds = input.loadedPluginIds;
  const resolvedAutomationPersonIds = input.resolvedPersonIds;
  const draftState = input.draftState;
  const creatorDefinition = (name: string): HarnessTool["definition"] => {
    const definition = AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`automation_creator_definition_missing:${name}`);
    return definition;
  };
  const creatorTools: HarnessTool[] = [
    {
      definition: creatorDefinition("plugins_list"),
      execute: async () => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_list", {}, catalog),
        summary: "Listed authorized automation plugins",
      }),
    },
    {
      definition: creatorDefinition("plugins_search"),
      execute: async (raw) => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_search", asRecord(raw), catalog),
        summary: "Searched authorized automation plugins",
      }),
    },
    {
      definition: creatorDefinition("plugin_inspect"),
      execute: async (raw) => {
        const output = executeAutomationCreatorDiscoveryTool("plugin_inspect", asRecord(raw), catalog);
        const pluginId = String(asRecord(raw).pluginId ?? "");
        if (pluginId) inspectedAutomationPluginIds.add(pluginId);
        return { output, summary: "Inspected an authorized automation plugin" };
      },
    },
    {
      definition: creatorDefinition("people_search"),
      validateInput: (raw) => {
        const parsed = z.strictObject({ query: z.string().min(1) }).safeParse(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw) => {
        if (!input.draftResearchPort) throw new Error("automation_draft_research_host_unavailable");
        const { query } = z.strictObject({ query: z.string().min(1) }).parse(raw);
        const output = await input.draftResearchPort.searchPeople(query);
        rememberAutomationPeopleSearchResult(output, resolvedAutomationPersonIds);
        return {
          output,
          summary: "Searched workspace people",
        };
      },
    },
    {
      definition: creatorDefinition("resources_search"),
      validateInput: (raw) => {
        const parsed = z.strictObject({ query: z.string().min(1) }).safeParse(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw) => {
        if (!input.draftResearchPort) throw new Error("automation_draft_research_host_unavailable");
        const { query } = z.strictObject({ query: z.string().min(1) }).parse(raw);
        const output = await input.draftResearchPort.searchResources(query);
        rememberAutomationResourceSearchResult(output, resolvedAutomationResources);
        return {
          output,
          summary: "Searched authorized resources",
        };
      },
    },
    {
      definition: creatorDefinition("automations_list"),
      execute: async () => {
        if (!input.automationDirectoryPort) throw new Error("automation_directory_host_unavailable");
        return {
          output: await input.automationDirectoryPort.listAutomations(),
          summary: "Listed the automations this conversation can edit",
        };
      },
    },
    {
      definition: creatorDefinition("submit_draft"),
      serial: true,
      /**
       * The draft's real contract is `AutomationDraftSchema`, and the parts of
       * it that decide whether a submission is accepted — a ready activity
       * trigger's binding key, its inspected plugin, its declared prefilter
       * event type, unique memory-table names — are cross-field refinements no
       * JSON Schema can state, so the declared `inputSchema` accepts arguments
       * the executor then rejects.
       *
       * Without this hook the runtime sees arguments that match everything it
       * was shown, files the executor's `ZodError` as downstream data
       * validation, and hands the model "the tool could not validate its data;
       * retry without changing the arguments". The model obeys: it resubmits
       * the same draft, is refused identically, and the compile ends with no
       * draft at all. That is request 8592b3f1 — four identical rejections of
       * one missing `deterministicPrefilter.eventType`, then
       * `automation_draft_not_submitted` and a 502 the person could only read
       * as "try again". Re-running the same parse here is what turns that dead
       * end into the named field, because it is the one signal that separates a
       * correctable argument from an external fault.
       */
      validateInput: (raw) => {
        const parsed = parseAutomationSubmission(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw, context) => {
        await input.onDiagnostic?.({
          stage: "normalize",
          schemaName: "automation_draft",
          model: input.model,
          attempt: 1,
          fallbackAttempt: 0,
          repairAttempt: 0,
        });
        const parsed = parseAutomationSubmission(raw);
        await input.onDiagnostic?.({
          stage: "validate",
          schemaName: "automation_draft",
          model: input.model,
          attempt: 1,
          fallbackAttempt: 0,
          repairAttempt: 0,
          ...(!parsed.success
            ? {
                validationIssues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  code: issue.code,
                })),
              }
            : {}),
        });
        if (!parsed.success) throw parsed.error;
        if (parsed.data.ready) {
          const sourcePluginIds = Object.values(automationActivitySourcePluginIds(parsed.data.triggers));
          const unloadedPluginId = [...sourcePluginIds, ...parsed.data.recommendedPlugins.map((plugin) => plugin.pluginId)]
            .find((pluginId) => (
              !loadedAutomationPluginIds.has(pluginId) || !inspectedAutomationPluginIds.has(pluginId)
            ));
          if (unloadedPluginId) {
            throw new Error(`Load and inspect ${unloadedPluginId} before submitting it in a ready automation draft`);
          }
          // AutomationAgent refuses both of these too, and that throw is the one
          // no caller can bypass. These exist for what the model reads: a
          // rejected tool call arrives as `error.message` verbatim, so the
          // object's code reaches it bare, tagged an external fault, with
          // nothing naming the tool that fixes it. The comment on
          // `set_evaluator_rules` below records where that ends — a model
          // resubmitting the same draft until the loop runs out. The same
          // predicate the object applies, so the two cannot disagree about
          // which drafts are refused; only the wording is this side's.
          const blocker = automationDraftAcceptanceBlocker(parsed.data, draftState.evaluatorRules ?? null);
          if (blocker === "automation_evaluator_rules_required") {
            throw new Error(
              "Call set_evaluator_rules with at least one rule before submitting a ready draft "
              + "that has a connector_activity, semantic_activity or webhook trigger",
            );
          }
          if (blocker === "automation_activity_source_unbound") {
            throw new Error(
              "Every rule's sourceBindingKey and suggestedSourcePluginId must match a connector_activity, "
              + "semantic_activity or webhook trigger in this draft. Call set_evaluator_rules again with rules "
              + "that name the triggers' bindings, or with [] when the draft no longer has such a trigger",
            );
          }
        }
        await input.draftMutationPort?.submitDraft(parsed.data, context, {
          automationId: automationSubmissionTarget(raw),
        });
        draftState.submitted = parsed.data;
        await input.onDiagnostic?.({
          stage: "complete",
          schemaName: "automation_draft",
          model: input.model,
          attempt: 1,
          fallbackAttempt: 0,
          repairAttempt: 0,
        });
        return {
          output: { accepted: true },
          summary: draftState.submitted.ready ? "Submitted ready automation draft" : "Submitted partial automation draft",
          ...(draftState.submitted.ready ? { halt: "completed" as const } : {}),
        };
      },
    },
    {
      definition: creatorDefinition("set_evaluator_rules"),
      serial: true,
      validateInput: (raw) => evaluatorRuleIssues(raw),
      execute: async (raw, context) => {
        if (!input.draftMutationPort) throw new Error("automation_draft_mutation_host_unavailable");
        // The harness consults `validateInput` only after the executor has
        // already thrown a ZodError, so a semantic check that lives there
        // alone never runs — the rule reaches durable storage unchecked. The
        // executor enforces the same function, and `validateInput` keeps
        // pointing at it so the two can never drift.
        const issues = evaluatorRuleIssues(raw);
        if (issues) throw issues;
        const rules = AutomationSetEvaluatorRulesInputV1Schema.parse(raw);
        const result = await input.draftMutationPort.setEvaluatorRules(rules, context);
        draftState.evaluatorRules = rules;
        return {
          output: result,
          summary: rules.evaluators.length === 0
            ? "Cleared external event evaluator rules"
            : `Set ${rules.evaluators.length} external event evaluator rule${rules.evaluators.length === 1 ? "" : "s"}`,
        };
      },
    },
  ];
  function evaluatorRuleIssues(raw: unknown): z.ZodError | null {
        const parsed = AutomationSetEvaluatorRulesInputV1Schema.safeParse(raw);
        if (!parsed.success) return parsed.error;
        const issues: z.core.$ZodIssue[] = [];
        for (const [index, evaluator] of parsed.data.evaluators.entries()) {
          const plugin = catalog.find((candidate) => candidate.pluginId === evaluator.source.suggestedSourcePluginId);
          if (!plugin || !inspectedAutomationPluginIds.has(plugin.pluginId)) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "suggestedSourcePluginId"],
              message: "This plugin has not been inspected. Call automation_plugin_inspect with this plugin ID, then set the rules again using only the event types and filter fields it declares.",
              input: evaluator.source.suggestedSourcePluginId,
            });
            continue;
          }
          const event = evaluator.source.event;
          const eventTypes = event.kind === "event_type"
            ? [event.eventType]
            : plugin.activityTriggers
                .filter((descriptor) => (descriptor.eventFamilies ?? []).includes(event.eventFamily))
                .map((descriptor) => descriptor.eventType);
          if (eventTypes.length === 0) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "event"],
              message: "This plugin declares no event of that name or family. Use one of the event types listed by automation_plugin_inspect for this plugin.",
              input: evaluator.source.event,
            });
            continue;
          }
          const resolvedResource = evaluator.source.resourceId
            ? resolvedAutomationResources.get(evaluator.source.resourceId)
            : undefined;
          if (
            evaluator.source.resourceId
            && (
              !resolvedResource
              || resolvedResource.pluginId !== plugin.pluginId
              || !resolvedResource.sourceBindingKeys.includes(evaluator.source.sourceBindingKey)
            )
          ) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "resourceId"],
              message: "This resource is not one this plugin can watch. Find it with resources_search and use an ID it returns for this source binding.",
              input: evaluator.source.resourceId,
            });
          }
          for (const eventType of eventTypes) {
            const descriptor = plugin.activityTriggers.find((candidate) => candidate.eventType === eventType);
            if (
              resolvedResource
              && !(descriptor?.resourceRelationships ?? []).some(
                (relationship) => relationship.resourceType === resolvedResource.resourceType,
              )
            ) {
              issues.push({
                code: "custom",
                path: ["evaluators", index, "source", "resourceId"],
                message: "This event cannot be filtered by that resource type. Use a resource whose type appears in the relationships automation_plugin_inspect lists for this event.",
                input: evaluator.source.resourceId,
              });
            }
            if (!descriptor || evaluator.when.kind !== "all") continue;
            {
              for (const [leafIndex, leaf] of evaluator.when.allOf.entries()) {
                const field = (descriptor.filterFields ?? []).find((candidate) => candidate.key === leaf.attribute);
                if (
                  !field
                  || !(field.operators ?? []).includes(leaf.operator)
                  || (leaf.kind !== "presence" && leaf.kind !== field.valueType)
                ) {
                  issues.push({
                    code: "custom",
                    path: ["evaluators", index, "when", "allOf", leafIndex],
                    message: "This filter field, operator, or value type is not one the plugin declares. Use a field from automation_plugin_inspect with one of the operators it lists and a value of the type it names.",
                    input: leaf,
                  });
                }
                if (
                  (leaf.kind === "person_id" || leaf.kind === "person_id_array")
                  && (Array.isArray(leaf.value) ? leaf.value : [leaf.value])
                    .some((personId: string) => !resolvedAutomationPersonIds.has(personId))
                ) {
                  issues.push({
                    code: "custom",
                    path: ["evaluators", index, "when", "allOf", leafIndex, "value"],
                    message: "This person ID was never resolved. Find the person with people_search and use an ID it returned.",
                    input: leaf.value,
                  });
                }
              }
            }
          }
        }
    return issues.length > 0 ? new z.ZodError(issues) : null;
  }
  return creatorTools;
}

export const AUTOMATIONS_PLUGIN_ID = "rally:automations";

export const AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE = [
  "Automations you draft are proposals. A person accepts them; you never activate one.",
  "Ask which scope before you submit, because it cannot be changed afterwards:",
  "\"personal\" belongs to the person who asked and acts with their own connections,",
  "\"workspace\" belongs to the admins and acts with the workspace's own connections,",
  "and \"workstream\" belongs to this work stream — everyone in the room can manage it,",
  "Rally posts its results here, and it outlives whoever asked for it.",
  "Nothing else is delivered for an automation: if its result should reach an inbox, a channel, a DM, or a document,",
  "write that send and its recipient into the instructions as a step, because the run performs it with its own tools",
  "and a result the instructions do not send goes nowhere.",
  "An automation can never deliver into a different work stream, so do not offer to send results to one.",
  "To change an automation that already exists, call automations_list, start from its current definition,",
  "and submit the whole revised draft with its automationId; a person applies the change the same way they accepted it.",
].join(" ");

/**
 * The drafting tools, as a plugin any work-stream agent can load.
 *
 * Deferred rather than preloaded: discovered through `list_plugins` and loaded
 * with `load_plugin`, the way `rally:terminal` is. Loading it starts,
 * authorizes and persists nothing — it puts the drafting tools in the catalog,
 * and the first thing that durably exists is the draft a person is asked to
 * accept, in the feed where the conversation happened.
 *
 * Withheld from an automation occurrence, and that is the host's call to make:
 * an occurrence that could draft automations from the email it just read is a
 * spam engine with a human approval step in front of it.
 */
export function createAutomationsPlugin(
  host: AutomationCreatorToolHost,
  systemMessage = AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE,
): {
  canonicalId: string;
  modelId: string;
  shortWireName: string;
  displayName: string;
  searchAliases: string[];
  description: string;
  systemMessage: string;
  tools: HarnessTool[];
  preload: boolean;
  explicit: boolean;
} {
  return {
    canonicalId: AUTOMATIONS_PLUGIN_ID,
    modelId: "rally_automations",
    shortWireName: "automation",
    displayName: "Automations",
    searchAliases: [
      "automation", "automate", "schedule", "recurring", "every morning",
      "every week", "when this happens", "watch for", "remind",
    ],
    description:
      "Draft an automation that runs on a schedule or when something happens, for a person, the workspace, or this work stream.",
    systemMessage,
    tools: createAutomationCreatorTools(host),
    preload: false,
    explicit: false,
  };
}
