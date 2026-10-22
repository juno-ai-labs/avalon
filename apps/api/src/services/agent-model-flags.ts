import { describeZodIssues, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  AGENT_MODEL_FLAG_KEYS,
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
import {
  loadFlagTargetingAttributes,
  type FlagTargetingAttributes,
  type FlagTargetingSubject,
} from "./flag-targeting-attributes";
import { createIdentityObjectPort } from "../runtime/identity-port";

/**
 * Every model-using task whose output does not define a persistent semantic
 * space is declared in the shared contract above. Each one owns a Flagship flag
 * carrying the OpenRouter model it runs on and the OpenRouter models it may
 * route onward to, so a model swap is a flag change rather than a deploy.
 *
 * The first two names match `AgentInferenceSource` in
 * `agent-inference-logging.ts`, so a lakehouse record and a flag key describe
 * the same agent. The rest are the standalone structured-output agents, which
 * call OpenRouter directly rather than through the harness.
 *
 * Durable-memory embeddings and message addressing are deliberate exceptions.
 * Their fixed models protect a semantic-space contract and a measured
 * two-provider cascade respectively, so neither can be retargeted through
 * Flagship. Other new model-using services belong in this catalog and the
 * default resolver below.
 */
export { AGENT_MODEL_FLAG_KEYS, AGENT_MODEL_ROLES };
export type { AgentModelRole, AgentModelRouting };

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
    // The import reads screenshots, so its default must accept images; the
    // primary conversation model does.
    // The memory sweep's judgments (what a colleague would need later, a
    // fact's horizon, which fact a sentence supersedes) are the ones small
    // models get wrong, so it runs on the primary model (agent-memory PRD,
    // design decision 10).
    case "workstream":
    case "inline_child":
    case "session_import":
    case "memory_sweep":
    case "sidekick_authoring":
      return { model: modelId(env.OPENROUTER_PRIMARY_MODEL), fallbackModels };
    case "workstream_naming":
      return { model: modelId(env.OPENROUTER_CLASSIFIER_MODEL), fallbackModels };
    case "work_opportunity_admission":
    case "work_opportunity_ranking":
    case "workstream_description":
    case "suggestion_draft":
      return { model: modelId(env.OPENROUTER_STRUCTURED_MODEL), fallbackModels };
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
async function resolveAgentModelRoutingForSubject(
  env: Env,
  role: AgentModelRole,
  context: AgentModelFlagContext,
  attributeSubject: FlagTargetingSubject,
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
  const attributes = await loadFlagTargetingAttributes(env, attributeSubject);
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
      validation_issues: describeZodIssues(parsed.error),
      error_code: zodDiagnosticCode(parsed.error, "agent_model_flag"),
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
  return parsed.data;
}

/**
 * Stable resolver for every ordinary agent evaluation. New work-stream
 * creation uses `resolveNewWorkstreamModelRouting` until its product facts are
 * committed.
 */
export async function resolveAgentModelRouting(
  env: Env,
  role: AgentModelRole,
  context: AgentModelFlagContext = {},
): Promise<AgentModelRouting> {
  return resolveAgentModelRoutingForSubject(env, role, context, context);
}

/**
 * Resolve the first run of a work stream before its product facts are
 * committed. Depending on the creation path, its object root is either still
 * `preparing` or is an authoritative runtime shell carrying placeholder facts.
 *
 * The work-stream id remains in the Flagship evaluation context, where it is
 * identity and bucketing input. It is deliberately omitted only from the
 * attribute loader: reading the Channel's product facts before the creation
 * path's product/root and first-run commit would either cross the authority
 * fence or expose the runtime shell's placeholders as targeting facts.
 * Workspace attributes are already authoritative and remain available. Later
 * runs use the ordinary resolver and load the complete work-stream facts.
 */
export function resolveNewWorkstreamModelRouting(
  env: Env,
  context: { workspaceId: string; workstreamId: string },
): Promise<AgentModelRouting> {
  return resolveAgentModelRoutingForSubject(
    env,
    "workstream",
    context,
    { workspaceId: context.workspaceId },
  );
}

/**
 * The model a work-stream run is expected to use, recorded on `harness_runs`
 * rows at schedule time. Resolved from the same flag the run itself reads.
 *
 * Flag-only: scheduled creation paths call this before the product row is
 * populated, so it deliberately shares the same workspace-only attribute
 * boundary as direct Durable Object creation. A caller that already knows the
 * override it is about to write passes it through `pinnedModelRouting`; every
 * path reading an existing work stream uses `resolveWorkstreamModelRouting`
 * below.
 */
export async function scheduledWorkstreamModel(
  env: Env,
  context: { workspaceId: string; workstreamId: string },
): Promise<string> {
  return (await resolveNewWorkstreamModelRouting(env, context)).model;
}

/**
 * A stored model override, validated against the closed list a creator may
 * choose from, or `null` for anything else — an absent override, and equally a
 * model that has since left the list. Re-validating on read is what lets a
 * model be retired from `AGENT_MODEL_OVERRIDES` without a migration: the work
 * streams pinned to it quietly return to the flag.
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
      agent: "workstream",
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
};

/** Only a Sidekick's Main is its wizard; activations and workers keep their existing route. */
export function conversationModelRole(
  context: ConversationModelContext,
): "workstream" | "sidekick_authoring" {
  return context.parentKind === "automation" && (context.substreamId ?? "0") === "0"
    ? "sidekick_authoring"
    : "workstream";
}

/**
 * The work-stream agent's route plan for one work stream: its own override if
 * it carries one, otherwise its conversation role's flag. Sidekick authoring
 * has its own role; triggered runs and ordinary threads retain `workstream`.
 *
 * The override wins over the flag rather than the other way round. A flag is a
 * fleet-wide default and an override is somebody asking this one work stream to
 * run somewhere else, so a rollout reaching the workspace must not quietly take
 * the pinned work stream with it.
 *
 * Unlike `resolveAgentModelRouting` this reads the authoritative conversation
 * identity, so its object RPC can fail before flag evaluation.
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
  context: { workspaceId: string; workstreamId: string },
): Promise<string> {
  return (await resolveWorkstreamModelRouting(env, context)).model;
}
