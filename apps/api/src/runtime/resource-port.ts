import { asWorkspaceId, type ExecutionPrincipal } from "@rally/contracts";
import { workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import type { ResourceObjectPort, ResourceOperation } from "../durable-objects/workstream-resource-protocol";
import { RESOURCE_OPERATIONS } from "../durable-objects/workstream-resource-protocol";
import type { WorkstreamResourceStorage } from "../durable-objects/workstream-resource-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";
import {
  conversationResourceLinks,
  type ConversationResourceLinks,
} from "../services/workstream-resource-visibility";

/**
 * Builds a port for one conversation's attachments; injected so callers stay
 * testable. No substream means the conversation the run executes in; one
 * named is answered locally only by that conversation's own object and goes
 * over the wire from any other, as every object port does.
 */
export type ResourcePortFactory = (
  workspaceId: string,
  workstreamId: string,
  substreamId?: string,
) => ResourceObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamResourceStorage, ResourceOperation> = {
  authority: "resource",
  operations: RESOURCE_OPERATIONS,
  dispatch: (stub, request) => stub.executeResourceOperation(request),
  failureCode: "resource_operation_failed",
  failureMessage: "Rally's resource authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createResourcePortFactory(
  env: Env,
  localStorage?: WorkstreamResourceStorage,
): ResourcePortFactory {
  return (workspaceId, workstreamId, substreamId) =>
    createResourceObjectPort(env, workspaceId, workstreamId, localStorage, substreamId);
}

/** A Worker-side handle on one work stream's resource attachments. */
export function createResourceObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamResourceStorage,
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string,
): ResourceObjectPort {
  return createObjectPort(env, workspaceId, workstreamId, CONTRACT, localStorage, substreamId);
}

/**
 * {@link createConversationResourceLinks} over an injected factory, for a
 * caller that takes one so a test can stand its ports in.
 */
export function conversationResourceLinksFrom(
  resourcePort: ResourcePortFactory,
  workspaceId: string,
  workstreamId: string,
  substreamId?: string,
  access?: { env: Env; principal: ExecutionPrincipal },
): ConversationResourceLinks {
  const userId = access?.principal.type === "user" ? access.principal.userId : null;
  return conversationResourceLinks(
    resourcePort(workspaceId, workstreamId, substreamId),
    () => resourcePort(workspaceId, workstreamId, "0"),
    access && userId ? async (context) => {
      const workspace = await durableObjectStubForWorkspace(access.env, access.env.WORKSPACE_DOS,
        asWorkspaceId(workspaceId), workspaceDOName(access.env.AVALON_REGION, asWorkspaceId(workspaceId)));
      const { conversations } = await workspace.conversationToolScope({
        workspaceId, userId,
        scope: { kind: "sidekick", automationId: context.sidekickId },
      });
      const sources = conversations.map((conversation) => ({
        key: conversation.conversationId,
        resources: conversationResourceLinks(
          resourcePort(workspaceId, conversation.parentId, conversation.substreamId),
          () => resourcePort(workspaceId, conversation.parentId, "0"),
          undefined, { kind: conversation.substreamId === "0" ? "none" : "breakout" },
        ),
      }));
      if (context.substreamId !== "0") sources.unshift({
        key: `${context.sidekickId}/0`,
        resources: conversationResourceLinks(resourcePort(workspaceId, context.sidekickId, "0"),
          () => resourcePort(workspaceId, context.sidekickId, "0"), undefined, { kind: "none" }),
      });
      return sources;
    } : undefined,
  );
}

/**
 * The resource links a run sees: its own and existing Breakout inheritance,
 * plus a Sidekick's live admitted home and attached conversations when a user
 * principal is supplied. All model-facing readers supply their principal.
 * `substreamId` follows {@link createResourceObjectPort}: left out, it is the
 * conversation this run executes in.
 */
export function createConversationResourceLinks(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamResourceStorage,
  substreamId?: string,
  principal?: ExecutionPrincipal,
): ConversationResourceLinks {
  const own = createResourceObjectPort(env, workspaceId, workstreamId, localStorage, substreamId);
  const resources = createResourcePortFactory(env);
  return conversationResourceLinksFrom(
    (workspace, parent, child) => workspace === workspaceId && parent === workstreamId && child === substreamId
      ? own : resources(workspace, parent, child),
    workspaceId, workstreamId, substreamId, principal ? { env, principal } : undefined,
  );
}
