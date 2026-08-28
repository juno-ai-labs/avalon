import { newId, nowIso } from "@rally/db";
import { AutomationDraftStateSchema, ResourceRelationshipTypeSchema, TriggerDefinitionSchema, asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type {
  HarnessRunId,
  WorkspaceId,
  WorkstreamId,
  AutomationCompilerMessage,
  AutomationDeliveryTargetType,
  AutomationDraft,
  AutomationDraftState,
  CreateAutomationRequestSchema,
  ExecutionPrincipal,
  Scope,
  WorkstreamWorkflowInput,
} from "@rally/contracts";
import { z } from "zod";
import { AutomationCompilerError, OpenRouterError } from "@rally/agent-harness";
import { ConnectorError } from "@rally/connectors";
import { isReconnectRequiredConnectorError } from "./connector-connection-access";
import type { AutomationCompilerStreamEvent } from "@rally/agent-harness";
import type { AuthContext, Env } from "../env";
import { ApiError, isConstraintError } from "../lib/api-error";
import { substreamLoopId } from "../durable-objects/names";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { automationModelOverride, scheduledWorkstreamModel } from "./agent-model-flags";
import { activateWorkstreamLoop, compileAutomationDraft } from "./integrations";
import {
  buildAutomationMemoryTableStatements,
  ensureAutomationMemoryTables,
} from "./memory-table-service";
import { resolveFrozenDeliveryIdentity, type FrozenDeliveryIdentity } from "./user-delivery";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import {
  AUTOMATION_SIDEBAR_SQL,
  AutomationSidebarRowSchema,
  SIDEBAR_LIST_LIMIT,
  toAutomationSummary,
} from "./sidebar-reads";
import {
  recordWorkstreamCreatedTelemetry,
  type WorkstreamCreationSource,
} from "../telemetry/workstream-creation";
import {
  emitProductUsageTelemetry,
  resourceTelemetryEventId,
  telemetryCountBucket,
  telemetryJourneyDuration,
} from "../telemetry/product-usage";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import { createMessageObjectPort } from "../runtime/message-port";
import {
  attachWorkstreamRuntimeResource,
} from "./workstream-object-client";
import { refreshWorkspaceSchedule } from "./workstream-wakeup-service";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { publishedRunStatus } from "../runtime/harness-run-runtime";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "./workstream-runtime-database";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";
import { createIdentityObjectPort } from "../runtime/identity-port";

type CreateAutomationInput = z.infer<typeof CreateAutomationRequestSchema>;
type TriggerDefinition = z.infer<typeof TriggerDefinitionSchema>;

const AUTOMATION_TELEMETRY_CONNECTORS = new Set([
  'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x',
]);

function automationTriggerTypes(triggers: TriggerDefinition[]): Array<TriggerDefinition['type'] | 'inbound_email'> {
  return [...new Set(triggers.map((trigger) => trigger.type))].slice(0, 8);
}

function automationConnectorTypes(triggers: TriggerDefinition[], additional: Iterable<string> = []): Array<
  'google' | 'generic_webhook' | 'github' | 'granola' | 'linear' | 'notion' | 'slack' | 'x'
> {
  const values = new Set<string>(additional);
  for (const trigger of triggers) {
    if (trigger.type === 'webhook') values.add('generic_webhook');
    if ((trigger.type === 'connector_activity' || trigger.type === 'semantic_activity') && trigger.connectorType) {
      values.add(trigger.connectorType);
    }
  }
  return [...values]
    .filter((value): value is 'google' | 'generic_webhook' | 'github' | 'granola' | 'linear' | 'notion' | 'slack' | 'x' =>
      AUTOMATION_TELEMETRY_CONNECTORS.has(value))
    .sort();
}

interface CompiledSchedule {
  type: "calendar" | "interval";
  rrule: string | null;
  intervalSeconds: number | null;
  timezone: string;
  nextRunAt: string;
}

type ResolvedDeliveryTarget =
  | ({ type: Exclude<AutomationDeliveryTargetType, "email"> } & FrozenDeliveryIdentity)
  | { type: "email"; emailAddress: string };

interface ValidatedConnectorBindings {
  bindings: Record<string, string>;
  connectorTypes: Set<string>;
  connectorTypesByPluginId: Record<string, string>;
}

interface IdempotentAutomationRun {
  runId: string;
  workstreamId: WorkstreamId;
  harnessRunId: HarnessRunId | null;
  workflowInstanceId: string | null;
  runStatus: string;
  harnessStatus: string | null;
  triggerMessageId: string | null;
}

export interface InboundAutomationOpeningInput {
  resendEmailId: string;
  textContent: string;
  structuredContent: Record<string, unknown>;
  resourceId: string;
}

export class AutomationService {
  private readonly env: Env;
  private readonly auth: AuthContext;

  constructor(env: Env, auth: AuthContext) {
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
  }

  private async recordAutomationAction(
    row: Record<string, unknown>,
    action: 'pause' | 'resume' | 'edit' | 'publish_template' | 'adopt_template_version' | 'run_now' | 'archive_draft' | 'delete',
    appliedStatus: 'draft' | 'active' | 'paused' | 'error' | 'deleted' | 'archived',
  ): Promise<void> {
    const previousStatus = String(row.status) as 'draft' | 'active' | 'paused' | 'error';
    await emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: 'automation_action_completed_v2',
      properties: {
        automationId: String(row.id),
        action,
        visibility: row.scope === 'workspace' ? 'public' : 'private',
        previousStatus,
        appliedStatus,
        result: 'success',
      },
      operationId: String(row.id),
      eventId: newId(),
    }).catch(() => undefined);
  }

  /**
   * The automations the sidebar lists.
   *
   * A plain read: the statement and the row mapping are shared with the socket
   * payload WorkspaceDO builds, and there is no longer any reconciliation for
   * one path to do and the other to skip. Global records only that an address
   * is taken, so a stored address is the whole truth about it.
   */
  async list() {
    const result = await this.env.DB.prepare(AUTOMATION_SIDEBAR_SQL)
      .bind(this.auth.workspaceId, this.auth.userId, SIDEBAR_LIST_LIMIT)
      .all<Record<string, unknown>>();
    const rows = (result.results ?? []).map((row) => AutomationSidebarRowSchema.parse(row));
    return { items: rows.map((row) => toAutomationSummary(row)) };
  }

  async compile(
    input: {
      draftId?: string | undefined;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      currentDraft?: AutomationDraft | null;
      attachmentIds?: string[];
      inputMode?: 'typed' | 'suggested_prompt' | 'elicitation_response' | 'edit';
      connectorMentionCount?: number;
      resolvedElicitation?: {
        id: string;
        responseType: 'free_text' | 'single_select' | 'multi_select';
        resolution: 'answered' | 'skipped';
        customResponseUsed: boolean;
        presentedAt: string;
      } | undefined;
    },
    requestId: string,
    options: {
      onStreamEvent?: (event: AutomationCompilerStreamEvent) => void | Promise<void>;
      signal?: AbortSignal;
    } = {},
  ) {
    const telemetryStartedAt = Date.now();
    const defaults = await this.defaultTimezones(this.auth.userId);
    if (input.resolvedElicitation) {
      const elicitation = input.resolvedElicitation;
      await emitProductUsageTelemetry(this.env, {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        name: 'elicitation_resolved',
        properties: {
          elicitationId: elicitation.id,
          runId: input.draftId ?? elicitation.id,
          ...(input.draftId ? { draftId: input.draftId } : {}),
          responseType: elicitation.responseType,
          resolution: elicitation.resolution,
          customResponseUsed: elicitation.customResponseUsed,
          responseLatency: telemetryJourneyDuration(
            Math.max(0, Date.now() - new Date(elicitation.presentedAt).getTime()),
          ),
          surface: 'automation_builder',
        },
        operationId: input.draftId ?? elicitation.id,
        eventId: resourceTelemetryEventId(elicitation.id, 6),
      }).catch(() => undefined);
    }
    try {
      const draft = await compileAutomationDraft(this.env, {
        ...input,
        requestId,
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        ...(options.onStreamEvent ? { onStreamEvent: options.onStreamEvent } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        defaultTimezones: {
          personal: defaults.personal ?? defaults.workspace,
          workspace: defaults.workspace,
        },
      });
      const resolved = draft.ready ? await this.withUsableActivitySources(draft) : draft;
      const assistantMessage = assistantMessageForDraft(resolved);
      const elicitationId = resolved.followUpQuestion ? newId() : null;
      const elicitationPresentedAt = elicitationId ? nowIso() : null;
      const draftId = await this.saveDraft(
        input,
        resolved,
        assistantMessage,
        elicitationId,
        elicitationPresentedAt,
      );
      await emitProductUsageTelemetry(this.env, {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        name: 'automation_draft_turn_completed',
        properties: {
          draftId,
          turnNumber: telemetryCountBucket(input.messages.filter((message) => message.role === 'user').length),
          result: 'success',
          duration: telemetryJourneyDuration(Date.now() - telemetryStartedAt),
          inputMode: input.inputMode ?? 'typed',
          attachmentCount: Math.min(100, input.attachmentIds?.length ?? 0),
          connectorMentionCount: Math.min(100, input.connectorMentionCount ?? 0),
          readyToCreate: resolved.ready,
        },
        operationId: draftId,
        eventId: newId(),
      }).catch(() => undefined);
      if (resolved.ready && input.currentDraft?.ready !== true) {
        await emitProductUsageTelemetry(this.env, {
          workspaceId: this.auth.workspaceId,
          userId: this.auth.userId,
          name: 'automation_draft_ready',
          properties: {
            draftId,
            turnsToReady: telemetryCountBucket(input.messages.filter((message) => message.role === 'user').length),
            visibility: resolved.suggestedScope === 'workspace' ? 'public' : 'private',
            triggerTypes: automationTriggerTypes(resolved.triggers),
            connectorTypes: automationConnectorTypes(resolved.triggers),
            pluginCount: Math.min(100, resolved.recommendedPlugins.length),
            deliveryTargetTypes: [],
          },
          operationId: draftId,
          eventId: resourceTelemetryEventId(draftId, 3),
        }).catch(() => undefined);
      }
      if (elicitationId && elicitationPresentedAt) {
        await emitProductUsageTelemetry(this.env, {
          workspaceId: this.auth.workspaceId,
          userId: this.auth.userId,
          name: 'elicitation_presented',
          properties: {
            elicitationId,
            runId: draftId,
            draftId,
            responseType: resolved.elicitation?.responseType ?? 'free_text',
            optionCount: telemetryCountBucket(resolved.elicitation?.options.length ?? 0),
            surface: 'automation_builder',
          },
          operationId: draftId,
          eventId: resourceTelemetryEventId(elicitationId, 5),
        }).catch(() => undefined);
      }
      return {
        draftId,
        elicitationId,
        elicitationPresentedAt,
        draft: resolved,
        assistantMessage,
      };
    } catch (error) {
      await emitProductUsageTelemetry(this.env, {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        name: 'automation_draft_turn_completed',
        properties: {
          ...(input.draftId ? { draftId: input.draftId } : {}),
          turnNumber: telemetryCountBucket(input.messages.filter((message) => message.role === 'user').length),
          result: options.signal?.aborted ? 'cancelled' : 'failed',
          duration: telemetryJourneyDuration(Date.now() - telemetryStartedAt),
          inputMode: input.inputMode ?? 'typed',
          attachmentCount: Math.min(100, input.attachmentIds?.length ?? 0),
          connectorMentionCount: Math.min(100, input.connectorMentionCount ?? 0),
          readyToCreate: false,
        },
        operationId: input.draftId ?? newId(),
        eventId: newId(),
      }).catch(() => undefined);
      if (error instanceof z.ZodError || (error instanceof OpenRouterError && /structured JSON/iu.test(error.message))) {
        const validationIssues = error instanceof z.ZodError
          ? error.issues.slice(0, 25).map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code }))
          : [{ path: "$", code: "invalid_json" }];
        throw new ApiError(502, "model_output_invalid", "Avalon could not validate the automation draft", {
          validationIssues,
        });
      }
      if (error instanceof AutomationCompilerError) {
        const timedOut = error.code === "run_wall_time_limit_exceeded";
        throw new ApiError(
          timedOut ? 503 : 502,
          timedOut ? "automation_compile_timeout" : "automation_compile_failed",
          timedOut
            ? "Avalon took too long to refine the automation. Try again"
            : "Avalon could not refine the automation draft. Try again",
          { failureCode: error.code, retryable: error.retryable },
        );
      }
      if (error instanceof OpenRouterError) {
        throw new ApiError(502, "automation_provider_failed", "The automation model could not complete the draft. Try again", {
          retryable: error.status !== 401 && error.status !== 402 && error.status !== 403,
        });
      }
      if (error instanceof ConnectorError) {
        // Not raised by a connector's own tool inspection or a tool call mid-
        // compile — both are caught closer to their source and never reach
        // here: `loadAutomationCreatorPluginCatalog` swallows a failing
        // connector's dynamic-tool discovery and drops it from the catalog
        // rather than aborting the compile (`integrations.ts`'s
        // `dynamic_connector_tools_unavailable` catch), and a tool call
        // during the compile itself is fed back to the model rather than
        // thrown. What does reach here is `connectorRegistryForEnv`'s own
        // construction failing, or an automation naming a `connector_type`
        // this environment does not register at all — both environment
        // defects, not something reconnecting or retrying fixes on its own.
        // `isReconnectRequiredConnectorError` is the one shape that would
        // call for reconnecting; nothing on this path can produce it today,
        // but the check stays correct if that ever changes.
        const reconnect = isReconnectRequiredConnectorError(error);
        throw new ApiError(
          502,
          "automation_connector_failed",
          reconnect
            ? "Rally could not use that connector. Reconnect it and try again."
            : "Rally could not use that connector in this environment.",
          { connectorErrorCode: error.code, retryable: false },
        );
      }
      throw error;
    }
  }

  /** A ready draft whose activity source cannot actually be bound is not ready:
   * it goes back to the person with the reason rather than reaching a Create
   * button that would reject it. */
  private async withUsableActivitySources(draft: AutomationDraft): Promise<AutomationDraft> {
    try {
      const activitySourcePluginIds = suggestedActivitySourcePluginIds(draft.triggers);
      const connectorSelection = await this.validateConnectorSelections(
        draft.suggestedScope,
        [],
        activitySourcePluginIds,
      );
      this.assertActivityTriggerBindings(draft.triggers, activitySourcePluginIds, connectorSelection);
      return draft;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return {
        ...draft,
        ready: false,
        followUpQuestion: `I couldn't use that activity source: ${error.message}. Please choose an available connector or revise the trigger.`,
        elicitation: null,
      };
    }
  }

  /** Writes the turn to the subscription this draft is going to become, and
   * answers the id of that row.
   *
   * A draft is a subscription from its first compiled turn rather than only
   * once it is finished, because that is what puts it in the sidebar while it
   * is still being written — the conversation used to live in the renderer's
   * memory alone, so an unfinished automation was invisible everywhere and gone
   * on reload. Creation promotes this same row, so the id here is the
   * automation's id for good and the sidebar entry never jumps.
   *
   * Three things a draft deliberately does not get, each of which would make an
   * unfinished automation act like a finished one:
   *
   * - **No schedules.** Rows in `schedules` are what the workspace alarm reads;
   *   a draft that carried one would be a half-written automation that fires.
   * - **No email address.** An address is a way to reach an automation, and
   *   there is nothing here to reach yet. It is reserved when the draft is
   *   promoted, which is also the only moment the route can be activated.
   * - **No workspace scope.** Whatever scope the compiler suggests is a
   *   proposal recorded in the draft; the row stays personal to its author so a
   *   half-formed idea is never in a coworker's sidebar. `create` applies the
   *   scope the author actually chose.
   *
   * A `draftId` that names anything else — an automation that runs, another
   * person's draft, an archived one — starts a new draft instead of writing
   * through to it. The id arrives from the client, so it is a claim to check,
   * not an instruction to follow.
   */
  private async saveDraft(
    input: { draftId?: string | undefined; messages: AutomationCompilerMessage[]; attachmentIds?: string[] },
    draft: AutomationDraft,
    assistantMessage: string,
    elicitationId: string | null,
    elicitationPresentedAt: string | null,
  ): Promise<string> {
    const at = nowIso();
    const conversation = JSON.stringify({
      messages: [...input.messages, { role: "assistant", content: assistantMessage }],
      attachmentIds: input.attachmentIds ?? [],
      elicitationId,
      elicitationPresentedAt,
      draft,
    } satisfies Omit<AutomationDraftState, "draftId">);
    const existing = await this.loadOwnDraft(input.draftId);
    if (existing) {
      // A compile turn takes seconds, and the row it started against can be
      // created or archived from another window in that time. Every statement
      // is therefore conditional on the subscription *still* being a visible
      // draft, rather than trusting the check above: without it a turn that
      // began before a promotion would rewrite the finished automation's name
      // and instructions from a draft that no longer exists, and hang a draft
      // conversation back off an automation that runs.
      const stillDraft = this.stillDraftPredicate(existing.id);
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE automation_templates SET name = ?, description = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND ${stillDraft.sql}`,
        ).bind(draft.name, draft.description, at, existing.template_id, this.auth.workspaceId, ...stillDraft.values),
        this.draftVersionUpdate(existing.template_version_id, draft, stillDraft),
        this.env.DB.prepare(
          `UPDATE automation_subscriptions SET draft_conversation_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'draft' AND lifecycle_state = 'visible'`,
        ).bind(conversation, at, existing.id, this.auth.workspaceId),
      ]);
      return existing.id;
    }
    const templateId = newId();
    const versionId = newId();
    const subscriptionId = newId();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_templates
         (id, workspace_id, owner_user_id, name, description, sharing_state,
          latest_version_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'private', 1, ?, ?)`,
      ).bind(templateId, this.auth.workspaceId, this.auth.userId, draft.name, draft.description, at, at),
      this.env.DB.prepare(
        `INSERT INTO automation_template_versions
         (id, template_id, version_number, overview, instructions, trigger_definitions_json,
          required_capabilities_json, expected_outputs_json, default_behavior_json,
          recommended_plugins_json, memory_tables_json, created_by_user_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(versionId, templateId, draft.overview, draft.instructions, JSON.stringify(draft.triggers), JSON.stringify(draft.requiredCapabilities), JSON.stringify(draft.expectedOutputs), JSON.stringify(draft.defaultBehavior), JSON.stringify(draft.recommendedPlugins), JSON.stringify(draft.memoryTables), this.auth.userId, at),
      this.env.DB.prepare(
        `INSERT INTO automation_subscriptions
         (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
          execution_principal_json, connector_bindings_json, activity_trigger_bindings_json,
          default_plugins_json, overrides_json, status, draft_conversation_json,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, 'personal', ?, ?, '{}', '{}', '[]', '{}', 'draft', ?, ?, ?)`,
      ).bind(subscriptionId, this.auth.workspaceId, templateId, versionId, this.auth.userId, JSON.stringify({ type: "user", userId: this.auth.userId } satisfies ExecutionPrincipal), conversation, at, at),
    ]);
    return subscriptionId;
  }

  /** The draft rows a client-supplied id may write through to: a visible draft
   * in this workspace that the caller owns, and nothing else. */
  private async loadOwnDraft(draftId: string | undefined) {
    if (draftId == null) return null;
    return this.env.DB.prepare(
      `SELECT id, template_id, template_version_id FROM automation_subscriptions
       WHERE id = ? AND workspace_id = ? AND owner_user_id = ?
         AND status = 'draft' AND lifecycle_state = 'visible'`,
    ).bind(draftId, this.auth.workspaceId, this.auth.userId).first<{
      id: string;
      template_id: string;
      template_version_id: string;
    }>();
  }

  /** Refuses a draft this caller owns that has already stopped being one.
   * Sequential double-creation lands here; the simultaneous kind is caught by
   * the claim in `create`, which is the same refusal a moment later. */
  private async assertDraftNotAlreadyCreated(draftId: string): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT status FROM automation_subscriptions
       WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND lifecycle_state = 'visible'`,
    ).bind(draftId, this.auth.workspaceId, this.auth.userId).first<{ status: string }>();
    if (row && row.status !== "draft") {
      throw new ApiError(409, "automation_already_created", "This automation has already been created");
    }
  }

  /** The condition under which a draft's rows may still be written: the
   * subscription is a visible draft in this workspace. Composed into a
   * statement's `WHERE` so a batch spanning three tables is all-or-nothing
   * against a promotion or an archival that landed in between. */
  private stillDraftPredicate(subscriptionId: string) {
    return {
      sql: `EXISTS (SELECT 1 FROM automation_subscriptions
                    WHERE id = ? AND workspace_id = ? AND status = 'draft' AND lifecycle_state = 'visible')`,
      values: [subscriptionId, this.auth.workspaceId] as const,
    };
  }

  /** The condition that a version row is the one this subscription pins. */
  private pinnedVersionPredicate(subscriptionId: string, versionId: string) {
    return {
      sql: `EXISTS (SELECT 1 FROM automation_subscriptions
                    WHERE id = ? AND workspace_id = ? AND template_version_id = ?)`,
      values: [subscriptionId, this.auth.workspaceId, versionId] as const,
    };
  }

  /**
   * Rewrites a template version in place — the one exception to the immutability
   * `data-model.md` states for `automation_template_versions`, and the reason
   * this is the only method that writes that table.
   *
   * It exists because a draft's version is private to the conversation writing
   * it: every turn would otherwise leave a version behind, and a draft that
   * took twenty turns would land as version 21 of a template nobody has ever
   * run. What makes that safe is that nothing else can be pinned to the row —
   * a draft's template is `private`, and `shareSubscription` refuses a draft.
   *
   * The guard is required rather than optional so this can never be pointed at
   * a version some other subscription is running against. A caller passes the
   * condition under which the row is still theirs to rewrite; the statement
   * changes nothing when it no longer holds.
   */
  private draftVersionUpdate(
    versionId: string,
    draft: AutomationDraft,
    guard: { sql: string; values: readonly string[] },
  ) {
    return this.env.DB.prepare(
      `UPDATE automation_template_versions
       SET overview = ?, instructions = ?, trigger_definitions_json = ?,
           required_capabilities_json = ?, expected_outputs_json = ?, default_behavior_json = ?,
           recommended_plugins_json = ?, memory_tables_json = ?
       WHERE id = ? AND ${guard.sql}`,
    ).bind(draft.overview, draft.instructions, JSON.stringify(draft.triggers), JSON.stringify(draft.requiredCapabilities), JSON.stringify(draft.expectedOutputs), JSON.stringify(draft.defaultBehavior), JSON.stringify(draft.recommendedPlugins), JSON.stringify(draft.memoryTables), versionId, ...guard.values);
  }

  /** The conversation behind a draft, so the builder can pick it back up out of
   * the sidebar. Only a draft has one; an automation that runs is edited
   * through its overview, not by reopening the conversation that wrote it. */
  async draftState(id: string): Promise<AutomationDraftState> {
    const row = await this.loadSubscription(id);
    this.assertCanManageSubscription(row);
    if (row.status !== "draft") {
      throw new ApiError(409, "automation_not_draft", "Only a draft automation can be reopened");
    }
    // Validated here rather than left to the route, because this blob was
    // written by whichever deploy compiled that turn and `AutomationDraft` is a
    // model-output contract that has changed before. A draft that predates a
    // change would otherwise fail the route's own parse, which is a 500 — and a
    // sidebar row that answers 500 forever is unopenable with no way to clear
    // it. The 409 below is the same recoverable state a missing conversation
    // gets: the draft is still there, still archivable, and says why.
    const stored = AutomationDraftStateSchema.safeParse({
      draftId: String(row.id),
      ...parseJson<Record<string, unknown>>(row.draft_conversation_json, {}),
    });
    if (!stored.success) {
      throw new ApiError(409, "automation_draft_unavailable", "This draft's conversation is no longer available");
    }
    return stored.data;
  }

  async create(input: CreateAutomationInput) {
    if (!input.draft.ready) throw new ApiError(422, "automation_not_ready", "Finish the automation conversation before creating it");
    this.assertScopeAllowed(input.scope);
    const connectorSelection = await this.validateConnectorSelections(
      input.scope,
      input.defaultPluginIds,
      input.activitySourcePluginIds,
    );
    this.assertActivityTriggerBindings(
      input.draft.triggers,
      input.activitySourcePluginIds,
      connectorSelection,
    );
    const resourceIds = await this.validateAutomationResources(input.scope, input.resourceIds);
    const deliveryTargets = await this.resolveDeliveryTargets(input.scope, input.deliveryTargets);
    // Creating an automation the person watched take shape in the sidebar
    // promotes that row rather than inserting a second one beside it: same id,
    // same position, and no abandoned draft left over. An id that names nothing
    // this caller may write through to — another person's draft, another
    // workspace's row, no row at all — creates a new automation, which is also
    // the path an automation created without a draft takes.
    //
    // A draft this caller *did* own and has already created is the one case
    // that refuses rather than inserting: it is a Create pressed twice, and
    // answering it with a second automation is never what was meant.
    const promoted = await this.loadOwnDraft(input.draftId);
    if (!promoted && input.draftId) await this.assertDraftNotAlreadyCreated(input.draftId);
    const templateId = promoted?.template_id ?? newId();
    const versionId = promoted?.template_version_id ?? newId();
    const subscriptionId = promoted?.id ?? newId();
    const at = nowIso();
    const principal: ExecutionPrincipal = input.scope === "personal"
      ? { type: "user", userId: this.auth.userId }
      : { type: "workspace", workspaceId: this.auth.workspaceId };
    const schedules = await this.schedulesForTriggers({
      triggers: input.draft.triggers,
      subscriptionId,
      at,
      scope: input.scope,
      ownerUserId: this.auth.userId,
    });
    const nextRunAt = schedules.map((schedule) => schedule.nextRunAt).sort()[0] ?? null;
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const routeInput = this.automationRouteInput(subscriptionId);
    const emailRoute = await emailRouting.reserveAutomation(routeInput);
    const memoryTables = buildAutomationMemoryTableStatements(this.env, {
      workspaceId: this.auth.workspaceId,
      automationSubscriptionId: subscriptionId,
      definitions: input.draft.memoryTables,
      createdByUserId: this.auth.userId,
      createdAt: at,
    });
    // Promotion claims the draft before anything else is written, and the claim
    // is the status transition itself — so two creations of the same draft
    // cannot both proceed. Without it the loser's `UPDATE` would change no rows
    // while its schedules, memory tables, and delivery targets were inserted
    // anyway: nothing constrains a subscription to one schedule, so the
    // automation would quietly run twice for every trigger it has.
    //
    // The cost of claiming first is the opposite failure: if the batch below
    // fails, the automation is active with no schedules and does not run until
    // it is recreated. That is visible and recoverable, where double-firing is
    // neither.
    if (promoted) {
      const claim = await this.env.DB.prepare(
        // The draft's own transcript goes with the status: an automation that
        // runs is edited through its overview, and keeping the conversation
        // would leave a second, diverging definition of it.
        `UPDATE automation_subscriptions
         SET scope = ?, owner_user_id = ?, execution_principal_json = ?,
             connector_bindings_json = ?, activity_trigger_bindings_json = ?,
             default_plugins_json = ?, status = 'active', draft_conversation_json = NULL,
             email_address = ?, model_override = ?,
             next_run_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'draft' AND lifecycle_state = 'visible'`,
      ).bind(input.scope, input.scope === "personal" ? this.auth.userId : null, JSON.stringify(principal), JSON.stringify(connectorSelection.bindings), JSON.stringify(input.activitySourcePluginIds), JSON.stringify(input.defaultPluginIds), emailRoute.emailAddress, input.modelOverride ?? null, nextRunAt, at, subscriptionId, this.auth.workspaceId).run();
      if (Number(claim.meta?.changes ?? 0) === 0) {
        throw new ApiError(409, "automation_already_created", "This automation has already been created");
      }
    }
    await this.env.DB.batch([
      ...(promoted
        ? [
            this.env.DB.prepare(
              `UPDATE automation_templates SET name = ?, description = ?, updated_at = ?
               WHERE id = ? AND workspace_id = ?`,
            ).bind(input.draft.name, input.draft.description, at, templateId, this.auth.workspaceId),
            // The claim above has already flipped the row to active, so this
            // is bounded by the version still being the one that row pins
            // rather than by it still being a draft's.
            this.draftVersionUpdate(versionId, input.draft, this.pinnedVersionPredicate(subscriptionId, versionId)),
          ]
        : [
            this.env.DB.prepare(
              `INSERT INTO automation_templates
               (id, workspace_id, owner_user_id, name, description, sharing_state,
                latest_version_number, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'private', 1, ?, ?)`,
            ).bind(templateId, this.auth.workspaceId, this.auth.userId, input.draft.name, input.draft.description, at, at),
            this.env.DB.prepare(
              `INSERT INTO automation_template_versions
               (id, template_id, version_number, overview, instructions, trigger_definitions_json,
                required_capabilities_json, expected_outputs_json, default_behavior_json,
                recommended_plugins_json, memory_tables_json, created_by_user_id, created_at)
               VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(versionId, templateId, input.draft.overview, input.draft.instructions, JSON.stringify(input.draft.triggers), JSON.stringify(input.draft.requiredCapabilities), JSON.stringify(input.draft.expectedOutputs), JSON.stringify(input.draft.defaultBehavior), JSON.stringify(input.draft.recommendedPlugins), JSON.stringify(input.draft.memoryTables), this.auth.userId, at),
            this.env.DB.prepare(
              `INSERT INTO automation_subscriptions
               (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
                execution_principal_json, connector_bindings_json, activity_trigger_bindings_json,
                default_plugins_json, overrides_json, status,
                email_address, model_override,
                next_run_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, ?, ?)`,
            ).bind(subscriptionId, this.auth.workspaceId, templateId, versionId, input.scope, input.scope === "personal" ? this.auth.userId : null, JSON.stringify(principal), JSON.stringify(connectorSelection.bindings), JSON.stringify(input.activitySourcePluginIds), JSON.stringify(input.defaultPluginIds), emailRoute.emailAddress, input.modelOverride ?? null, nextRunAt, at, at),
          ]),
      ...memoryTables.statements,
      ...deliveryTargets.map((target) => this.env.DB.prepare(
        `INSERT INTO automation_delivery_targets
         (id, workspace_id, automation_subscription_id, target_type, connection_id,
          user_id, slack_team_id, slack_user_id, email_address, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(
        newId(),
        this.auth.workspaceId,
        subscriptionId,
        target.type,
        target.type === "email" ? null : target.connectionId,
        this.auth.userId,
        target.type === "email" ? null : target.providerTenantId,
        target.type === "email" ? null : target.providerUserId,
        target.type === "email" ? target.emailAddress : null,
        at,
        at,
      )),
      ...resourceIds.map((resourceId) => this.env.DB.prepare(
        `INSERT INTO automation_resources
         (automation_subscription_id, resource_id, attached_by_user_id, relationship_type, attached_at)
         VALUES (?, ?, ?, 'context', ?)`,
      ).bind(subscriptionId, resourceId, this.auth.userId, at)),
      ...schedules.map((schedule) => this.env.DB.prepare(
        `INSERT INTO schedules
         (id, workspace_id, automation_subscription_id, schedule_type, rrule,
          interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      ).bind(newId(), this.auth.workspaceId, subscriptionId, schedule.type, schedule.rrule, schedule.intervalSeconds, schedule.timezone, schedule.nextRunAt, at, at)),
    ]);
    try {
      await emailRouting.activateAutomationRoute(routeInput);
    } catch (error) {
      if (!isRecoverableEmailRouteTransition(error)) throw error;
    }
    if (schedules.length > 0) await this.refreshScheduler();
    const detail = await this.get(subscriptionId);
    await emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: 'automation_created_v2',
      properties: {
        automationId: subscriptionId,
        ...(input.draftId ? { draftId: input.draftId } : {}),
        creationMethod: 'custom',
        visibility: input.scope === 'workspace' ? 'public' : 'private',
        triggerTypes: automationTriggerTypes(input.draft.triggers),
        connectorTypes: automationConnectorTypes(input.draft.triggers, connectorSelection.connectorTypes),
        pluginCount: Math.min(100, new Set([
          ...input.defaultPluginIds,
          ...Object.values(input.activitySourcePluginIds),
        ]).size),
        deliveryTargetTypes: [...new Set(deliveryTargets.map((target) => target.type))].sort(),
        modelOverride: Boolean(input.modelOverride),
      },
      operationId: subscriptionId,
      eventId: resourceTelemetryEventId(subscriptionId, 4),
    }).catch(() => undefined);
    return detail;
  }

  async get(id: string) {
    const row = await this.loadSubscription(id);
    // Detail is a regional read. Route reservation and repair belong to the
    // lifecycle transitions that own them, so opening an already-active
    // automation never depends on Global availability.
    const emailAddress = row.email_address == null ? null : String(row.email_address);
    const updateAvailable = Number(row.latest_version_number) > Number(row.version_number);
    const plannedWorkstream = row.next_run_at == null
      ? null
      : await new WorkstreamDirectoryService(this.env, this.auth).plannedForAutomation(
          id,
          String(row.next_run_at),
        );
    const [runs, latestVersion, deliveryTargets, calendarSchedules] = await Promise.all([
      this.loadRuns(id, 20),
      updateAvailable
        ? this.env.DB.prepare(
            `SELECT id, version_number, overview, instructions, trigger_definitions_json,
              required_capabilities_json, expected_outputs_json, recommended_plugins_json,
              memory_tables_json
             FROM automation_template_versions
             WHERE template_id = ? AND version_number = ?`,
          ).bind(row.template_id, row.latest_version_number).first<Record<string, unknown>>()
        : Promise.resolve(null),
      this.env.DB.prepare(
        `SELECT dt.target_type, dt.connection_id, dt.email_address, dt.status, cc.display_name
         FROM automation_delivery_targets dt
         LEFT JOIN connector_connections cc ON cc.id = dt.connection_id
         WHERE dt.automation_subscription_id = ? AND dt.workspace_id = ?
           AND dt.status <> 'disabled'
         ORDER BY dt.created_at`,
      ).bind(id, this.auth.workspaceId).all<{
        target_type: "slack_agent_dm" | "email";
        connection_id: string | null;
        email_address: string | null;
        status: "active" | "needs_input" | "disabled";
        display_name: string | null;
      }>(),
      // What this automation actually fires on, which is not always what the
      // account would answer today: the row was resolved when it was written
      // and does not follow a later change to the owner's timezone.
      this.env.DB.prepare(
        `SELECT rrule, timezone FROM schedules
         WHERE automation_subscription_id = ? AND workspace_id = ?
           AND schedule_type = 'calendar' AND rrule IS NOT NULL`,
      ).bind(id, this.auth.workspaceId).all<{ rrule: string; timezone: string }>(),
    ]);
    const scheduleZonesByRrule = new Map(
      (calendarSchedules.results ?? []).map((schedule) => [schedule.rrule, schedule.timezone]),
    );
    const scope = String(row.scope) as Scope;
    const ownerUserId = row.owner_user_id == null ? null : String(row.owner_user_id);
    const [wireTriggers, wireUpdateTriggers] = await Promise.all([
      this.triggersForWire({
        triggers: parseJson(row.trigger_definitions_json, []),
        scheduleZonesByRrule,
        scope,
        ownerUserId,
      }),
      latestVersion
        ? this.triggersForWire({
            // A version nobody has adopted has no `schedules` row of its own, so
            // this is the zone adopting it would land on rather than one it runs
            // in today.
            triggers: parseJson(latestVersion.trigger_definitions_json, []),
            scheduleZonesByRrule: new Map(),
            scope,
            ownerUserId,
          })
        : Promise.resolve([]),
    ]);
    return {
      id: String(row.id), name: String(row.name), description: String(row.description), emailAddress, scope: String(row.scope), status: String(row.status),
      nextRunAt: row.next_run_at == null ? null : String(row.next_run_at), lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
      updatedAt: String(row.updated_at),
      updateAvailable, templateId: String(row.template_id), templateVersionId: String(row.template_version_id),
      versionNumber: Number(row.version_number), overview: String(row.overview ?? ""), instructions: String(row.instructions), triggers: wireTriggers,
      requiredCapabilities: parseJson(row.required_capabilities_json, []), expectedOutputs: parseJson(row.expected_outputs_json, []),
      executionPrincipal: parseJson(row.execution_principal_json, {}),
      recommendedPlugins: parseJson(row.recommended_plugins_json, []),
      memoryTables: parseJson(row.memory_tables_json, []),
      defaultPluginIds: parseJson(row.default_plugins_json, []),
      activitySourcePluginIds: parseJson(row.activity_trigger_bindings_json, {}),
      deliveryTargets: (deliveryTargets.results ?? []).map((target) => ({
        type: target.target_type,
        connectionId: target.connection_id,
        displayName: target.target_type === "email"
          ? target.email_address ?? "Email"
          : target.display_name ?? "Slack",
        status: target.status,
      })),
      templateUpdate: latestVersion ? {
        versionId: String(latestVersion.id),
        versionNumber: Number(latestVersion.version_number),
        overview: String(latestVersion.overview ?? ""),
        instructions: String(latestVersion.instructions),
        triggers: wireUpdateTriggers,
        requiredCapabilities: parseJson(latestVersion.required_capabilities_json, []),
        expectedOutputs: parseJson(latestVersion.expected_outputs_json, []),
        recommendedPlugins: parseJson(latestVersion.recommended_plugins_json, []),
        memoryTables: parseJson(latestVersion.memory_tables_json, []),
      } : null,
      nextPlannedWorkstream: plannedWorkstream, recentRuns: runs.items,
    };
  }

  async update(id: string, input: {
    name?: string | undefined;
    description?: string | undefined;
    instructions?: string | undefined;
    defaultPluginIds?: string[] | undefined;
    activitySourcePluginIds?: Record<string, string> | undefined;
    overrides?: Record<string, unknown> | undefined;
    deliveryTargets?: CreateAutomationInput["deliveryTargets"] | undefined;
  }) {
    const row = await this.loadSubscription(id);
    this.assertCanManageSubscription(row);
    // A delivery target is one person's: the row carries their user id and the
    // address is their own. Somebody else administering the automation may
    // change what it does, never where it reaches this person.
    //
    // Two cases, and only one of them is defence. A *personal* automation is
    // returned by `loadSubscription` to nobody but its owner, so for that scope
    // this cannot fire — it is here so that a change making automations visible
    // more widely fails closed rather than letting an administrator redirect
    // somebody else's mail. A *workspace* automation has no `owner_user_id` at
    // all, so this does fire, for any member and for any value including an
    // empty set. That is the right outcome by a less obvious route than the
    // scope check below, and it is why a workspace automation shows no delivery
    // section: there is no owner whose address it could be frozen to.
    if (input.deliveryTargets !== undefined && row.owner_user_id !== this.auth.userId) {
      throw new ApiError(403, "delivery_owner_required", "Only the automation's owner can change where its results are delivered");
    }
    if ((input.name != null || input.description != null) && row.template_owner_user_id !== this.auth.userId) {
      throw new ApiError(403, "template_owner_required", "Only the template owner can change its name or description");
    }
    const triggers = parseJson<TriggerDefinition[]>(row.trigger_definitions_json, []);
    const hasActivitySourceSlots = triggers.some((trigger) =>
      (trigger.type === "connector_activity" || trigger.type === "semantic_activity" || trigger.type === "webhook")
      && Boolean(trigger.sourceBindingKey));
    const shouldValidateConnectorSelection = input.defaultPluginIds !== undefined
      || (input.activitySourcePluginIds !== undefined
        && (hasActivitySourceSlots || Object.keys(input.activitySourcePluginIds).length > 0));
    const connectorSelection = shouldValidateConnectorSelection
      ? await this.validateConnectorSelections(
          String(row.scope) as Scope,
          input.defaultPluginIds ?? parseJson(row.default_plugins_json, []),
          input.activitySourcePluginIds ?? parseJson(row.activity_trigger_bindings_json, {}),
        )
      : null;
    if (connectorSelection) {
      this.assertActivityTriggerBindings(
        triggers,
        input.activitySourcePluginIds ?? parseJson(row.activity_trigger_bindings_json, {}),
        connectorSelection,
      );
    }
    const at = nowIso();
    const statements = [
      this.env.DB.prepare(
        `UPDATE automation_templates SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(input.name ?? null, input.description ?? null, at, row.template_id, this.auth.workspaceId),
      this.env.DB.prepare(
        `UPDATE automation_subscriptions SET default_plugins_json = COALESCE(?, default_plugins_json),
         connector_bindings_json = COALESCE(?, connector_bindings_json),
         activity_trigger_bindings_json = COALESCE(?, activity_trigger_bindings_json),
         overrides_json = COALESCE(?, overrides_json), updated_at = ? WHERE id = ? AND workspace_id = ?`,
      ).bind(
        input.defaultPluginIds ? JSON.stringify(input.defaultPluginIds) : null,
        connectorSelection ? JSON.stringify(connectorSelection.bindings) : null,
        input.activitySourcePluginIds ? JSON.stringify(input.activitySourcePluginIds) : null,
        input.overrides ? JSON.stringify(input.overrides) : null,
        at,
        id,
        this.auth.workspaceId,
      ),
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
           (id, template_id, version_number, overview, instructions, trigger_definitions_json,
            required_capabilities_json, expected_outputs_json, default_behavior_json,
            recommended_plugins_json, memory_tables_json, created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(versionId, row.template_id, versionNumber, row.overview ?? "", input.instructions, row.trigger_definitions_json, row.required_capabilities_json, row.expected_outputs_json, row.default_behavior_json, row.recommended_plugins_json ?? "[]", row.memory_tables_json ?? "[]", this.auth.userId, at),
        this.env.DB.prepare(
          `UPDATE automation_templates SET latest_version_number = ?, updated_at = ? WHERE id = ?`,
        ).bind(versionNumber, at, row.template_id),
        this.env.DB.prepare(
          `UPDATE automation_subscriptions SET template_version_id = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        ).bind(versionId, at, id, this.auth.workspaceId),
      );
    }
    if (input.deliveryTargets !== undefined) {
      statements.push(...await this.deliveryTargetStatements(id, String(row.scope) as Scope, input.deliveryTargets, at));
    }
    await this.env.DB.batch(statements);
    const detail = await this.get(id);
    await this.recordAutomationAction(row, 'edit', String(detail.status) as 'draft' | 'active' | 'paused' | 'error');
    return detail;
  }

  /**
   * The statements that make an automation's destinations match what was asked
   * for.
   *
   * Written as an upsert per requested type plus one retirement of the types
   * that were not requested, so the statements *describe the end state* rather
   * than a diff against a set read a moment earlier. Three things follow from that,
   * each of which was a defect when this reconciled against a prior read:
   *
   * - **A row is never replaced by an equivalent row.** The delivery fences are
   *   keyed on the target's own id — `last_delivered_workstream_id`
   *   (`automation-email-service.ts`), the Resend idempotency key, and the
   *   Slack `client_msg_id` are all derived from it. `ON CONFLICT … DO UPDATE`
   *   keeps the id even when the owner turns a destination off and back on, so
   *   a retry landing in that window still recognizes the result as delivered.
   *   Delete-then-insert clears all three at once, which is the duplicate this
   *   whole change exists to remove — which is also why turning a destination
   *   off retires its row rather than removing it.
   * - **No statement order can violate the unique index.** Swapping a Slack
   *   destination onto a reconnected connection is one upsert on the row that
   *   is already there, not an insert racing a delete of the row it replaces.
   * - **Two concurrent edits cannot lose one.** Each request states the whole
   *   set, so the later one wins outright instead of deleting a row the earlier
   *   one had just added.
   *
   * An address is resolved when a destination is added rather than per run, so
   * a type already present keeps the identity frozen on it; only a type that is
   * new, or one whose connection changed, is resolved here. That matters beyond
   * cost: re-resolving a destination the owner is not touching fails the whole
   * edit once their Slack link lapses, which left the dead destination
   * impossible to remove.
   */
  private async deliveryTargetStatements(
    subscriptionId: string,
    scope: Scope,
    requested: CreateAutomationInput["deliveryTargets"],
    at: string,
  ): Promise<D1PreparedStatement[]> {
    // Asked here rather than left to `resolveDeliveryTargets`, which answers
    // early for an empty list — and the list it is handed below is filtered, so
    // a set that is entirely unchanged would reach it empty and skip the check.
    if (requested.length > 0 && scope !== "personal") {
      throw new ApiError(422, "personal_automation_required", "Result delivery outside Avalon requires a personal automation");
    }
    const existing = await this.env.DB.prepare(
      `SELECT target_type, connection_id FROM automation_delivery_targets
        WHERE workspace_id = ? AND automation_subscription_id = ? AND user_id = ?
          AND status <> 'disabled'`,
    ).bind(this.auth.workspaceId, subscriptionId, this.auth.userId).all<{
      target_type: string;
      connection_id: string | null;
    }>();
    // Only what this edit actually changes needs an identity resolved. A stale
    // read here can cost a resolution that was not needed; it cannot produce a
    // wrong write, because the statements below do not reference it.
    const unchanged = new Set((existing.results ?? [])
      .map((row) => `${row.target_type}:${row.connection_id ?? ""}`));
    const resolved = await this.resolveDeliveryTargets(
      scope,
      requested.filter((target) =>
        !unchanged.has(`${target.type}:${target.type === "email" ? "" : target.connectionId}`)),
    );
    const statements: D1PreparedStatement[] = [];
    for (const target of resolved) {
      statements.push(this.env.DB.prepare(
        `INSERT INTO automation_delivery_targets
          (id, workspace_id, automation_subscription_id, target_type, connection_id,
           user_id, slack_team_id, slack_user_id, email_address, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT (automation_subscription_id, target_type) DO UPDATE SET
           connection_id = excluded.connection_id,
           slack_team_id = excluded.slack_team_id,
           slack_user_id = excluded.slack_user_id,
           status = 'active',
           last_error_json = NULL,
           updated_at = excluded.updated_at`,
      ).bind(
        newId(),
        this.auth.workspaceId,
        subscriptionId,
        target.type,
        target.type === "email" ? null : target.connectionId,
        this.auth.userId,
        target.type === "email" ? null : target.providerTenantId,
        target.type === "email" ? null : target.providerUserId,
        target.type === "email" ? target.emailAddress : null,
        at,
        at,
      ));
    }
    // A destination the owner chose again is one they want delivering, whatever
    // a past failure left on it — so a type that is staying but was not
    // resolved above still has its failure state cleared.
    for (const target of requested) {
      if (resolved.some((entry) => entry.type === target.type)) continue;
      statements.push(this.env.DB.prepare(
        `UPDATE automation_delivery_targets
            SET status = 'active', last_error_json = NULL, updated_at = ?
          WHERE workspace_id = ? AND automation_subscription_id = ? AND target_type = ?`,
      ).bind(at, this.auth.workspaceId, subscriptionId, target.type));
    }
    // Switched off, not deleted. Both dedupe layers are keyed on the row's id,
    // so removing it and inserting an equivalent row later is the one way an
    // owner can still make a retry re-send a result already delivered — and
    // turning a destination off and back on is a plainly reasonable thing to
    // do. A retired row delivers nowhere (every sender's predicate names the
    // statuses it will send to, and `disabled` is in none of them) and is not
    // returned to the client, so it is off in every sense except forgetting.
    const keptTypes = requested.map((target) => target.type);
    statements.push(this.env.DB.prepare(
      `UPDATE automation_delivery_targets
          SET status = 'disabled', updated_at = ?
        WHERE workspace_id = ? AND automation_subscription_id = ?
          ${keptTypes.length > 0 ? `AND target_type NOT IN (${keptTypes.map(() => "?").join(", ")})` : ""}`,
    ).bind(at, this.auth.workspaceId, subscriptionId, ...keptTypes));
    return statements;
  }

  async runNow(id: string, idempotencyKey: string) {
    const subscription = await this.loadSubscription(id);
    if (subscription.status !== "active") throw new ApiError(409, "automation_not_active", "Resume the automation before running it");
    const run = await this.createRun(subscription, "manual", null, null, true, idempotencyKey);
    await this.recordAutomationAction(subscription, 'run_now', 'active');
    return run;
  }

  async runFromInboundEmail(id: string, input: InboundAutomationOpeningInput) {
    const subscription = await this.loadSubscription(id);
    if (subscription.status !== "active") {
      throw new ApiError(409, "automation_not_active", "Resume the automation before emailing it");
    }
    return this.createRun(
      subscription,
      "inbound_email",
      null,
      null,
      true,
      `resend:${input.resendEmailId}`,
      {
        clientMessageId: `resend:${input.resendEmailId}`,
        textContent: input.textContent,
        structuredContent: input.structuredContent,
        resourceId: input.resourceId,
      },
    );
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    const subscription = await this.loadSubscription(id);
    this.assertCanManageSubscription(subscription);
    // Pausing and resuming move between two states an automation reaches only
    // by being created. A draft has never had its scope, connector bindings, or
    // activity sources validated — that happens in `create` — so arriving at
    // 'active' through here would hand a half-written automation a live email
    // route and a Run now, with nothing having checked what it would run as.
    if (subscription.status === "draft") {
      throw new ApiError(409, "automation_not_created", "Create this automation before pausing or resuming it");
    }
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE automation_subscriptions SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
        .bind(paused ? "paused" : "active", at, id, this.auth.workspaceId),
      this.env.DB.prepare("UPDATE schedules SET enabled = ?, updated_at = ?, version = version + 1 WHERE automation_subscription_id = ?")
        .bind(paused ? 0 : 1, at, id),
    ]);
    // No route work: pausing changes whether mail is accepted, and that is read
    // from this row when a message arrives. Global holds only the claim on the
    // address, which a pause does not alter.
    await this.refreshScheduler();
    await this.recordAutomationAction(subscription, paused ? 'pause' : 'resume', paused ? 'paused' : 'active');
  }

  /** Hides an abandoned draft from the automation list; a finished automation is
   * paused or deleted instead. A draft is created without schedules and holds no
   * active email route, so archiving one stops nothing that was running — but
   * the schedules are disabled anyway rather than trusting that, since a
   * hidden-yet-firing automation is the one outcome this must never produce. */
  async archiveDraft(id: string): Promise<void> {
    const subscription = await this.loadSubscription(id);
    this.assertCanManageSubscription(subscription);
    if (subscription.status !== "draft") {
      throw new ApiError(409, "automation_not_draft", "Only a draft automation can be archived");
    }
    const at = nowIso();
    const [, disabled] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE automation_subscriptions SET lifecycle_state = 'archived', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND lifecycle_state = 'visible'`,
      ).bind(at, id, this.auth.workspaceId),
      this.env.DB.prepare(
        `UPDATE schedules SET enabled = 0, updated_at = ?, version = version + 1
         WHERE automation_subscription_id = ? AND enabled = 1`,
      ).bind(at, id),
    ]);
    // The workspace alarm only needs recomputing if a draft did carry one.
    if (Number(disabled?.meta?.changes ?? 0) > 0) await this.refreshScheduler();
    await this.recordAutomationAction(subscription, 'archive_draft', 'archived');
  }

  /** Removes an automation for good. The row stays so its runs, work streams,
   * memory scope, and permanent email tombstone keep their referent, but every
   * way it could still fire is closed in one transaction:
   *
   * - Calendar and interval triggers: every schedule is disabled and the
   *   workspace alarm is recomputed, so the Durable Object stops waking for it.
   * - Activity, webhook, and resource-watch triggers: matching selects only
   *   visible, active subscriptions, so nothing routes to it again.
   * - Inbound email: the route is disabled and ingestion requires the same
   *   visible-and-active subscription. The address stays reserved forever.
   * - Manual runs and pre-opened runs: both load the subscription, which no
   *   longer resolves.
   * - A run already in flight loses tool authority at its next revalidation,
   *   exactly as a pause does.
   */
  async deleteAutomation(id: string): Promise<void> {
    const subscription = await this.loadSubscription(id);
    this.assertCanManageSubscription(subscription);
    const at = nowIso();
    // A run opened ahead of its planned time is a queued trigger of its own:
    // the work stream and run already exist and only wait for the alarm.
    // Nothing would start them once the schedule is disabled, so they would sit
    // in the sidebar claiming to be scheduled forever.
    //
    // The run's own state decides this, not the work stream's. The scheduler
    // marks a run running as soon as it creates the Workflow instance, while
    // the work stream stays harness_status = 'scheduled' until the harness
    // claims its attempt — so a work stream matched on that alone could belong
    // to a run that is already live.
    const planned = await this.env.DB.prepare(
      `SELECT workstream_id AS id FROM automation_runs
        WHERE workspace_id = ? AND automation_subscription_id = ?
          AND status = 'scheduled' AND started_at IS NULL`,
    ).bind(this.auth.workspaceId, id).all<{ id: string }>();
    const plannedWorkstreamIds = (planned.results ?? []).map((item) => String(item.id));
    const regionalStatements = [
      this.env.DB.prepare(
        `UPDATE automation_subscriptions SET lifecycle_state = 'deleted', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND lifecycle_state = 'visible'`,
      ).bind(at, id, this.auth.workspaceId),
      this.env.DB.prepare(
        "UPDATE schedules SET enabled = 0, updated_at = ?, version = version + 1 WHERE automation_subscription_id = ?",
      ).bind(at, id),
      this.env.DB.prepare(
        `UPDATE automation_runs SET status = 'failed', completed_at = ?,
           result_summary = COALESCE(result_summary, 'The automation was deleted before this run started')
         WHERE workspace_id = ? AND automation_subscription_id = ?
           AND status = 'scheduled' AND started_at IS NULL`,
      ).bind(at, this.auth.workspaceId, id),
    ];
    await Promise.all(plannedWorkstreamIds.map((workstreamId) =>
      createIdentityObjectPort(this.env, this.auth.workspaceId, workstreamId)
        .archiveScheduledWorkstream({ now: Date.parse(at) })));
    await this.env.DB.batch(regionalStatements);
    // No route to close. The address stays claimed forever — that is the point
    // of the Global ledger — and mail to it is refused by the same checks that
    // always refused it: automation ingestion requires a visible, active
    // subscription, and work-stream ingestion rejects an archived owner.
    try {
      await this.refreshScheduler();
    } catch {
      // The deletion is already committed, and a retry would 404 because the
      // subscription no longer loads — so failing here would strand the caller
      // on work that actually succeeded. Nothing is lost by tolerating it: the
      // alarm re-reads enabled schedules from WorkspaceDO on every firing, so
      // a stale armed alarm wakes, finds nothing due, and clears itself.
    }
    await this.recordAutomationAction(subscription, 'delete', 'deleted');
  }

  async runs(id: string, limit = 50) {
    await this.loadSubscription(id);
    return this.loadRuns(id, limit);
  }

  private async loadRuns(id: string, limit: number) {
    const result = await this.env.DB.prepare(
      `SELECT * FROM automation_runs WHERE workspace_id = ? AND automation_subscription_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(this.auth.workspaceId, id, Math.min(limit, 100)).all<Record<string, unknown>>();
    const runs = (result.results ?? []).map(toAutomationRun);
    if (runs.length === 0) return { items: [] };
    const readableIds = new Set(await new WorkstreamDirectoryService(this.env, this.auth)
      .readableIds(runs.map((run) => run.workstreamId)));
    // New runs copy the automation scope, so loading the subscription is their
    // authorization boundary. The one parent-object projection read preserves the
    // narrower audience of personal objects created before that invariant,
    // without waking one SubstreamAgent per history row.
    return { items: runs.filter((run) => readableIds.has(run.workstreamId)) };
  }

  async nextRun(id: string) {
    const subscription = await this.loadSubscription(id);
    const schedule = await this.env.DB.prepare(
      `SELECT * FROM schedules WHERE workspace_id = ? AND automation_subscription_id = ? AND enabled = 1
       ORDER BY next_run_at LIMIT 1`,
    ).bind(this.auth.workspaceId, id).first<Record<string, unknown>>();
    // Both branches return the same keys. They did not: the unscheduled one
    // omitted `automation` entirely, which nothing caught because the response
    // met no contract and the desktop client does not call this route.
    if (!schedule) return { scheduledFor: null, workstream: null, automation: String(subscription.name) };
    const workstream = await new WorkstreamDirectoryService(this.env, this.auth)
      .plannedForAutomation(id, String(schedule.next_run_at));
    return { scheduledFor: String(schedule.next_run_at), workstream, automation: String(subscription.name) };
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
      `SELECT t.*,
       (SELECT COUNT(*) FROM automation_subscriptions s
         WHERE s.template_id = t.id AND s.workspace_id = t.workspace_id
           AND s.lifecycle_state = 'visible') AS use_count,
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

  async shareSubscription(subscriptionId: string): Promise<{ templateId: string }> {
    const subscription = await this.loadSubscription(subscriptionId);
    // A draft's template is owned by whoever started the conversation, so the
    // ownership check below passes by construction and cannot stand in for
    // this one. Publishing a draft would put a half-written template in the
    // workspace gallery — and worse, a subscriber would pin the very version
    // row every later compile turn rewrites in place, so their automation's
    // definition would change under them with no version bump and nothing
    // marking it as an update.
    if (subscription.status === "draft") {
      throw new ApiError(409, "automation_not_created", "Create this automation before sharing it as a template");
    }
    if (subscription.template_owner_user_id !== this.auth.userId) {
      throw new ApiError(403, "template_owner_required", "Only the template owner can publish this automation");
    }
    await this.env.DB.prepare(
      `UPDATE automation_templates SET sharing_state = 'workspace', updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(nowIso(), subscription.template_id, this.auth.workspaceId).run();
    await this.recordAutomationAction(
      subscription,
      'publish_template',
      String(subscription.status) as 'active' | 'paused' | 'error',
    );
    return { templateId: String(subscription.template_id) };
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

  async subscribe(templateId: string, input: {
    defaultPluginIds: string[];
    activitySourcePluginIds: Record<string, string>;
  }) {
    const template = await this.env.DB.prepare(
      `SELECT t.*, v.id AS version_id, v.* FROM automation_templates t
       JOIN automation_template_versions v ON v.template_id = t.id AND v.version_number = t.latest_version_number
       WHERE t.id = ? AND t.workspace_id = ? AND t.sharing_state = 'workspace' AND t.archived_at IS NULL`,
    ).bind(templateId, this.auth.workspaceId).first<Record<string, unknown>>();
    if (!template) throw new ApiError(404, "template_not_found", "Workspace template not found");
    const draft: AutomationDraft = {
      name: String(template.name), description: String(template.description), instructions: String(template.instructions),
      overview: String(template.overview ?? ""),
      triggers: parseJson(template.trigger_definitions_json, []), requiredCapabilities: parseJson(template.required_capabilities_json, []),
      expectedOutputs: parseJson(template.expected_outputs_json, []), defaultBehavior: parseJson(template.default_behavior_json, {}),
      // A shared template carries no delivery request: the person adopting it
      // picks their own destinations, and inheriting somebody else's would be
      // a decision made for them.
      requestedDelivery: [],
      recommendedPlugins: parseJson(template.recommended_plugins_json, []),
      memoryTables: parseJson(template.memory_tables_json, []),
      suggestedScope: "personal", followUpQuestion: null, elicitation: null, ready: true,
    };
    const connectorSelection = await this.validateConnectorSelections(
      "personal",
      input.defaultPluginIds,
      input.activitySourcePluginIds,
    );
    this.assertActivityTriggerBindings(draft.triggers, input.activitySourcePluginIds, connectorSelection);
    const subscriptionId = newId();
    const at = nowIso();
    const schedules = await this.schedulesForTriggers({
      triggers: draft.triggers,
      subscriptionId,
      at,
      scope: "personal",
      ownerUserId: this.auth.userId,
    });
    const nextRunAt = schedules.map((item) => item.nextRunAt).sort()[0] ?? null;
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const routeInput = this.automationRouteInput(subscriptionId);
    const emailRoute = await emailRouting.reserveAutomation(routeInput);
    const memoryTables = buildAutomationMemoryTableStatements(this.env, {
      workspaceId: this.auth.workspaceId,
      automationSubscriptionId: subscriptionId,
      definitions: draft.memoryTables,
      createdByUserId: this.auth.userId,
      createdAt: at,
    });
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_subscriptions
         (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
          execution_principal_json, connector_bindings_json, activity_trigger_bindings_json,
          default_plugins_json, overrides_json, status,
          email_address, email_route_status,
          next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'personal', ?, ?, ?, ?, ?, '{}', 'active', ?, 'reserved', ?, ?, ?)`,
      ).bind(subscriptionId, this.auth.workspaceId, templateId, template.version_id, this.auth.userId, JSON.stringify({ type: "user", userId: this.auth.userId }), JSON.stringify(connectorSelection.bindings), JSON.stringify(input.activitySourcePluginIds), JSON.stringify(input.defaultPluginIds), emailRoute.emailAddress, nextRunAt, at, at),
      ...memoryTables.statements,
      ...schedules.map((schedule) => this.env.DB.prepare(
        `INSERT INTO schedules
         (id, workspace_id, automation_subscription_id, schedule_type, rrule,
          interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      ).bind(newId(), this.auth.workspaceId, subscriptionId, schedule.type, schedule.rrule, schedule.intervalSeconds, schedule.timezone, schedule.nextRunAt, at, at)),
    ]);
    try {
      await emailRouting.activateAutomationRoute(routeInput);
    } catch (error) {
      if (!isRecoverableEmailRouteTransition(error)) throw error;
    }
    if (schedules.length) await this.refreshScheduler();
    const detail = await this.get(subscriptionId);
    await emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: 'automation_created_v2',
      properties: {
        automationId: subscriptionId,
        templateId,
        creationMethod: 'template',
        visibility: 'private',
        triggerTypes: automationTriggerTypes(draft.triggers),
        connectorTypes: automationConnectorTypes(draft.triggers, connectorSelection.connectorTypes),
        pluginCount: Math.min(100, new Set([
          ...input.defaultPluginIds,
          ...Object.values(input.activitySourcePluginIds),
        ]).size),
        deliveryTargetTypes: [],
        modelOverride: false,
      },
      operationId: subscriptionId,
      eventId: resourceTelemetryEventId(subscriptionId, 4),
    }).catch(() => undefined);
    return detail;
  }

  async adoptVersion(
    subscriptionId: string,
    versionId: string,
    activitySourcePluginIds?: Record<string, string>,
  ) {
    const subscription = await this.loadSubscription(subscriptionId);
    this.assertCanManageSubscription(subscription);
    const version = await this.env.DB.prepare(
      `SELECT * FROM automation_template_versions WHERE id = ? AND template_id = ?`,
    ).bind(versionId, subscription.template_id).first<Record<string, unknown>>();
    if (!version) throw new ApiError(404, "template_version_not_found", "Template version not found");
    const triggers = parseJson<TriggerDefinition[]>(version.trigger_definitions_json, []);
    const effectiveSourcePluginIds = pickActivitySourcePluginIds(
      triggers,
      activitySourcePluginIds ?? parseJson<Record<string, string>>(subscription.activity_trigger_bindings_json, {}),
    );
    const connectorSelection = await this.validateConnectorSelections(
      String(subscription.scope) as Scope,
      parseJson(subscription.default_plugins_json, []),
      effectiveSourcePluginIds,
    );
    const at = nowIso();
    this.assertActivityTriggerBindings(triggers, effectiveSourcePluginIds, connectorSelection);
    const schedules = await this.schedulesForTriggers({
      triggers,
      subscriptionId,
      at,
      scope: String(subscription.scope) as Scope,
      ownerUserId: subscription.owner_user_id == null ? null : String(subscription.owner_user_id),
    });
    const nextRunAt = schedules.map((schedule) => schedule.nextRunAt).sort()[0] ?? null;
    const enabled = subscription.status === "paused" ? 0 : 1;
    await ensureAutomationMemoryTables(this.env, {
      workspaceId: this.auth.workspaceId,
      automationSubscriptionId: subscriptionId,
      definitions: parseJson(version.memory_tables_json, []),
      createdByUserId: this.auth.userId,
    });
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE automation_subscriptions
         SET template_version_id = ?, connector_bindings_json = ?, activity_trigger_bindings_json = ?,
             next_run_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(versionId, JSON.stringify(connectorSelection.bindings), JSON.stringify(effectiveSourcePluginIds), nextRunAt, at, subscriptionId, this.auth.workspaceId),
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
    const detail = await this.get(subscriptionId);
    await this.recordAutomationAction(
      subscription,
      'adopt_template_version',
      String(detail.status) as 'active' | 'paused' | 'error',
    );
    return detail;
  }

  private async createRun(
    subscription: Record<string, unknown>,
    triggerType: string,
    plannedFor: string | null,
    activityId: string | null,
    start: boolean,
    idempotencyKey: string | null,
    openingInput: {
      clientMessageId: string;
      textContent: string;
      structuredContent: Record<string, unknown>;
      resourceId: string;
    } | null = null,
  ) {
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const routeInputFor = (workstreamId: string) => ({
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId,
    } as const);
    if (plannedFor) {
      const existing = await this.env.DB.prepare(
        `SELECT r.id AS run_id, r.workstream_id FROM automation_runs r
         WHERE r.automation_subscription_id = ? AND r.planned_for = ?`,
      ).bind(subscription.id, plannedFor).first<{ run_id: string; workstream_id: string }>();
      if (existing) {
        await emailRouting.ensureWorkstreamAddress(routeInputFor(existing.workstream_id));
        await this.recordRunCreationTelemetry(existing.workstream_id, triggerType);
        return { runId: existing.run_id, workstreamId: asWorkstreamId(existing.workstream_id), reused: true };
      }
    }
    if (idempotencyKey) {
      const existing = await this.loadIdempotentRun(String(subscription.id), idempotencyKey, openingInput?.clientMessageId ?? null);
      if (existing) {
        await emailRouting.ensureWorkstreamAddress(routeInputFor(existing.workstreamId));
        if (start) await this.recoverIdempotentRun(subscription, existing, triggerType, activityId);
        await this.recordRunCreationTelemetry(existing.workstreamId, triggerType);
        return this.runResponse(existing, true);
      }
    }
    const runId = newId();
    const workstreamId = asWorkstreamId(newId());
    const harnessRunId = asHarnessRunId(newId());
    const triggerMessageId = openingInput ? newId() : null;
    const at = nowIso();
    // Copied onto the run's work stream rather than looked up through the
    // subscription later, so the run reads its model from its own row like
    // every other work stream does.
    const modelOverride = automationModelOverride(this.env, subscription.model_override, {
      workspaceId: this.auth.workspaceId,
      automationSubscriptionId: String(subscription.id),
    });
    const routeInput = routeInputFor(workstreamId);
    const emailRoute = await emailRouting.reserve(routeInput);
    const principal = parseJson<ExecutionPrincipal>(subscription.execution_principal_json, { type: "user", userId: this.auth.userId });
    const executionEnv = await bootstrapWorkstreamRuntimeEnvironment(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    );
    let controlRunInserted = false;
    try {
      // The control row is claimed first, so the unique keys on it — the
      // idempotency key and the subscription's planned-for slot — decide who
      // provisions before anything visible exists. Two concurrent requests
      // sharing a key both pass the lookup above; the loser fails here, with
      // nothing object-side to compensate, and falls through to the existing
      // run below. Provisioning first would leave it an orphaned sidebar entry
      // and a permanently reserved email address for a run that never was.
      const runStatement = this.env.DB.prepare(
        `INSERT INTO automation_runs
         (id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
          trigger_activity_id, planned_for, started_at, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(runId, this.auth.workspaceId, subscription.id, workstreamId, triggerType, activityId, plannedFor, null, "scheduled", idempotencyKey, at);
      // The regional row is a control-plane run record; the root, transcript,
      // run and resource links below belong to the newly bootstrapped object.
      const inserted = await runStatement.run();
      controlRunInserted = (inserted.meta.changes ?? 0) > 0;
      // Every run copies the automation's scope. The member who starts it is
      // still its durable creator and initial participant; workspace-scoped
      // runs are additionally visible through ordinary workspace membership.
      await provisionWorkstreamObject(this.env, {
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        workstreamId: asWorkstreamId(workstreamId),
        title: String(subscription.name),
        objective: String(subscription.description),
        scope: String(subscription.scope) as Scope,
        originType: "automation",
        createdByUserId: this.auth.userId,
        participantUserIds: [this.auth.userId],
        harnessStatus: "scheduled",
        emailAddress: emailRoute.emailAddress,
        emailRouteStatus: "reserved",
        systemKind: null,
        automationSubscriptionId: String(subscription.id),
        automationRunId: runId,
        plannedFor: plannedFor === null ? null : Date.parse(plannedFor),
        modelOverride,
        now: Date.parse(at),
      });
      if (openingInput && triggerMessageId) {
        // The routed batch wrote `sequence_number = 1` and set the root's
        // counters to 2 in the same statement set. The transcript authority
        // takes the number and advances the counters itself, so the opening
        // message no longer depends on its writer having guessed both.
        await createMessageObjectPort(
          executionEnv,
          this.auth.workspaceId,
          workstreamId,
        ).appendMessage({
          messageId: triggerMessageId,
          clientMessageId: openingInput.clientMessageId,
          authorType: "system",
          authorUserId: null,
          externalActorJson: null,
          messageType: "system",
          text: openingInput.textContent,
          structuredContentJson: JSON.stringify(openingInput.structuredContent),
          producedByRunId: null,
          now: Date.parse(at),
        });
      }
      if (start) {
        // The work stream is provisioned just above, and its override is the
        // value that write carries, so it cannot be read back off the row yet.
        const model = modelOverride ?? await scheduledWorkstreamModel(executionEnv, {
          workspaceId: this.auth.workspaceId,
          workstreamId,
        });
        // The same id the workflow is launched with below. A run that records
        // a different trigger than it ran against is one `retry` replays
        // against the wrong window.
        await createHarnessRunObjectPort(
          executionEnv,
          this.auth.workspaceId,
          workstreamId,
        ).admitRun({
          runId: harnessRunId,
          origin: "automation_run",
          executionPrincipalJson: JSON.stringify(principal),
          status: "admitted",
          startedAt: null,
          model,
          triggerPartId: triggerMessageId ?? null,
          parentRunId: null,
          expectedLatestRunId: null,
          now: Date.parse(at),
        });
      }
      // The child authority now exists. Later attachment/telemetry failures
      // must not compensate the control row away from a real work stream.
      controlRunInserted = false;
      await this.recordRunCreationTelemetry(workstreamId, triggerType);
      const resourceRows = await this.env.DB.prepare(
        `SELECT ar.resource_id, ar.attached_by_user_id, ar.relationship_type
           FROM automation_resources ar
           JOIN notes n ON n.resource_id = ar.resource_id AND n.workspace_id = ?
          WHERE ar.automation_subscription_id = ? AND n.archived_at IS NULL
            AND (n.scope = 'workspace' OR n.owner_user_id = ?)`,
      ).bind(
        this.auth.workspaceId,
        subscription.id,
        principal.type === "user" ? principal.userId : null,
      ).all<{ resource_id: string; attached_by_user_id: string | null; relationship_type: string }>();
      const attachments = [
        ...(resourceRows.results ?? []).map((resource) => ({
          resourceId: resource.resource_id,
          attachedByUserId: resource.attached_by_user_id,
          relationshipType: ResourceRelationshipTypeSchema.parse(resource.relationship_type),
        })),
        ...(openingInput ? [{
          resourceId: openingInput.resourceId,
          attachedByUserId: null,
          relationshipType: "inbound_email" as const,
        }] : []),
      ];
      for (const attachment of attachments) {
        await attachWorkstreamRuntimeResource(this.env, {
          workspaceId: this.auth.workspaceId,
          workstreamId,
          ...attachment,
        });
      }
    } catch (error) {
      if (controlRunInserted) {
        try {
          const deleted = await this.env.DB.prepare(
            `DELETE FROM automation_runs
              WHERE id = ? AND workspace_id = ? AND workflow_instance_id IS NULL
              RETURNING id`,
          ).bind(runId, this.auth.workspaceId).first<{ id: string }>();
          if (deleted?.id !== runId) {
            throw new Error("automation_run_compensation_not_applied", { cause: error });
          }
        } catch (compensationError) {
          throw new AggregateError(
            [error, compensationError],
            "automation_run_compensation_failed",
            { cause: compensationError },
          );
        }
      }
      if (plannedFor && isConstraintError(error)) {
        const existing = await this.env.DB.prepare(
          `SELECT id AS run_id, workstream_id FROM automation_runs WHERE automation_subscription_id = ? AND planned_for = ?`,
        ).bind(subscription.id, plannedFor).first<{ run_id: string; workstream_id: string }>();
        if (existing) {
          await emailRouting.ensureWorkstreamAddress(routeInputFor(existing.workstream_id));
          await this.recordRunCreationTelemetry(existing.workstream_id, triggerType);
          return { runId: existing.run_id, workstreamId: asWorkstreamId(existing.workstream_id), reused: true };
        }
      }
      if (idempotencyKey && isConstraintError(error)) {
        const existing = await this.loadIdempotentRun(String(subscription.id), idempotencyKey, openingInput?.clientMessageId ?? null);
        if (existing) {
          await emailRouting.ensureWorkstreamAddress(routeInputFor(existing.workstreamId));
          if (start) await this.recoverIdempotentRun(subscription, existing, triggerType, activityId);
          await this.recordRunCreationTelemetry(existing.workstreamId, triggerType);
          return this.runResponse(existing, true);
        }
      }
      throw error;
    }
    await emailRouting.activateWorkstreamRoute(routeInput);
    if (start) {
      await this.launchAutomationRun(subscription, {
        runId,
        workstreamId,
        harnessRunId,
        workflowInstanceId: null,
        runStatus: "scheduled",
        harnessStatus: "scheduled",
        triggerMessageId,
      }, triggerType, activityId, principal);
    }
    return { runId, workstreamId, ...(start ? { harnessRunId } : {}), reused: false };
  }

  private async recordRunCreationTelemetry(workstreamId: string, triggerType: string): Promise<void> {
    const creationSource: WorkstreamCreationSource = triggerType === "schedule"
      ? "automation_scheduled"
      : triggerType === "inbound_email" ? "automation_inbound_email" : "automation_manual";
    await recordWorkstreamCreatedTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      workstreamId,
      creationSource,
      principal: { type: "user", userId: this.auth.userId },
    });
  }

  private async loadIdempotentRun(subscriptionId: string, idempotencyKey: string, openingClientMessageId: string | null = null): Promise<IdempotentAutomationRun | null> {
    const run = await this.env.DB.prepare(
      `SELECT id AS run_id, workstream_id, status AS run_status,
              workflow_instance_id AS run_workflow_instance_id
         FROM automation_runs
        WHERE workspace_id = ? AND automation_subscription_id = ? AND idempotency_key = ?
        LIMIT 1`,
    ).bind(this.auth.workspaceId, subscriptionId, idempotencyKey).first<{
      run_id: string;
      workstream_id: string;
      run_status: string;
      run_workflow_instance_id: string | null;
    }>();
    if (!run) return null;
    const executionEnv = this.env;
    const [harness, message] = await Promise.all([
      createHarnessRunObjectPort(executionEnv, this.auth.workspaceId, run.workstream_id)
        .latestRootRun(),
      openingClientMessageId
        ? createMessageObjectPort(this.env, this.auth.workspaceId, run.workstream_id)
          .messageByClientId({ clientMessageId: openingClientMessageId })
        : Promise.resolve(undefined),
    ]);
    return {
      runId: run.run_id,
      workstreamId: asWorkstreamId(run.workstream_id),
      harnessRunId: harness?.run_id ? asHarnessRunId(harness.run_id) : null,
      workflowInstanceId: harness?.workflow_instance_id ?? run.run_workflow_instance_id,
      runStatus: run.run_status,
      // The row speaks the object's vocabulary; the terminal set this is
      // compared against below is the published one.
      harnessStatus: harness ? publishedRunStatus(harness.status) : null,
      triggerMessageId: message?.id ?? null,
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
    // Projection succeeds only after the stable receipt has been accepted by
    // SubstreamAgent. Together these fields are durable proof that this exact
    // activation crossed both boundaries; replay is for the ambiguous
    // scheduled state only.
    if (run.runStatus === "running" && run.workflowInstanceId) return;
    if (!run.harnessRunId) {
      throw new ApiError(503, "workflow_launch_pending", "The automation run is still being prepared; retry with the same key");
    }
    if (run.workflowInstanceId) {
      const executionEnv = this.env;
      const { harnessRunId, workflowInstanceId } = run;
      const reconcile = () => Promise.all([
        createHarnessRunObjectPort(executionEnv, this.auth.workspaceId, run.workstreamId)
          .bindWorkflowInstance({
            runId: harnessRunId,
            workflowInstanceId,
            now: Date.now(),
          }),
        this.env.DB.prepare(
          "UPDATE automation_runs SET workflow_instance_id = ? WHERE id = ? AND workspace_id = ?",
        ).bind(run.workflowInstanceId, run.runId, this.auth.workspaceId).run(),
      ]);
      try {
        await reconcile();
      } catch {
        // Both writes are idempotent. Repeating both repairs whichever side of
        // the cross-object pair did not commit before the transient failure.
        await reconcile();
      }
      // The receipt commits before SubstreamAgent activation. A lost response
      // can therefore leave this pair reconciled without proving the loop saw
      // the request. Fall through and replay the same stable activation.
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
      loopId: substreamLoopId(asWorkstreamId(run.workstreamId)),
      harnessRunId: run.harnessRunId,
      triggerMessageId: run.triggerMessageId,
      automationSubscriptionId: String(subscription.id),
      activityId,
      executionPrincipal: principal,
      reason: triggerType,
    };
    try {
      await activateWorkstreamLoop(this.env, workflowInput);
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

  /**
   * The two zones an automation can fall back to when its trigger names none.
   *
   * One statement for both: the compiler is handed both and picks by the scope
   * it is drafting for, and a schedule picks by the scope it is written with.
   * `personal` comes back null when this is asked without an owner — which a
   * workspace automation has none of, and never reads.
   */
  private async defaultTimezones(ownerUserId: string | null): Promise<{
    personal: string | null;
    workspace: string;
  }> {
    // One statement, one pass, and the membership predicate is in the statement
    // rather than in whichever caller happened to resolve the id: `ownerUserId`
    // is an automation's owner, not necessarily the caller, so the join is what
    // keeps this from being a `users` read by bare primary key. `u.id` rather
    // than `u.timezone` answers whether the person is here, because a row that
    // is absent and a zone that is unset are different questions.
    const row = await this.env.DB.prepare(
      `SELECT w.timezone AS workspace_timezone, u.id AS user_id, u.timezone AS user_timezone
       FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?1 AND m.status = 'active'
       LEFT JOIN users u ON u.id = m.user_id
       WHERE w.id = ?2`,
    ).bind(ownerUserId, this.auth.workspaceId).first<{
      workspace_timezone: string;
      user_id: string | null;
      user_timezone: string | null;
    }>();
    if (!row) throw new ApiError(403, "workspace_access_denied", "Workspace access is unavailable");
    if (ownerUserId !== null && row.user_id == null) {
      throw new ApiError(403, "workspace_access_denied", "Workspace access is unavailable");
    }
    return { personal: row.user_timezone, workspace: row.workspace_timezone };
  }

  /**
   * The zone a schedule is derived in when its trigger does not name one.
   *
   * The resolution order the data model states — explicit trigger, then the
   * owner's account, then the workspace — and this is where the second and
   * third terms are read, at the moment a `schedules` row is written rather
   * than when a draft was compiled. Every path that derives schedules goes
   * through here: accepting a draft, subscribing to a shared template, and
   * adopting a new version all pick the zone of the person the automation runs
   * for, not of whoever wrote the definition or of a zone the compiler guessed.
   */
  private async scheduleTimezone(scope: Scope, ownerUserId: string | null): Promise<string> {
    if (scope !== "personal") return (await this.defaultTimezones(null)).workspace;
    const defaults = await this.defaultTimezones(ownerUserId);
    return defaults.personal ?? defaults.workspace;
  }

  /**
   * The zone somebody actually named on a calendar trigger, or null.
   *
   * Type-checked rather than optional-chained because both callers read a
   * definition that crossed a durable boundary — `trigger_definitions_json`
   * written by an older deployment, parsed with an unchecked cast — where a
   * number or an object would make `.trim()` throw a `TypeError` and turn a
   * typed 422 into a 500.
   */
  private static namedTimezone(trigger: TriggerDefinition): string | null {
    if (trigger.type !== "calendar") return null;
    return typeof trigger.timezone === "string" && trigger.timezone.trim()
      ? trigger.timezone
      : null;
  }

  /**
   * Triggers as a response carries them, with every calendar zone filled in.
   *
   * Storage keeps `null` for a zone nobody named: that absence is what lets the
   * create screen's chosen scope, and somebody adopting a shared template,
   * answer it against their own account rather than the drafting session's.
   * A response is the one place the question is already settled, so it answers
   * it — from the `schedules` row the automation actually fires on, and for a
   * version nobody has adopted yet, from what adopting it would resolve to.
   *
   * This cannot re-freeze anything: no client posts these triggers back. The
   * create screen posts a draft, which keeps its nulls, and `update` re-binds
   * the stored definition rather than anything a response handed out.
   */
  private async triggersForWire(input: {
    triggers: TriggerDefinition[];
    scheduleZonesByRrule: Map<string, string>;
    scope: Scope;
    ownerUserId: string | null;
  }): Promise<TriggerDefinition[]> {
    const unresolved = input.triggers.filter((trigger) =>
      trigger.type === "calendar" && !AutomationService.namedTimezone(trigger));
    if (unresolved.length === 0) return input.triggers;
    const needsAccountZone = unresolved.some((trigger) =>
      trigger.type !== "calendar" || !input.scheduleZonesByRrule.has(String(trigger.rrule)));
    const accountZone = needsAccountZone
      ? await this.scheduleTimezone(input.scope, input.ownerUserId)
      : null;
    return input.triggers.map((trigger) => {
      if (trigger.type !== "calendar" || AutomationService.namedTimezone(trigger)) return trigger;
      return {
        ...trigger,
        timezone: input.scheduleZonesByRrule.get(String(trigger.rrule)) ?? accountZone,
      };
    });
  }

  /**
   * Every `schedules` row a set of triggers implies, in the right zone.
   *
   * The account is read once, and only when some calendar trigger actually
   * needs it — an automation that runs on an interval or on connector activity
   * asks nobody what time it is.
   */
  private async schedulesForTriggers(input: {
    triggers: TriggerDefinition[];
    subscriptionId: string;
    at: string;
    scope: Scope;
    ownerUserId: string | null;
  }): Promise<CompiledSchedule[]> {
    const needsAccountZone = input.triggers.some((trigger) =>
      trigger.type === "calendar" && !AutomationService.namedTimezone(trigger));
    const defaultTimezone = needsAccountZone
      ? await this.scheduleTimezone(input.scope, input.ownerUserId)
      : null;
    return input.triggers.flatMap((trigger) =>
      this.scheduleForTrigger(trigger, input.subscriptionId, input.at, defaultTimezone));
  }

  private scheduleForTrigger(
    trigger: TriggerDefinition,
    _subscriptionId: string,
    at: string,
    defaultTimezone: string | null,
  ): CompiledSchedule[] {
    if (trigger.type === "interval") {
      return [{ type: "interval", rrule: null, intervalSeconds: trigger.intervalSeconds, timezone: "UTC", nextRunAt: new Date(Date.parse(at) + trigger.intervalSeconds * 1_000).toISOString() }];
    }
    if (trigger.type === "calendar") {
      // A trigger that names no zone takes the account's: the compiler is asked
      // to leave it unset when nobody named one, and `schedulesForTriggers`
      // resolves the account's zone whenever any trigger here is in that state.
      const timezone = AutomationService.namedTimezone(trigger) ?? defaultTimezone;
      if (!timezone) throw new ApiError(422, "invalid_timezone", "The automation recurrence names no time zone");
      try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new ApiError(422, "invalid_timezone", `Invalid IANA time zone: ${timezone}`); }
      let next: Date | null;
      try {
        next = nextRRuleOccurrence(trigger.rrule, timezone, new Date(at), new Date(at));
      } catch {
        throw new ApiError(422, "invalid_recurrence", "The automation recurrence rule is invalid");
      }
      if (!next) throw new ApiError(422, "recurrence_has_no_future", "The automation recurrence has no future occurrence");
      return [{ type: "calendar", rrule: trigger.rrule, intervalSeconds: null, timezone, nextRunAt: next.toISOString() }];
    }
    return [];
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

  private assertScopeAllowed(scope: Scope): void {
    if (scope === "workspace" && this.auth.role !== "owner" && this.auth.role !== "admin") throw new ApiError(403, "workspace_admin_required", "Only administrators can create workspace automations");
  }

  private async resolveDeliveryTargets(
    scope: Scope,
    targets: CreateAutomationInput["deliveryTargets"],
  ): Promise<ResolvedDeliveryTarget[]> {
    if (targets.length === 0) return [];
    if (scope !== "personal") throw new ApiError(422, "personal_automation_required", "Result delivery outside Avalon requires a personal automation");
    const resolved: ResolvedDeliveryTarget[] = [];
    for (const target of targets) {
      if (target.type === "email") {
        resolved.push({ type: "email", emailAddress: await this.deliveryEmailAddress() });
        continue;
      }
      // Accepted on exactly the terms the create screen offered it on: the
      // connector declares the surface, the connection is healthy, and any
      // identity link that surface requires is in place.
      const identity = await resolveFrozenDeliveryIdentity(this.env, {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        connectionId: target.connectionId,
        targetType: target.type,
      });
      if (!identity) {
        throw new ApiError(422, "delivery_target_unavailable", "Connect your Avalon account in the selected destination before using it for automation delivery");
      }
      resolved.push({ type: target.type, ...identity });
    }
    return resolved;
  }

  // Email delivery is frozen against the owner's account address at save time
  // rather than resolved per run, so a later account change cannot silently
  // redirect an automation's results.
  private async deliveryEmailAddress(): Promise<string> {
    const row = await this.env.DB.prepare(
      `SELECT u.email FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ? AND wm.status = 'active'
       WHERE u.id = ?`,
    ).bind(this.auth.workspaceId, this.auth.userId).first<{ email: string | null }>();
    const email = row?.email?.trim() ?? "";
    if (!email) throw new ApiError(422, "email_delivery_unavailable", "Your Avalon account has no email address to deliver results to");
    return email;
  }

  private assertCanManageSubscription(subscription: Record<string, unknown>): void {
    if (subscription.scope === "workspace" && this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Only administrators can change workspace automations");
    }
  }

  private async validateAutomationResources(scope: Scope, requestedIds: string[]): Promise<string[]> {
    const ids = [...new Set(requestedIds)];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.env.DB.prepare(
      `SELECT r.id
       FROM resources r
       JOIN notes n ON n.resource_id = r.id AND n.workspace_id = r.workspace_id
       WHERE r.id IN (${placeholders}) AND r.workspace_id = ?
         AND r.provider = 'avalon_note' AND r.resource_type = 'note'
         AND n.archived_at IS NULL
         AND (n.scope = 'workspace' OR n.owner_user_id = ?)`,
    ).bind(...ids, this.auth.workspaceId, this.auth.userId).all<{ id: string }>();
    const available = new Set((rows.results ?? []).map((row) => row.id));
    if (available.size !== ids.length) {
      throw new ApiError(422, "invalid_automation_resource", "One or more selected note resources are unavailable");
    }
    if (scope === "workspace") {
      const workspaceRows = await this.env.DB.prepare(
        `SELECT resource_id FROM notes
         WHERE resource_id IN (${placeholders}) AND workspace_id = ?
           AND scope = 'workspace' AND archived_at IS NULL`,
      ).bind(...ids, this.auth.workspaceId).all<{ resource_id: string }>();
      if ((workspaceRows.results ?? []).length !== ids.length) {
        throw new ApiError(422, "personal_resource_in_workspace_automation", "Workspace automations can only use workspace notes");
      }
    }
    return ids;
  }

  private async loadSubscription(id: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      `SELECT s.*, t.name, t.description, t.latest_version_number,
       v.version_number, v.overview, v.instructions, v.trigger_definitions_json,
       v.required_capabilities_json, v.expected_outputs_json, v.default_behavior_json,
       v.recommended_plugins_json, v.memory_tables_json
       , t.owner_user_id AS template_owner_user_id
       FROM automation_subscriptions s JOIN automation_templates t ON t.id = s.template_id
       JOIN automation_template_versions v ON v.id = s.template_version_id
       WHERE s.id = ? AND s.workspace_id = ? AND s.lifecycle_state = 'visible'
         AND (s.scope = 'workspace' OR s.owner_user_id = ?) AND t.archived_at IS NULL`,
    ).bind(id, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "automation_not_found", "Automation not found");
    return row;
  }

  private automationRouteInput(automationSubscriptionId: string) {
    return {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      automationSubscriptionId,
    } as const;
  }

  private async refreshScheduler(): Promise<void> {
    await refreshWorkspaceSchedule(this.env, this.auth.workspaceId);
  }
}

export async function runAutomationFromInboundEmail(
  env: Env,
  input: {
    workspaceId: WorkspaceId;
    automationSubscriptionId: string;
    opening: InboundAutomationOpeningInput;
  },
) {
  const subscription = await env.DB.prepare(
    `SELECT s.scope, s.owner_user_id, t.owner_user_id AS template_owner_user_id
     FROM automation_subscriptions s
     JOIN automation_templates t ON t.id = s.template_id
     WHERE s.id = ? AND s.workspace_id = ? AND t.archived_at IS NULL`,
  ).bind(input.automationSubscriptionId, input.workspaceId).first<{
    scope: Scope;
    owner_user_id: string | null;
    template_owner_user_id: string;
  }>();
  if (!subscription) throw new ApiError(404, "automation_not_found", "Automation not found");
  const userId = asUserId(subscription.owner_user_id ?? subscription.template_owner_user_id);
  const auth: AuthContext = {
    sessionId: `inbound-email:${input.opening.resendEmailId}`,
    userId,
    workspaceId: input.workspaceId,
    region: env.AVALON_REGION,
    role: "owner",
  };
  return new AutomationService(env, auth)
    .runFromInboundEmail(input.automationSubscriptionId, input.opening);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
/** What the compiler says back after a turn. The service owns it rather than
 * the route because the saved transcript and the streamed reply have to be the
 * same sentence — a resumed draft that ends on a different question than the
 * one on screen reads as a different conversation. */
function assistantMessageForDraft(draft: AutomationDraft): string {
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
 * Both siblings that read `trigger_definitions_json` already parse it —
 * `queues/activity-consumer.ts` and `services/slack-agent-service.ts` — and
 * `draftState` does the same for its own blob for the same stated reason. A
 * template that loses its bindings here is one nobody can subscribe to, which
 * the subscribe path already refuses with a typed 422; a catalog that 500s is
 * a template browser no one in the workspace can open at all.
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
function pickActivitySourcePluginIds(
  triggers: TriggerDefinition[],
  candidates: Record<string, string>,
): Record<string, string> {
  const bindingKeys = new Set(activitySourceDefinitions(triggers).map((source) => source.bindingKey));
  return Object.fromEntries(Object.entries(candidates).filter(([bindingKey]) => bindingKeys.has(bindingKey)));
}
function isRecoverableEmailRouteTransition(error: unknown): boolean {
  // Service-binding transport failures are not guaranteed to arrive as an
  // ApiError. Once regional state has committed, fail open into the durable
  // reserved marker so list/get reconciliation can finish the transition
  // without making the client retry and create a duplicate automation.
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || error.code === "automation_email_route_not_found";
}
function toAutomationRun(row: Record<string, unknown>) {
  return { id: String(row.id), automationSubscriptionId: String(row.automation_subscription_id), workstreamId: String(row.workstream_id), triggerType: String(row.trigger_type), plannedFor: row.planned_for == null ? null : String(row.planned_for), startedAt: row.started_at == null ? null : String(row.started_at), completedAt: row.completed_at == null ? null : String(row.completed_at), status: String(row.status), resultSummary: row.result_summary == null ? null : String(row.result_summary), createdAt: String(row.created_at) };
}
