/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";

import type { Env } from "../../src/env";

/**
 * The Organization namespace, recording each method a caller invokes on a
 * stub it hands out. The object itself is real; only the calling side is
 * observed, which is where a round trip is spent.
 */
export function countingNamespace(calls: string[]): Env["WORKSPACE_DOS"] {
  const namespace = env.WORKSPACE_DOS;
  return new Proxy(namespace, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property !== "get" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: Parameters<typeof namespace.get>) => {
        const stub = namespace.get(...args);
        return new Proxy(stub, {
          get: (stubTarget, method) => {
            const member: unknown = Reflect.get(stubTarget, method);
            if (typeof method !== "string" || typeof member !== "function") return member;
            // Called through the stub rather than `apply`d: an RPC method is
            // itself a stub, and would take `apply` for a remote method name.
            const rpc = stubTarget as unknown as Record<string, (...values: unknown[]) => unknown>;
            return (...input: unknown[]) => {
              calls.push(method);
              return rpc[method]!(...input);
            };
          },
        });
      };
    },
  });
}

/** `env` with its Organization namespace counted into `calls`. */
export function countingEnv(calls: string[], base: Env = env): Env {
  return new Proxy(base, {
    get: (current, property, receiver) => property === "WORKSPACE_DOS"
      ? countingNamespace(calls)
      : Reflect.get(current, property, receiver),
  });
}
