import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

import { WorkspaceDO } from "../../src/durable-objects/workspace-do";
import {
  claimWorkspaceResourceObjectRemoval,
  claimWorkspaceResourceSlug,
  listWorkspaceReapableResourceObjects,
  listWorkspaceResourcesAwaitingSlug,
  reapWorkspaceExpiredDraftResources,
  recordWorkspaceResourceObjectCleanupFailure,
  retireWorkspaceResourceObjectStaging,
} from "../../src/durable-objects/workspace-resources-storage";
import {
  WorkspaceExpiredDraftReapRequestSchema,
  WorkspaceResourceObjectFailureRequestSchema,
  WorkspaceResourceObjectRefRequestSchema,
  WorkspaceResourceSlugBacklogRequestSchema,
  WorkspaceResourceSlugClaimRequestSchema,
} from "../../src/durable-objects/workspace-resources-protocol";
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
  environment?: Partial<Env>;
  region?: string;
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
      // A method that writes a sidebar-visible table publishes the list to
      // every subscribed socket afterwards; here there are none to publish to.
      getWebSockets: () => [],
      storage,
    }),
    createTestEnv({
      ...input.environment,
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
  "resolveHostedParent",
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
  // The App Home context and feedback, converted alongside the ingress spine.
  "slackAppContext",
  "storeSlackAppContext",
  "recordSlackFeedback",
  // External conversation bindings: the routing authority Slack ingress asks
  // before it routes a reply.
  "resolveExternalConversation",
  "externalConversationBinding",
  "activateExternalConversationBinding",
  "releaseExternalConversationBinding",
  "latestOutboundExternalConversation",
  "suspendExternalConversationBindings",
  "reactivateExternalConversationBindings",
  "moveExternalConversationBindings",
] as const satisfies readonly (keyof WorkspaceDO)[];

/**
 * The typed resource-maintenance methods, over an existing fixture database.
 *
 * For a suite whose subject still writes `resources` through the D1-shaped
 * port into its own fixture database: a second, real WorkspaceDO could not
 * see those rows, so the maintenance passes run the object's own storage
 * functions over the same database. The SQL and the decisions are
 * production's; only the object shell — input parsing and the identity fence
 * — is out of the loop, and the workerd suite covers that shell.
 */
export function workspaceResourceMaintenanceRpcs(database: DatabaseSync): Record<string, unknown> {
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    transactionSync: <T,>(body: () => T) => body(),
    sql: createTestSqlStorage(database),
  });
  return {
    listReapableResourceObjects: async (input: { workspaceId: string }) =>
      listWorkspaceReapableResourceObjects(storage, input.workspaceId),
    claimResourceObjectRemoval: async (input: unknown) => {
      const request = WorkspaceResourceObjectRefRequestSchema.parse(input);
      return claimWorkspaceResourceObjectRemoval(storage, request.workspaceId, request.objectRef);
    },
    retireResourceObjectStaging: async (input: unknown) => {
      const request = WorkspaceResourceObjectRefRequestSchema.parse(input);
      return retireWorkspaceResourceObjectStaging(storage, request.workspaceId, request.objectRef);
    },
    recordResourceObjectCleanupFailure: async (input: unknown) => {
      recordWorkspaceResourceObjectCleanupFailure(
        storage,
        WorkspaceResourceObjectFailureRequestSchema.parse(input),
      );
    },
    reapExpiredDraftResources: async (input: unknown) => reapWorkspaceExpiredDraftResources(
      storage,
      WorkspaceExpiredDraftReapRequestSchema.parse(input).workspaceId,
    ),
    claimResourceSlug: async (input: unknown) =>
      claimWorkspaceResourceSlug(storage, WorkspaceResourceSlugClaimRequestSchema.parse(input)),
    listResourcesAwaitingSlug: async (input: unknown) => listWorkspaceResourcesAwaitingSlug(
      storage,
      WorkspaceResourceSlugBacklogRequestSchema.parse(input).workspaceId,
    ),
  };
}

/** {@link workspaceResourceMaintenanceRpcs} as a whole WORKSPACE_DOS binding. */
export function workspaceResourceMaintenanceBinding(database: DatabaseSync): Env["WORKSPACE_DOS"] {
  const stub = workspaceResourceMaintenanceRpcs(database);
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return binding;
}

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
  for (const name of new Set<keyof WorkspaceDO>(['readSearchAuthorizationSnapshots', 'registerSearchAuthorization', 'writeSearchAuthorizationSnapshots', 'readAuthorizationSnapshots', 'writeAuthorizationSnapshots', 'authorizationResourceFacts', 'beginAuthorizationBackfill', ...names])) {
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

/**
 * A WORKSPACE_DOS binding for a path that creates the Organization, so its id
 * is not known until the create mints it: a real `WorkspaceDO` is built for
 * each id an `initializeWorkspace` names. Close the returned databases.
 */
export function creatingWorkspaceObjectBinding(regionalDatabase: DatabaseSync): {
  binding: Env["WORKSPACE_DOS"];
  databases: DatabaseSync[];
} {
  const databases: DatabaseSync[] = [];
  const instances = new Map<string, WorkspaceDO>();
  const stub = {
    initializeWorkspace: async (workspaceId: string, placementAffinity: Parameters<WorkspaceDO["initializeWorkspace"]>[1]) => {
      const instance = instances.get(workspaceId)
        ?? createTestWorkspaceDO({ workspaceId, regionalDatabase, register: (database) => databases.push(database) }).instance;
      instances.set(workspaceId, instance);
      await instance.initializeWorkspace(workspaceId, placementAffinity);
    },
  };
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return { binding, databases };
}
