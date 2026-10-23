import { rpcResultBody } from "../durable-objects/rpc-result";
import { Preparation } from "./harness-preparation";
import {
  agentAddressForId, agentIdForAddress, AgentIdSchema, asSubstreamId, modelAgentId,
  asUserId, asWorkstreamId, type AgentExchangeNotice, type AgentId, type AgentMessageResult, type StartAgentInput,
  type StartAgentResult, type SendAgentMessageInput, type ReplyToAgentMessageInput, type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import type { AuthContext, Env } from "../env";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { createConversationResourceLinks } from "../runtime/resource-port";
import { conversationParentStub } from "./conversation-parent-client";
import { createAutomation } from "./automation-service";

// The wire names this service asks about — a message, and the delegation that
// also counts as handing work on — are in `@rally/contracts` beside the schemas
// they belong to, because the client reads the same list to decide which row a
// call gets. `AGENT_HANDOFF_TOOL_NAMES` is re-exported so the callers that
// already import it from here keep working.
export { AGENT_HANDOFF_TOOL_NAMES, AGENT_MESSAGE_TOOL_NAMES } from "@rally/contracts";

/**
 * What a delegating or messaging result tells the model about what happens
 * next. A result is read at the moment the model decides its next step, where
 * a description was only skimmed, so the delivery contract is stated here:
 * the reply is a message that arrives on its own, and nothing is fetched.
 */
const REPLY_ARRIVES = "whether you keep working or finish your turn. There is no tool to fetch it";

/** Host-only routing: tools cannot supply their sender, workspace, team or principal. */
export class AgentCommunicationService {
  readonly senderId: AgentId;
  private readonly teamPreparation = new Preparation(() => this.resolveTeam());
  private readonly threadPreparation = new Preparation(() => this.owningWorkstream());
  private readonly guestPreparation = new Preparation(() => this.principalIsGuest());

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

  private team(): Promise<AgentId> {
    return this.teamPreparation.get();
  }

  private async resolveTeam(): Promise<AgentId> {
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

  private async validateAttachments(ids: string[], unavailableCode = "agent_attachment_unavailable") {
    const attachmentIds = [...new Set(ids)];
    if (attachmentIds.length === 0) return attachmentIds;
    // Forwarding shares with another audience, so it requires an actual link
    // in the sender's scope rather than the broader Sidekick read permission.
    const { links } = await createConversationResourceLinks(this.env, this.input.workspaceId, this.input.parentId,
      undefined, this.input.substreamId ?? "0", this.input.executionPrincipal).links({ resourceIds: attachmentIds }, { resolveReadable: false });
    const attached = new Set(links.map((link) => link.resource_id));
    if (attachmentIds.some((resourceId) => !attached.has(resourceId))) {
      throw new AgentCommunicationError(unavailableCode);
    }
    return attachmentIds;
  }

  async start(args: StartAgentInput, context: HarnessToolContext): Promise<StartAgentResult> {
    const source = await this.conversation(this.senderId);
    const origin = await source.agentRuntimeInfo();
    if (origin?.status === "stopped") throw new AgentCommunicationError("agent_origin_stopped");
    // A worker started by a worker works for the conversation its starter
    // works for; the composer there is the one that counts it. A starter from
    // before roots were recorded has none, and its workers count in the main
    // conversation, as every legacy agent does.
    const rootSubstreamId = asSubstreamId(origin?.background
      ? origin.rootSubstreamId ?? "0"
      : this.input.substreamId ?? "0");
    await this.validateAttachments(args.attachmentIds);
    const id = await this.messageId(context);
    const childId = agentIdForAddress({ parentKind: this.input.parentKind, parentId: this.input.parentId, substreamId: asSubstreamId(id) });
    const identity = await createIdentityObjectPort(this.env, this.input.workspaceId, this.input.parentId,
      undefined, this.input.substreamId ?? "0").identity();
    if (!identity || identity.archived_at !== null) throw new AgentCommunicationError("agent_origin_unavailable");
    const parent = await conversationParentStub(this.env, this.input);
    // Start membership setup while the parent reserves and the child initializes.
    const teamPromise = this.team();
    const reservation = await parent.reserveAgentChild({ workspaceId: this.input.workspaceId, parentId: this.input.parentId,
      substreamId: asSubstreamId(id), createdByUserId: identity.created_by_user_id ? asUserId(identity.created_by_user_id) : null })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "workstream_archived") throw new AgentCommunicationError("workstream_archived");
        throw error;
      });
    const child = await this.conversation(childId);
    const initialized = await child.initializeDelegatedAgent({ bootstrap: { workspaceId: this.input.workspaceId, parentKind: this.input.parentKind,
      parentId: this.input.parentId, substreamId: asSubstreamId(id), generation: reservation.authorityGeneration }, provision: {
      title: args.name, objective: args.description, scope: identity.scope,
      createdByUserId: identity.created_by_user_id,
      participantUserIds: this.input.executionPrincipal.type === "user" ? [this.input.executionPrincipal.userId] : [],
      harnessStatus: "idle", titleStatus: "settled", emailAddress: null, emailRouteStatus: null,
      systemKind: null, modelOverride: identity.model_override, now: Date.now(),
    }, executionPrincipal: this.input.executionPrincipal, rootSubstreamId });
    if (initialized.status !== 200) {
      const body = rpcResultBody(initialized);
      const code = body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error : "agent_initialization_failed";
      throw new AgentCommunicationError(code);
    }
    const teamId = await teamPromise;
    const registered = await (await this.workspace()).registerAgentDelegation({ workspaceId: this.input.workspaceId,
      teamId, ownerAgentId: this.senderId, agentId: childId });
    if (!registered.ok) throw new AgentCommunicationError(registered.code);
    if ((await source.agentRuntimeInfo())?.status === "stopped") {
      await child.stopOwnedAgent();
      throw new AgentCommunicationError("agent_origin_stopped");
    }
    let sourceStopped: boolean;
    try {
      await this.deliver({ ...args, agentId: childId }, id, true, teamId);
    } finally {
      // Admission may commit even when its confirmation is lost. Preserve an
      // owner stop on both the successful and uncertain delivery paths.
      sourceStopped = (await source.agentRuntimeInfo())?.status === "stopped";
      if (sourceStopped) await child.stopOwnedAgent();
    }
    if (sourceStopped) throw new AgentCommunicationError("agent_origin_stopped");
    return {
      agentId: childId,
      name: args.name,
      next: `Started ${args.name}. Its reply will arrive here as a message, ${REPLY_ARRIVES}. Do not resend the assignment.`,
    };
  }

  async send(args: SendAgentMessageInput | ReplyToAgentMessageInput, context: HarnessToolContext): Promise<AgentMessageResult> {
    const delivered = "agentId" in args
      ? await (async () => {
        const teamId = await this.team();
        await this.contactSidekick(args.agentId, teamId);
        return this.deliver(args, await this.messageId(context), true, teamId);
      })()
      : await this.deliver(args, await this.messageId(context));
    return { ...delivered, next: `Delivered. Any reply will arrive here as a message, ${REPLY_ARRIVES}.` };
  }

  /**
   * The two notices the host sends an owner on a run's behalf, and the only
   * messages it ever synthesizes: a failure, and a completion that sent nothing.
   */
  async notifyFailure(reason: string) {
    await this.notifyOwner(`Agent failed due to ${reason}. Id: ${modelAgentId(this.senderId)}`, `failure:${this.input.harnessRunId}`, "failed", reason);
  }

  /**
   * A worker that finishes without a word to anyone has left its owner waiting
   * on a reply that will never come. Saying so once lets the owner decide,
   * exactly as a failure does; a run that sent even one message needs no notice.
   */
  async notifySilentCompletion(name: string | null) {
    await this.notifyOwner(`Agent ${name ?? modelAgentId(this.senderId)} finished without replying. Id: ${modelAgentId(this.senderId)}. Message it if you still need its result.`, `completion:${this.input.harnessRunId}`, "finished_without_reply");
  }

  private async notifyOwner(
    message: string,
    effectKey: string,
    notice: AgentExchangeNotice,
    // The terminal diagnostic, carried as a field so the recipient does not
    // have to parse it back out of the sentence above.
    noticeReason?: string,
  ) {
    const owner = await (await this.workspace()).agentOwner({ workspaceId: this.input.workspaceId, agentId: this.senderId });
    if (!owner.agentId) return;
    try {
      // The run supplies the delivery identity, so a settlement retry cannot
      // deliver the same notice twice.
      await this.deliver({ agentId: owner.agentId, message, attachmentIds: [] },
        await this.messageId({ effectIntentId: effectKey }), false, undefined, notice, noticeReason);
    } catch (error) {
      // Archival closes admission; it must not prevent the run settling.
      if (error instanceof AgentCommunicationError && error.code === "workstream_archived") return;
      throw error;
    }
  }

  private async deliver(
    args: SendAgentMessageInput | ReplyToAgentMessageInput,
    messageId: string,
    resumeStopped = true,
    teamId?: AgentId,
    // Set only by `notifyOwner`. A model-authored message has no notice, which
    // is what lets the recipient tell the two apart.
    notice?: AgentExchangeNotice,
    noticeReason?: string,
  ) {
    const route = await (await this.workspace()).resolveAgentMessage({
      workspaceId: this.input.workspaceId, messageId, senderAgentId: this.senderId,
      ...("agentId" in args ? { recipientAgentId: args.agentId, preferredTeamId: teamId ?? await this.team() }
        : { replyToMessageId: args.messageId }),
    });
    if (!route.ok) throw new AgentCommunicationError(route.code);
    const target = route.value;
    if (target.recipientAgentId === this.senderId) throw new AgentCommunicationError("agent_self_message");
    if ("messageId" in args) await this.authorizeSidekick(target.recipientAgentId);
    const address = agentAddressForId(target.recipientAgentId);
    const recipient = await this.conversation(target.recipientAgentId);
    const attachmentIds = await this.validateAttachments(args.attachmentIds);
    const result = await recipient.admitAgentMessage({ workspaceId: this.input.workspaceId,
      workstreamId: asWorkstreamId(address.parentId), messageId, clientMessageId: `agent-message:${messageId}`,
      recipientAgentId: target.recipientAgentId, resumeStopped, text: args.message, attachmentIds,
      agentExchange: {
        teamId: AgentIdSchema.parse(target.teamId), senderAgentId: this.senderId, messageId,
        ...(notice ? { notice } : {}),
        ...(noticeReason ? { noticeReason } : {}),
      },
      executionPrincipal: this.input.executionPrincipal,
      origin: "agent_message", now: Date.now() });
    if (!result.accepted) throw new AgentCommunicationError(result.code);
    return { messageId };
  }

  private async contactSidekick(agentId: AgentId, teamId: AgentId) {
    const address = agentAddressForId(agentId);
    if (address.parentKind !== "automation" || address.substreamId !== "0") return;
    await this.authorizeSidekick(agentId);
    await (await this.workspace()).joinAgentTeam({ workspaceId: this.input.workspaceId, teamId, agentId });
  }

  /**
   * Whether this conversation may message a Sidekick's authoring agent, which
   * is how a Sidekick's setup changes. Seeing the Sidekick is not enough: a
   * Sidekick another thread owns is that thread's to change, and a model that
   * misreads a list must not be able to rewrite it (`docs/agent-communication.md`).
   */
  private async authorizeSidekick(agentId: AgentId) {
    const address = agentAddressForId(agentId);
    if (address.parentKind !== "automation" || address.substreamId !== "0") return;
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_contact_user_unavailable");
    const userId = this.input.executionPrincipal.userId;
    const [parent, guest, owner, thread] = await Promise.all([
      conversationParentStub(this.env, { workspaceId: this.input.workspaceId, ...address }),
      this.guestPreparation.get(),
      this.workspace().then((workspace) => workspace.automationOwner({ workspaceId: this.input.workspaceId,
        automationId: address.parentId })),
      this.threadPreparation.get(),
    ]);
    // A guest reaches a Sidekick only through its grants, as every other
    // transport admits them (`docs/authorization.md`).
    const access = await parent.authorizeViewer({ workspaceId: this.input.workspaceId, parentId: address.parentId,
      substreamId: address.substreamId, userId, ...(guest ? { requireGrantAuthority: true } : {}) });
    if (!access.authorized || access.archived) throw new AgentCommunicationError("sidekick_contact_forbidden");
    if (sidekickOwnership(owner.owningWorkstreamId, thread) === "another_thread") {
      throw new AgentCommunicationError("sidekick_owned_by_another_thread");
    }
  }

  private async principalIsGuest(): Promise<boolean> {
    if (this.input.executionPrincipal.type !== "user") return false;
    const member = await this.env.DB.prepare(
      `SELECT access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(this.input.workspaceId, this.input.executionPrincipal.userId).first<{ access_class: string | null }>();
    return member?.access_class === "guest";
  }

  /** Already-authorized directory plus the existing contact ownership rule. */
  private async editableSidekicks() {
    if (this.input.executionPrincipal.type !== "user") return [];
    const workspace = await this.workspace();
    const listed = await workspace.listSidekickDirectoryForAuthorizedMember({ workspaceId: this.input.workspaceId,
      userId: this.input.executionPrincipal.userId });
    const thread = await this.threadPreparation.get();
    return listed.items
      .filter((sidekick) => sidekickOwnership(sidekick.owningWorkstreamId, thread) !== "another_thread")
      .map((sidekick) => ({
        sidekickId: sidekick.id, name: sidekick.name, description: sidekick.description,
        isCurrentSidekick: this.input.parentKind === "automation" && sidekick.id === this.input.parentId,
        scope: sidekick.scope, ownedByThisWorkstream: sidekickOwnership(sidekick.owningWorkstreamId, thread) === "this_thread",
        canEdit: true, status: sidekick.status, nextRunAt: sidekick.nextRunAt, lastRunAt: sidekick.lastRunAt,
        agentId: agentIdForAddress({ parentKind: "automation", parentId: sidekick.id, substreamId: asSubstreamId("0") }),
      }));
  }

  /** Setup never falls back to a personal, organization or foreign-thread Sidekick. */
  async sidekicks() {
    if (this.input.executionPrincipal.type !== "user") return { sidekicks: [] };
    const sidekicks = (await this.editableSidekicks()).filter((sidekick) => sidekick.ownedByThisWorkstream || sidekick.isCurrentSidekick);
    const thread = await this.threadPreparation.get();
    return { sidekicks, ...(sidekicks.length ? {} : { next: this.input.automationRun
      ? `You are already executing Sidekick ${this.input.automationRun.automationId}. An empty editable list does not mean it needs to be created. Complete this activation using its saved instructions.`
      : thread === null
      ? "This conversation has no owning thread. Set up a thread-owned Sidekick from the intended thread."
      : "This thread has no editable Sidekicks. Create one here with create_sidekick (scope=workstream), then send setup instructions to its authoring agent." }) };
  }

  /** Resolve only the exact name the person requested; this is not setup discovery. */
  async findSidekick(name: string) {
    const requested = name.trim().toLowerCase();
    const sidekicks = (await this.editableSidekicks()).filter((sidekick) => sidekick.name.trim().toLowerCase() === requested);
    return { sidekicks, ...(sidekicks.length === 1 ? {} : { next: sidekicks.length
      ? "Several editable Sidekicks have that exact name. Ask which one the person means before editing."
      : "No editable Sidekick with that exact name is available here. Report that the named target could not be reached; do not silently create a replacement." }) };
  }

  /** The thread this conversation acts for: itself, or the thread that owns its Sidekick. */
  private async owningWorkstream(): Promise<string | null> {
    if (this.input.parentKind === "workstream") return this.input.parentId;
    if (this.input.parentKind !== "automation") return null;
    const owner = await (await this.workspace()).automationOwner({ workspaceId: this.input.workspaceId,
      automationId: this.input.parentId });
    return owner.owningWorkstreamId;
  }

  /**
   * Which conversation under the owning Channel a room-scoped Sidekick created
   * here calls home: the Breakout this loop runs in, or the Channel's Main
   * conversation. A background agent is not a Breakout anyone reads, so its
   * Sidekicks live in Main; a Sidekick's own conversation passes on its home.
   */
  private async owningSubstream(): Promise<string> {
    if (this.input.parentKind === "workstream") {
      return this.input.backgroundAgent ? "0" : this.input.substreamId ?? "0";
    }
    const owner = await (await this.workspace()).automationOwner({ workspaceId: this.input.workspaceId,
      automationId: this.input.parentId });
    return owner.owningSubstreamId;
  }

  async createSidekick(scope: "personal" | "workspace" | "workstream", context: HarnessToolContext) {
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_author_unavailable");
    const owningWorkstreamId = scope === "workstream" ? await this.threadPreparation.get() : null;
    if (scope === "workstream" && !owningWorkstreamId) throw new AgentCommunicationError("sidekick_owning_workstream_unavailable");
    const owningSubstreamId = owningWorkstreamId ? await this.owningSubstream() : "0";
    if (owningWorkstreamId) {
      const workspace = await this.workspace();
      const userId = this.input.executionPrincipal.userId;
      const member = owningSubstreamId === "0"
        ? (await workspace.workstreamParticipant({ workspaceId: this.input.workspaceId,
          workstreamId: owningWorkstreamId, userId })).participant
        : (await workspace.authorizeViewer({ workspaceId: this.input.workspaceId, parentId: owningWorkstreamId,
          substreamId: asSubstreamId(owningSubstreamId), userId })).authorized;
      if (!member) throw new AgentCommunicationError("sidekick_owning_workstream_forbidden");
    }
    const creationId = await this.messageId(context);
    const created = await createAutomation(this.env, { workspaceId: this.input.workspaceId,
      authorUserId: this.input.executionPrincipal.userId, scope, owningWorkstreamId, owningSubstreamId,
      automationId: creationId });
    return { sidekickId: created.automationId, agentId: agentIdForAddress({ parentKind: "automation",
      parentId: created.automationId, substreamId: asSubstreamId("0") }) };
  }

  /** Add context without admitting a message, joining a team or waking a loop. */
  async attachSidekickResource(sidekickId: string, resourceId: string) {
    const agentId = agentIdForAddress({ parentKind: "automation", parentId: sidekickId, substreamId: asSubstreamId("0") });
    await this.authorizeSidekick(agentId);
    await this.validateAttachments([resourceId], "sidekick_resource_unavailable");
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_contact_user_unavailable");
    const userId = this.input.executionPrincipal.userId;
    const member = await this.env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
    ).bind(this.input.workspaceId, userId).first<{ role: AuthContext["role"] }>();
    if (!member) throw new AgentCommunicationError("sidekick_contact_forbidden");
    // Like conversation_merge, a harness execution has no login session.
    // The product authority rechecks this member before its ordinary attach.
    const auth: AuthContext = { sessionId: `sidekick-resource:${this.input.harnessRunId}`, userId,
      workspaceId: this.input.workspaceId, region: this.input.region, role: member.role, principal: "connector" };
    const result = await WorkstreamObjectClient.forParent(this.env, auth, "automation", sidekickId).attachResources([resourceId]);
    if (!result.ok) throw new AgentCommunicationError(`sidekick_${result.code}`);
    return { sidekickId, resourceId, alreadyAttached: !result.linked.includes(resourceId) };
  }

  async list() {
    const result = await (await this.workspace()).listAgentTeammates({ workspaceId: this.input.workspaceId,
      teamId: await this.team(), requesterAgentId: this.senderId });
    if (!result.ok) throw new AgentCommunicationError(result.code);
    const agents = await Promise.all(result.value.agentIds.filter((id) => id !== this.senderId).map(async (agentId) => {
      try {
        await this.authorizeSidekick(agentId);
      } catch (error) {
        if (error instanceof AgentCommunicationError
          && (error.code === "sidekick_contact_forbidden" || error.code === "sidekick_contact_user_unavailable"
            || error.code === "sidekick_owned_by_another_thread")) return null;
        throw error;
      }
      // `status` says whether a teammate is still running, which a message
      // cannot ask without resuming it. The way to wait for one is to finish.
      const runtime = await (await this.conversation(agentId)).agentRuntimeInfo();
      return runtime ? { agentId, name: runtime.name, description: runtime.description,
        status: runtime.status, pendingWork: runtime.pendingWork } : null;
    }));
    return { agents: agents.filter((agent) => agent !== null) };
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
  readonly details?: { reason: string; retryable: false; available: string[] };
  constructor(readonly code: string) {
    super({
      agent_not_teammate: "List teammates or accessible Sidekicks, then copy a returned agentId. This recipient is not available to you.",
      agent_message_not_received: "Copy Message ID from a message you received. You cannot respond using another agent’s message ID.",
      agent_self_message: "Do the work in this conversation. You cannot send or reply to your own agent address.",
      agent_not_owned: "Message the agent instead. You can stop only agents you own.",
      sidekick_resource_unavailable: "resourceId is not visible in this conversation. Use list_resources and choose a visible Rally resource ID.",
      sidekick_resource_not_found: "resourceId could not be read. Refresh list_resources and choose an available Rally resource ID.",
      sidekick_resource_access_denied: "resourceId cannot be shared by this execution user. Choose a resource this user may share.",
      sidekick_attachment_draft_requires_message: "resourceId is an unsent upload. Send it in a message before attaching it as an existing resource.",
      agent_attachment_unavailable: "Attach the resource to this conversation before forwarding it, or remove it from attachmentIds.",
      workstream_archived: "Stop sending work to this destination. Its workstream is archived or no longer exists.",
      agent_origin_stopped: "Wait for a continuation message. This agent is stopped and cannot start more work.",
      agent_origin_unavailable: "Stop starting agents from this conversation. It is archived or no longer available.",
      agent_destination_unavailable: "List teammates again and choose an available agentId. This recipient is unavailable.",
      agent_destination_mismatch: "Copy the exact agentId from creation or discovery. The supplied ID does not match the recipient.",
      sidekick_contact_forbidden: "Choose a Sidekick you can access. This Sidekick is unavailable to this execution.",
      sidekick_owned_by_another_thread: "This Sidekick belongs to another thread, so only that thread can change it.",
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
    if (code === "sidekick_contact_forbidden" || code === "sidekick_owned_by_another_thread") {
      this.details = {
        reason: "This action was not performed. For setup here, refresh sidekicks_list. For an explicitly named target, use find_sidekick or report its refusal without replacing it. This refusal does not establish a connector or scheduling blocker.",
        retryable: false,
        available: ["sidekicks_list", "find_sidekick", "create_sidekick"],
      };
    }
  }
}

/**
 * Who may change a Sidekick, from one conversation: the one rule behind both
 * the `sidekicks_list` flags and the refusal in `authorizeSidekick`.
 *
 * A thread owns a Sidekick its own conversations created, Breakouts included:
 * ownership is per thread, as `automation_directory.owning_workstream_id`
 * records it. A personal or Organization Sidekick has no owning thread and is
 * the person's to change from anywhere they can reach it. A conversation that
 * acts for no thread owns nothing, so a `null` thread never matches.
 */
export function sidekickOwnership(
  owningWorkstreamId: string | null,
  thread: string | null,
): "this_thread" | "another_thread" | "unowned" {
  if (owningWorkstreamId === null) return "unowned";
  return owningWorkstreamId === thread ? "this_thread" : "another_thread";
}
