/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Every Durable Object class recognizes its own name, on real workerd.
 *
 * The routing decision itself is proved in the Node suite, against a registry
 * built by hand. What that cannot reach is the half that actually decides
 * whether a self-call is caught: that each class *registers* in its constructor,
 * with the binding it answers on and a thunk that derives the name a shared
 * helper would resolve, from identity written to its own storage.
 *
 * The legacy `WorkstreamDO` and `SpaceDO` no longer register: they only export
 * their rows to the Organization object and never call their own names
 * (`docs/hosted-conversation-parents.md`).
 *
 * Those registrations and name derivations were covered only
 * incidentally before, and incidental coverage is exactly what let the product
 * service keep an unregistered environment through the first draft of this
 * change. The product-service case here is the regression test for that: it is not enough
 * that the object holds a registered environment, if the collaborators it builds
 * and keeps do not.
 */
import { env } from "cloudflare:workers";
import type { DurableObject as RpcDurableObject } from "cloudflare:workers";
import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  conversationObjectName,
  workspaceDOName,
} from "../src/durable-objects/names";
import { durableObjectSelfForId } from "../src/lib/durable-object-self";
import {
  seedWorkstreamRoot,
  WORKSPACE_ID,
  WORKSTREAM_ID,
} from "./helpers/substream-fixture";

const OTHER_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000004b1");

/**
 * The internals these tests read on purpose.
 *
 * A registration is private by design — nothing in the product reaches for it,
 * and the resolver is the only reader. Proving the constructor performed it
 * therefore means looking at what the constructor kept, the same way the
 * existing runtime tests reach private methods through a local interface.
 */
interface RegisteredObject {
  env: object;
  product?: { env: object };
}

function internals(instance: object): RegisteredObject {
  return instance as unknown as RegisteredObject;
}

/**
 * Recognition as a caller performs it: derive the id the name resolves to in
 * this binding, then ask whether it is the caller's own.
 *
 * The local test environment resolves without a jurisdiction, so `idFromName`
 * on the binding is the same derivation `durableObjectIdForRegion` makes.
 */
function selfFor<T extends RpcDurableObject | undefined>(
  held: object,
  namespace: DurableObjectNamespace<T>,
  name: string,
): unknown {
  return durableObjectSelfForId(held, namespace, namespace.idFromName(name));
}

beforeEach(async () => {
  await reset();
});

describe("a Durable Object's registration of its own identity", () => {
  it("lets an AgentLoopDO recognize itself before its identity is written", async () => {
    const name = conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(name));

    await runInDurableObject(stub, (instance, state) => {
      const held = internals(instance);
      // Before identity, and this is the case that matters: an object whose
      // durable facts are not written yet is still the object that name
      // resolves to, and a call it makes to that name would land back on it.
      // Recognition reads `state.id`, which it has had since construction, so
      // there is no window where it fails to see that.
      expect(selfFor(held.env, env.SUBSTREAM_AGENTS, name)).not.toBeNull();

      seedWorkstreamRoot(state);

      expect(selfFor(held.env, env.SUBSTREAM_AGENTS, name)).not.toBeNull();
      expect(selfFor(
        held.env,
        env.SUBSTREAM_AGENTS,
        conversationObjectName("global", WORKSPACE_ID, OTHER_WORKSTREAM_ID),
      )).toBeNull();
      expect(selfFor(held.env, env.ARTIFACT_HOSTS, name)).toBeNull();
    });
  });

  it("gives the agent's product service the registered environment too", async () => {
    // The regression test for the first draft of this change, which registered
    // `this.env` and then built this service with the raw constructor argument.
    // The service keeps its environment for the object's whole life and resolves
    // this work stream's own model routing through it, so an unregistered one
    // left that resolution going out through the namespace and back in.
    const name = conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(name));

    await runInDurableObject(stub, (instance, state) => {
      seedWorkstreamRoot(state);
      const product = internals(instance).product;
      expect(product).toBeDefined();
      expect(selfFor(product!.env, env.SUBSTREAM_AGENTS, name)).not.toBeNull();
    });
  });

  it("lets a WorkspaceDO recognize itself once its workspace is initialized", async () => {
    const name = workspaceDOName("global", WORKSPACE_ID);
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(name));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    await runInDurableObject(stub, (instance) => {
      const held = internals(instance);
      expect(selfFor(held.env, env.WORKSPACE_DOS, name)).not.toBeNull();
      expect(selfFor(
        held.env,
        env.WORKSPACE_DOS,
        workspaceDOName("global", asWorkspaceId("00000000-0000-7000-8000-0000000004b3")),
      )).toBeNull();
      expect(selfFor(held.env, env.ARTIFACT_HOSTS, name)).toBeNull();
    });
  });
});
