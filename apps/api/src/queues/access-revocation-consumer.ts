import {
  asArtifactId,
  asWorkspaceId,
  asWorkstreamId,
  type SubstreamId,
} from "@rally/contracts";
import { describeZodIssues } from "@rally/contracts/zod-diagnostics";

import {
  artifactHostDOName,
  conversationObjectName,
  workspaceDOName,
} from "../durable-objects/names";
import type { Env } from "../env";
import {
  durableObjectStubForArtifact,
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { isRetirementRefusal } from "../durable-objects/object-retirement";
import { logInfo, logWarn } from "../observability/logger";
import { WorkspaceRelationshipChangeMessageSchema, type WorkspaceRelationshipChangeMessage } from "../services/workspace-relationship-delivery";
import { seatOrganizationMember } from "../services/space-bootstrap-service";
import { publishWorkspaceSync } from "../services/workspace-realtime-service";
import {
  AccessRevocationMessageSchema,
  descendantRevocation,
  publishDescendantRevocations,
  type AccessRevocationMessage,
  type SocketAccessRevocation,
} from "../services/access-revocation";

/**
 * Carry one revocation to one object, then publish its children.
 *
 * The walk is queue-driven rather than one long call chain: a message names a
 * single object, that object closes its own sockets and answers with the
 * children it knows about, and each child becomes its own message. So a hop
 * that fails retries alone, no invocation holds the hierarchy open, and the
 * objects stay ignorant of the transport — they return lists, and this consumer
 * decides what carries them onward.
 *
 * Every `revokeSocketAccess` is idempotent: a socket already closed is not
 * found again, and a list re-published is a list of hops that each find nothing
 * left to do. A retry therefore costs repeated calls and nothing else.
 */
export async function applyAccessRevocation(env: Env, message: AccessRevocationMessage): Promise<void> {
  const workspaceId = asWorkspaceId(message.workspaceId);
  const placementAffinity = await workspacePlacementAffinity(env, workspaceId);
  const target = message.target;
  const carried = {
    reason: message.reason,
    workspaceId: message.workspaceId,
    sessionId: message.sessionId,
    ...(message.membershipIncarnation ? { membershipIncarnation:message.membershipIncarnation } : {}),
  };

  if (target.scope === "workstream_audience_narrowed") {
    // The one hop that arrives without a name. The room closes what it can no
    // longer admit and answers with whose sockets those were; from there each
    // one is an ordinary per-user revocation, which is what reaches the
    // substreams and the automations the room owns. Nobody holding a socket
    // means nobody to publish for — the members who lost access and were not
    // connected have nothing open to close.
    // The room's parent is hosted by the Organization object, which holds its
    // control sockets too.
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    const { closedUserIds = [], substreams, automationIds } = await workspace.revokeNarrowedAudienceAccess({
      workspaceId,
      parentId: target.workstreamId,
    });
    if (substreams && automationIds) {
      // The object ran each person's Channel step in the same call, so only
      // the leaves go out: each conversation, and each Sidekick the Channel owns.
      await publishDescendantRevocations(env, [
        ...substreams.flatMap(({ userId, substreamIds }) => substreamIds.map((substreamId) =>
          descendantRevocation({ ...carried, userId }, {
            scope: "substream", workstreamId: target.workstreamId, substreamId,
          }))),
        ...closedUserIds.flatMap((userId) => automationIds.map((automationId) =>
          descendantRevocation({ ...carried, userId }, { scope: "automation", automationId }))),
      ]);
      return;
    }
    // An object from before the combined step answers with names only.
    await publishDescendantRevocations(env, closedUserIds.flatMap((userId) => [
      descendantRevocation({ ...carried, userId }, { scope: "workstream", workstreamId: target.workstreamId }),
      descendantRevocation({ ...carried, userId },
        { scope: "workstream_automations", workstreamId: target.workstreamId }),
    ]));
    return;
  }

  // Every other target is about one person, and the schema has already
  // refused a message that lost them. Named rather than asserted non-null, so
  // a future target added without a hop says which field it is missing.
  if (message.userId === null) {
    throw new Error(`access_revocation_user_required:${target.scope}`);
  }
  const revocation: SocketAccessRevocation = { ...carried, userId: message.userId };

  if (target.scope === "workspace") {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    // Every list is defaulted, and that is about deploys rather than about
    // tests: this consumer and WorkspaceDO are separate deployments of the same
    // Worker, so during a rollout a consumer that knows about artifacts can
    // reach an object that does not yet name them. Reading `undefined.map`
    // there would throw and fail the whole revocation hop — dropping a
    // retraction — where an empty list simply reaches nothing new.
    const {
      workstreamIds = [],
      channels = [],
      automationIds = [],
      artifactIds = [],
    } = await workspace.revokeSocketAccess(revocation);
    // A Channel in `channels` had its own hop run inside that call, so only
    // its conversations go out. The rest (a Channel still waiting for its
    // legacy import, or every Channel when an older object answered) get the
    // `workstream` hop.
    const handled = new Set(channels.map((channel) => channel.workstreamId));
    await publishDescendantRevocations(env, [
      ...workstreamIds.filter((workstreamId) => !handled.has(workstreamId)).map((workstreamId) =>
        descendantRevocation(revocation, { scope: "workstream", workstreamId })),
      ...channels.flatMap(({ workstreamId, substreamIds }) => substreamIds.map((substreamId) =>
        descendantRevocation(revocation, { scope: "substream", workstreamId, substreamId }))),
      // An automation holds no socket of its own, but its conversation and
      // its runs do, and only the automation object can name them.
      ...automationIds.map((automationId) =>
        descendantRevocation(revocation, { scope: "automation", automationId })),
      // An artifact host holds no socket, but it holds viewer sessions, and a
      // session that outlived a membership would keep serving a page to
      // somebody who is no longer in the workspace. It is a sibling of the
      // work streams for the same reason an automation is: `artifact_registry`
      // lives in WorkspaceDO, so that is the only object that can name them.
      ...artifactIds.map((artifactId) =>
        descendantRevocation(revocation, { scope: "artifact", artifactId })),
    ]);
    return;
  }

  if (target.scope === "artifact") {
    // Named directly rather than through `durableObjectStubForWorkspace`: an
    // artifact object's name carries no workspace segment — the serving Worker
    // has only a hostname to derive it from — so there is no workspace
    // affinity to look up here either. A leaf; it names no children.
    const artifact = durableObjectStubForArtifact(
      env,
      env.ARTIFACT_HOSTS,
      artifactHostDOName(env.AVALON_REGION, asArtifactId(target.artifactId)),
      placementAffinity,
    );
    await artifact.revokeSocketAccess(revocation);
    return;
  }

  if (target.scope === "automation") {
    // The Sidekick's parent is hosted by its Organization object.
    const automation = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    const { children } = await automation.listChildren({
      workspaceId,
      parentId: target.automationId,
    });
    // Each child conversation is its own hop, addressed by its parent's id the
    // way a work stream's substreams are.
    await publishDescendantRevocations(env, children.map((child) => descendantRevocation(revocation, {
      scope: "substream",
      workstreamId: target.automationId,
      substreamId: child.substreamId,
    })));
    return;
  }

  if (target.scope === "space") {
    // No `revokeSocketAccess` call: a Space admits no client socket, so there
    // is nothing here to close and asking would be a subrequest whose answer is
    // always empty. Its children are addressed by the Space id exactly as a
    // work stream's substreams are addressed by its own.
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    const { children } = await workspace.listChildren({
      workspaceId,
      parentId: target.spaceId,
    });
    await publishDescendantRevocations(env, children.map((child) => descendantRevocation(revocation, {
      scope: "substream",
      workstreamId: target.spaceId,
      substreamId: child.substreamId,
    })));
    return;
  }

  if (target.scope === "workstream_automations") {
    // A room owns no Sidekick any more, so a person who lost one lost no
    // Sidekick with it; a hop queued before that has nothing to name.
    return;
  }

  const workstreamId = asWorkstreamId(target.workstreamId);

  if (target.scope === "workstream") {
    // The Channel's parent — and its control sockets — live in the
    // Organization object.
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    const { substreamIds } = await workspace.revokeParentSocketAccess({ parentId: workstreamId, revocation });
    await publishDescendantRevocations(env, [
      ...substreamIds.map((substreamId) => descendantRevocation(revocation, {
        scope: "substream",
        workstreamId: target.workstreamId,
        substreamId,
      })),
    ]);
    return;
  }

  if (target.scope === "substream") {
    const agent = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      workspaceId,
      conversationObjectName(
        env.AVALON_REGION,
        workspaceId,
        workstreamId,
        target.substreamId === "0" ? "0" : target.substreamId as SubstreamId,
      ),
      placementAffinity,
    );
    await agent.revokeSocketAccess(revocation);
    return;
  }

  const exhaustiveTarget: never = target;
  throw new Error(`unsupported_access_revocation_target:${String(exhaustiveTarget)}`);
}

