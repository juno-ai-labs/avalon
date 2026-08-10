import { z } from "zod";
import { HYPERSIGHT_MODEL, type Env } from "../env";
import { logStructuredEvent } from "../observability/logger";

/**
 * Every distinct model-using agent in Avalon. Each one owns a Flagship flag
 * carrying the OpenRouter model it runs on and the OpenRouter models it may
 * route onward to, so a model swap is a flag change rather than a deploy.
 *
 * The first five names match `AgentInferenceSource` in
 * `agent-inference-logging.ts`, so a ledger row and a flag key describe the
 * same agent. The last two are the standalone structured-output classifiers,
 * which call OpenRouter directly rather than through the harness.
 */
export type AgentModelRole =
  | "workstream"
  | "inline_child"
  | "automation_compiler"
  | "hypersight"
  | "meeting_notes"
  | "addressing_classifier"
  | "activity_structured";

export const AGENT_MODEL_ROLES = [
  "workstream",
  "inline_child",
  "automation_compiler",
  "hypersight",
  "meeting_notes",
  "addressing_classifier",
  "activity_structured",
] as const satisfies readonly AgentModelRole[];

/** Flagship flag key per agent. Provisioned per app; see `docs/FEATURE_FLAGS.md`. */
export const AGENT_MODEL_FLAG_KEYS: Readonly<Record<AgentModelRole, string>> = {
  workstream: "agent-model-workstream",
  inline_child: "agent-model-inline-child",
  automation_compiler: "agent-model-automation-compiler",
  hypersight: "agent-model-hypersight",
  meeting_notes: "agent-model-meeting-notes",
  addressing_classifier: "agent-model-addressing-classifier",
  activity_structured: "agent-model-activity-structured",
};

/** One agent's OpenRouter route plan: the default model, then its fallbacks in order. */
export interface AgentModelRouting {
  model: string;
  fallbackModels: string[];
}

const AgentModelRoutingSchema = z.object({
  model: z.string().trim().min(1),
  fallbackModels: z.array(z.string().trim().min(1)).default([]),
});

export interface AgentModelFlagContext {
  workspaceId?: string | undefined;
  workstreamId?: string | undefined;
  userId?: string | undefined;
}

function splitModelIds(value: string | undefined): string[] {
  return (value ?? "").split(",").map((model) => model.trim()).filter(Boolean);
}

/**
 * The route plan a role runs on when Flagship has nothing to say — the Worker
 * variables that owned model selection before the flags existed. This is also
 * the default handed to Flagship, so an absent flag, an unbound binding, and a
 * failed evaluation all resolve identically.
 */
export function defaultAgentModelRouting(env: Env, role: AgentModelRole): AgentModelRouting {
  const fallbackModels = splitModelIds(env.OPENROUTER_FALLBACK_MODELS);
  switch (role) {
    case "workstream":
    case "inline_child":
    case "meeting_notes":
      return { model: env.OPENROUTER_PRIMARY_MODEL, fallbackModels };
    case "automation_compiler":
      return { model: env.OPENROUTER_AUTOMATION_MODEL, fallbackModels };
    case "addressing_classifier":
      return { model: env.OPENROUTER_CLASSIFIER_MODEL, fallbackModels };
    case "activity_structured":
      return { model: env.OPENROUTER_STRUCTURED_MODEL, fallbackModels };
    case "hypersight":
      // HyperSight blocks pin one model and never route onward, so a refreshed
      // block cannot silently change voice partway through a configuration.
      return { model: HYPERSIGHT_MODEL, fallbackModels: [] };
    default: {
      const exhaustive: never = role;
      throw new Error(`Unhandled agent model role: ${String(exhaustive)}`);
    }
  }
}

function evaluationContext(
  env: Env,
  role: AgentModelRole,
  context: AgentModelFlagContext,
): FlagshipEvaluationContext {
  return {
    agent: role,
    region: env.AVALON_REGION,
    appEnv: env.APP_ENV,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.workstreamId ? { workstreamId: context.workstreamId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
  };
}

/**
 * Resolve one agent's OpenRouter models from its Flagship flag, falling back to
 * the Worker variables. Never throws and never returns a partially applied
 * plan: a malformed flag value is rejected whole so an agent cannot end up with
 * a new default model and stale fallbacks.
 */
export async function resolveAgentModelRouting(
  env: Env,
  role: AgentModelRole,
  context: AgentModelFlagContext = {},
): Promise<AgentModelRouting> {
  const fallback = defaultAgentModelRouting(env, role);
  const flags = env.FLAGS;
  if (!flags) return fallback;
  const flagKey = AGENT_MODEL_FLAG_KEYS[role];
  let value: unknown;
  try {
    value = await flags.getObjectValue(flagKey, fallback, evaluationContext(env, role, context));
  } catch (error) {
    logStructuredEvent(env, "warn", "agent_model_flag_unavailable", {
      agent: role,
      flag_key: flagKey,
      workspace_id: context.workspaceId,
      error_name: error instanceof Error ? error.name : "UnknownError",
      model: fallback.model,
    });
    return fallback;
  }
  const parsed = AgentModelRoutingSchema.safeParse(value);
  if (!parsed.success) {
    logStructuredEvent(env, "warn", "agent_model_flag_invalid", {
      agent: role,
      flag_key: flagKey,
      workspace_id: context.workspaceId,
      validation_issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"),
      model: fallback.model,
    });
    return fallback;
  }
  return { model: parsed.data.model, fallbackModels: parsed.data.fallbackModels };
}

/**
 * The model a work-stream run is expected to use, recorded on `harness_runs`
 * rows at schedule time. Resolved from the same flag the run itself reads.
 */
export async function scheduledWorkstreamModel(
  env: Env,
  context: AgentModelFlagContext = {},
): Promise<string> {
  return (await resolveAgentModelRouting(env, "workstream", context)).model;
}
