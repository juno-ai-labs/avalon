import { runInDurableObject } from "cloudflare:test";
import { asWorkspaceId } from "@rally/contracts";
import type { Env } from "../../src/env";
import type { HostedParent } from "../../src/durable-objects/hosted-parent";
import { workspaceDOName } from "../../src/durable-objects/names";

/**
 * The Organization object that hosts every Channel and Space parent in a
 * workspace. A test that used to address a `WorkstreamDO` or `SpaceDO` stub
 * addresses this one with the same method names.
 */
export function hostedParentStub(env: Env, workspaceId: string, region: string = "global") {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(region, asWorkspaceId(workspaceId))));
}

/**
 * Runs `fn` inside the Organization object with the hosted parent for
 * `parentId`, for a test that reads or drives the parent's internals directly.
 * Every parent row is keyed by `parent_id`; filter by it.
 */
export async function withHostedParent<T>(
  stub: DurableObjectStub,
  parentId: string,
  fn: (parent: HostedParent, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, async (instance, state) => {
    const host = instance as unknown as { hostedParent(parentId: string): Promise<HostedParent> };
    return fn(await host.hostedParent(parentId), state);
  });
}
