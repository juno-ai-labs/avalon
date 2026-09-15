import {
  agentAddressForId, agentIdForAddress, AgentIdSchema, asSubstreamId,
  asUserId, asWorkstreamId, type AgentId, type StartAgentInput,
  type SendAgentMessageInput, type ReplyToAgentMessageInput, type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import type { Env } from "../env";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { createResourceObjectPort } from "../runtime/resource-port";
import { conversationParentStub } from "./conversation-parent-client";
import { provisionWorkstreamObject } from "./workstream-runtime-database";
import { createAutomation } from "./automation-service";

/** Host-only routing: tools cannot supply their sender, workspace, team or principal. */
export class AgentCommunicationService {
  readonly senderId: AgentId;

  constructor(private readonly env: Env, private readonly input: WorkstreamWorkflowInput) {
    this.senderId = agentIdForAddress({ parentKind: input.parentKind, parentId: input.parentId, substreamId: input.substreamId ?? asSubstreamId("0") });
  }

  private workspace() {
    return durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.input.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.input.workspaceId));
  }

  private conversation(agentId: AgentId) {
    const address = agentAddressForId(agentId);
    return durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.input.workspaceId,
      conversationObjectName(this.env.AVALON_REGION, this.input.workspaceId, address.parentId, address.substreamId));
  }

  private async team(): Promise<AgentId> {
    if (this.input.agentExchange) return this.input.agentExchange.teamId;
    const team = await (await this.workspace()).ensureAgentTeam({ workspaceId: this.input.workspaceId, originAgentId: this.senderId });
    return AgentIdSchema.parse(team.teamId);
  }

  /** Stable across retries of the exact durable tool effect. */
  private async messageId(context: Pick<HarnessToolContext, "effectIntentId">): Promise<string> {
    if (!context.effectIntentId) throw new AgentCommunicationError("agent_effect_identity_missing");
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      `agent-message:${this.input.workspaceId}:${this.senderId}:${context.effectIntentId}`,
    )));
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private async validateAttachments(ids: string[]) {
    const sourceResources = createResourceObjectPort(this.env, this.input.workspaceId, this.input.parentId,
      undefined, this.input.substreamId ?? "0");
    const attachmentIds = [...new Set(ids)];
    for (const resourceId of attachmentIds) {
      if (!await sourceResources.isAttached({ resourceId })) throw new AgentCommunicationError("agent_attachment_unavailable");
    }
    return attachmentIds;
  }

  async start(args: StartAgentInput, context: HarnessToolContext) {
    const source = await this.conversation(this.senderId);
    if ((await source.agentRuntimeInfo())?.status === "stopped") throw new AgentCommunicationError("agent_origin_stopped");
    await this.validateAttachments(args.attachmentIds);
    const id = await this.messageId(context);
    const childId = agentIdForAddress({ parentKind: this.input.parentKind, parentId: this.input.parentId, substreamId: asSubstreamId(id) });
    const identity = await createIdentityObjectPort(this.env, this.input.workspaceId, this.input.parentId,
      undefined, this.input.substreamId ?? "0").identity();
    if (!identity || identity.archived_at !== null) throw new AgentCommunicationError("agent_origin_unavailable");
    const parent = await conversationParentStub(this.env, this.input);
    const authority = await parent.authority({ workspaceId: this.input.workspaceId, parentId: this.input.parentId });
    if (!authority.exists || authority.archived) throw new AgentCommunicationError("workstream_archived");
    const teamId = await this.team();
    await parent.reserveChild({ workspaceId: this.input.workspaceId, parentId: this.input.parentId,
      substreamId: asSubstreamId(id), kind: "child", createdByUserId: identity.created_by_user_id ? asUserId(identity.created_by_user_id) : null,
      authorityGeneration: authority.authorityGeneration });
    const child = await this.conversation(childId);
    const boot = await child.bootstrapRuntime({ workspaceId: this.input.workspaceId, parentKind: this.input.parentKind,
      parentId: this.input.parentId, substreamId: asSubstreamId(id), generation: authority.authorityGeneration });
    if (boot.status !== 200) throw new AgentCommunicationError("agent_bootstrap_failed");
    await provisionWorkstreamObject(this.env, {
      workspaceId: this.input.workspaceId, workstreamId: this.input.parentId, substreamId: id,
      title: args.name, objective: args.description, scope: identity.scope,
      createdByUserId: identity.created_by_user_id,
      participantUserIds: this.input.executionPrincipal.type === "user" ? [this.input.executionPrincipal.userId] : [],
      harnessStatus: "idle", titleStatus: "settled", emailAddress: null, emailRouteStatus: null,
      systemKind: null, modelOverride: identity.model_override, now: Date.now(),
    });
    await child.initializeBackgroundAgent({ executionPrincipal: this.input.executionPrincipal });
    const registered = await (await this.workspace()).registerAgentDelegation({ workspaceId: this.input.workspaceId,
      teamId, ownerAgentId: this.senderId, agentId: childId });
    if (!registered.ok) throw new AgentCommunicationError(registered.code);
    if ((await source.agentRuntimeInfo())?.status === "stopped") {
      await child.stopOwnedAgent();
      throw new AgentCommunicationError("agent_origin_stopped");
    }
    let sourceStopped: boolean;
    try {
      await this.send({ ...args, agentId: childId }, context);
    } finally {
      // Admission may commit even when its confirmation is lost. Preserve an
      // owner stop on both the successful and uncertain delivery paths.
      sourceStopped = (await source.agentRuntimeInfo())?.status === "stopped";
      if (sourceStopped) await child.stopOwnedAgent();
    }
    if (sourceStopped) throw new AgentCommunicationError("agent_origin_stopped");
    return { agentId: childId };
  }

  async send(args: SendAgentMessageInput | ReplyToAgentMessageInput, context: HarnessToolContext) {
    if ("agentId" in args) await this.contactSidekick(args.agentId);
    return this.deliver(args, await this.messageId(context));
  }

  /** Host failure settlement is the sole automatic parent notification. */
  async notifyFailure(reason: string) {
    const owner = await (await this.workspace()).agentOwner({ workspaceId: this.input.workspaceId, agentId: this.senderId });
    if (!owner.agentId) return;
    try {
      await this.deliver({ agentId: owner.agentId, message: `Agent failed due to ${reason}. Id: ${this.senderId}`, attachmentIds: [] },
        await this.messageId({ effectIntentId: `failure:${this.input.harnessRunId}` }), false);
    } catch (error) {
      // Archival closes admission; it must not prevent the failed run settling.
      if (error instanceof AgentCommunicationError && error.code === "workstream_archived") return;
      throw error;
    }
  }

  private async deliver(args: SendAgentMessageInput | ReplyToAgentMessageInput, messageId: string, resumeStopped = true) {
    const route = await (await this.workspace()).resolveAgentMessage({
      workspaceId: this.input.workspaceId, messageId, senderAgentId: this.senderId,
      ...("agentId" in args ? { recipientAgentId: args.agentId, preferredTeamId: await this.team() }
        : { replyToMessageId: args.messageId }),
    });
    if (!route.ok) throw new AgentCommunicationError(route.code);
    const target = route.value;
    if ("messageId" in args) await this.authorizeSidekick(target.recipientAgentId);
    const address = agentAddressForId(target.recipientAgentId);
    const parent = await conversationParentStub(this.env, { workspaceId: this.input.workspaceId, ...address });
    const authority = await parent.authority({ workspaceId: this.input.workspaceId, parentId: address.parentId });
    if (!authority.exists || authority.archived) throw new AgentCommunicationError("workstream_archived");
    const recipient = await this.conversation(target.recipientAgentId);
    const runtime = await recipient.agentRuntimeInfo();
    if (!runtime) throw new AgentCommunicationError("agent_destination_unavailable");
    const attachmentIds = await this.validateAttachments(args.attachmentIds);
    const result = await recipient.admitAgentMessage({ workspaceId: this.input.workspaceId,
      workstreamId: asWorkstreamId(address.parentId), messageId, clientMessageId: `agent-message:${messageId}`,
      recipientAgentId: target.recipientAgentId, resumeStopped, text: args.message, attachmentIds,
      agentExchange: { teamId: AgentIdSchema.parse(target.teamId), senderAgentId: this.senderId, messageId },
      executionPrincipal: runtime.executionPrincipal ?? this.input.executionPrincipal,
      origin: "agent_message", now: Date.now() });
    if (!result.accepted) throw new AgentCommunicationError(result.code);
    return { messageId };
  }

  private async contactSidekick(agentId: AgentId) {
    const address = agentAddressForId(agentId);
    if (address.parentKind !== "automation" || address.substreamId !== "0") return;
    await this.authorizeSidekick(agentId);
    await (await this.workspace()).joinAgentTeam({ workspaceId: this.input.workspaceId, teamId: await this.team(), agentId });
  }

  private async authorizeSidekick(agentId: AgentId) {
    const address = agentAddressForId(agentId);
    if (address.parentKind !== "automation" || address.substreamId !== "0") return;
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_contact_user_unavailable");
    const parent = await conversationParentStub(this.env, { workspaceId: this.input.workspaceId, ...address });
    const access = await parent.authorizeViewer({ workspaceId: this.input.workspaceId, parentId: address.parentId,
      substreamId: address.substreamId, userId: this.input.executionPrincipal.userId });
    if (!access.authorized || access.archived) throw new AgentCommunicationError("sidekick_contact_forbidden");
  }

  async sidekicks() {
    if (this.input.executionPrincipal.type !== "user") return { sidekicks: [] };
    const listed = await (await this.workspace()).listSidekickDirectory({ workspaceId: this.input.workspaceId,
      userId: this.input.executionPrincipal.userId });
    const owningWorkstreamId = await this.owningWorkstream();
    return { sidekicks: listed.items.sort((a, b) =>
      Number(b.owningWorkstreamId === owningWorkstreamId) - Number(a.owningWorkstreamId === owningWorkstreamId),
    ).map((sidekick) => ({
      sidekickId: sidekick.id, name: sidekick.name, description: sidekick.description,
      scope: sidekick.scope, owningWorkstreamId: sidekick.owningWorkstreamId,
      agentId: agentIdForAddress({ parentKind: "automation", parentId: sidekick.id, substreamId: asSubstreamId("0") }),
    })) };
  }

  private async owningWorkstream(): Promise<string | null> {
    if (this.input.parentKind === "workstream") return this.input.parentId;
    const owner = await (await this.workspace()).automationOwner({ workspaceId: this.input.workspaceId,
      automationId: this.input.parentId });
    return owner.owningWorkstreamId;
  }

  async createSidekick(scope: "personal" | "workspace" | "workstream", context: HarnessToolContext) {
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_author_unavailable");
    const owningWorkstreamId = scope === "workstream" ? await this.owningWorkstream() : null;
    if (scope === "workstream" && !owningWorkstreamId) throw new AgentCommunicationError("sidekick_owning_workstream_unavailable");
    if (owningWorkstreamId) {
      const membership = await (await this.workspace()).workstreamParticipant({ workspaceId: this.input.workspaceId,
        workstreamId: owningWorkstreamId, userId: this.input.executionPrincipal.userId });
      if (!membership.participant) throw new AgentCommunicationError("sidekick_owning_workstream_forbidden");
    }
    const created = await createAutomation(this.env, { workspaceId: this.input.workspaceId,
      authorUserId: this.input.executionPrincipal.userId, scope, owningWorkstreamId,
      automationId: await this.messageId(context) });
    return { sidekickId: created.automationId, agentId: agentIdForAddress({ parentKind: "automation",
      parentId: created.automationId, substreamId: asSubstreamId("0") }) };
  }

  async list() {
    const result = await (await this.workspace()).listAgentTeammates({ workspaceId: this.input.workspaceId,
      teamId: await this.team(), requesterAgentId: this.senderId });
    if (!result.ok) throw new AgentCommunicationError(result.code);
    const agents = [];
    for (const agentId of result.value.agentIds) {
      if (agentId === this.senderId) continue;
      try {
        await this.authorizeSidekick(agentId);
      } catch (error) {
        if (error instanceof AgentCommunicationError
          && (error.code === "sidekick_contact_forbidden" || error.code === "sidekick_contact_user_unavailable")) continue;
        throw error;
      }
      const runtime = await (await this.conversation(agentId)).agentRuntimeInfo();
      if (runtime) agents.push({ agentId, name: runtime.name, description: runtime.description, status: runtime.status });
    }
    return { agents };
  }

  async stop(agentId: AgentId) {
    const workspace = await this.workspace();
    const owned = await workspace.ownedAgentDescendants({ workspaceId: this.input.workspaceId, agentId: this.senderId });
    if (!owned.agentIds.includes(agentId)) throw new AgentCommunicationError("agent_not_owned");
    const pending = [agentId];
    const stopped = new Set<AgentId>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (stopped.has(id)) continue;
      await (await this.conversation(id)).stopOwnedAgent();
      stopped.add(id);
      // Fence each owner before reading its descendants. A concurrent start
      // either appears here or observes its stopped owner after registration.
      const descendants = await workspace.ownedAgentDescendants({ workspaceId: this.input.workspaceId, agentId: id });
      pending.push(...descendants.agentIds);
    }
    return { stopped: true };
  }
}


