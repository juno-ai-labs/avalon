/**
 * Give every run in a file a selected model, so a loop can reach the provider
 * double instead of dying on an empty route plan.
 *
 * `wrangler.test.jsonc` deliberately leaves `OPENROUTER_PRIMARY_MODEL` unset so
 * a test that never meant to reach inference cannot. A file that installs
 * `useOpenRouterDouble` does mean to, and needs a model name for the harness to
 * route on; the double answers whatever name it is given. The Worker's `env`
 * is one object for the whole isolate and every Durable Object reads it
 * through a proxy, so setting the variable here is what a constructed object
 * sees. Cleared after each test so the next file starts as configured.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach } from "vitest";

export const SELECTED_TEST_MODEL = "double/primary";

export function useSelectedModel(model = SELECTED_TEST_MODEL): void {
  const mutable = env as { OPENROUTER_PRIMARY_MODEL?: string };
  beforeEach(() => {
    mutable.OPENROUTER_PRIMARY_MODEL = model;
  });
  afterEach(() => {
    delete mutable.OPENROUTER_PRIMARY_MODEL;
  });
}