/** Queue entry point: one hop per message, retried on its own. */
export async function consumeAccessRevocationQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const relationshipChange = WorkspaceRelationshipChangeMessageSchema.safeParse(message.body);
    if (relationshipChange.success) {
      try {
        await applyWorkspaceRelationshipChange(env, relationshipChange.data);
        message.ack();
      } catch (error) {
        logWarn(env, "workspace_relationship_apply_failed", { sequence: relationshipChange.data.sequence,
          error: error instanceof Error ? error.message : "unknown" });
        message.retry();
      }
      return;
    }
    const parsed = AccessRevocationMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      // A message this consumer cannot read will never become readable, so it
      // is acknowledged rather than retried into the dead-letter queue.
      // `describeZodIssues` names each failing field — a malformed
      // `workspaceId`, an unknown `target.scope` — by its declared path and
      // issue code, and leaves the rejected values behind. The `kind` is the
      // one breadcrumb of the body itself worth keeping, and it is a literal
      // rather than anything a person wrote.
      const body: unknown = message.body;
      logWarn(env, "access_revocation_message_invalid", {
        kind: body !== null && typeof body === "object" && "kind" in body
          ? String((body as { kind: unknown }).kind).slice(0, 64)
          : "absent",
        errors: describeZodIssues(parsed.error),
      });
      message.ack();
      return;
    }
    try {
      await applyAccessRevocation(env, parsed.data);
      message.ack();
    } catch (error) {
      // A retired object refuses the enumeration a hop asks for
      // (`listChildren`), and will refuse it
      // on every redelivery. Retirement closed every socket beneath that object
      // when it wrote the tombstone, so there is nothing left for this hop to
      // find: the message is done, not failed.
      if (isRetirementRefusal(error)) {
        logInfo(env, "access_revocation_hop_terminal", {
          workspace_id: parsed.data.workspaceId,
          user_id: parsed.data.userId,
          reason: parsed.data.reason,
          scope: parsed.data.target.scope,
          outcome: "workspace_retired",
        });
        message.ack();
        return;
      }
      logWarn(env, "access_revocation_hop_failed", {
        workspace_id: parsed.data.workspaceId,
        user_id: parsed.data.userId,
        reason: parsed.data.reason,
        scope: parsed.data.target.scope,
        error: error instanceof Error ? error.message : "unknown",
      });
      message.retry();
    }
  }));
}

