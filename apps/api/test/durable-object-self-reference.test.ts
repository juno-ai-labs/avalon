/**
 * A Durable Object must not address itself through its own namespace.
 *
 * These run in the Node suite rather than `test-workers/` on purpose: what is
 * under test is a routing decision made in plain JavaScript — does this name,
 * under this binding, belong to the object that is asking — and workerd decides
 * none of it. What the objects then do is proved where it already was, against
 * real Durable Objects.
 */
import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { describe, expect, it, vi } from "vitest";

import { substreamAgentName } from "../src/durable-objects/names";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import type { Env } from "../src/env";
import { durableObjectStubForWorkspace } from "../src/lib/durable-object-namespace";
import { withDurableObjectSelf } from "../src/lib/durable-object-self";
import { publishWorkstreamEvent } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestDurableObjectInstance,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const WORKSTREAM = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSTREAM = "33333333-3333-4333-8333-333333333333";
const OTHER_WORKSPACE = "44444444-4444-4444-8444-444444444444";
/** Built the way the agent builds it, so the test cannot drift from the code. */
const OWN_NAME = substreamAgentName(
  "global",
  asWorkspaceId(WORKSPACE),
  asWorkstreamId(WORKSTREAM),
);
const SIBLING_NAME = substreamAgentName(
  "global",
  asWorkspaceId(WORKSPACE),
  asWorkstreamId(OTHER_WORKSTREAM),
);

/**
 * A binding that records every name resolved through it.
 *
 * That recording is the assertion: a self-call that still leaves the object
 * shows up here as a namespace lookup rather than as a wrong answer, because
 * the round trip reaches the same object and produces the same result.
 */
function trackedNamespace(resolved: object = {}) {
  const idFromName = vi.fn((name: string) => createTestDurableObjectId(name));
  const namespace = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
    idFromName,
    get: vi.fn((): object => resolved),
  });
  return { namespace, idFromName, resolved };
}

function affinityDatabase(): D1Database {
  const statement: D1PreparedStatement = createTestD1PreparedStatement({
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({ placement_affinity: "wnam" })),
  });
  return createTestD1Database({ prepare: vi.fn(() => statement) });
}

/**
 * The smallest agent the resolver has to hand back.
 *
 * `publishEvent` is the method every path in finding 2 of the audit ends on, and
 * pushing onto a captured array proves the call reached this object rather than
 * a namespace stub that happens to answer the same way.
 */
function testAgent(published: unknown[]) {
  return createTestDurableObjectInstance<SubstreamAgent>({
    publishEvent: async (input: unknown) => {
      published.push(input);
      return { status: 202, body: "{}" };
    },
  });
}

function selfEnv(
  instance: SubstreamAgent,
  namespace: Env["SUBSTREAM_AGENTS"],
  name: string | null,
): Env {
  return withDurableObjectSelf(
    createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      DB: affinityDatabase(),
      SUBSTREAM_AGENTS: namespace,
    }),
    {
      namespace,
      name: () => name,
      id: createTestDurableObjectId(name ?? "unnamed"),
      instance,
    },
  );
}

