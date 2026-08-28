import { newId, nowIso } from "@rally/db";
import { TriggerDefinitionSchema } from "@rally/contracts";
import type {
  AutomationDraft,
  Scope,
} from "@rally/contracts";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";

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
    const result = await this.env.DB.prepare(
      `SELECT t.*,
       0 AS use_count,
       v.required_capabilities_json, v.trigger_definitions_json
       FROM automation_templates t
       JOIN automation_template_versions v ON v.template_id = t.id AND v.version_number = t.latest_version_number
       WHERE t.workspace_id = ? AND t.sharing_state = 'workspace' AND t.archived_at IS NULL
       ORDER BY t.name COLLATE NOCASE`,
    ).bind(this.auth.workspaceId).all<Record<string, unknown>>();
    const ownerIds = [...new Set(result.results.flatMap((row) =>
      typeof row.owner_user_id === "string" ? [row.owner_user_id] : []))];
    const owners = ownerIds.length === 0 ? [] : (await workspaceRegionalDatabase(this.env).prepare(
      `SELECT id, name FROM users WHERE id IN (${ownerIds.map(() => "?").join(",")})`,
    ).bind(...ownerIds).all<{ id: string; name: string }>()).results;
    const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));
    return { items: result.results.map((row) => ({
      id: row.id,
      name: row.name,
      author: typeof row.owner_user_id === "string"
        ? ownerNames.get(row.owner_user_id) ?? "Unknown member"
        : "Unknown member",
      description: row.description,
      usedBy: Number(row.use_count),
      requiredCapabilities: templateCapabilities(row.required_capabilities_json),
      latestVersion: Number(row.latest_version_number),
      activitySources: activitySourceDefinitions(templateTriggers(row.trigger_definitions_json)),
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
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_templates
         (id, workspace_id, owner_user_id, name, description, sharing_state,
          latest_version_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'workspace', 1, ?, ?)`,
      ).bind(templateId, this.auth.workspaceId, this.auth.userId, input.name, input.description, at, at),
      this.env.DB.prepare(
        `INSERT INTO automation_template_versions
         (id, template_id, version_number, overview, instructions, trigger_definitions_json,
          required_capabilities_json, expected_outputs_json, default_behavior_json,
          recommended_plugins_json, memory_tables_json, created_by_user_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(versionId, templateId, input.draft.overview, input.draft.instructions, JSON.stringify(input.draft.triggers), JSON.stringify(input.draft.requiredCapabilities), JSON.stringify(input.draft.expectedOutputs), JSON.stringify(input.draft.defaultBehavior), JSON.stringify(input.draft.recommendedPlugins), JSON.stringify(input.draft.memoryTables), this.auth.userId, at),
    ]);
    return { id: templateId, latestVersionId: versionId, latestVersionNumber: 1 };
  }

  async addTemplateVersion(templateId: string, draft: AutomationDraft) {
    const template = await this.env.DB.prepare(
      `SELECT * FROM automation_templates WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL`,
    ).bind(templateId, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>();
    if (!template) throw new ApiError(404, "template_not_found", "Automation template not found");
    const activitySourcePluginIds = suggestedActivitySourcePluginIds(draft.triggers);
    const connectorSelection = await this.validateConnectorSelections(
      draft.suggestedScope,
      [],
      activitySourcePluginIds,
    );
    this.assertActivityTriggerBindings(draft.triggers, activitySourcePluginIds, connectorSelection);
    const number = Number(template.latest_version_number) + 1;
    const id = newId();
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_template_versions
         (id, template_id, version_number, overview, instructions, trigger_definitions_json,
          required_capabilities_json, expected_outputs_json, default_behavior_json,
          recommended_plugins_json, memory_tables_json, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, templateId, number, draft.overview, draft.instructions, JSON.stringify(draft.triggers), JSON.stringify(draft.requiredCapabilities), JSON.stringify(draft.expectedOutputs), JSON.stringify(draft.defaultBehavior), JSON.stringify(draft.recommendedPlugins), JSON.stringify(draft.memoryTables), this.auth.userId, at),
      this.env.DB.prepare("UPDATE automation_templates SET latest_version_number = ?, updated_at = ? WHERE id = ?").bind(number, at, templateId),
    ]);
    return { id, versionNumber: number };
  }

  private async validateConnectorSelections(
    scope: Scope,
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
      if (scope === "personal" && row.scope === "personal" && row.owner_user_id !== this.auth.userId) {
        throw new ApiError(403, "personal_connection_access_denied", "A personal automation cannot use another member's personal connection");
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
/** What the compiler says back after a turn. The service owns it rather than
 * the route because the saved transcript and the streamed reply have to be the
 * same sentence — a resumed draft that ends on a different question than the
 * one on screen reads as a different conversation. */
export function assistantMessageForDraft(draft: AutomationDraft): string {
  return draft.elicitation?.prompt
    ?? draft.followUpQuestion
    ?? (draft.ready
      ? "The automation is ready to create."
      : "I need one more detail before I can create this automation.");
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
