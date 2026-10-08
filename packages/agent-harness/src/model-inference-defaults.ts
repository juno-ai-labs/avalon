export type ModelReasoningEffort = "low" | "medium" | "high";

export interface ModelInferenceDefaults {
  /** Omitted to preserve the provider's own default for this model. */
  readonly reasoningEffort?: ModelReasoningEffort;
  /**
   * The provider refuses `reasoning: { effort: "none" }` for this model
   * ("Reasoning is mandatory for this endpoint"), so a caller's `none` is
   * served at {@link reasoningEffort} instead of failing the attempt.
   */
  readonly reasoningRequired?: true;
}

/**
 * App-wide inference defaults keyed by canonical model id.
 *
 * Absence is deliberate: most models should receive no reasoning field at all,
 * leaving their provider-defined behavior unchanged. A caller's explicit
 * request still overrides the value here.
 */
export const MODEL_INFERENCE_DEFAULTS: Readonly<Record<string, ModelInferenceDefaults>> = {
  "openai/gpt-6.1-sol": { reasoningEffort: "low" },
  "x-ai/grok-4.6": { reasoningEffort: "low", reasoningRequired: true },
  "google/gemini-3.7-flash": { reasoningEffort: "low", reasoningRequired: true },
  "google/gemini-3.8-flash": { reasoningEffort: "low", reasoningRequired: true },
};

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