/** Process the root; descendant queue hops retain their own retry lifecycle. */
export async function applyWorkspaceRelationshipChange(env: Env, message: WorkspaceRelationshipChangeMessage): Promise<void> {
  const { relationship, removed } = message;
  try {
    // The Organization object answers access checks (grants, invitations,
    // Space writes, breakout creation) from its own copy of each relationship,
    // and this event is what keeps that copy current. First, so that a
    // revocation hop that throws and retries, or dead-letters, has not left
    // the copy saying active: every new check refuses the person at once,
    // while the walk below closes what they already hold. Sequence-fenced, so
    // a redelivery applies nothing twice.
    const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, relationship.workspaceId,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(relationship.workspaceId)));
    await workspace.applyMemberStatus({
      workspaceId: relationship.workspaceId, sequence: message.sequence, removed, relationship,
    });
    if (removed || relationship.status !== "active") {
      await applyAccessRevocation(env, {
        kind: "access_revoked", reason: "workspace_membership_removed",
        workspaceId: relationship.workspaceId, userId: relationship.userId,
        sessionId: null, membershipIncarnation:relationship.incarnation, target: { scope: "workspace" }, occurredAt: new Date().toISOString(),
      });
    }
    await publishWorkspaceSync(env, relationship.workspaceId,
      ["workspace_profile", "member_directory", "workstream_directory"], { memberUserIds: [relationship.userId] });
    // Joining, or a guest becoming a member: General and their own Personal
    // Channel. Last, so a failure here retries a message whose earlier steps
    // are all fenced against applying twice.
    if (!removed && relationship.status === "active" && relationship.accessClass === "member") {
      await seatOrganizationMember(env, relationship.workspaceId, relationship.userId);
    }
  } catch (error) {
    // Retirement is terminal and has already fenced the object's readers.
    // Match the existing revocation consumer's terminal treatment.
    if (!isRetirementRefusal(error)) throw error;
  }
  // Root processing is not an acknowledgement from every descendant. Do not
  // label this timestamp fully applied in a sharing/revocation UI.
  await env.DB.prepare(`UPDATE workspace_relationship_deliveries SET processed_at = ?
    WHERE sequence = ? AND workspace_id = ? AND user_id = ? AND incarnation = ? AND revision = ?`)
    .bind(new Date().toISOString(), message.sequence, relationship.workspaceId, relationship.userId,
      relationship.incarnation, relationship.revision).run();
}
