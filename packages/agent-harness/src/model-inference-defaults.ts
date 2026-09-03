export type ModelReasoningEffort = "low" | "medium" | "high";

export interface ModelInferenceDefaults {
  /** Omitted to preserve the provider's own default for this model. */
  readonly reasoningEffort?: ModelReasoningEffort;
}

/**
 * App-wide inference defaults keyed by canonical model id.
 *
 * Absence is deliberate: most models should receive no reasoning field at all,
 * leaving their provider-defined behavior unchanged. A caller's explicit
 * request still overrides the value here.
 */
export const MODEL_INFERENCE_DEFAULTS: Readonly<Record<string, ModelInferenceDefaults>> = {
  "x-ai/grok-4.6": { reasoningEffort: "low" },
  "google/gemini-3.8-flash": { reasoningEffort: "low" },
};

export function modelDefaultReasoningEffort(
  model: string,
): ModelReasoningEffort | undefined {
  return MODEL_INFERENCE_DEFAULTS[model]?.reasoningEffort;
}
