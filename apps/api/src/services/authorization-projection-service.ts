import { hostedConversationParentKind } from '../durable-objects/workstream-object-storage';
import type { Env } from '../env';
import type { AuthorizationProjectionJob } from '../durable-objects/authorization-projection';
import { authorizationWorkspace } from './authorization-service';
import { createIdentityObjectPort } from '../runtime/identity-port';
import { createResourceObjectPort } from '../runtime/resource-port';

/** Reference-only Queue jobs always reload canonical state; old deliveries cannot resurrect links. */
export async function projectAuthorization(env: Env, job: AuthorizationProjectionJob, refreshExisting = true): Promise<void> {
  if (job.region !== env.AVALON_REGION) throw new Error('authorization_projection_region_mismatch');
  const workspace = await authorizationWorkspace(env, job.workspaceId);
  {
    // The Organization object hosts every Canvas and Sidekick parent; one it
    // does not host (a retired Thread) answers no children.
    const request = { workspaceId: job.workspaceId, parentId: job.parentId };
    // The Organization answers a Sidekick's children here too.
    const { substreamIds } = await workspace.listAuthorizationChildren(request);
    if (job.substreamId === undefined || !substreamIds.includes(job.substreamId)) {
      await workspace.registerAuthorizationChildren({ workspaceId: job.workspaceId, parentId: job.parentId,
        substreamIds, ...(job.mutationAt === undefined ? {} : { mutationAt: job.mutationAt }), refreshExisting: job.substreamId === undefined ? refreshExisting : false });
      return;
    }
  }
  const identity = await createIdentityObjectPort(env, job.workspaceId, job.parentId, undefined, job.substreamId).identity();
  if (!identity) throw new Error('authorization_projection_conversation_not_ready');
  const facts = await createResourceObjectPort(env, job.workspaceId, job.parentId, undefined, job.substreamId).readAuthorizationFacts();
  // The stored kind, parsed rather than collapsed: a Thread's or Space's
  // conversation is refused by name (`conversation_parent_kind_retired:<kind>`),
  // never recorded in the authorization universe a search result and a
  // resource grant are decided from.
  const parentKind = hostedConversationParentKind(identity.parent_kind);
  await workspace.applyAuthorizationLocations({ workspaceId: job.workspaceId, parentId: job.parentId, substreamId: job.substreamId,
    ...(job.mutationAt === undefined ? {} : { mutationAt: job.mutationAt }),
    parentKind, ...facts });
}
