import { asAutomationId, asWorkstreamId } from '@rally/contracts';
import type { Env } from '../env';
import type { AuthorizationProjectionJob } from '../durable-objects/authorization-projection';
import { authorizationWorkspace } from './authorization-service';
import { durableObjectStubForWorkspace } from '../lib/durable-object-namespace';
import { automationDOName, workstreamDOName } from '../durable-objects/names';
import { createIdentityObjectPort } from '../runtime/identity-port';
import { createResourceObjectPort } from '../runtime/resource-port';

/** Reference-only Queue jobs always reload canonical state; old deliveries cannot resurrect links. */
export async function projectAuthorization(env: Env, job: AuthorizationProjectionJob): Promise<void> {
  if (job.region !== env.AVALON_REGION) throw new Error('authorization_projection_region_mismatch');
  const workspace = await authorizationWorkspace(env, job.workspaceId);
  if (job.substreamId === undefined) {
    const parent = await durableObjectStubForWorkspace(env, env.WORKSTREAM_DOS, job.workspaceId,
      workstreamDOName(env.AVALON_REGION, job.workspaceId, asWorkstreamId(job.parentId)));
    const authority = await parent.authority({ workspaceId: job.workspaceId, parentId: job.parentId });
    const request = { workspaceId: job.workspaceId, parentId: job.parentId };
    const substreamIds = authority.exists ? (await parent.listAuthorizationChildren(request)).substreamIds
      : (await (await durableObjectStubForWorkspace(env, env.AUTOMATION_DOS, job.workspaceId,
        automationDOName(env.AVALON_REGION, job.workspaceId, asAutomationId(job.parentId)))).listChildren(request))
        .children.map((child) => child.substreamId);
    await workspace.registerAuthorizationChildren({ workspaceId: job.workspaceId, parentId: job.parentId,
      substreamIds });
    return;
  }
  const identity = await createIdentityObjectPort(env, job.workspaceId, job.parentId, undefined, job.substreamId).identity();
  if (!identity) throw new Error('authorization_projection_conversation_not_ready');
  const facts = await createResourceObjectPort(env, job.workspaceId, job.parentId, undefined, job.substreamId).readAuthorizationFacts();
  await workspace.applyAuthorizationLocations({ workspaceId: job.workspaceId, parentId: job.parentId, substreamId: job.substreamId,
    parentKind: identity.parent_kind === 'automation' ? 'automation' : 'workstream', ...facts });
}