class AgentCommunicationError extends Error {
  constructor(readonly code: string) {
    super({
      agent_not_teammate: "List teammates or accessible Sidekicks, then copy a returned agentId. This recipient is not available to you.",
      agent_message_not_received: "Copy Message ID from a message you received. You cannot respond using another agent’s message ID.",
      agent_not_owned: "Message the agent instead. You can stop only agents you own.",
      agent_attachment_unavailable: "Attach the resource to this conversation before forwarding it, or remove it from attachmentIds.",
      workstream_archived: "Stop sending work to this destination. Its workstream is archived or no longer exists.",
      agent_origin_stopped: "Wait for a continuation message. This agent is stopped and cannot start more work.",
      agent_origin_unavailable: "Stop starting agents from this conversation. It is archived or no longer available.",
      agent_destination_unavailable: "List teammates again and choose an available agentId. This recipient is unavailable.",
      agent_destination_mismatch: "Copy the exact agentId from creation or discovery. The supplied ID does not match the recipient.",
      sidekick_contact_forbidden: "Choose a Sidekick you can access. This Sidekick is unavailable to this execution.",
      sidekick_contact_user_unavailable: "Ask your coordinator to contact the Sidekick. This execution has no user identity for Sidekick access.",
      sidekick_author_unavailable: "Ask your coordinator to create the Sidekick. This execution has no user identity for creation.",
      sidekick_owning_workstream_unavailable: "Choose personal or workspace scope if appropriate. This conversation has no owning workstream.",
      sidekick_owning_workstream_forbidden: "Ask a participant in the owning workstream to create the Sidekick. This execution cannot create one there.",
      agent_ownership_conflict: "Use the existing agent or report the conflict. This agent already has a different owner or team.",
      agent_ownership_cycle: "Choose a different agent. An agent cannot own itself or one of its ancestors.",
      agent_message_identity_conflict: "Report the delivery conflict. This message ID is already assigned to a different route; changing the recipient cannot repair it.",
      agent_effect_identity_missing: "Report this runtime error. The host did not supply a delivery identity; changing tool arguments cannot repair it.",
      agent_bootstrap_failed: "Report that the background agent could not start. Its runtime could not be initialized.",
      workstream_authority_generation_stale: "Report that the recipient’s workstream state is stale. Changing the message cannot repair it.",
    }[code] ?? `Report this agent communication error: ${code}.`);
    this.name = "AgentCommunicationError";
  }
}
