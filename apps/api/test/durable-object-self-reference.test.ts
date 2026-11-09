/**
 * A Durable Object must not address itself through its own namespace.
 *
 * These run in the Node suite rather than `test-workers/` on purpose: what is
 * under test is a routing decision made in plain JavaScript — does this name,
 * under this binding, belong to the object that is asking — and workerd decides
 * none of it. What the objects then do is proved where it already was, against
 * real Durable Objects.
 */
import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { conversationObjectName } from "../src/durable-objects/names";
import {
  substreamSelfObjectName,
  type AgentLoopDO,
} from "../src/durable-objects/agent-loop-do";
import type { Env } from "../src/env";
import {
  durableObjectStubForRegion,
  durableObjectStubForWorkspace,
} from "../src/lib/durable-object-namespace";
import { durableObjectSelfForId, withDurableObjectSelf } from "../src/lib/durable-object-self";
import { publishWorkstreamEvent } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
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
const OWN_NAME = conversationObjectName(
  "global",
  asWorkspaceId(WORKSPACE),
  asWorkstreamId(WORKSTREAM),
);
const SIBLING_NAME = conversationObjectName(
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
  const get = vi.fn((): object => resolved);
  // `jurisdiction` answers the same binding so a production environment routes
  // the way it does in staging and production without a second double.
  const namespace: Env["SUBSTREAM_AGENTS"] = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
    idFromName,
    get,
    jurisdiction: vi.fn(() => namespace),
  });
  return { namespace, idFromName, get, resolved };
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
  return createTestDurableObjectInstance<AgentLoopDO>({
    publishEvent: async (input: unknown) => {
      published.push(input);
      return { status: 202, body: "{}" };
    },
  });
}

function selfEnv(
  instance: AgentLoopDO,
  namespace: Env["SUBSTREAM_AGENTS"],
  name: string | null,
  /**
   * The name this object's id was derived from, when that is not the name it
   * answers to.
   *
   * The two come apart in exactly one state, and it is the interesting one: an
   * object whose identity is not yet durably its own has a real id and no name.
   */
  idName: string = name ?? "unnamed",
  /** `production` is what separates the fatal path from the logged one. */
  appEnv: "test" | "production" = "test",
): Env {
  return withDurableObjectSelf(
    createTestEnv({
      APP_ENV: appEnv,
      AVALON_REGION: "global",
      DB: affinityDatabase(),
      SUBSTREAM_AGENTS: namespace,
    }),
    {
      namespace,
      name: () => name,
      id: createTestDurableObjectId(idName),
      instance,
    },
  );
}

describe("a Durable Object addressing its own name", () => {
  it("reaches the object itself instead of resolving through the namespace", async () => {
    const published: unknown[] = [];
    const { namespace, get } = trackedNamespace();
    const env = selfEnv(testAgent(published), namespace, OWN_NAME);

    const stub = await durableObjectStubForWorkspace(env, namespace, WORKSPACE, OWN_NAME);
    const result = await stub.publishEvent({
      workspaceId: asWorkspaceId(WORKSPACE),
      workstreamId: asWorkstreamId(WORKSTREAM),
      event: { type: "message_created" },
    });

    // Deriving the id is expected — that is how the caller recognizes itself.
    // Fetching a stub from the namespace is what must not happen.
    expect(get).not.toHaveBeenCalled();
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
    const otherBinding = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: otherIdFromName,
      get: vi.fn((): object => other),
    });
    const env = selfEnv(testAgent([]), namespace, OWN_NAME);

    const stub = await durableObjectStubForWorkspace(env, otherBinding, WORKSPACE, OWN_NAME);

    expect(stub).toBe(other);
    expect(otherIdFromName).toHaveBeenCalledWith(OWN_NAME);
  });

  it("reaches itself even while it cannot say what it is called", async () => {
    // The incident's state, and the reason recognition moved off the name: the
    // object holds a registration and answers `null` for its own name, which
    // used to send every call to that name out through the namespace and back
    // into this object. The id it would resolve to is known either way.
    const published: unknown[] = [];
    const { namespace, resolved } = trackedNamespace();
    const env = selfEnv(testAgent(published), namespace, null, OWN_NAME);

    const stub = await durableObjectStubForWorkspace(env, namespace, WORKSPACE, OWN_NAME);
    await stub.publishEvent({
      workspaceId: asWorkspaceId(WORKSPACE),
      workstreamId: asWorkstreamId(WORKSTREAM),
      event: { type: "message_created" },
    });

    expect(stub).not.toBe(resolved);
    expect(published).toHaveLength(1);
  });

  it("refuses to match an omitted binding against another omitted binding", async () => {
    // A focused unit environment may bind neither namespace, the same allowance
    // `withWorkspaceRuntimeDatabase` makes. Both then read `undefined`, and an
    // identity comparison alone would call them equal — leaving the name as the
    // only discriminator, which is the one that is not sufficient.
    const bare = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      DB: affinityDatabase(),
    });
    const env = withDurableObjectSelf(bare, {
      namespace: bare.SUBSTREAM_AGENTS,
      name: () => OWN_NAME,
      id: createTestDurableObjectId(OWN_NAME),
      instance: testAgent([]),
    });

    expect(durableObjectSelfForId(
      env,
      bare.WORKSPACE_DOS,
      createTestDurableObjectId(OWN_NAME),
    )).toBeNull();
  });

  it("keeps a shared helper local when it publishes for the object's own work stream", async () => {
    const published: unknown[] = [];
    const { namespace, get } = trackedNamespace();
    const env = selfEnv(testAgent(published), namespace, OWN_NAME);

    const delivered = await publishWorkstreamEvent(env, WORKSPACE, WORKSTREAM, {
      type: "workstream_renamed",
      title: "A new name",
    });

    expect(delivered).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
  });
});

