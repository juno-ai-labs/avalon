/**
 * Select one model with no fallbacks for a scripted provider. Each scripted
 * reply represents one inference attempt, including a deliberate failure;
 * deployment defaults must not add an attempt that consumes the next reply.
 * Every Durable Object reads the isolate's environment through a proxy, so
 * these overrides apply to constructed objects too. Restore the model and fallback variables
 * after each test so other files retain their own configuration.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach } from "vitest";

export const SELECTED_TEST_MODEL = "double/primary";

export function useSelectedModel(model = SELECTED_TEST_MODEL): void {
  const mutable = env as { OPENROUTER_PRIMARY_MODEL?: string; OPENROUTER_SMARTER_MODEL?: string; OPENROUTER_FALLBACK_MODEL?: string };
  let previousModel: string | undefined;
  let previousSmarterModel: string | undefined;
  let previousFallbacks: string | undefined;
  beforeEach(() => {
    previousModel = mutable.OPENROUTER_PRIMARY_MODEL;
    previousSmarterModel = mutable.OPENROUTER_SMARTER_MODEL;
    previousFallbacks = mutable.OPENROUTER_FALLBACK_MODEL;
    mutable.OPENROUTER_PRIMARY_MODEL = model;
    mutable.OPENROUTER_SMARTER_MODEL = model;
    mutable.OPENROUTER_FALLBACK_MODEL = "";
  });
  afterEach(() => {
    if (previousModel === undefined) delete mutable.OPENROUTER_PRIMARY_MODEL;
    else mutable.OPENROUTER_PRIMARY_MODEL = previousModel;
    if (previousSmarterModel === undefined) delete mutable.OPENROUTER_SMARTER_MODEL;
    else mutable.OPENROUTER_SMARTER_MODEL = previousSmarterModel;
    if (previousFallbacks === undefined) delete mutable.OPENROUTER_FALLBACK_MODEL;
    else mutable.OPENROUTER_FALLBACK_MODEL = previousFallbacks;
  });
}
