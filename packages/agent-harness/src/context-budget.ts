/**
 * Conservative context windows for the OpenRouter routes Avalon ships.
 *
 * Values are input+output tokens. We intentionally convert the remaining input
 * allowance to bytes at one byte per token. Byte-level tokenizers cannot
 * produce more tokens than input bytes, so this can under-use a model window
 * but cannot overrun it because of optimistic character/token heuristics.
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  "x-ai/grok-4.3": 1_000_000,
  "google/gemini-2.5-flash-lite": 1_048_576,
  "google/gemini-2.5-pro": 1_048_576,
  "anthropic/claude-sonnet-4.5": 200_000,
});

export type ModelContextBudget = {
  model: string;
  configuredMaxBytes: number;
  contextWindowTokens: number | null;
  reservedRunTokens: number;
  modelInputMaxBytes: number | null;
  effectiveMaxBytes: number;
};

export function resolveModelContextWindowTokens(
  model: string,
  overrides: Readonly<Record<string, number>> = {},
): number | null {
  const configured = overrides[model] ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS[model];
  if (configured === undefined) return null;
  const tokens = Math.trunc(configured);
  return Number.isFinite(configured) && tokens > 0 ? tokens : null;
}

export function modelContextBudget(input: {
  model: string;
  configuredMaxBytes: number;
  maxRunTokens?: number;
  modelContextWindowTokens?: Readonly<Record<string, number>>;
}): ModelContextBudget {
  const configuredMaxBytes = Math.trunc(input.configuredMaxBytes);
  if (!Number.isFinite(input.configuredMaxBytes) || configuredMaxBytes < 1) {
    return {
      model: input.model,
      configuredMaxBytes,
      contextWindowTokens: null,
      reservedRunTokens: 0,
      modelInputMaxBytes: null,
      effectiveMaxBytes: 0,
    };
  }

  const contextWindowTokens = resolveModelContextWindowTokens(
    input.model,
    input.modelContextWindowTokens,
  );
  if (contextWindowTokens === null) {
    return {
      model: input.model,
      configuredMaxBytes,
      contextWindowTokens: null,
      reservedRunTokens: 0,
      modelInputMaxBytes: null,
      effectiveMaxBytes: configuredMaxBytes,
    };
  }

  const requestedRunTokens = Math.max(0, Math.trunc(input.maxRunTokens ?? 0));
  const reservedRunTokens = Math.min(requestedRunTokens, Math.max(0, contextWindowTokens - 1));
  // One byte per available input token is deliberately conservative. The
  // exact JSON request is measured later; no prompt or JSON value is sliced.
  const modelInputMaxBytes = Math.max(1, contextWindowTokens - reservedRunTokens);
  return {
    model: input.model,
    configuredMaxBytes,
    contextWindowTokens,
    reservedRunTokens,
    modelInputMaxBytes,
    effectiveMaxBytes: Math.min(configuredMaxBytes, modelInputMaxBytes),
  };
}
