import { newId, nowIso } from "@avalon/db";
import type {
  AutomationDraft,
  CreateAutomationRequestSchema,
  ExecutionPrincipal,
  Scope,
  TriggerDefinitionSchema,
  WorkstreamWorkflowInput,
} from "@avalon/contracts";
import type { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError, isConstraintError } from "../lib/api-error";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { compileAutomationDraft, startWorkstreamWorkflow } from "./integrations";

type CreateAutomationInput = z.infer<typeof CreateAutomationRequestSchema>;
type TriggerDefinition = z.infer<typeof TriggerDefinitionSchema>;

interface CompiledSchedule {
  type: "calendar" | "interval";
  rrule: string | null;
  intervalSeconds: number | null;
  timezone: string;
  nextRunAt: string;
}

interface IdempotentAutomationRun {
  runId: string;
  workstreamId: string;
  harnessRunId: string | null;
  workflowInstanceId: string | null;
  runStatus: string;
  harnessStatus: string | null;
}

export class AutomationService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async list() {
    const result = await this.env.DB.prepare(
      `SELECT s.id, t.name, t.description, s.scope, s.status,
         s.next_run_at, s.last_run_at,
         CASE WHEN t.latest_version_number > v.version_number THEN 1 ELSE 0 END AS update_available
       FROM automation_subscriptions s
       JOIN automation_templates t ON t.id = s.template_id
       JOIN automation_template_versions v ON v.id = s.template_version_id
       WHERE s.workspace_id = ? AND t.archived_at IS NULL
         AND (s.scope = 'workspace' OR s.owner_user_id = ?)
       ORDER BY t.name COLLATE NOCASE`,
    ).bind(this.auth.workspaceId, this.auth.userId).all<Record<string, unknown>>();
    return { items: (result.results ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      scope: String(row.scope),
      status: String(row.status),
      nextRunAt: row.next_run_at == null ? null : String(row.next_run_at),
      lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
      updateAvailable: Number(row.update_available) === 1,
    })) };
  }

  async compile(input: { messages: Array<{ role: "user" | "assistant"; content: string }>; currentDraft?: AutomationDraft | null }) {
    return compileAutomationDraft(this.env, input);
  }

  async create(input: CreateAutomationInput) {
    if (!input.draft.ready) throw new ApiError(422, "automation_not_ready", "Finish the automation conversation before creating it");
    this.assertScopeAllowed(input.scope);
    await this.validateConnectorBindings(input.scope, input.draft.requiredCapabilities, input.connectorBindings);
    const templateId = newId();
    const versionId = newId();
    const subscriptionId = newId();
    const at = nowIso();
    const principal: ExecutionPrincipal = input.scope === "personal"
      ? { type: "user", userId: this.auth.userId }
      : { type: "workspace", workspaceId: this.auth.workspaceId };
    const schedules = input.draft.triggers.flatMap((trigger) => this.scheduleForTrigger(trigger, subscriptionId, at));
    const nextRunAt = schedules.map((schedule) => schedule.nextRunAt).sort()[0] ?? null;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_templates
         (id, workspace_id, owner_user_id, name, description, sharing_state,
          latest_version_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'private', 1, ?, ?)`,
      ).bind(templateId, this.auth.workspaceId, this.auth.userId, input.draft.name, input.draft.description, at, at),
      this.env.DB.prepare(
        `INSERT INTO automation_template_versions
         (id, template_id, version_number, instructions, trigger_definitions_json,
          required_capabilities_json, expected_outputs_json, default_behavior_json,
          created_by_user_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(versionId, templateId, input.draft.instructions, JSON.stringify(input.draft.triggers), JSON.stringify(input.draft.requiredCapabilities), JSON.stringify(input.draft.expectedOutputs), JSON.stringify(input.draft.defaultBehavior), this.auth.userId, at),
      this.env.DB.prepare(
        `INSERT INTO automation_subscriptions
         (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
          execution_principal_json, connector_bindings_json, overrides_json, status,
          next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?)`,
      ).bind(subscriptionId, this.auth.workspaceId, templateId, versionId, input.scope, input.scope === "personal" ? this.auth.userId : null, JSON.stringify(principal), JSON.stringify(input.connectorBindings), nextRunAt, at, at),
      ...schedules.map((schedule) => this.env.DB.prepare(
        `INSERT INTO schedules
         (id, workspace_id, automation_subscription_id, schedule_type, rrule,
          interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      ).bind(newId(), this.auth.workspaceId, subscriptionId, schedule.type, schedule.rrule, schedule.intervalSeconds, schedule.timezone, schedule.nextRunAt, at, at)),
    ]);
    if (schedules.length > 0) await this.refreshScheduler();
    return this.get(subscriptionId);
  }

  async get(id: string) {
    const row = await this.loadSubscription(id);
    const updateAvailable = Number(row.latest_version_number) > Number(row.version_number);
    const [runs, planned, latestVersion] = await Promise.all([
      this.runs(id, 20),
      this.env.DB.prepare(
        `SELECT w.*, t.name AS origin_label FROM workstreams w
         JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
         JOIN automation_templates t ON t.id = s.template_id
         JOIN schedules sc ON sc.automation_subscription_id = s.id
           AND sc.workspace_id = s.workspace_id AND sc.enabled = 1
           AND sc.next_run_at = w.planned_for
         WHERE w.workspace_id = ? AND w.automation_subscription_id = ? AND w.harness_status = 'scheduled'
         ORDER BY w.planned_for LIMIT 1`,
      ).bind(this.auth.workspaceId, id).first<Record<string, unknown>>(),
      updateAvailable
        ? this.env.DB.prepare(
            `SELECT id, version_number, instructions, trigger_definitions_json,
              required_capabilities_json, expected_outputs_json
             FROM automation_template_versions
             WHERE template_id = ? AND version_number = ?`,
          ).bind(row.template_id, row.latest_version_number).first<Record<string, unknown>>()
        : Promise.resolve(null),
    ]);
    return {
      id: String(row.id), name: String(row.name), description: String(row.description), scope: String(row.scope), status: String(row.status),
      nextRunAt: row.next_run_at == null ? null : String(row.next_run_at), lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
      updateAvailable, templateId: String(row.template_id), templateVersionId: String(row.template_version_id),
      versionNumber: Number(row.version_number), instructions: String(row.instructions), triggers: parseJson(row.trigger_definitions_json, []),
      requiredCapabilities: parseJson(row.required_capabilities_json, []), expectedOutputs: parseJson(row.expected_outputs_json, []),
      executionPrincipal: parseJson(row.execution_principal_json, {}),
      connectorBindings: parseJson(row.connector_bindings_json, {}),
      templateUpdate: latestVersion ? {
        versionId: String(latestVersion.id),
        versionNumber: Number(latestVersion.version_number),
        instructions: String(latestVersion.instructions),
        triggers: parseJson(latestVersion.trigger_definitions_json, []),
        requiredCapabilities: parseJson(latestVersion.required_capabilities_json, []),
        expectedOutputs: parseJson(latestVersion.expected_outputs_json, []),
      } : null,
      nextPlannedWorkstream: planned ? toWorkstream(planned) : null, recentRuns: runs.items,
    };
  }

  async update(id: string, input: {
    name?: string | undefined;
    description?: string | undefined;
    instructions?: string | undefined;
    connectorBindings?: Record<string, string> | undefined;
    overrides?: Record<string, unknown> | undefined;
  }) {
    const row = await this.loadSubscription(id);
    this.assertCanManageSubscription(row);
    if ((input.name != null || input.description != null) && row.template_owner_user_id !== this.auth.userId) {
      throw new ApiError(403, "template_owner_required", "Only the template owner can change its name or description");
    }
    if (input.connectorBindings) {
      await this.validateConnectorBindings(String(row.scope) as Scope, parseJson(row.required_capabilities_json, []), input.connectorBindings);
    }
    const at = nowIso();
    const statements = [
      this.env.DB.prepare(
        `UPDATE automation_templates SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(input.name ?? null, input.description ?? null, at, row.template_id, this.auth.workspaceId),
      this.env.DB.prepare(
        `UPDATE automation_subscriptions SET connector_bindings_json = COALESCE(?, connector_bindings_json),
         overrides_json = COALESCE(?, overrides_json), updated_at = ? WHERE id = ? AND workspace_id = ?`,
      ).bind(input.connectorBindings ? JSON.stringify(input.connectorBindings) : null, input.overrides ? JSON.stringify(input.overrides) : null, at, id, this.auth.workspaceId),
    ];
    if (input.instructions != null && input.instructions !== row.instructions) {
      if (row.template_owner_user_id !== this.auth.userId) {
        throw new ApiError(403, "template_owner_required", "Only the template owner can change its instructions");
      }
      const versionId = newId();
      const versionNumber = Number(row.latest_version_number) + 1;
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO automation_template_versions
           (id, template_id, version_number, instructions, trigger_definitions_json,
            required_capabilities_json, expected_outputs_json, default_behavior_json,
            created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(versionId, row.template_id, versionNumber, input.instructions, row.trigger_definitions_json, row.required_capabilities_json, row.expected_outputs_json, row.default_behavior_json, this.auth.userId, at),
        this.env.DB.prepare(
          `UPDATE automation_templates SET latest_version_number = ?, updated_at = ? WHERE id = ?`,
        ).bind(versionNumber, at, row.template_id),
        this.env.DB.prepare(
          `UPDATE automation_subscriptions SET template_version_id = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        ).bind(versionId, at, id, this.auth.workspaceId),
      );
    }
    await this.env.DB.batch(statements);
    return this.get(id);
  }

  async runNow(id: string, idempotencyKey: string) {
    const subscription = await this.loadSubscription(id);
    if (subscription.status !== "active") throw new ApiError(409, "automation_not_active", "Resume the automation before running it");
    return this.createRun(subscription, "manual", null, null, true, idempotencyKey);
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    const subscription = await this.loadSubscription(id);
    this.assertCanManageSubscription(subscription);
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE automation_subscriptions SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
        .bind(paused ? "paused" : "active", at, id, this.auth.workspaceId),
      this.env.DB.prepare("UPDATE schedules SET enabled = ?, updated_at = ?, version = version + 1 WHERE automation_subscription_id = ?")
        .bind(paused ? 0 : 1, at, id),
    ]);
    await this.refreshScheduler();
  }

  async runs(id: string, limit = 50) {
    await this.loadSubscription(id);
    const result = await this.env.DB.prepare(
      `SELECT * FROM automation_runs WHERE workspace_id = ? AND automation_subscription_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(this.auth.workspaceId, id, Math.min(limit, 100)).all<Record<string, unknown>>();
    return { items: (result.results ?? []).map(toAutomationRun) };
  }

  async nextRun(id: string) {
    const subscription = await this.loadSubscription(id);
    const schedule = await this.env.DB.prepare(
      `SELECT * FROM schedules WHERE workspace_id = ? AND automation_subscription_id = ? AND enabled = 1
       ORDER BY next_run_at LIMIT 1`,
    ).bind(this.auth.workspaceId, id).first<Record<string, unknown>>();
    if (!schedule) return { scheduledFor: null, workstream: null };
    const workstream = await this.env.DB.prepare(
      `SELECT * FROM workstreams WHERE workspace_id = ? AND automation_subscription_id = ? AND planned_for = ?`,
    ).bind(this.auth.workspaceId, id, schedule.next_run_at).first<Record<string, unknown>>();
    return { scheduledFor: String(schedule.next_run_at), workstream: workstream ? toWorkstream(workstream) : null, automation: String(subscription.name) };
  }

  async openNextRun(id: string) {
    const subscription = await this.loadSubscription(id);
    const schedule = await this.env.DB.prepare(
      `SELECT next_run_at FROM schedules WHERE workspace_id = ? AND automation_subscription_id = ? AND enabled = 1
       ORDER BY next_run_at LIMIT 1`,
    ).bind(this.auth.workspaceId, id).first<{ next_run_at: string }>();
    if (!schedule) throw new ApiError(404, "next_run_not_scheduled", "This automation has no scheduled run");
    return this.createRun(subscription, "schedule", schedule.next_run_at, null, false, null);
  }

  async listTemplates() {
    const result = await this.env.DB.prepare(
      `SELECT t.*, u.name AS author_name,
       (SELECT COUNT(*) FROM automation_subscriptions s WHERE s.template_id = t.id) AS use_count,
       v.required_capabilities_json
       FROM automation_templates t JOIN users u ON u.id = t.owner_user_id
       JOIN automation_template_versions v ON v.template_id = t.id AND v.version_number = t.latest_version_number
       WHERE t.workspace_id = ? AND t.sharing_state = 'workspace' AND t.archived_at IS NULL
       ORDER BY t.name COLLATE NOCASE`,
    ).bind(this.auth.workspaceId).all<Record<string, unknown>>();
    return { items: (result.results ?? []).map((row) => ({ id: row.id, name: row.name, author: row.author_name, description: row.description, usedBy: Number(row.use_count), requiredCapabilities: parseJson(row.required_capabilities_json, []), latestVersion: Number(row.latest_version_number) })) };
  }

  async publishTemplate(input: { name: string; description: string; draft: AutomationDraft }) {
    if (!input.draft.ready) throw new ApiError(422, "template_not_ready", "Finish the automation recipe before publishing it");
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
         (id, template_id, version_number, instructions, trigger_definitions_json,
          required_capabilities_json, expected_outputs_json, default_behavior_json,
          created_by_user_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(versionId, templateId, input.draft.instructions, JSON.stringify(input.draft.triggers), JSON.stringify(input.draft.requiredCapabilities), JSON.stringify(input.draft.expectedOutputs), JSON.stringify(input.draft.defaultBehavior), this.auth.userId, at),
    ]);
    return { id: templateId, latestVersionId: versionId, latestVersionNumber: 1 };
  }

  async shareSubscription(subscriptionId: string): Promise<{ templateId: string }> {
    const subscription = await this.loadSubscription(subscriptionId);
    if (subscription.template_owner_user_id !== this.auth.userId) {
      throw new ApiError(403, "template_owner_required", "Only the template owner can publish this automation");
    }
    await this.env.DB.prepare(
      `UPDATE automation_templates SET sharing_state = 'workspace', updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(nowIso(), subscription.template_id, this.auth.workspaceId).run();
    return { templateId: String(subscription.template_id) };
  }

  async addTemplateVersion(templateId: string, draft: AutomationDraft) {
    const template = await this.env.DB.prepare(
      `SELECT * FROM automation_templates WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL`,
    ).bind(templateId, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>();
    if (!template) throw new ApiError(404, "template_not_found", "Automation template not found");
    const number = Number(template.latest_version_number) + 1;
    const id = newId();
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_template_versions
         (id, template_id, version_number, instructions, trigger_definitions_json,
          required_capabilities_json, expected_outputs_json, default_behavior_json,
          created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, templateId, number, draft.instructions, JSON.stringify(draft.triggers), JSON.stringify(draft.requiredCapabilities), JSON.stringify(draft.expectedOutputs), JSON.stringify(draft.defaultBehavior), this.auth.userId, at),
      this.env.DB.prepare("UPDATE automation_templates SET latest_version_number = ?, updated_at = ? WHERE id = ?").bind(number, at, templateId),
    ]);
    return { id, versionNumber: number };
  }

  async subscribe(templateId: string, input: { connectorBindings: Record<string, string> }) {
    const template = await this.env.DB.prepare(
      `SELECT t.*, v.id AS version_id, v.* FROM automation_templates t
       JOIN automation_template_versions v ON v.template_id = t.id AND v.version_number = t.latest_version_number
       WHERE t.id = ? AND t.workspace_id = ? AND t.sharing_state = 'workspace' AND t.archived_at IS NULL`,
    ).bind(templateId, this.auth.workspaceId).first<Record<string, unknown>>();
    if (!template) throw new ApiError(404, "template_not_found", "Workspace template not found");
    const draft: AutomationDraft = {
      name: String(template.name), description: String(template.description), instructions: String(template.instructions),
      triggers: parseJson(template.trigger_definitions_json, []), requiredCapabilities: parseJson(template.required_capabilities_json, []),
      expectedOutputs: parseJson(template.expected_outputs_json, []), defaultBehavior: parseJson(template.default_behavior_json, {}),
      suggestedScope: "personal", followUpQuestion: null, ready: true,
    };
    await this.validateConnectorBindings("personal", draft.requiredCapabilities, input.connectorBindings);
    const subscriptionId = newId();
    const at = nowIso();
    const schedules = draft.triggers.flatMap((trigger) => this.scheduleForTrigger(trigger, subscriptionId, at));
    const nextRunAt = schedules.map((item) => item.nextRunAt).sort()[0] ?? null;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_subscriptions
         (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
          execution_principal_json, connector_bindings_json, overrides_json, status,
          next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'personal', ?, ?, ?, '{}', 'active', ?, ?, ?)`,
      ).bind(subscriptionId, this.auth.workspaceId, templateId, template.version_id, this.auth.userId, JSON.stringify({ type: "user", userId: this.auth.userId }), JSON.stringify(input.connectorBindings), nextRunAt, at, at),
      ...schedules.map((schedule) => this.env.DB.prepare(
        `INSERT INTO schedules
         (id, workspace_id, automation_subscription_id, schedule_type, rrule,
          interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      ).bind(newId(), this.auth.workspaceId, subscriptionId, schedule.type, schedule.rrule, schedule.intervalSeconds, schedule.timezone, schedule.nextRunAt, at, at)),
    ]);
    if (schedules.length) await this.refreshScheduler();
    return this.get(subscriptionId);
  }

  async adoptVersion(subscriptionId: string, versionId: string) {
    const subscription = await this.loadSubscription(subscriptionId);
    this.assertCanManageSubscription(subscription);
    const version = await this.env.DB.prepare(
      `SELECT * FROM automation_template_versions WHERE id = ? AND template_id = ?`,
    ).bind(versionId, subscription.template_id).first<Record<string, unknown>>();
    if (!version) throw new ApiError(404, "template_version_not_found", "Template version not found");
    await this.validateConnectorBindings(String(subscription.scope) as Scope, parseJson(version.required_capabilities_json, []), parseJson(subscription.connector_bindings_json, {}));
    const at = nowIso();
    const triggers = parseJson<TriggerDefinition[]>(version.trigger_definitions_json, []);
    const schedules = triggers.flatMap((trigger) => this.scheduleForTrigger(trigger, subscriptionId, at));
    const nextRunAt = schedules.map((schedule) => schedule.nextRunAt).sort()[0] ?? null;
    const enabled = subscription.status === "paused" ? 0 : 1;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE automation_subscriptions
         SET template_version_id = ?, next_run_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(versionId, nextRunAt, at, subscriptionId, this.auth.workspaceId),
      this.env.DB.prepare(
        "DELETE FROM schedules WHERE automation_subscription_id = ? AND workspace_id = ?",
      ).bind(subscriptionId, this.auth.workspaceId),
      ...schedules.map((schedule) => this.env.DB.prepare(
        `INSERT INTO schedules
         (id, workspace_id, automation_subscription_id, schedule_type, rrule,
          interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(newId(), this.auth.workspaceId, subscriptionId, schedule.type, schedule.rrule, schedule.intervalSeconds, schedule.timezone, schedule.nextRunAt, enabled, at, at)),
    ]);
    await this.refreshScheduler();
    return this.get(subscriptionId);
  }

  private async createRun(
    subscription: Record<string, unknown>,
    triggerType: string,
    plannedFor: string | null,
    activityId: string | null,
    start: boolean,
    idempotencyKey: string | null,
  ) {
    if (plannedFor) {
      const existing = await this.env.DB.prepare(
        `SELECT r.id AS run_id, r.workstream_id FROM automation_runs r
         WHERE r.automation_subscription_id = ? AND r.planned_for = ?`,
      ).bind(subscription.id, plannedFor).first<{ run_id: string; workstream_id: string }>();
      if (existing) return { runId: existing.run_id, workstreamId: existing.workstream_id, reused: true };
    }
    if (idempotencyKey) {
      const existing = await this.loadIdempotentRun(String(subscription.id), idempotencyKey);
      if (existing) {
        if (start) await this.recoverIdempotentRun(subscription, existing, triggerType, activityId);
        return this.runResponse(existing, true);
      }
    }
    const runId = newId();
    const workstreamId = newId();
    const harnessRunId = newId();
    const at = nowIso();
    const principal = parseJson<ExecutionPrincipal>(subscription.execution_principal_json, { type: "user", userId: this.auth.userId });
    try {
      const statements = [
        this.env.DB.prepare(
          `INSERT INTO workstreams
           (id, workspace_id, title, objective, origin_type, automation_subscription_id,
            automation_run_id, planned_for, harness_status, next_sequence_number,
           last_activity_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'automation', ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(workstreamId, this.auth.workspaceId, String(subscription.name), String(subscription.description), subscription.id, runId, plannedFor, "scheduled", at, at, at),
        this.env.DB.prepare(
          `INSERT INTO automation_runs
           (id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
            trigger_activity_id, planned_for, started_at, status, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(runId, this.auth.workspaceId, subscription.id, workstreamId, triggerType, activityId, plannedFor, null, "scheduled", idempotencyKey, at),
      ];
      if (start) {
        statements.push(this.env.DB.prepare(
          `INSERT INTO harness_runs
           (id, workspace_id, workstream_id, origin, execution_principal_json,
            status, started_at, model, created_at)
           VALUES (?, ?, ?, 'automation_run', ?, 'scheduled', NULL, ?, ?)`,
        ).bind(harnessRunId, this.auth.workspaceId, workstreamId, JSON.stringify(principal), this.env.OPENROUTER_PRIMARY_MODEL, at));
      }
      await this.env.DB.batch(statements);
    } catch (error) {
      if (plannedFor && isConstraintError(error)) {
        const existing = await this.env.DB.prepare(
          `SELECT id AS run_id, workstream_id FROM automation_runs WHERE automation_subscription_id = ? AND planned_for = ?`,
        ).bind(subscription.id, plannedFor).first<{ run_id: string; workstream_id: string }>();
        if (existing) return { runId: existing.run_id, workstreamId: existing.workstream_id, reused: true };
      }
      if (idempotencyKey && isConstraintError(error)) {
        const existing = await this.loadIdempotentRun(String(subscription.id), idempotencyKey);
        if (existing) {
          if (start) await this.recoverIdempotentRun(subscription, existing, triggerType, activityId);
          return this.runResponse(existing, true);
        }
      }
      throw error;
    }
    if (start) {
      await this.launchAutomationRun(subscription, {
        runId,
        workstreamId,
        harnessRunId,
        workflowInstanceId: null,
        runStatus: "scheduled",
        harnessStatus: "scheduled",
      }, triggerType, activityId, principal);
    }
    return { runId, workstreamId, ...(start ? { harnessRunId } : {}), reused: false };
  }

  private async loadIdempotentRun(subscriptionId: string, idempotencyKey: string): Promise<IdempotentAutomationRun | null> {
    const row = await this.env.DB.prepare(
      `SELECT r.id AS run_id, r.workstream_id, r.status AS run_status,
       r.workflow_instance_id AS run_workflow_instance_id,
       h.id AS harness_run_id, h.status AS harness_status,
       h.workflow_instance_id AS harness_workflow_instance_id
       FROM automation_runs r
       LEFT JOIN harness_runs h ON h.workstream_id = r.workstream_id
       WHERE r.workspace_id = ? AND r.automation_subscription_id = ? AND r.idempotency_key = ?
       ORDER BY h.created_at DESC LIMIT 1`,
    ).bind(this.auth.workspaceId, subscriptionId, idempotencyKey).first<{
      run_id: string;
      workstream_id: string;
      run_status: string;
      run_workflow_instance_id: string | null;
      harness_run_id: string | null;
      harness_status: string | null;
      harness_workflow_instance_id: string | null;
    }>();
    if (!row) return null;
    return {
      runId: row.run_id,
      workstreamId: row.workstream_id,
      harnessRunId: row.harness_run_id,
      workflowInstanceId: row.harness_workflow_instance_id ?? row.run_workflow_instance_id,
      runStatus: row.run_status,
      harnessStatus: row.harness_status,
    };
  }

  private async recoverIdempotentRun(
    subscription: Record<string, unknown>,
    run: IdempotentAutomationRun,
    triggerType: string,
    activityId: string | null,
  ): Promise<void> {
    const terminalStatuses = new Set(["completed", "failed", "needs_input", "stopped"]);
    if (terminalStatuses.has(run.runStatus) || (run.harnessStatus && terminalStatuses.has(run.harnessStatus))) {
      return;
    }
    if (!run.harnessRunId) {
      throw new ApiError(503, "workflow_launch_pending", "The automation run is still being prepared; retry with the same key");
    }
    if (run.workflowInstanceId) {
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE harness_runs SET workflow_instance_id = ? WHERE id = ? AND workspace_id = ?",
        ).bind(run.workflowInstanceId, run.harnessRunId, this.auth.workspaceId),
        this.env.DB.prepare(
          "UPDATE automation_runs SET workflow_instance_id = ? WHERE id = ? AND workspace_id = ?",
        ).bind(run.workflowInstanceId, run.runId, this.auth.workspaceId),
      ]);
      return;
    }
    const principal = parseJson<ExecutionPrincipal>(subscription.execution_principal_json, {
      type: "user",
      userId: this.auth.userId,
    });
    await this.launchAutomationRun(subscription, run, triggerType, activityId, principal);
  }

  private async launchAutomationRun(
    subscription: Record<string, unknown>,
    run: IdempotentAutomationRun,
    triggerType: string,
    activityId: string | null,
    principal: ExecutionPrincipal,
  ): Promise<void> {
    if (!run.harnessRunId) {
      throw new ApiError(503, "workflow_launch_pending", "The automation run is still being prepared; retry with the same key");
    }
    const workflowInput: WorkstreamWorkflowInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId: run.workstreamId,
      harnessRunId: run.harnessRunId,
      triggerMessageId: null,
      automationSubscriptionId: String(subscription.id),
      activityId,
      executionPrincipal: principal,
      reason: triggerType,
    };
    try {
      await startWorkstreamWorkflow(this.env, workflowInput);
    } catch {
      throw new ApiError(503, "workflow_unavailable", "The automation run could not be started; retry with the same key");
    }
  }

  private runResponse(run: IdempotentAutomationRun, reused: boolean) {
    return {
      runId: run.runId,
      workstreamId: run.workstreamId,
      ...(run.harnessRunId ? { harnessRunId: run.harnessRunId } : {}),
      reused,
    };
  }

  private scheduleForTrigger(trigger: TriggerDefinition, _subscriptionId: string, at: string): CompiledSchedule[] {
    if (trigger.type === "interval") {
      return [{ type: "interval", rrule: null, intervalSeconds: trigger.intervalSeconds, timezone: "UTC", nextRunAt: new Date(Date.parse(at) + trigger.intervalSeconds * 1_000).toISOString() }];
    }
    if (trigger.type === "calendar") {
      try { new Intl.DateTimeFormat("en-US", { timeZone: trigger.timezone }).format(); } catch { throw new ApiError(422, "invalid_timezone", `Invalid IANA time zone: ${trigger.timezone}`); }
      let next: Date | null;
      try {
        next = nextRRuleOccurrence(trigger.rrule, trigger.timezone, new Date(at), new Date(at));
      } catch {
        throw new ApiError(422, "invalid_recurrence", "The automation recurrence rule is invalid");
      }
      if (!next) throw new ApiError(422, "recurrence_has_no_future", "The automation recurrence has no future occurrence");
      return [{ type: "calendar", rrule: trigger.rrule, intervalSeconds: null, timezone: trigger.timezone, nextRunAt: next.toISOString() }];
    }
    return [];
  }

  private async validateConnectorBindings(scope: Scope, capabilities: string[], bindings: Record<string, string>): Promise<void> {
    for (const capability of capabilities) {
      const connectionId = bindings[capability];
      if (!connectionId) throw new ApiError(422, "connector_binding_required", `Select a connection for ${capability}`);
      const row = await this.env.DB.prepare(
        `SELECT scope, owner_user_id, granted_scopes_json, status FROM connector_connections
         WHERE id = ? AND workspace_id = ?`,
      ).bind(connectionId, this.auth.workspaceId).first<Record<string, unknown>>();
      if (!row || row.status !== "healthy") throw new ApiError(422, "connection_unavailable", `The connection for ${capability} is unavailable`);
      if (scope === "personal" && row.scope === "personal" && row.owner_user_id !== this.auth.userId) throw new ApiError(403, "personal_connection_access_denied", "A personal automation cannot use another member's connection");
      if (scope === "workspace" && row.scope !== "workspace") throw new ApiError(422, "workspace_connection_required", "Workspace automations require workspace connections");
      if (!parseJson<string[]>(row.granted_scopes_json, []).includes(capability)) throw new ApiError(422, "connector_capability_missing", `The selected connection has not granted ${capability}`);
    }
  }

  private assertScopeAllowed(scope: Scope): void {
    if (scope === "workspace" && this.auth.role !== "owner" && this.auth.role !== "admin") throw new ApiError(403, "workspace_admin_required", "Only administrators can create workspace automations");
  }

  private assertCanManageSubscription(subscription: Record<string, unknown>): void {
    if (subscription.scope === "workspace" && this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Only administrators can change workspace automations");
    }
  }

  private async loadSubscription(id: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      `SELECT s.*, t.name, t.description, t.latest_version_number,
       v.version_number, v.instructions, v.trigger_definitions_json,
       v.required_capabilities_json, v.expected_outputs_json, v.default_behavior_json
       , t.owner_user_id AS template_owner_user_id
       FROM automation_subscriptions s JOIN automation_templates t ON t.id = s.template_id
       JOIN automation_template_versions v ON v.id = s.template_version_id
       WHERE s.id = ? AND s.workspace_id = ?
         AND (s.scope = 'workspace' OR s.owner_user_id = ?) AND t.archived_at IS NULL`,
    ).bind(id, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "automation_not_found", "Automation not found");
    return row;
  }

  private async refreshScheduler(): Promise<void> {
    const schedulers = durableObjectNamespaceForRegion(this.env.WORKSPACE_SCHEDULERS, this.env.AVALON_REGION, this.env.APP_ENV);
    const id = schedulers.idFromName(`${this.env.AVALON_REGION}:${this.auth.workspaceId}`);
    const response = await schedulers.get(id).fetch("https://scheduler.internal/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: this.auth.workspaceId, region: this.env.AVALON_REGION }) });
    if (!response.ok) throw new Error(`Scheduler refresh failed (${response.status})`);
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function toAutomationRun(row: Record<string, unknown>) {
  return { id: String(row.id), automationSubscriptionId: String(row.automation_subscription_id), workstreamId: String(row.workstream_id), triggerType: String(row.trigger_type), plannedFor: row.planned_for == null ? null : String(row.planned_for), startedAt: row.started_at == null ? null : String(row.started_at), completedAt: row.completed_at == null ? null : String(row.completed_at), status: String(row.status), resultSummary: row.result_summary == null ? null : String(row.result_summary), createdAt: String(row.created_at) };
}
function toWorkstream(row: Record<string, unknown>) {
  return { id: String(row.id), workspaceId: String(row.workspace_id), title: String(row.title), objective: String(row.objective ?? ""), originType: String(row.origin_type), originLabel: row.origin_label == null ? null : String(row.origin_label), createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id), automationSubscriptionId: row.automation_subscription_id == null ? null : String(row.automation_subscription_id), automationRunId: row.automation_run_id == null ? null : String(row.automation_run_id), plannedFor: row.planned_for == null ? null : String(row.planned_for), harnessStatus: String(row.harness_status), lastActivityAt: String(row.last_activity_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at == null ? null : String(row.archived_at) };
}
