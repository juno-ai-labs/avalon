import { asAutomationId } from '@rally/contracts';
import { ConversationParentKindSchema } from '@rally/contracts/conversation-parent';
import type { Env } from '../env';
import type { AuthorizationProjectionJob } from '../durable-objects/authorization-projection';
import { authorizationWorkspace } from './authorization-service';
import { durableObjectStubForWorkspace } from '../lib/durable-object-namespace';
import { automationDOName } from '../durable-objects/names';
import { createIdentityObjectPort } from '../runtime/identity-port';
import { createResourceObjectPort } from '../runtime/resource-port';

/** Reference-only Queue jobs always reload canonical state; old deliveries cannot resurrect links. */
export async function projectAuthorization(env: Env, job: AuthorizationProjectionJob, refreshExisting = true): Promise<void> {
  if (job.region !== env.AVALON_REGION) throw new Error('authorization_projection_region_mismatch');
  const workspace = await authorizationWorkspace(env, job.workspaceId);
  {
    // The Organization object hosts every Channel and Space parent and knows
    // which kind this id is without creating anything to find out.
    const resolved = await workspace.resolveHostedParent({ workspaceId: job.workspaceId, parentId: job.parentId });
    if (resolved.kind === 'space') throw new Error('authorization_projection_space_parent_unsupported');
    const request = { workspaceId: job.workspaceId, parentId: job.parentId };
    let substreamIds: string[];
    if (resolved.kind === 'workstream') substreamIds = (await workspace.listAuthorizationChildren(request)).substreamIds;
    else {
      const automation = await durableObjectStubForWorkspace(env, env.AUTOMATION_DOS, job.workspaceId,
        automationDOName(env.AVALON_REGION, job.workspaceId, asAutomationId(job.parentId)));
      const present = await automation.authorizationDiscoveryChildren(request);
      substreamIds = present.substreamIds;
    }
    if (job.substreamId === undefined || !substreamIds.includes(job.substreamId)) {
      await workspace.registerAuthorizationChildren({ workspaceId: job.workspaceId, parentId: job.parentId,
        substreamIds, ...(job.mutationAt === undefined ? {} : { mutationAt: job.mutationAt }), refreshExisting: job.substreamId === undefined ? refreshExisting : false });
      return;
    }
  }
  const identity = await createIdentityObjectPort(env, job.workspaceId, job.parentId, undefined, job.substreamId).identity();
  if (!identity) throw new Error('authorization_projection_conversation_not_ready');
  const facts = await createResourceObjectPort(env, job.workspaceId, job.parentId, undefined, job.substreamId).readAuthorizationFacts();
  // The stored kind, parsed rather than collapsed. This read used to be
  // `=== 'automation' ? 'automation' : 'workstream'`, which had no third case
  // to be wrong about; a Space's hidden conversation would now take the `else`
  // and be recorded as a Channel in the authorization universe — the one place
  // it must never appear, since that universe is what a search result and a
  // resource grant are decided from.
  const parentKind = ConversationParentKindSchema.parse(identity.parent_kind);
  if (parentKind === 'space') {
    // Phase 3 of the Spaces work decides what a Space's resource authority
    // projects and widens `AuthorizationLocationSchema` with it. Until then
    // this is refused by name rather than guessed at: the message retries and
    // then dead-letters, which says exactly what is missing.
    throw new Error('authorization_projection_space_parent_unsupported');
  }
  await workspace.applyAuthorizationLocations({ workspaceId: job.workspaceId, parentId: job.parentId, substreamId: job.substreamId,
    ...(job.mutationAt === undefined ? {} : { mutationAt: job.mutationAt }),
    parentKind, ...facts });
}
