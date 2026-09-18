import {
  TELEMETRY_CONNECTOR_TYPES,
  type TelemetryConnectorType,
} from "@rally/contracts/telemetry";
import type { AutomationDraft, AutomationScope, UserId, WorkspaceId } from "@rally/contracts";
import type { Env } from "../env";
import type { WorkDeferral } from "../lib/defer";
import { uuidV7 } from "../lib/uuid-v7";
import { emitProductUsageTelemetry, resourceTelemetryEventId } from "./product-usage";

/**
 * What a Sidekick's authoritative server writes report to analytics.
 *
 * Both contracts here are produced from `SidekickDO` rather than from the route
 * or the service, because the object is the only party that sees every
 * publication: `POST /sidekicks/:id/accept` reaches `apply` directly, and a
 * drafting conversation reaches it through `saveDefinition`, which applies a
 * ready draft in the same call. A Worker-side producer would have measured one
 * of those two and silently missed the other.
 *
 * Emission is observational. `emitProductUsageTelemetry` defers the work and
 * swallows its own failure, so nothing here can fail, delay, or retry a
 * lifecycle transition.
 */

/**
 * Event-id namespaces, distinct from every other one in the tree (1 tool
 * invocation, 2 harness run, 8/9 work opportunity, 10 digest delivery,
 * 11-14 invitation).
 */
const FIRST_PUBLICATION_NAMESPACE = 3;
const MANUAL_RUN_NAMESPACE = 4;

export type AutomationLifecycleStatus = "draft" | "active" | "paused" | "error";
export type AutomationAppliedStatus = AutomationLifecycleStatus | "deleted" | "archived";

export type AutomationLifecycleAction =
  | "pause"
  | "resume"
  | "edit"
  | "publish_template"
  | "adopt_template_version"
  | "run_now"
  | "archive_draft"
  | "delete";

interface AutomationSubject {
  workspaceId: WorkspaceId;
  automationId: string;
  /** The member whose request produced the write; every action here has one. */
  actorUserId: UserId;
  scope: AutomationScope;
}

/**
 * A workspace-scoped Sidekick is readable by the whole workspace; a personal
 * one and a room's are not. The same reading `workstream-creation.ts` takes.
 */
function visibility(scope: AutomationScope): "private" | "public" {
  return scope === "workspace" ? "public" : "private";
}

type AutomationTriggerType = AutomationDraft["triggers"][number]["type"];

/** Deduplicated and sorted, so two identical definitions report the same array. */
function triggerTypes(definition: AutomationDraft): AutomationTriggerType[] {
  return [...new Set(definition.triggers.map((trigger) => trigger.type))].sort();
}

/**
 * The connectors a definition's triggers bind to, keeping only types the closed
 * registry admits. A connector the enum has not been taught is dropped rather
 * than widening a shipped field to an arbitrary string.
 */
function connectorTypes(definition: AutomationDraft): TelemetryConnectorType[] {
  const present = new Set<string>();
  for (const trigger of definition.triggers) {
    if (trigger.type === "webhook") present.add("generic_webhook");
    else if ("connectorType" in trigger && typeof trigger.connectorType === "string") {
      present.add(trigger.connectorType);
    }
  }
  return TELEMETRY_CONNECTOR_TYPES.filter((value) => present.has(value));
}

/** `resourceCount` is `0..100`; a definition with more plugins reports the ceiling. */
function boundedCount(value: number): number {
  return Math.max(0, Math.min(100, Math.trunc(Number.isFinite(value) ? value : 0)));
}

/**
 * A Sidekick's first ready definition became the one that runs.
 *
 * Keyed on the automation id, so the apply replay path — which re-runs its
 * whole tail until `applied_effects_revision` catches up — reports one
 * occurrence however many times it runs. Every later publication is an `edit`
 * through `emitAutomationActionCompleted` instead.
 */
export function emitAutomationPublished(
  env: Env,
  input: AutomationSubject & {
    definition: AutomationDraft;
    pluginCount: number;
    modelOverride: boolean;
  },
  defer?: WorkDeferral,
): void {
  emitProductUsageTelemetry(env, {
    workspaceId: input.workspaceId,
    userId: input.actorUserId,
    name: "automation_created_v2",
    properties: {
      automationId: input.automationId,
      // `creationMethod` has one live value and `deliveryTargetTypes` one live
      // shape: the template gallery and per-automation delivery targets are
      // both retired. Both are required by a closed, shipped schema, so they
      // are reported truthfully rather than dropped. `draftId` and `templateId`
      // are optional and are never set — one id runs from the first authoring
      // turn through acceptance, and there is no gallery to adopt from.
      creationMethod: "custom",
      deliveryTargetTypes: [],
      visibility: visibility(input.scope),
      triggerTypes: triggerTypes(input.definition),
      connectorTypes: connectorTypes(input.definition),
      pluginCount: boundedCount(input.pluginCount),
      modelOverride: input.modelOverride,
    },
    operationId: input.automationId,
    eventId: resourceTelemetryEventId(input.automationId, FIRST_PUBLICATION_NAMESPACE),
  }, defer);
}

/**
 * One completed lifecycle or execution action on an existing Sidekick.
 *
 * `runId` is passed for `run_now` because an occurrence is idempotent and
 * carries its own durable id, so a retried request reports once. The other
 * actions need no such key: `pause`, `resume` and `remove` each return before
 * doing anything when the object already holds the state they ask for, so a
 * replay reaches this call only when it really did move the lifecycle.
 *
 * `result` is `success` on every occurrence today, because every producer is
 * on the far side of a write that committed — a refusal throws an `ApiError`
 * out of the object before reaching here. Classifying refusals means catching
 * and rethrowing in each caller, which is a change to a lifecycle path for an
 * observation, and was left for whoever needs the refused half.
 */
export function emitAutomationActionCompleted(
  env: Env,
  input: AutomationSubject & {
    action: AutomationLifecycleAction;
    previousStatus: AutomationLifecycleStatus;
    appliedStatus: AutomationAppliedStatus;
    runId?: string;
  },
  defer?: WorkDeferral,
): void {
  emitProductUsageTelemetry(env, {
    workspaceId: input.workspaceId,
    userId: input.actorUserId,
    name: "automation_action_completed_v2",
    properties: {
      automationId: input.automationId,
      action: input.action,
      visibility: visibility(input.scope),
      previousStatus: input.previousStatus,
      appliedStatus: input.appliedStatus,
      result: "success",
    },
    operationId: input.automationId,
    eventId: input.runId
      ? resourceTelemetryEventId(input.runId, MANUAL_RUN_NAMESPACE)
      : uuidV7(),
  }, defer);
}
