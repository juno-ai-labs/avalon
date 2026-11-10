import { MODEL_INFERENCE_DEFAULTS, type ModelReasoningEffort } from "@rally/contracts/runtime-config";
export { MODEL_INFERENCE_DEFAULTS, type ModelReasoningEffort, type ModelInferenceDefaults } from "@rally/contracts/runtime-config";

export function modelDefaultReasoningEffort(
  model: string,
): ModelReasoningEffort | undefined {
  return MODEL_INFERENCE_DEFAULTS[model]?.reasoningEffort;
}

/**
 * The effort one attempt on `model` is sent with: the caller's, else the
 * model's default. A caller's `none` gives way to the default on a model whose
 * provider refuses it, because one effort applies to every model in a fallback
 * route and a fallback that cannot serve it is no fallback.
 */
export function reasoningEffortFor<Effort extends string>(
  model: string,
  requested: Effort | undefined,
): Effort | ModelReasoningEffort | undefined {
  const defaults = MODEL_INFERENCE_DEFAULTS[model];
  if (requested === "none" && defaults?.reasoningRequired) return defaults.reasoningEffort;
  return requested ?? defaults?.reasoningEffort;
}