describe("a Durable Object addressing its own name", () => {
  it("reaches the object itself instead of resolving through the namespace", async () => {
    const published: unknown[] = [];
    const { namespace, idFromName } = trackedNamespace();
    const env = selfEnv(testAgent(published), namespace, OWN_NAME);

    const stub = await durableObjectStubForWorkspace(env, namespace, WORKSPACE, OWN_NAME);
    const result = await stub.publishEvent({
      workspaceId: asWorkspaceId(WORKSPACE),
      workstreamId: asWorkstreamId(WORKSTREAM),
      event: { type: "message_created" },
    });

    expect(idFromName).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 202, body: "{}" });
    expect(published).toHaveLength(1);
  });

  it("answers id and name so it is a complete stand-in for the stub", async () => {
    const { namespace } = trackedNamespace();
    const env = selfEnv(testAgent([]), namespace, OWN_NAME);

    const stub = await durableObjectStubForWorkspace(env, namespace, WORKSPACE, OWN_NAME);

    expect(stub.name).toBe(OWN_NAME);
    expect(stub.id.toString()).toBe(createTestDurableObjectId(OWN_NAME).toString());
  });

  it("still resolves a sibling of the same class through the namespace", async () => {
    const { namespace, idFromName, resolved } = trackedNamespace();
    const env = selfEnv(testAgent([]), namespace, OWN_NAME);

    const stub = await durableObjectStubForWorkspace(env, namespace, WORKSPACE, SIBLING_NAME);

    expect(stub).toBe(resolved);
    expect(idFromName).toHaveBeenCalledWith(SIBLING_NAME);
  });

  it("still resolves the same name under a different binding through the namespace", async () => {
    const other = {};
    const { namespace } = trackedNamespace();
    const otherIdFromName = vi.fn((name: string) => createTestDurableObjectId(name));
    const otherBinding = createCloudflareTestBinding<Env["WORKSTREAM_DOS"]>({
      idFromName: otherIdFromName,
      get: vi.fn((): object => other),
    });
    const env = selfEnv(testAgent([]), namespace, OWN_NAME);

    const stub = await durableObjectStubForWorkspace(env, otherBinding, WORKSPACE, OWN_NAME);

    expect(stub).toBe(other);
    expect(otherIdFromName).toHaveBeenCalledWith(OWN_NAME);
  });

  it("resolves through the namespace until the object knows its own identity", async () => {
    const { namespace, idFromName, resolved } = trackedNamespace();
    const env = selfEnv(testAgent([]), namespace, null);

    expect(await durableObjectStubForWorkspace(env, namespace, WORKSPACE, OWN_NAME)).toBe(resolved);
    expect(idFromName).toHaveBeenCalledWith(OWN_NAME);
  });

  it("keeps a shared helper local when it publishes for the object's own work stream", async () => {
    const published: unknown[] = [];
    const { namespace, idFromName } = trackedNamespace();
    const env = selfEnv(testAgent(published), namespace, OWN_NAME);

    const delivered = await publishWorkstreamEvent(env, WORKSPACE, WORKSTREAM, {
      type: "workstream_renamed",
      title: "A new name",
    });

    expect(delivered).toBe(true);
    expect(idFromName).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
  });
});

describe("a local SQL executor carried on the environment", () => {
  function executorEnv(): Env {
    return createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      DB: affinityDatabase(),
      SUBSTREAM_AGENTS: trackedNamespace().namespace,
      WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
        idFromName: vi.fn((name: string) => createTestDurableObjectId(name)),
        get: vi.fn((): object => ({})),
      }),
    });
  }

  it("survives a work-stream environment being derived a second time", async () => {
    const executor = vi.fn(async () => [{ columns: ["one"], rows: [{ one: 1 }], changes: 0 }]);
    const owned = withWorkstreamRuntimeDatabase(
      executorEnv(),
      WORKSPACE,
      WORKSTREAM,
      "0",
      executor,
    );

    // What `launchWorkstreamHarness`, the flag-targeting loader, and digest
    // settlement each do with an environment the agent handed them.
    const rederived = withWorkstreamRuntimeDatabase(owned, WORKSPACE, WORKSTREAM);
    await rederived.DB.prepare("SELECT one FROM messages").first();

    expect(executor).toHaveBeenCalledOnce();
  });

  it("does not lend one work stream's executor to another", async () => {
    const executor = vi.fn(async () => [{ columns: [], rows: [], changes: 0 }]);
    const owned = withWorkstreamRuntimeDatabase(
      executorEnv(),
      WORKSPACE,
      WORKSTREAM,
      "0",
      executor,
    );

    const other = withWorkstreamRuntimeDatabase(owned, WORKSPACE, OTHER_WORKSTREAM);
    await other.DB.prepare("SELECT one FROM messages").first().catch(() => undefined);

    expect(executor).not.toHaveBeenCalled();
  });

  it("survives a workspace environment being derived a second time", async () => {
    const executor = vi.fn(async () => [{ columns: ["one"], rows: [{ one: 1 }], changes: 0 }]);
    const owned = withWorkspaceRuntimeDatabase(executorEnv(), WORKSPACE, executor);

    const rederived = withWorkspaceRuntimeDatabase(owned, WORKSPACE);
    await rederived.DB.prepare("SELECT id FROM connector_connections").first();

    expect(executor).toHaveBeenCalledOnce();
  });

  it("does not lend one workspace's executor to another", async () => {
    const executor = vi.fn(async () => [{ columns: [], rows: [], changes: 0 }]);
    const owned = withWorkspaceRuntimeDatabase(executorEnv(), WORKSPACE, executor);

    const other = withWorkspaceRuntimeDatabase(owned, OTHER_WORKSPACE);
    await other.DB.prepare("SELECT id FROM connector_connections").first().catch(() => undefined);

    expect(executor).not.toHaveBeenCalled();
  });
});
