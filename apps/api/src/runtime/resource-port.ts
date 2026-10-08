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
): ConversationResourceLinks {
  return conversationResourceLinks(
    resourcePort(workspaceId, workstreamId, substreamId),
    () => resourcePort(workspaceId, workstreamId, "0"),
  );
}

/**
 * The resource links a conversation's runs see: its own, and for a Breakout
 * its Channel's Main as well. Every visibility read takes this rather than a
 * bare port, so no reader can see a Breakout's own links without its parent's.
 * `substreamId` follows {@link createResourceObjectPort}: left out, it is the
 * conversation this run executes in.
 */
export function createConversationResourceLinks(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamResourceStorage,
  substreamId?: string,
): ConversationResourceLinks {
  return conversationResourceLinks(
    createResourceObjectPort(env, workspaceId, workstreamId, localStorage, substreamId),
    () => createResourceObjectPort(env, workspaceId, workstreamId, undefined, "0"),
  );
}
