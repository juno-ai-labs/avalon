import { z } from "zod";
import { HYPERSIGHT_MODEL, type Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import {
  loadFlagTargetingAttributes,
  type FlagTargetingAttributes,
  type FlagTargetingSubject,
} from "./flag-targeting-attributes";

/**
 * Every distinct model-using agent in Avalon. Each one owns a Flagship flag
 * carrying the OpenRouter model it runs on and the OpenRouter models it may
 * route onward to, so a model swap is a flag change rather than a deploy.
 *
 * The first five names match `AgentInferenceSource` in
 * `agent-inference-logging.ts`, so a ledger row and a flag key describe the
 * same agent. The rest are the standalone structured-output agents, which call
 * OpenRouter directly rather than through the harness.
 *
 * A new model-using service belongs here. One that reads `OPENROUTER_*`
 * directly cannot be retargeted or rolled out, and nothing in the type system
 * will point that out.
 */
export const AGENT_MODEL_ROLES = [
  "workstream",
  "inline_child",
  "automation_compiler",
  "hypersight",
  "meeting_notes",
  "addressing_classifier",
  "workstream_naming",
  "activity_structured",
  "work_opportunity_admission",
  "work_opportunity_ranking",
  "workstream_description",
] as const;

export type AgentModelRole = (typeof AGENT_MODEL_ROLES)[number];

/** Flagship flag key per agent. Provisioned per app; see `docs/FEATURE_FLAGS.md`. */
export const AGENT_MODEL_FLAG_KEYS: Readonly<Record<AgentModelRole, string>> = {
  workstream: "agent-model-workstream",
  inline_child: "agent-model-inline-child",
  automation_compiler: "agent-model-automation-compiler",
  hypersight: "agent-model-hypersight",
  meeting_notes: "agent-model-meeting-notes",
  addressing_classifier: "agent-model-addressing-classifier",
  workstream_naming: "agent-model-workstream-naming",
  activity_structured: "agent-model-activity-structured",
  work_opportunity_admission: "agent-model-work-opportunity-admission",
  work_opportunity_ranking: "agent-model-work-opportunity-ranking",
  workstream_description: "agent-model-workstream-description",
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

/**
 * Roles whose route plan a flag may retarget but not widen. A HyperSight block
 * pins one model and never routes onward so a refresh cannot change voice
 * partway through a configuration; that invariant belongs to the product, not
 * to whoever last edited the flag, so a served `fallbackModels` is dropped
 * rather than honoured.
 */
const NO_FALLBACK_ROLES: ReadonlySet<AgentModelRole> = new Set<AgentModelRole>(["hypersight"]);

/**
 * Who the evaluation is for. The identifiers are all a caller has to supply;
 * the attributes a rule matches on beyond them are looked up from these, in
 * `flag-targeting-attributes.ts`.
 */
export type AgentModelFlagContext = FlagTargetingSubject;

function splitModelIds(value: string | undefined): string[] {
  return (value ?? "").split(",").map((model) => model.trim()).filter(Boolean);
}

/**
 * `Env` types the model variables as required strings, but a Worker or test
 * environment can leave one unset. Normalizing to `""` keeps `model` a string
 * for every caller instead of an `undefined` that only surfaces downstream.
 */
function modelId(value: string | undefined): string {
  return value?.trim() ?? "";
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
      return { model: modelId(env.OPENROUTER_PRIMARY_MODEL), fallbackModels };
    case "automation_compiler":
      return { model: modelId(env.OPENROUTER_AUTOMATION_MODEL), fallbackModels };
    case "addressing_classifier":
    case "workstream_naming":
      return { model: modelId(env.OPENROUTER_CLASSIFIER_MODEL), fallbackModels };
    case "activity_structured":
    case "work_opportunity_admission":
    case "work_opportunity_ranking":
    case "workstream_description":
      return { model: modelId(env.OPENROUTER_STRUCTURED_MODEL), fallbackModels };
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

function unreachableFlagLevel(env: Env): "debug" | "warn" {
  return env.APP_ENV === "development" || env.APP_ENV === "test" ? "debug" : "warn";
}

function evaluationContext(
  env: Env,
  role: AgentModelRole,
  context: AgentModelFlagContext,
  attributes: FlagTargetingAttributes,
): FlagshipEvaluationContext {
  // Attributes are spread first so a loaded fact can never shadow the run's own
  // identity: `agent`, `region`, and the ids are what bucketing depends on.
  return {
    ...attributes,
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
  // Loaded outside the try below on purpose. That catch is written for one
  // expected condition — the local always-remote binding throwing — and reports
  // it as `agent_model_flag_unavailable` at a level chosen to keep local runs
  // quiet; an attribute failure caught there would wear the wrong name. The
  // loader guarantees its own no-throw contract and logs its own diagnostics.
  const attributes = await loadFlagTargetingAttributes(env, context);
  let details: FlagshipEvaluationDetails<AgentModelRouting>;
  try {
    details = await flags.getObjectDetails(
      flagKey,
      fallback,
      evaluationContext(env, role, context, attributes),
    );
  } catch (error) {
    // `wrangler dev --local` binds an always-remote binding as an object whose
    // every call throws `Binding FLAGS needs to be run remotely`, so this path
    // is the normal local one and must not warn once per agent run.
    logStructuredEvent(env, unreachableFlagLevel(env), "agent_model_flag_unavailable", {
      agent: role,
      flag_key: flagKey,
      workspace_id: context.workspaceId,
      error_name: error instanceof Error ? error.name : "UnknownError",
      model: fallback.model,
    });
    return fallback;
  }
  // `getObjectDetails` resolves the default rather than throwing when a flag is
  // missing, disabled, or type-mismatched, so a mistyped key would otherwise be
  // indistinguishable from a correctly provisioned one. `errorCode` is the only
  // thing that separates them.
  if (details.errorCode) {
    logStructuredEvent(env, "warn", "agent_model_flag_unresolved", {
      agent: role,
      flag_key: flagKey,
      workspace_id: context.workspaceId,
      error_code: details.errorCode,
      error_message: details.errorMessage,
      reason: details.reason,
      model: fallback.model,
    });
    return fallback;
  }
  const parsed = AgentModelRoutingSchema.safeParse(details.value);
  if (!parsed.success) {
    logStructuredEvent(env, "warn", "agent_model_flag_invalid", {
      agent: role,
      flag_key: flagKey,
      workspace_id: context.workspaceId,
      variant: details.variant,
      validation_issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        code: issue.code,
      })),
      model: fallback.model,
    });
    return fallback;
  }
  // The variant and reason are what confirm a staged rollout actually reached
  // this run; the inference ledger records only the model that resulted. The
  // loaded attributes' *names* say which targeting rules could even have
  // applied — a rule on an attribute that was never sent silently never
  // matches — while their values stay out of the logs. The identity keys are
  // deliberately not in this list: they are on every evaluation, so including
  // them would bury the one thing the field exists to answer.
  logStructuredEvent(env, "debug", "agent_model_flag_resolved", {
    agent: role,
    flag_key: flagKey,
    workspace_id: context.workspaceId,
    variant: details.variant,
    reason: details.reason,
    attributes: Object.keys(attributes).sort().join(","),
    model: parsed.data.model,
  });
  if (NO_FALLBACK_ROLES.has(role) && parsed.data.fallbackModels.length > 0) {
    logStructuredEvent(env, "warn", "agent_model_flag_fallbacks_ignored", {
      agent: role,
      flag_key: flagKey,
      workspace_id: context.workspaceId,
      model: parsed.data.model,
      ignored_fallback_count: parsed.data.fallbackModels.length,
    });
    return { model: parsed.data.model, fallbackModels: [] };
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
