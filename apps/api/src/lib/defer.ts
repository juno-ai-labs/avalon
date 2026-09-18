import { waitUntil } from "cloudflare:workers";
import type { Context } from "hono";
import type { HonoAppEnv } from "../env";

export type WorkDeferral = (promise: Promise<unknown>) => void;

/**
 * Keep background work alive from code that is not handed an execution context.
 *
 * In a Worker invocation, Cloudflare's module-level waitUntil has the same
 * lifetime semantics as ExecutionContext.waitUntil. Durable Objects already
 * remain active while asynchronous I/O is pending, so the runtime accepts this
 * call there without adding a second lifetime mechanism.
 */
export const runtimeDeferral: WorkDeferral = (promise) => {
  try {
    waitUntil(promise);
  } catch {
    // A Node host or a call made outside a Workers invocation has no runtime
    // lifecycle to extend. The work has already started; observe its rejection
    // so the fallback cannot create an unrelated unhandled-rejection failure.
    void promise.catch(() => undefined);
  }
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
      // promise has already started; observe failure even when the service did
      // not attach its own operational logger.
      void promise.catch(() => undefined);
    }
  };
}
