import { z } from "zod";

import {
  AutomationSetEvaluatorRulesModelInputV1Schema,
  automationActivitySourcePluginIds,
  automationDraftAcceptanceBlocker,
  automationTriggersAdmitResourceType,
  type AutomationDraft,
  type PickedAppearance,
  type AutomationSetEvaluatorRulesInputV1,
} from "@rally/contracts";

import {
  activityTriggerScopeRefusal,
  asRecord,
  executeAutomationCreatorDiscoveryTool,
  parseAutomationSubmission,
  AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS,
  automationSubmissionTarget,
  withoutUnusableDraftResourceIds,
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
    /**
     * `target` names an automation from `listAutomations`; null creates one.
     * Its appearance is the icon and colour the draft was submitted with.
     */
    submitDraft(
      draft: AutomationDraft,
      context: HarnessToolContext,
      target: { automationId: string | null; appearance: PickedAppearance },
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
  const record = asRecord(output);
  // `you` is a person the search returned like any other, so a rule may name
  // it like any other. The host already seeds this set with the same id when
  // it builds the plugin; recording it here is what keeps the replay path,
  // which rebuilds the set from stored tool output alone, agreeing with it.
  const you = asRecord(record.you).id;
  if (typeof you === "string") resolvedPersonIds.add(you);
  const people = record.people;
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

/**
 * The rules whose source binding names no trigger in the draft they belong to.
 *
 * The same predicate `automationDraftAcceptanceBlocker` refuses on, kept in one
 * place so the warning `set_evaluator_rules` echoes and the refusal
 * `submit_draft` throws can never disagree about which rules are unbound — a
 * warning that cleared a submission the object then rejected would be worse
 * than no warning, because it would be believed.
 */
function unboundEvaluatorRules(
  triggers: AutomationDraft["triggers"],
  rules: AutomationSetEvaluatorRulesInputV1 | null,
): {
  declared: Record<string, string>;
  unbound: AutomationSetEvaluatorRulesInputV1["evaluators"];
} {
  const declared = automationActivitySourcePluginIds(triggers);
  return {
    declared,
    // `undefined !== string` covers the binding no trigger declares at all, so
    // this one comparison is both halves of the blocker's `!bound || bound !==`.
    unbound: (rules?.evaluators ?? []).filter(
      (evaluator) => declared[evaluator.source.sourceBindingKey] !== evaluator.source.suggestedSourcePluginId,
    ),
  };
}

function describeSourceBindings(declared: Record<string, string>): string {
  const entries = Object.entries(declared);
  return entries.length === 0
    ? "no activity source bindings at all"
    : entries.map(([key, pluginId]) => `${key} (${pluginId})`).join(", ");
}

function describeUnboundRules(unbound: AutomationSetEvaluatorRulesInputV1["evaluators"]): string {
  if (unbound.length === 0) return "Every rule names one of those";
  const named = unbound
    .map((evaluator) => (
      `${evaluator.evaluatorKey} names ${evaluator.source.sourceBindingKey} `
      + `(${evaluator.source.suggestedSourcePluginId})`
    ))
    .join("; ");
  return `${unbound.length === 1 ? "This rule names something else" : "These rules name something else"}: ${named}`;
}

const RegisterResourceInputSchema = z.strictObject({ pluginId: z.string().min(1), resource: z.string().min(1) });

export function createAutomationCreatorTools(input: AutomationCreatorToolHost): HarnessTool[] {
  const catalog = input.catalog;
  const inspectedAutomationPluginIds = input.inspectedPluginIds;
  const resolvedAutomationResources = input.resolvedResources;
  const loadedAutomationPluginIds = input.loadedPluginIds;
  const resolvedAutomationPersonIds = input.resolvedPersonIds;
  const draftState = input.draftState;
  const creatorDefinition = (name: string): HarnessTool["definition"] => {
    const definition = AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`sidekick_creator_definition_missing:${name}`);
    return definition;
  };
  const creatorTools: HarnessTool[] = [
    {
      definition: creatorDefinition("plugins_list"),
      execute: async () => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_list", {}, catalog),
        summary: "Listed authorized Sidekick plugins",
      }),
    },
    {
      definition: creatorDefinition("plugins_search"),
      execute: async (raw) => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_search", asRecord(raw), catalog),
        summary: "Searched authorized Sidekick plugins",
      }),
    },
    {
      definition: creatorDefinition("plugin_inspect"),
      execute: async (raw) => {
        const output = executeAutomationCreatorDiscoveryTool("plugin_inspect", asRecord(raw), catalog);
        const pluginId = String(asRecord(raw).pluginId ?? "");
        if (pluginId) inspectedAutomationPluginIds.add(pluginId);
        return { output, summary: "Inspected an authorized Sidekick plugin" };
      },
    },
    {
      definition: creatorDefinition("people_search"),
      validateInput: (raw) => {
        const parsed = z.strictObject({ query: z.string().min(1) }).safeParse(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw) => {
        if (!input.draftResearchPort) throw new Error("sidekick_draft_research_host_unavailable");
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
        if (!input.draftResearchPort) throw new Error("sidekick_draft_research_host_unavailable");
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
      definition: creatorDefinition("resources_register"),
      validateInput: (raw) => {
        const parsed = RegisterResourceInputSchema.safeParse(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw, context) => {
        const args = RegisterResourceInputSchema.parse(raw);
        const plugin = catalog.find((entry) => entry.pluginId === args.pluginId);
        if (!plugin) throw new Error("sidekick_resource_plugin_unavailable: Find the source plugin with plugins_list or plugins_search.");
        if (!plugin.registerResource) throw new Error("sidekick_resource_registration_unsupported: This plugin cannot register external resources. Inspect its events and available filters before choosing a fallback.");
        const output = await plugin.registerResource(args.resource, context.signal);
        rememberAutomationResourceSearchResult(output, resolvedAutomationResources);
        return { output, summary: "Registered an external resource for event binding" };
      },
    },
    {
      definition: creatorDefinition("sidekicks_list"),
      execute: async () => {
        if (!input.automationDirectoryPort) throw new Error("sidekick_directory_host_unavailable");
        return {
          output: await input.automationDirectoryPort.listAutomations(),
          summary: "Listed editable and attachable Sidekicks",
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
       * `sidekick_draft_not_submitted` and a 502 the person could only read
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
        const { draft, appearance } = parsed.data;
        if (draft.ready) {
          const sourcePluginIds = Object.values(automationActivitySourcePluginIds(draft.triggers));
          const unloadedPluginId = [...sourcePluginIds, ...draft.recommendedPlugins.map((plugin) => plugin.pluginId)]
            .find((pluginId) => (
              !loadedAutomationPluginIds.has(pluginId) || !inspectedAutomationPluginIds.has(pluginId)
            ));
          if (unloadedPluginId) {
            throw new Error(`Load and inspect ${unloadedPluginId} before submitting it in a ready Sidekick draft`);
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
          const blocker = automationDraftAcceptanceBlocker(draft, draftState.evaluatorRules ?? null);
          if (blocker === "sidekick_evaluator_rules_required") {
            throw new Error(
              "Call set_evaluator_rules with at least one rule before submitting a ready draft "
              + "that has a connector_activity, semantic_activity or webhook trigger",
            );
          }
          if (blocker === "sidekick_activity_source_unbound") {
            // Both halves are in hand here and nowhere else: the triggers are
            // in this submission, the rules are the ones already buffered. The
            // wording used to say only that they had to agree, which leaves a
            // model to guess *which* of two invented labels it typed wrong —
            // and a binding key is invented, so neither side is discoverable
            // from a catalog. Naming the two sets is what turns the refusal
            // into an edit.
            const { declared, unbound } = unboundEvaluatorRules(draft.triggers, draftState.evaluatorRules ?? null);
            throw new Error(
              "Every rule's sourceBindingKey and suggestedSourcePluginId must match a connector_activity, "
              + "semantic_activity or webhook trigger in this draft. "
              + `This draft's triggers declare ${describeSourceBindings(declared)}. `
              + `${describeUnboundRules(unbound)}. `
              + "Call set_evaluator_rules again with rules that name the triggers' bindings, "
              + "or with [] when the draft no longer has such a trigger",
            );
          }
        }
        await input.draftMutationPort?.submitDraft(draft, context, {
          automationId: automationSubmissionTarget(raw),
          appearance,
        });
        draftState.submitted = draft;
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
          summary: draftState.submitted.ready ? "Submitted ready Sidekick draft" : "Submitted partial Sidekick draft",
        };
      },
    },
    {
      definition: creatorDefinition("set_evaluator_rules"),
      serial: true,
      validateInput: (raw) => evaluatorRuleIssues(withoutUnusableDraftResourceIds(raw, catalog)),
      execute: async (rawArguments, context) => {
        if (!input.draftMutationPort) throw new Error("sidekick_draft_mutation_host_unavailable");
        const raw = withoutUnusableDraftResourceIds(rawArguments, catalog);
        // The harness consults `validateInput` only after the executor has
        // already thrown a ZodError, so a semantic check that lives there
        // alone never runs — the rule reaches durable storage unchecked. The
        // executor enforces the same function, and `validateInput` keeps
        // pointing at it so the two can never drift.
        const issues = evaluatorRuleIssues(raw);
        if (issues) throw issues;
        // The model's spelling in, the stored shape out; everything below and
        // downstream of here is the stored shape.
        const rules = AutomationSetEvaluatorRulesModelInputV1Schema.parse(raw);
        const result = await input.draftMutationPort.setEvaluatorRules(rules, context);
        draftState.evaluatorRules = rules;
        // What the submitted draft's triggers currently declare, echoed back so
        // a binding key typed two ways is visible now rather than at submit.
        // Only when a draft exists: rules may be set before one, deliberately —
        // buffering is what keeps the two calls order-independent — and there
        // is then nothing to compare against rather than a disagreement to
        // report. The check that does fire in that case is `submit_draft`'s,
        // which names both sets for the same reason.
        const submitted = draftState.submitted;
        const check = submitted === null
          ? null
          : unboundEvaluatorRules(submitted.triggers, rules);
        return {
          output: {
            ...asRecord(result),
            ...(check === null ? {} : {
              declaredSourceBindings: check.declared,
              ...(check.unbound.length > 0
                ? { rulesNamingNoTrigger: check.unbound.map((evaluator) => evaluator.evaluatorKey) }
                : {}),
            }),
          },
          summary: rules.evaluators.length === 0
            ? "Cleared external event evaluator rules"
            : `Set ${rules.evaluators.length} external event evaluator rule${rules.evaluators.length === 1 ? "" : "s"}`,
        };
      },
    },
  ];
  function evaluatorRuleIssues(raw: unknown): z.ZodError | null {
        const parsed = AutomationSetEvaluatorRulesModelInputV1Schema.safeParse(raw);
        if (!parsed.success) return parsed.error;
        const issues: z.core.$ZodIssue[] = [];
        for (const [index, evaluator] of parsed.data.evaluators.entries()) {
          const plugin = catalog.find((candidate) => candidate.pluginId === evaluator.source.suggestedSourcePluginId);
          if (!plugin || !inspectedAutomationPluginIds.has(plugin.pluginId)) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "suggestedSourcePluginId"],
              message: "This plugin has not been inspected. Call sidekick_plugin_inspect with this plugin ID, then set the rules again using only the event types and filter fields it declares.",
              input: evaluator.source.suggestedSourcePluginId,
            });
            continue;
          }
          // Refused on the plugin rather than on the event, because every
          // event is refused: this connection's scope cannot receive any of
          // them. A rule naming an event type outright is not otherwise
          // checked against the catalog here, so without this the draft is
          // accepted and the automation is silent for good.
          const scopeRefusal = activityTriggerScopeRefusal(plugin);
          if (scopeRefusal) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "suggestedSourcePluginId"],
              message: scopeRefusal,
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
              message: "This plugin declares no event of that name or family. Use one of the event types listed by sidekick_plugin_inspect for this plugin.",
              input: evaluator.source.event,
            });
            continue;
          }
          const resolvedResource = evaluator.source.resourceId
            ? resolvedAutomationResources.get(evaluator.source.resourceId)
            : undefined;
          // A resource belongs to a rule when the plugin that reaches it is the
          // rule's source plugin. A search result that also names binding keys
          // narrows it further; one that names none is not a refusal.
          if (
            evaluator.source.resourceId
            && (
              !resolvedResource
              || resolvedResource.pluginId !== plugin.pluginId
              || (
                resolvedResource.sourceBindingKeys.length > 0
                && !resolvedResource.sourceBindingKeys.includes(evaluator.source.sourceBindingKey)
              )
            )
          ) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "resourceId"],
              message: "This resource is not one this plugin can watch. Find it with resources_search or register the external file with resources_register, then use the returned ID for this source binding. Omit resourceId only when the rule is not about one resource.",
              input: evaluator.source.resourceId,
            });
          }
          for (const eventType of eventTypes) {
            const descriptor = plugin.activityTriggers.find((candidate) => candidate.eventType === eventType);
            if (
              resolvedResource
              && !automationTriggersAdmitResourceType(
                descriptor ? [descriptor] : [],
                resolvedResource.resourceType,
              )
            ) {
              issues.push({
                code: "custom",
                path: ["evaluators", index, "source", "resourceId"],
                message: "This event cannot be filtered by that resource type. Use a resource whose type appears in the relationships sidekick_plugin_inspect lists for this event.",
                input: evaluator.source.resourceId,
              });
            }
            if (!descriptor || evaluator.when.kind !== "all") continue;
            {
              for (const [leafIndex, leaf] of evaluator.when.allOf.entries()) {
                const field = (descriptor.filterFields ?? []).find((candidate) => candidate.key === leaf.attribute);
                // An open descriptor's fields are the payload's own keys, which
                // nobody declared: the leaf is checked for shape only, the same
                // rule the accept-side evaluator applies. The two must agree,
                // or a rule the conversation could write is refused at accept,
                // or one it could not write is admitted there.
                if (descriptor.openFilterFields === true && leaf.attribute.includes(".")) {
                  issues.push({
                    code: "custom",
                    path: ["evaluators", index, "when", "allOf", leafIndex, "attribute"],
                    message: "Name the payload key bare, without a metadata. prefix: the event's metadata keys are the filter fields themselves.",
                    input: leaf.attribute,
                  });
                  continue;
                }
                if (
                  descriptor.openFilterFields !== true
                  && (
                    !field
                    || !(field.operators ?? []).includes(leaf.operator)
                    || (leaf.kind !== "presence" && leaf.kind !== field.valueType)
                  )
                ) {
                  issues.push({
                    code: "custom",
                    path: ["evaluators", index, "when", "allOf", leafIndex],
                    message: "This filter field, operator, or value type is not one the plugin declares. Use a field from sidekick_plugin_inspect with one of the operators it lists and a value of the type it names.",
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

export const AUTOMATIONS_PLUGIN_ID = "rally:sidekicks";

export const AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE = [
  "Sidekicks let people delegate work or knowledge. Create and edit them through conversation; never ask users to edit system instructions.",
  "Write internal instructions and a clear description for the person. Use tools to resolve missing details before asking questions.",
  "Before submitting executable behavior as ready, find the authorized tools and skills, inspect real resources and sample inputs, and resolve their IDs. Test the workflow with available reads or non-destructive trials. Record what worked, what you could not test, and remaining assumptions. Draft acceptance is not a workflow test. Leave future runs' deliveries and other effects to those runs unless requested during setup.",
  "For executable work, save the discovered method as a detailed, self-contained runbook. Runs cannot see this conversation: give them the steps and decision rules so they can execute without repeating discovery. Separate setup facts from data each run must refresh. Include success checks, when to do nothing, and recovery steps.",
  "For work after an external change, load polling-for-events and follow its event-first setup and resource-registration procedure.",
  "Each Sidekick run has a separate conversation, but its wizard, runs, and background agents share one Terminal sandbox (file workspace). Other Sidekicks and the requesting Thread have separate sandboxes. Only the Sidekick's run-as user can use its shared Terminal files; other editors can still configure it. Save resource IDs, file recovery steps, and instructions for opening shared tables so work can recover if files are missing. To update an existing site, load building-live-sites and save its import, update, and publish steps in the run instructions.",
  "Resource tools automatically include resources visible in the Sidekick's home and explicitly attached conversations, under the execution user's current permissions. This applies to the wizard, activations, and background agents. Known Rally resource IDs can also be read through the execution user's current read access without an attachment. Prefer attaching the intended resource during handoff for clarity; an omitted attachment must not block an authorized read. Terminal publications belong to the home conversation when it has one.",
  "Activations can overlap, and Terminal locks only one tool call at a time. For runs that update the same files or publication, load tracking-seen-or-done-items and save shared-table coordination steps for the whole update; use separate directories for independent work.",
  "A ready submission saves and activates immediately. Do not ask the person to press Create or Apply. Submit only the behavior they requested.",
  "A connection state check never blocks a submission. A personal or workstream Sidekick may use the personal connection of the person it runs as: when a plugin you inspected can do the work, use it and submit ready.",
  "Only a refused submission blocks activation; report its refusal exactly. Treat a blocker another agent reports as a claim to test by submitting, not as a reason to stay a draft.",
  "After saving a draft, briefly acknowledge what was saved; after a partial submission, ask for the missing details.",
  "Use an empty triggers array for reusable knowledge. Use inbound_email only when the person wants email to start work. Do not add manual or scheduled triggers to make a reusable skill valid.",
  "Use the scope already selected for this Sidekick. Do not ask participants to choose it again. Workstream ownership cannot change. Before first publication, change between personal and workspace scope only when explicitly requested. Published scope cannot change.",
  "\"personal\" belongs to the person who asked and acts with their own connections,",
  "\"workspace\" belongs to the admins and acts with the workspace's own connections,",
  "and \"workstream\" belongs to its owning work stream — everyone in that room can manage it,",
  "A Sidekick outlives whoever asked for it. Include each result destination and delivery step in its instructions.",
  "To send a result to an inbox, channel, DM, or document, name the recipient and tell the run to send it.",
  "Scheduled result delivery to a workstream is limited to the owning workstream.",
  "To change this Sidekick, read its current definition with sidekick_sidekicks_list first,",
  "and submit the whole revised draft; ready changes save immediately.",
].join(" ");

/**
 * Drafting tools for a Sidekick's own authoring conversation. The host controls
 * eligibility and supplies the existing Sidekick identity. Loading tools does
 * not create another Sidekick; a ready submission saves through normal domain
 * validation. Occurrences and coordinating workstreams use their own surfaces.
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
    modelId: "rally_sidekicks",
    shortWireName: "sidekick",
    displayName: "Sidekicks",
    searchAliases: [
      "sidekick", "knowledge", "instructions", "automation", "automate", "schedule", "recurring", "every morning",
      "every week", "when this happens", "watch for", "remind",
    ],
    description:
      "Set up this Sidekick to provide reusable instructions or carry out work on a schedule or when an event occurs, within its existing scope.",
    systemMessage,
    tools: createAutomationCreatorTools(host),
    preload: false,
    explicit: false,
  };
}
