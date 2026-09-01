import { newId, nowIso } from "@rally/db";
import { TriggerDefinitionSchema } from "@rally/contracts";
import type {
  AutomationDraft,
  AutomationScope,
} from "@rally/contracts";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";
import { asWorkspaceId } from "@rally/contracts";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceAutomationTemplateListSchema,
  WorkspaceAutomationTemplateOwnershipSchema,
  WorkspaceAutomationTemplateVersionResultSchema,
} from "../durable-objects/workspace-automation-template-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

type TriggerDefinition = z.infer<typeof TriggerDefinitionSchema>;

interface ValidatedConnectorBindings {
  bindings: Record<string, string>;
  connectorTypes: Set<string>;
  connectorTypesByPluginId: Record<string, string>;
}

/**
 * The workspace template gallery.
 *
 * All that is left of the D1-backed automation runtime: AutomationAgent
 * owns an automation's lifecycle, runs, schedules, delivery, and email
 * routing, and the cutover dropped the tables the rest of this service
 * read. Templates are still regional rows, so publishing one, adding a
 * version, and listing the gallery stay here.
 */
export class AutomationService {
  private readonly env: Env;
  private readonly auth: AuthContext;

  constructor(env: Env, auth: AuthContext) {
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
  }

  async listTemplates() {
    // The gallery rows come from the object that owns the tables; the author
    // names are a regional join the object cannot make, so they stay here.
    const gallery = WorkspaceAutomationTemplateListSchema.parse(
      await (await this.workspace()).listAutomationTemplates({
        workspaceId: this.auth.workspaceId,
      }),
    );
    const ownerIds = [...new Set(gallery.items.flatMap((item) =>
      item.ownerUserId === null ? [] : [item.ownerUserId]))];
    const owners = ownerIds.length === 0 ? [] : (await workspaceRegionalDatabase(this.env).prepare(
      `SELECT id, name FROM users WHERE id IN (${ownerIds.map(() => "?").join(",")})`,
    ).bind(...ownerIds).all<{ id: string; name: string }>()).results;
    const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));
    return { items: gallery.items.map((item) => ({
      id: item.id,
      name: item.name,
      author: item.ownerUserId === null
        ? "Unknown member"
        : ownerNames.get(item.ownerUserId) ?? "Unknown member",
      description: item.description,
      // Nothing counts subscriptions any more: AutomationAgent owns them, and
      // the cutover dropped the table this used to join. The contract keeps the
      // field, so the gallery reports zero rather than a number it cannot know.
      usedBy: 0,
      requiredCapabilities: templateCapabilities(item.requiredCapabilitiesJson),
      latestVersion: item.latestVersionNumber,
      activitySources: activitySourceDefinitions(templateTriggers(item.triggerDefinitionsJson)),
    })) };
  }

  async publishTemplate(input: { name: string; description: string; draft: AutomationDraft }) {
    if (!input.draft.ready) throw new ApiError(422, "template_not_ready", "Finish the automation recipe before publishing it");
    const activitySourcePluginIds = suggestedActivitySourcePluginIds(input.draft.triggers);
    const connectorSelection = await this.validateConnectorSelections(
      input.draft.suggestedScope,
      [],
      activitySourcePluginIds,
    );
    this.assertActivityTriggerBindings(input.draft.triggers, activitySourcePluginIds, connectorSelection);
    const templateId = newId();
    const versionId = newId();
    const at = nowIso();
    await (await this.workspace()).publishAutomationTemplate({
      workspaceId: this.auth.workspaceId,
      templateId,
      ownerUserId: this.auth.userId,
      name: input.name,
      description: input.description,
      version: {
        versionId,
        overview: input.draft.overview,
        instructions: input.draft.instructions,
        triggerDefinitionsJson: JSON.stringify(input.draft.triggers),
        requiredCapabilitiesJson: JSON.stringify(input.draft.requiredCapabilities),
        expectedOutputsJson: JSON.stringify(input.draft.expectedOutputs),
        defaultBehaviorJson: JSON.stringify(input.draft.defaultBehavior),
        recommendedPluginsJson: JSON.stringify(input.draft.recommendedPlugins),
        memoryTablesJson: JSON.stringify(input.draft.memoryTables),
        createdByUserId: this.auth.userId,
        at,
      },
    });
    return { id: templateId, latestVersionId: versionId, latestVersionNumber: 1 };
  }

  async addTemplateVersion(templateId: string, draft: AutomationDraft) {
    // Authorization before validation. The write below fences on ownership
    // too, but by then the draft's connectors have been checked — and a
    // template that is missing, archived, or somebody else's would answer with
    // a connector error rather than the 404 this endpoint has always given,
    // telling a caller about connector state they have no claim on.
    const ownership = WorkspaceAutomationTemplateOwnershipSchema.parse(
      await (await this.workspace()).automationTemplateOwnership({
        workspaceId: this.auth.workspaceId,
        templateId,
        ownerUserId: this.auth.userId,
      }),
    );
    if (!ownership.owned) {
      throw new ApiError(404, "template_not_found", "Automation template not found");
    }
    const activitySourcePluginIds = suggestedActivitySourcePluginIds(draft.triggers);
    const connectorSelection = await this.validateConnectorSelections(
      draft.suggestedScope,
      [],
      activitySourcePluginIds,
    );
    this.assertActivityTriggerBindings(draft.triggers, activitySourcePluginIds, connectorSelection);
    const id = newId();
    const at = nowIso();
    // One round trip, where it used to be a read here and a batch afterwards:
    // two revisions published at the same moment read the same number and the
    // unique constraint refused the second, a 500 rather than the next version.
    // The object's input gate is what serializes it; the transaction inside
    // keeps the counter and the version rows consistent, which is a different
    // guarantee.
    const result = WorkspaceAutomationTemplateVersionResultSchema.parse(
      await (await this.workspace()).addAutomationTemplateVersion({
        workspaceId: this.auth.workspaceId,
        templateId,
        ownerUserId: this.auth.userId,
        version: {
          versionId: id,
          overview: draft.overview,
          instructions: draft.instructions,
          triggerDefinitionsJson: JSON.stringify(draft.triggers),
          requiredCapabilitiesJson: JSON.stringify(draft.requiredCapabilities),
          expectedOutputsJson: JSON.stringify(draft.expectedOutputs),
          defaultBehaviorJson: JSON.stringify(draft.defaultBehavior),
          recommendedPluginsJson: JSON.stringify(draft.recommendedPlugins),
          memoryTablesJson: JSON.stringify(draft.memoryTables),
          createdByUserId: this.auth.userId,
          at,
        },
      }),
    );
    if (result.outcome === "template_not_found") {
      throw new ApiError(404, "template_not_found", "Automation template not found");
    }
    return { id, versionNumber: result.versionNumber };
  }

  /** The WorkspaceDO that owns this workspace's template gallery. */
  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(this.auth.workspaceId),
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
  }

  private async validateConnectorSelections(
    scope: AutomationScope,
    defaultPluginIds: string[],
    activitySourcePluginIds: Record<string, string>,
  ): Promise<ValidatedConnectorBindings> {
    if (new Set(defaultPluginIds).size !== defaultPluginIds.length) {
      throw new ApiError(422, "duplicate_default_plugin", "Default automation plugins must be unique");
    }
    const pluginIds = [...new Set([...defaultPluginIds, ...Object.values(activitySourcePluginIds)])];
    const bindings: Record<string, string> = {};
    const connectorTypes = new Set<string>();
    const connectorTypesByPluginId: Record<string, string> = {};
    for (const pluginId of pluginIds) {
      const row = await this.env.DB.prepare(
        `SELECT id, connector_type, scope, owner_user_id, status FROM connector_connections
         WHERE workspace_id = ? AND model_plugin_id = ?`,
      ).bind(this.auth.workspaceId, pluginId).first<Record<string, unknown>>();
      // `disabled` only. A `needs_reconnect` belief blocked a member from even
      // setting up an automation against a connection that, once tried, works —
      // and the belief outlives its cause, so the refusal could be permanent.
      // A run that genuinely cannot authorize fails at the run, on the
      // provider's word, which is where it is both true and actionable.
      if (!row || row.status === "disabled") {
        throw new ApiError(422, "plugin_unavailable", `Connector plugin ${pluginId} is unavailable`);
      }
      // `workstream` is held to the same rule as `personal`, and has to be:
      // lending your own credentials to a standing automation is something you
      // agree to, and a room's automation is managed by everyone in the room.
      // Without this, one participant could bind a colleague's personal Gmail
      // to an automation that then outlives them both.
      if (scope !== "workspace" && row.scope === "personal" && row.owner_user_id !== this.auth.userId) {
        throw new ApiError(403, "personal_connection_access_denied", "An automation cannot use another member's personal connection");
      }
      if (scope === "workspace" && row.scope !== "workspace") {
        throw new ApiError(422, "workspace_connection_required", "Workspace automations may only use workspace connections");
      }
      bindings[pluginId] = String(row.id);
      const connectorType = String(row.connector_type);
      connectorTypes.add(connectorType);
      connectorTypesByPluginId[pluginId] = connectorType;
    }
    return { bindings, connectorTypes, connectorTypesByPluginId };
  }

  private assertActivityTriggerBindings(
    triggers: TriggerDefinition[],
    activitySourcePluginIds: Record<string, string>,
    connectorSelection: ValidatedConnectorBindings,
  ): void {
    const usedSourceKeys = new Set<string>();
    for (const trigger of triggers) {
      if (trigger.type !== "connector_activity" && trigger.type !== "semantic_activity" && trigger.type !== "webhook") {
        continue;
      }
      const requiredConnectorType = trigger.type === "webhook" ? "generic_webhook" : trigger.connectorType;
      if (trigger.sourceBindingKey) {
        usedSourceKeys.add(trigger.sourceBindingKey);
        const pluginId = activitySourcePluginIds[trigger.sourceBindingKey];
        if (!pluginId) {
          throw new ApiError(
            422,
            "activity_trigger_source_required",
            `Select a connector for activity source ${trigger.sourceBindingKey}`,
            { sourceBindingKey: trigger.sourceBindingKey, connectorType: requiredConnectorType },
          );
        }
        const selectedConnectorType = connectorSelection.connectorTypesByPluginId[pluginId];
        if (!requiredConnectorType || selectedConnectorType !== requiredConnectorType) {
          throw new ApiError(
            422,
            "activity_trigger_source_type_mismatch",
            `Activity source ${trigger.sourceBindingKey} requires a ${requiredConnectorType ?? "specific"} connector`,
            { sourceBindingKey: trigger.sourceBindingKey, pluginId, connectorType: requiredConnectorType },
          );
        }
        this.assertDeclaredActivityTrigger(trigger, requiredConnectorType);
        continue;
      }
      if (requiredConnectorType == null) {
        if (connectorSelection.connectorTypes.size > 0) continue;
        throw new ApiError(
          422,
          "activity_trigger_connection_required",
          "Select at least one connector for this activity-triggered automation",
        );
      }
      if (!connectorSelection.connectorTypes.has(requiredConnectorType)) {
        throw new ApiError(
          422,
          "activity_trigger_connection_required",
          `Select a ${requiredConnectorType} connector for this activity-triggered automation`,
        );
      }
    }
    for (const sourceBindingKey of Object.keys(activitySourcePluginIds)) {
      if (!usedSourceKeys.has(sourceBindingKey)) {
        throw new ApiError(
          422,
          "unexpected_activity_source",
          `Activity source ${sourceBindingKey} is not used by this automation version`,
          { sourceBindingKey },
        );
      }
    }
  }

  private assertDeclaredActivityTrigger(trigger: TriggerDefinition, connectorType: string): void {
    if (trigger.type === "webhook") return;
    if (trigger.type !== "connector_activity" && trigger.type !== "semantic_activity") return;
    const descriptors = connectorRegistryForEnv(this.env).get(connectorType).manifest.activityTriggers;
    const descriptorByType = new Map(descriptors.map((descriptor) => [descriptor.eventType, descriptor]));
    const eventTypes = trigger.type === "connector_activity"
      ? trigger.eventTypes
      : typeof trigger.deterministicPrefilter.eventType === "string"
        ? [trigger.deterministicPrefilter.eventType]
        : [];
    if (trigger.type === "semantic_activity" && eventTypes.length === 0) {
      throw new ApiError(
        422,
        "activity_trigger_event_required",
        `Semantic ${connectorType} activity triggers require one declared event type`,
        { connectorType },
      );
    }
    for (const eventType of eventTypes) {
      if (!descriptorByType.has(eventType)) {
        throw new ApiError(
          422,
          "unknown_activity_event",
          `${eventType} is not a declared ${connectorType} activity event`,
          { connectorType, eventType },
        );
      }
    }
    const relevantDescriptors = eventTypes.length
      ? eventTypes.flatMap((eventType) => {
          const descriptor = descriptorByType.get(eventType);
          return descriptor ? [descriptor] : [];
        })
      : descriptors;
    const filters = trigger.type === "connector_activity"
      ? trigger.deterministicFilters
      : trigger.deterministicPrefilter;
    const commonTypes: Record<string, string> = {
      provider: "string",
      connectorType: "string",
      eventType: "string",
      resourceType: "string",
      providerResourceId: "string",
    };
    const declaredTypes = new Map<string, Set<string>>(
      Object.entries(commonTypes).map(([key, valueType]) => [key, new Set([valueType])]),
    );
    for (const descriptor of relevantDescriptors) {
      for (const field of descriptor.filterFields) {
        const valueTypes = declaredTypes.get(field.key) ?? new Set<string>();
        valueTypes.add(field.valueType);
        declaredTypes.set(field.key, valueTypes);
      }
    }
    for (const [key, value] of Object.entries(filters)) {
      const valueTypes = declaredTypes.get(key);
      if (!valueTypes || ![...valueTypes].some((valueType) => activityFilterValueMatches(valueType, value))) {
        throw new ApiError(
          422,
          "invalid_activity_filter",
          `${key} is not a declared ${connectorType} activity filter with a compatible value`,
          { connectorType, key },
        );
      }
    }
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function activityFilterValueMatches(valueType: string, value: unknown): boolean {
  if (valueType === "string") return typeof value === "string";
  if (valueType === "number") return typeof value === "number" && Number.isFinite(value);
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "string_array") {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
  return false;
}
/**
 * The catalog's two reads of a stored JSON blob, each degrading its own row.
 *
 * `parseJson` is `JSON.parse(...) as T` — an assertion, not a parse — and these
 * columns are durable: a row is whatever the deploy that published it wrote.
 * The page's response contract covers every item at once, so one blob the
 * projection cannot represent throws for the *whole* catalog rather than for
 * its own row. That is the failure this endpoint was already fixed for once;
 * unvalidated reads are the other way to reach it, and a non-array blob does
 * not even get as far as the contract — `activitySourceDefinitions` would
 * throw iterating it.
 *
 * The sibling that reads `trigger_definitions_json` in
 * `services/slack-agent-service.ts` parses it already for the same stated
 * reason. A template that loses its bindings here is one nobody can subscribe
 * to, which the AutomationAgent's adoption path refuses with a typed 422; a
 * catalog that 500s is a template browser no one in the workspace can open at
 * all.
 */
function templateTriggers(value: unknown): TriggerDefinition[] {
  const parsed = z.array(TriggerDefinitionSchema).safeParse(parseJson<unknown>(value, []));
  return parsed.success ? parsed.data : [];
}

function templateCapabilities(value: unknown): string[] {
  const parsed = z.array(z.string()).safeParse(parseJson<unknown>(value, []));
  return parsed.success ? parsed.data : [];
}

function activitySourceDefinitions(triggers: TriggerDefinition[]): Array<{
  bindingKey: string;
  connectorType: string;
  suggestedPluginId?: string;
}> {
  const sources = new Map<string, {
    bindingKey: string;
    connectorType: string;
    suggestedPluginId?: string;
  }>();
  for (const trigger of triggers) {
    if (trigger.type !== "connector_activity" && trigger.type !== "semantic_activity" && trigger.type !== "webhook") continue;
    if (!trigger.sourceBindingKey) continue;
    const connectorType = trigger.type === "webhook" ? "generic_webhook" : trigger.connectorType;
    if (!connectorType) continue;
    sources.set(trigger.sourceBindingKey, {
      bindingKey: trigger.sourceBindingKey,
      connectorType,
      ...(trigger.suggestedSourcePluginId ? { suggestedPluginId: trigger.suggestedSourcePluginId } : {}),
    });
  }
  return [...sources.values()];
}
function suggestedActivitySourcePluginIds(triggers: TriggerDefinition[]): Record<string, string> {
  return Object.fromEntries(activitySourceDefinitions(triggers).flatMap((source) =>
    source.suggestedPluginId ? [[source.bindingKey, source.suggestedPluginId] as const] : []));
}
