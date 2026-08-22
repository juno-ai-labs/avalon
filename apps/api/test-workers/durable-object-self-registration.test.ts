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
 * Those four registrations and four name derivations were covered only
 * incidentally before, and incidental coverage is exactly what let the product
 * service keep an unregistered environment through the first draft of this
 * change. The last case here is the regression test for that: it is not enough
 * that the object holds a registered environment, if the collaborators it builds
 * and keeps do not.
 */
import { env } from "cloudflare:workers";
import { asBlockId, asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  blockDashboardAgentName,
  substreamAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import { durableObjectSelf } from "../src/lib/durable-object-self";
import {
  seedWorkstreamRoot,
  WORKSPACE_ID,
  WORKSTREAM_ID,
} from "./helpers/substream-fixture";

const OTHER_WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000004b1");
const BLOCK_ID = asBlockId("00000000-0000-7000-8000-0000000004b2");

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

beforeEach(async () => {
  await reset();
});

describe("a Durable Object's registration of its own name", () => {
  it("lets a SubstreamAgent recognize itself once its identity is written", async () => {
    const name = substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(name));

    await runInDurableObject(stub, (instance, state) => {
      const held = internals(instance);
      // Before identity: nothing may address this object by name, so the
      // registration must decline rather than guess at one.
      expect(durableObjectSelf(held.env, env.SUBSTREAM_AGENTS, name)).toBeNull();

      seedWorkstreamRoot(state);

      expect(durableObjectSelf(held.env, env.SUBSTREAM_AGENTS, name)).not.toBeNull();
      expect(durableObjectSelf(
        held.env,
        env.SUBSTREAM_AGENTS,
        substreamAgentName("global", WORKSPACE_ID, OTHER_WORKSTREAM_ID),
      )).toBeNull();
      expect(durableObjectSelf(held.env, env.WORKSTREAM_DOS, name)).toBeNull();
    });
  });

  it("gives the agent's product service the registered environment too", async () => {
    // The regression test for the first draft of this change, which registered
    // `this.env` and then built this service with the raw constructor argument.
    // The service keeps its environment for the object's whole life and resolves
    // this work stream's own model routing through it, so an unregistered one
    // left that resolution going out through the namespace and back in.
    const name = substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(name));

    await runInDurableObject(stub, (instance, state) => {
      seedWorkstreamRoot(state);
      const product = internals(instance).product;
      expect(product).toBeDefined();
      expect(durableObjectSelf(product!.env, env.SUBSTREAM_AGENTS, name)).not.toBeNull();
    });
  });

  it("lets a WorkspaceDO recognize itself once its workspace is initialized", async () => {
    const name = workspaceDOName("global", WORKSPACE_ID);
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(name));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    await runInDurableObject(stub, (instance) => {
      const held = internals(instance);
      expect(durableObjectSelf(held.env, env.WORKSPACE_DOS, name)).not.toBeNull();
      expect(durableObjectSelf(
        held.env,
        env.WORKSPACE_DOS,
        workspaceDOName("global", asWorkspaceId("00000000-0000-7000-8000-0000000004b3")),
      )).toBeNull();
      expect(durableObjectSelf(held.env, env.WORKSTREAM_DOS, name)).toBeNull();
    });
  });

  it("lets a WorkstreamDO recognize itself once its metadata exists", async () => {
    const name = workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID);
    const stub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(name));
    await stub.fetch("https://workstream.test/health");

    await runInDurableObject(stub, (instance, state) => {
      const held = internals(instance);
      expect(durableObjectSelf(held.env, env.WORKSTREAM_DOS, name)).toBeNull();

      state.storage.sql.exec(
        `INSERT INTO workstream_metadata
           (id, workspace_id, workstream_id, region, authority_generation, title,
            description, preview, scope, exact_state, last_activity_at,
            created_at, updated_at)
         VALUES (1, ?, ?, 'global', 1, 'Fixture', '', '', 'workspace', 'idle', 1, 1, 1)`,
        WORKSPACE_ID,
        WORKSTREAM_ID,
      );

      expect(durableObjectSelf(held.env, env.WORKSTREAM_DOS, name)).not.toBeNull();
      expect(durableObjectSelf(
        held.env,
        env.WORKSTREAM_DOS,
        workstreamDOName("global", WORKSPACE_ID, OTHER_WORKSTREAM_ID),
      )).toBeNull();
      expect(durableObjectSelf(held.env, env.SUBSTREAM_AGENTS, name)).toBeNull();
    });
  });

  it("lets a BlockDashboardAgent recognize itself once its block identity is written", async () => {
    const name = blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, BLOCK_ID);
    const stub = env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(name));
    await stub.fetch("https://block-dashboard.test/health");

    await runInDurableObject(stub, (instance, state) => {
      const held = internals(instance);
      expect(durableObjectSelf(held.env, env.BLOCK_DASHBOARD_AGENTS, name)).toBeNull();

      state.storage.sql.exec(
        `INSERT INTO block_dashboard_block_identity
           (id, workspace_id, workstream_id, block_id, region, created_at)
         VALUES (1, ?, ?, ?, 'global', 1)`,
        WORKSPACE_ID,
        WORKSTREAM_ID,
        BLOCK_ID,
      );

      expect(durableObjectSelf(held.env, env.BLOCK_DASHBOARD_AGENTS, name)).not.toBeNull();
      expect(durableObjectSelf(held.env, env.WORKSTREAM_DOS, name)).toBeNull();
    });
  });
});
