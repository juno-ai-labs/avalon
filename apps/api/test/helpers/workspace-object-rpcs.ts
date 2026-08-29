import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

import { WorkspaceDO } from "../../src/durable-objects/workspace-do";
import type { Env } from "../../src/env";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./cloudflare-test";
import { createTestSqlStorage } from "./sql-storage";
import { sqliteD1 } from "./sqlite-d1";

/**
 * A real `WorkspaceDO`, over a real object-schema database, for a Node test.
 *
 * As the facade gives way to typed methods, a Node suite that used to reach
 * WorkspaceDO tables through a D1-shaped port now calls methods on a stub —
 * and a stub can answer anything. Re-implementing a method in the fixture
 * moves the behaviour under test into the test, where its bugs are the test's
 * own and the object is free to drift from it.
 *
 * So this stands up the object itself: its real schema from its own migration
 * ledger, its real SQL, its real identity fences. Only the transport is
 * doubled, which is the one thing a Node suite genuinely cannot run.
 *
 * `transactionSync` runs the body directly rather than in a transaction —
 * `node:sqlite` has no nested-savepoint equivalent of what workerd gives the
 * object, and every other storage double in this directory does the same. A
 * test that turns on a transaction *rolling back* belongs in
 * `apps/api/test-workers/`, against the real runtime.
 */
export function createTestWorkspaceDO(input: {
  workspaceId: string;
  /** The regional database the object's own D1 reads should see. */
  regionalDatabase: DatabaseSync;
  region?: "global" | "eu";
  /** Registered so the caller can close it with its other databases. */
  register?: (database: DatabaseSync) => void;
}): { instance: WorkspaceDO; objectDatabase: DatabaseSync } {
  const objectDatabase = new DatabaseSync(":memory:");
  input.register?.(objectDatabase);
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    transactionSync: <T,>(body: () => T) => body(),
    sql: createTestSqlStorage(objectDatabase),
  });
  // The constructor registers the runtime-only websocket auto-response pair.
  vi.stubGlobal("WebSocketRequestResponsePair", class {
    constructor(readonly request: string, readonly response: string) {}
  });
  const instance = new WorkspaceDO(
    createCloudflareTestBinding<DurableObjectState>({
      id: createTestDurableObjectId("workspace-do"),
      blockConcurrencyWhile: async <T,>(body: () => Promise<T>) => body(),
      setWebSocketAutoResponse: () => undefined,
      waitUntil: () => undefined,
      storage,
    }),
    createTestEnv({
      DB: sqliteD1(input.regionalDatabase),
      AVALON_REGION: input.region ?? "global",
      APP_ENV: "test",
    }),
  );
  // The identity row is what `assertWorkspace` reads, so a method called on
  // this object refuses another workspace's id exactly as production does.
  objectDatabase.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, ?, 'wnam', 0, 0)`,
  ).run(input.workspaceId, input.region ?? "global");
  return { instance, objectDatabase };
}

/**
 * The object surface a Slack ingress flow reaches on `WORKSPACE_DOS`.
 *
 * The typed Slack methods plus `executeRuntimeSql`, because the flows under
 * test mix both: a thread claim is a typed call while the session row beside
 * it is still a facade statement, and serving the two from different stores
 * would split one workspace's state across two databases mid-test. Listing
 * the port here keeps every WorkspaceDO-authority table in the object's own
 * database, which is where production has them.
 */
export const SLACK_WORKSPACE_OBJECT_METHODS = [
  "executeRuntimeSql",
  // Read on the way into every activity-shaped event; a fresh object answers
  // "inactive", which is the stubbed `false` these suites used to hand-write.
  "hasActiveExternalEventRegistration",
  "enqueueSlackIngressJob",
  "claimSlackIngressJob",
  "completeSlackIngressJob",
  "failSlackIngressJob",
  "recoverableSlackIngressJobs",
  "sweepSlackIngress",
  "slackThreadRoutable",
  "pendingSlackPrompt",
  "rememberSlackPendingPrompt",
  "clearSlackPendingPrompt",
  "claimSlackThread",
  "releaseSlackThreadClaim",
] as const satisfies readonly (keyof WorkspaceDO)[];

/**
 * Expose named methods of a real `WorkspaceDO` as stub RPCs.
 *
 * Pass the result as `extra` to `testSubstreamAgentsBinding` so a service under
 * test reaches the real implementation while everything else on that binding
 * keeps its existing store.
 */
export function workspaceObjectRpcs<Name extends keyof WorkspaceDO>(
  instance: WorkspaceDO,
  names: readonly Name[],
): Record<string, unknown> {
  const rpcs: Record<string, unknown> = {};
  for (const name of names) {
    const method = instance[name];
    if (typeof method !== "function") throw new Error(`workspace_object_rpc_missing:${String(name)}`);
    rpcs[String(name)] = (...args: unknown[]) =>
      (method as (...called: unknown[]) => unknown).apply(instance, args);
  }
  return rpcs;
}

/** Convenience for a service that only needs the workspace binding. */
export function testWorkspaceObjectBinding(
  instance: WorkspaceDO,
  names: readonly (keyof WorkspaceDO)[],
): Env["WORKSPACE_DOS"] {
  const stub = workspaceObjectRpcs(instance, names);
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return binding;
}
