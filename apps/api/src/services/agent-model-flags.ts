import { describeZodIssues, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  AGENT_MODEL_ROLES,
  AgentModelOverrideSchema,
  AgentModelRoutingSchema,
  type AgentModelOverride,
  type AgentModelRole,
  type AgentModelRouting,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { AGENT_MODEL_DEFAULTS, AGENT_MODEL_ENV_KEYS } from "@rally/contracts/runtime-config";
import { z } from "zod";
import { createIdentityObjectPort } from "../runtime/identity-port";

/** Stable entry points for agent routing; defaults live in @rally/contracts/runtime-config. */
export { AGENT_MODEL_ROLES };
export type { AgentModelRole, AgentModelRouting };

export interface AgentModelFlagContext {
  workspaceId?: string | undefined;
  workstreamId?: string | undefined;
  userId?: string | undefined;
}

export function defaultAgentModelRouting(env: Env, role: AgentModelRole): AgentModelRouting {
  const variable = AGENT_MODEL_ENV_KEYS[role];
  const model = env[variable]?.trim() || AGENT_MODEL_DEFAULTS[variable];
  // An explicitly empty list disables fallbacks; an unset variable uses the constant.
  const fallbackModels = (env.OPENROUTER_FALLBACK_MODEL ?? AGENT_MODEL_DEFAULTS.OPENROUTER_FALLBACK_MODEL)
    .split(",").map((value) => value.trim()).filter(Boolean);
  return { model, fallbackModels };
}

/** A per-role JSON override replaces the entire route, including reasoning effort. */
export async function resolveAgentModelRouting(
  env: Env,
  role: AgentModelRole,
  context: AgentModelFlagContext = {},
): Promise<AgentModelRouting> {
  void context; // Identity is retained in the caller contract; configuration is deployment-wide.
  const fallback = defaultAgentModelRouting(env, role);
  if (!env.AGENT_MODEL_ROUTING_JSON?.trim()) return fallback;
  let overrides: Record<string, unknown>;
  try {
    overrides = z.record(z.string(), z.unknown()).parse(JSON.parse(env.AGENT_MODEL_ROUTING_JSON));
  } catch (error) {
    logStructuredEvent(env, "warn", "agent_model_override_invalid", {
      variable: "AGENT_MODEL_ROUTING_JSON",
      error_code: zodDiagnosticCode(error, "agent_model_routing") ?? "agent_model_routing:invalid_json",
    });
    return fallback;
  }
  if (overrides[role] === undefined) return fallback;
  const parsed = AgentModelRoutingSchema.safeParse(overrides[role]);
  if (!parsed.success) {
    logStructuredEvent(env, "warn", "agent_model_override_invalid", {
      agent: role,
      variable: "AGENT_MODEL_ROUTING_JSON",
      error_code: zodDiagnosticCode(parsed.error, "agent_model_routing"),
      validation_issues: describeZodIssues(parsed.error),
    });
    return fallback;
  }
  return parsed.data;
}

export function resolveNewWorkstreamModelRouting(
  env: Env,
  context: { workspaceId: string; workstreamId: string },
  role: AgentModelRole = "canvas",
): Promise<AgentModelRouting> {
  return resolveAgentModelRouting(env, role, context);
}

export async function scheduledWorkstreamModel(
  env: Env,
  context: { workspaceId: string; workstreamId: string },
  role: AgentModelRole = "canvas",
): Promise<string> {
  return (await resolveNewWorkstreamModelRouting(env, context, role)).model;
}

/**
 * A stored model override, validated against the closed list a creator may
 * choose from, or `null` for anything else — an absent override, and equally a
 * model that has since left the list. Re-validating on read is what lets a
 * model be retired from `AGENT_MODEL_OVERRIDES` without a migration: the work
 * streams pinned to it quietly return to the configured default.
 */
export function agentModelOverride(value: unknown): AgentModelOverride | null {
  const parsed = AgentModelOverrideSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A stored value that was meant to be an override and is not one — a model that
 * has left `AGENT_MODEL_OVERRIDES`, or anything a direct database write could
 * have put there. Absent and empty are not that: they are the ordinary
 * unpinned state and say nothing.
 */
function unknownStoredOverride(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return agentModelOverride(value) === null ? value : null;
}

/**
 * `agentModelOverride`, for a pin being copied off an automation subscription
 * onto the work stream a run is creating.
 *
 * Separate from the plain validator because dropping a pin silently is only
 * acceptable where something else will say so. The work-stream read path logs
 * it; these paths write the column and would otherwise retire a model out from
 * under every automation pinned to it with nothing in the logs — which is
 * exactly the diagnostic `docs/feature-flags.md` promises exists.
 */
export function automationModelOverride(
  env: Env,
  value: unknown,
  context: { workspaceId: string; automationId: string },
): string | null {
  const unknown = unknownStoredOverride(value);
  if (unknown) {
    logStructuredEvent(env, "warn", "workstream_model_override_unknown", {
      agent: "sidekick_run",
      workspace_id: context.workspaceId,
      automation_id: context.automationId,
      stored_model: unknown,
    });
  }
  return agentModelOverride(value);
}

/**
 * The route plan for a pinned model. An override carries no fallbacks: it is a
 * request to observe one specific model, and routing onward would answer a
 * question nobody asked.
 */
export function pinnedModelRouting(model: string): AgentModelRouting {
  return { model, fallbackModels: [] };
}

type ConversationModelContext = {
  parentKind?: WorkstreamWorkflowInput["parentKind"];
  substreamId?: string | undefined;
  backgroundAgent?: boolean | undefined;
  automationRun?: unknown;
  automationDelegation?: unknown;
};

/**
 * The one place the fields a route reads are picked off an activation, so the
 * role a caller logs and the route it resolves cannot read different ones.
 */
export function conversationModelContext(
  input: Pick<WorkstreamWorkflowInput, "parentKind"> & Partial<Pick<WorkstreamWorkflowInput, "backgroundAgent" | "automationRun" | "automationDelegation">>,
  substreamId: string | undefined,
): ConversationModelContext {
  return {
    parentKind: input.parentKind,
    substreamId,
    backgroundAgent: input.backgroundAgent === true,
    automationRun: input.automationRun,
    automationDelegation: input.automationDelegation,
  };
}

/**
 * A Sidekick's Main is its wizard, and the background agents the wizard
 * starts use the wizard route; a run's activation and its
 * delegation workers use the Sidekick run route.
 */
export function conversationModelRole(
  context: ConversationModelContext,
): "canvas" | "sidekick_wizard" | "sidekick_run" {
  if (context.parentKind !== "automation") return "canvas";
  return !context.automationRun && !context.automationDelegation
    && ((context.substreamId ?? "0") === "0" || context.backgroundAgent === true)
    ? "sidekick_wizard"
    : "sidekick_run";
}

/**
 * The work-stream agent's route plan for one work stream: its own override if
 * it carries one, otherwise its conversation role's configured default.
 * Sidekick wizard and run roles are independent of the Canvas `canvas` role.
 *
 * The override wins over configuration. Configuration is a
 * fleet-wide default and an override is somebody asking this one work stream to
 * run somewhere else, so a configuration change must not quietly take
 * the pinned work stream with it.
 *
 * Unlike `resolveAgentModelRouting` this reads the authoritative conversation
 * identity, so its object RPC can fail before configuration resolution.
 */
export async function resolveWorkstreamModelRouting(
  env: Env,
  context: { workspaceId: string; workstreamId: string }
    & ConversationModelContext,
): Promise<AgentModelRouting> {
  const role = conversationModelRole(context);
  const row = await createIdentityObjectPort(env, context.workspaceId, context.workstreamId)
    .identity();
  const override = agentModelOverride(row?.model_override);
  if (override) {
    logStructuredEvent(env, "debug", "workstream_model_override_applied", {
      agent: role,
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      model: override,
    });
    return pinnedModelRouting(override);
  }
  // A stored value the list no longer admits is worth saying out loud: the work
  // stream is about to run on a different model than whoever pinned it expects.
  const unknown = unknownStoredOverride(row?.model_override);
  if (unknown) {
    logStructuredEvent(env, "warn", "workstream_model_override_unknown", {
      agent: role,
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      stored_model: unknown,
    });
  }
  return resolveAgentModelRouting(env, role, context);
}

/** `resolveWorkstreamModelRouting`, reduced to the model column's value. */
export async function scheduledWorkstreamModelForExisting(
  env: Env,
  context: { workspaceId: string; workstreamId: string } & ConversationModelContext,
): Promise<string> {
  return (await resolveWorkstreamModelRouting(env, context)).model;
}