describe("a local workspace SQL executor carried on the environment", () => {
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

describe("the name an AgentLoopDO answers to", () => {
  const identity = {
    workspaceId: asWorkspaceId(WORKSPACE),
    parentKind: "workstream" as const,
    parentId: asWorkstreamId(WORKSTREAM),
  };

  it("is the object's own name once both durable facts are recorded", () => {
    expect(substreamSelfObjectName("global", identity, "0")).toBe(OWN_NAME);
  });

  it("is withheld while the object has no work stream yet", () => {
    expect(substreamSelfObjectName("global", null, "0")).toBeNull();
  });

  it("is withheld while the external substream id is unwritten", () => {
    // Not the main child's name: an object holding only a root identity would
    // otherwise answer self-calls addressed to substream 0 out of its own
    // storage. `externalSubstreamId`'s "0" default is right as an *am I the
    // main child?* predicate and wrong as a name, which is why this takes the
    // raw row rather than that helper.
    expect(substreamSelfObjectName("global", identity, null)).toBeNull();
  });

  it("names a non-main substream as its own object", () => {
    const second = "55555555-5555-4555-8555-555555555555";
    expect(substreamSelfObjectName("global", identity, second)).toBe(`${OWN_NAME}:${second}`);
  });
});

/**
 * The backstop, now that routing cannot produce a self-address on its own.
 *
 * Every resolver answers the caller's own id locally, so what is left to catch
 * is a caller that skipped them: `durableObjectStubForRegion` is the one
 * sanctioned way to reach a namespace — `durable-object-region-routing` rejects
 * the rest — so it is where the refusal lives. Development and test throw,
 * because a failing test is the cheapest version of this news; staging and
 * production log at error and hand back the stub, because refusing there would
 * turn a latent defect into an outage.
 */
describe("a caller that reaches a namespace for its own object", () => {
  it("is refused outright in development and test", () => {
    const { namespace } = trackedNamespace();
    const env = selfEnv(testAgent([]), namespace, OWN_NAME);

    expect(() => durableObjectStubForRegion(env, namespace, "global", OWN_NAME, "wnam"))
      .toThrow("durable_object_self_addressed_over_rpc:region:" + OWN_NAME);
  });

  it("logs an error and continues in production", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { namespace, resolved } = trackedNamespace();
      const env = selfEnv(testAgent([]), namespace, null, OWN_NAME, "production");

      expect(durableObjectStubForRegion(env, namespace, "global", OWN_NAME, "wnam"))
        .toBe(resolved);
      expect(error.mock.calls.map(([entry]) => entry)).toEqual([expect.objectContaining({
        level: "error",
        event: "durable_object_self_addressed_over_rpc",
        resolver: "region",
        requested_name: OWN_NAME,
        // The object could not name itself. That no longer decides anything —
        // the id did — but it still separates an object mid-initialization from
        // one whose registration never reached the environment.
        self_name: null,
      })]);
    } finally {
      error.mockRestore();
    }
  });

  it("says nothing for a sibling of the same class", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { namespace, resolved } = trackedNamespace();
      const env = selfEnv(testAgent([]), namespace, OWN_NAME);

      expect(durableObjectStubForRegion(env, namespace, "global", SIBLING_NAME, "wnam"))
        .toBe(resolved);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("says nothing for the same name under a different binding", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const other = {};
      const { namespace } = trackedNamespace();
      const otherBinding = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
        idFromName: vi.fn((name: string) => createTestDurableObjectId(name)),
        get: vi.fn((): object => other),
      });
      const env = selfEnv(testAgent([]), namespace, OWN_NAME);

      expect(durableObjectStubForRegion(env, otherBinding, "global", OWN_NAME, "wnam"))
        .toBe(other);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
