import { asAutomationId, asBlockId, asWorkspaceId, asWorkstreamId, type SubstreamId } from "@rally/contracts";

import {
  automationAgentName,
  blockDashboardAgentName,
  substreamAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
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
  const revocation: SocketAccessRevocation = {
    reason: message.reason,
    workspaceId: message.workspaceId,
    userId: message.userId,
    sessionId: message.sessionId,
  };
  const placementAffinity = await workspacePlacementAffinity(env, workspaceId);
  const target = message.target;

  if (target.scope === "workspace") {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    const { workstreamIds, automationIds } = await workspace.revokeSocketAccess(revocation);
    await publishDescendantRevocations(env, [
      ...workstreamIds.map((workstreamId) =>
        descendantRevocation(revocation, { scope: "workstream", workstreamId })),
      // AutomationAgent holds its own socket room, so losing workspace access
      // has to reach it the same way it reaches every other socket-holding
      // object — the room never re-authorizes on its own.
      ...automationIds.map((automationId) =>
        descendantRevocation(revocation, { scope: "automation", automationId })),
    ]);
    return;
  }

  if (target.scope === "automation") {
    const agent = await durableObjectStubForWorkspace(
      env,
      env.AUTOMATION_AGENTS,
      workspaceId,
      automationAgentName(env.AVALON_REGION, workspaceId, asAutomationId(target.automationId)),
      placementAffinity,
    );
    await agent.revokeSocketAccess(revocation);
    return;
  }

  const workstreamId = asWorkstreamId(target.workstreamId);

  if (target.scope === "workstream") {
    const workstream = await durableObjectStubForWorkspace(
      env,
      env.WORKSTREAM_DOS,
      workspaceId,
      workstreamDOName(env.AVALON_REGION, workspaceId, workstreamId),
      placementAffinity,
    );
    const { substreamIds, blockIds } = await workstream.revokeSocketAccess(revocation);
    await publishDescendantRevocations(env, [
      ...substreamIds.map((substreamId) => descendantRevocation(revocation, {
        scope: "substream",
        workstreamId: target.workstreamId,
        substreamId,
      })),
      ...blockIds.map((blockId) => descendantRevocation(revocation, {
        scope: "block",
        workstreamId: target.workstreamId,
        blockId,
      })),
    ]);
    return;
  }

  if (target.scope === "substream") {
    const agent = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      workspaceId,
      substreamAgentName(
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

  const block = await durableObjectStubForWorkspace(
    env,
    env.BLOCK_DASHBOARD_AGENTS,
    workspaceId,
    blockDashboardAgentName(env.AVALON_REGION, workspaceId, workstreamId, asBlockId(target.blockId)),
    placementAffinity,
  );
  await block.revokeSocketAccess(revocation);
}

/** Queue entry point: one hop per message, retried on its own. */
export async function consumeAccessRevocationQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = AccessRevocationMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      // A message this consumer cannot read will never become readable, so it
      // is acknowledged rather than retried into the dead-letter queue.
      // `issues`, not `flatten().formErrors`: the latter carries only root-level
      // problems, and every realistic failure here is a field — a malformed
      // `workspaceId`, an unknown `target.scope`. Logged as empty, it would say
      // a message was unreadable without saying which part. The `kind` is the
      // one breadcrumb of the body itself worth keeping, and it is a literal
      // rather than anything a person wrote.
      const body: unknown = message.body;
      logWarn(env, "access_revocation_message_invalid", {
        kind: body !== null && typeof body === "object" && "kind" in body
          ? String((body as { kind: unknown }).kind).slice(0, 64)
          : "absent",
        errors: parsed.error.issues.slice(0, 4).map((issue) =>
          `${issue.path.join(".") || "(root)"}: ${issue.code}`),
      });
      message.ack();
      return;
    }
    try {
      await applyAccessRevocation(env, parsed.data);
      message.ack();
    } catch (error) {
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
