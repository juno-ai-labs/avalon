import type { Context } from "hono";
import type { HonoAppEnv } from "../env";

/**
 * Hand a service a way to keep background work alive past its response.
 *
 * A Worker may be torn down as soon as it responds, so an unawaited promise —
 * a notification, a rename — is not guaranteed to finish unless the runtime is
 * told to wait for it. Services take this as an optional constructor argument
 * so the same code runs unchanged where no execution context exists.
 */
export function requestDeferral(c: Context<HonoAppEnv>): (promise: Promise<unknown>) => void {
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
