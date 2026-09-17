import { waitUntil } from "cloudflare:workers";
import type { Context } from "hono";
import type { HonoAppEnv } from "../env";

export type WorkDeferral = (promise: Promise<unknown>) => void;

/**
 * Keep background work alive from code that is not handed an execution context.
 *
 * Cloudflare's module-level waitUntil has the same lifetime semantics as
 * ExecutionContext.waitUntil and is available inside services shared by HTTP,
 * Queue, Workflow, and Durable Object entrypoints.
 */
export const runtimeDeferral: WorkDeferral = (promise) => {
  waitUntil(promise);
};

/**
 * Hand a service a way to keep background work alive past its response.
 *
 * A Worker may be torn down as soon as it responds, so an unawaited promise —
 * a notification, a rename — is not guaranteed to finish unless the runtime is
 * told to wait for it. Services take this as an optional constructor argument
 * so the same code runs unchanged where no execution context exists.
 */
export function requestDeferral(c: Context<HonoAppEnv>): WorkDeferral {
  return (promise: Promise<unknown>): void => {
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      // Node-based route tests do not provide a Workers ExecutionContext. The
      // promise is already guarded by the service and may finish normally.
      void promise;
    }
  };
}
