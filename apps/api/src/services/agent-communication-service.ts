import { derivedFromOf } from "./memory-service";
import { rpcResultBody } from "../durable-objects/rpc-result";
import { hostedConversationParentKind } from "../durable-objects/workstream-object-storage";
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
import { sidekickChangeRequestText } from "@rally/prompts/api/sidekick-change-request";
import { renderAgentFailureNotice, renderAgentSilentCompletionNotice } from "@rally/prompts/api/agent-owner-notice";
import { personManagesSidekick } from "./sidekick-run-continuation";
import { canvasChatAuthority, loopAuthority } from "../lib/loop-authority";

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
  private readonly guestPreparation = new Preparation(() => this.principalIsGuest());

  /**
   * @param turnIsSelfReview Whether the turn using this service is the
   * Sidekick self-review's, which `reviewOwnsThisTurn` decides for a turn whose
   * own `reason` does not say so. Asked only when an agent is started.
   */
  constructor(private readonly env: Env, private readonly input: WorkstreamWorkflowInput,
    private readonly turnIsSelfReview: () => Promise<boolean> = async () => input.reason === "sidekick_review") {
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
    // What started the root, inherited the same way: a gate that treats the
    // self-review's agents apart reads it (docs/agent-loop-types.md).
    const rootReason = origin?.background
      ? origin.rootReason ?? null
      : await this.turnIsSelfReview() ? "sidekick_review" : this.input.reason;
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
    const initialized = await child.initializeDelegatedAgent({ bootstrap: { workspaceId: this.input.workspaceId, parentKind: hostedConversationParentKind(this.input.parentKind),
      parentId: this.input.parentId, substreamId: asSubstreamId(id), generation: reservation.authorityGeneration }, provision: {
      title: args.name, objective: args.description, scope: identity.scope,
      createdByUserId: identity.created_by_user_id,
      participantUserIds: this.input.executionPrincipal.type === "user" ? [this.input.executionPrincipal.userId] : [],
      harnessStatus: "idle", titleStatus: "settled",
      systemKind: null, modelOverride: identity.model_override, now: Date.now(),
    }, executionPrincipal: this.input.executionPrincipal, rootSubstreamId, rootReason });
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
   * A Sidekick run asks its own Sidekick's wizard for a change. The recipient
   * is derived from the run, never chosen by the model, and delivery is the
   * ordinary `send`, so the run passes the same Sidekick contact check and
   * team join as any conversation messaging that wizard. It grants no new
   * authority: a run could already reach its wizard with `send_message` once it
   * found the agentId; this names the path so a run uses it.
   */
  async requestSidekickChange(changes: string, context: HarnessToolContext): Promise<AgentMessageResult> {
    // A run's worker asks for its run, which is whose change it is.
    const run = loopAuthority(this.input);
    if (run?.kind !== "sidekick_run") throw new AgentCommunicationError("sidekick_change_outside_run");
    const wizard = agentIdForAddress({ parentKind: "automation", parentId: run.sidekickId, substreamId: asSubstreamId("0") });
    const sent = await this.send({ agentId: wizard, attachmentIds: [],
      message: sidekickChangeRequestText(run.runId, this.input.automationContinuation, changes) }, context);
    return { ...sent, next: `Sent to this Sidekick's wizard. Its reply will arrive here as a message, ${REPLY_ARRIVES}. The change is not saved until the wizard confirms the revision was accepted.` };
  }

  /**
   * The two notices the host sends an owner on a run's behalf, and the only
   * messages it ever synthesizes: a failure, and a completion that sent nothing.
   */
  async notifyFailure(reason: string) {
    await this.notifyOwner(renderAgentFailureNotice(reason, modelAgentId(this.senderId)), `failure:${this.input.harnessRunId}`, "failed", reason);
  }

  /**
   * A worker that finishes without a word to anyone has left its owner waiting
   * on a reply that will never come. Saying so once lets the owner decide,
   * exactly as a failure does; a run that sent even one message needs no notice.
   */
  async notifySilentCompletion(name: string | null) {
    await this.notifyOwner(renderAgentSilentCompletionNotice(name, modelAgentId(this.senderId)), `completion:${this.input.harnessRunId}`, "finished_without_reply");
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
    if (!owner.ok) throw new AgentCommunicationError(owner.code);
    if (!owner.value.agentId) return;
    try {
      // The run supplies the delivery identity, so a settlement retry cannot
      // deliver the same notice twice.
      await this.deliver({ agentId: owner.value.agentId, message, attachmentIds: [] },
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
    if ("messageId" in args) {
      await this.authorizeWizardContact(target.recipientAgentId);
    }
    const address = agentAddressForId(target.recipientAgentId);
    const recipient = await this.conversation(target.recipientAgentId);
    const attachmentIds = await this.validateAttachments(args.attachmentIds);
    const result = await recipient.admitAgentMessage({ workspaceId: this.input.workspaceId,
      workstreamId: asWorkstreamId(address.parentId), messageId, clientMessageId: `agent-message:${messageId}`,
      recipientAgentId: target.recipientAgentId, resumeStopped, text: args.message, attachmentIds,
      agentExchange: {
        teamId: AgentIdSchema.parse(target.teamId), senderAgentId: this.senderId, messageId,
        ...(!notice && this.personStartedTurn() ? { fromPersonTurn: true as const } : {}),
        ...(notice ? { notice } : {}),
        ...(noticeReason ? { noticeReason } : {}),
      },
      executionPrincipal: this.input.executionPrincipal,
      origin: "agent_message", now: Date.now() });
    if (!result.accepted) throw new AgentCommunicationError(result.code);
    return { messageId };
  }

  /**
   * Whether a person started this turn, by the trust class a remembered fact
   * takes (`derivedFromOf`), and it is no run, worker or background agent:
   * what this turn asks for is theirs, not something it read.
   */
  private personStartedTurn(): boolean {
    return derivedFromOf(this.input) === "person" && this.input.backgroundAgent !== true
      && !this.input.automationRun && !this.input.automationDelegation;
  }

  private async contactSidekick(agentId: AgentId, teamId: AgentId) {
    const address = agentAddressForId(agentId);
    if (address.parentKind !== "automation" || address.substreamId !== "0") return;
    await this.authorizeWizardContact(agentId);
    await (await this.workspace()).joinAgentTeam({ workspaceId: this.input.workspaceId, teamId, agentId });
  }

  /**
   * Whether this conversation's message may start a turn of a Sidekick's
   * wizard, which runs with the authoring tools. The shared conversation
   * gives the wizard a person's message only from someone who manages the
   * Sidekick (`admitConversationMessage`), and an agent's message is held to
   * the same rule by the person it acts for, refused by name otherwise. That
   * includes the Sidekick's own runs: a run under a non-manager's own access,
   * or a delegate's who does not manage it, would otherwise reach the wizard's
   * authoring tools as that person. A refused change request tells the run to
   * tell the person, which is what the run owes them.
   */
  private async authorizeWizardContact(agentId: AgentId) {
    const address = agentAddressForId(agentId);
    if (address.parentKind !== "automation" || address.substreamId !== "0") return;
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_contact_user_unavailable");
    // Managing is the whole test. A Sidekick a Canvas's Chat made is managed
    // by everyone in that Canvas (`sidekickManages`), who need not be people
    // it is shared with; every other manager can open it anyway.
    if (await personManagesSidekick(this.env, {
      workspaceId: this.input.workspaceId, automationId: address.parentId, userId: this.input.executionPrincipal.userId,
    })) return;
    // Refused either way; which refusal depends on whether they can open it.
    await this.authorizeSidekick(agentId);
    throw new AgentCommunicationError("sidekick_edit_requires_manager");
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
    const [parent, guest] = await Promise.all([
      conversationParentStub(this.env, { workspaceId: this.input.workspaceId, ...address }),
      this.guestPreparation.get(),
    ]);
    // A guest reaches a Sidekick only through its grants, as every other
    // transport admits them (`docs/authorization.md`).
    const access = await parent.authorizeViewer({ workspaceId: this.input.workspaceId, parentId: address.parentId,
      substreamId: address.substreamId, userId, ...(guest ? { requireGrantAuthority: true } : {}) });
    if (!access.authorized || access.archived) throw new AgentCommunicationError("sidekick_contact_forbidden");
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
    return listed.items
      .map((sidekick) => ({
        sidekickId: sidekick.id, name: sidekick.name, description: sidekick.description,
        isCurrentSidekick: this.input.parentKind === "automation" && sidekick.id === this.input.parentId,
        scope: sidekick.scope,
        canEdit: true, status: sidekick.status, nextRunAt: sidekick.nextRunAt, lastRunAt: sidekick.lastRunAt,
        agentId: agentIdForAddress({ parentKind: "automation", parentId: sidekick.id, substreamId: asSubstreamId("0") }),
      }));
  }

  /**
   * Setup never falls back to some other personal or Organization Sidekick:
   * only the Sidekick this conversation belongs to is listed. A thread owns
   * none, so setup from a thread creates one.
   */
  async sidekicks() {
    if (this.input.executionPrincipal.type !== "user") return { sidekicks: [] };
    if (this.canvasChatId() !== null) {
      const sidekicks = await this.canvasManagedSidekicks();
      return { sidekicks, ...(sidekicks.length ? {} : {
        next: "This Canvas has no Sidekick attached. Create one with create_sidekick, then send setup instructions to its authoring agent." }) };
    }
    const sidekicks = (await this.editableSidekicks()).filter((sidekick) => sidekick.isCurrentSidekick);
    return { sidekicks, ...(sidekicks.length ? {} : { next: this.input.automationRun
      ? `You are already executing Sidekick ${this.input.automationRun.automationId}. An empty editable list does not mean it needs to be created. Complete this activation using its saved instructions.`
      : "No Sidekick belongs to this conversation. Create one with create_sidekick, then send setup instructions to its authoring agent." }) };
  }

  /** Resolve only the exact name the person requested; this is not setup discovery. */
  async findSidekick(name: string) {
    const requested = name.trim().toLowerCase();
    const sidekicks = (await this.editableSidekicks()).filter((sidekick) => sidekick.name.trim().toLowerCase() === requested);
    return { sidekicks, ...(sidekicks.length === 1 ? {} : { next: sidekicks.length
      ? "Several editable Sidekicks have that exact name. Ask which one the person means before editing."
      : "No editable Sidekick with that exact name is available here. Report that the named target could not be reached; do not silently create a replacement." }) };
  }

  async createSidekick(scope: "personal" | "workspace", context: HarnessToolContext) {
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_author_unavailable");
    const creationId = await this.messageId(context);
    // The Canvas is this loop's own, never a model argument: a Chat makes a
    // Sidekick for its own Canvas and for no other.
    const canvasId = this.canvasChatId();
    const created = await createAutomation(this.env, { workspaceId: this.input.workspaceId,
      authorUserId: this.input.executionPrincipal.userId, scope, automationId: creationId,
      ...(canvasId ? { madeInCanvasId: canvasId } : {}) });
    return { sidekickId: created.automationId, agentId: agentIdForAddress({ parentKind: "automation",
      parentId: created.automationId, substreamId: asSubstreamId("0") }),
      ...(canvasId ? { attachedToCanvasId: canvasId } : {}) };
  }

  /**
   * The Canvas this loop acts for as its Chat, or null: the Chat itself and
   * any agent it started (`loopAuthority`), so a Sidekick that agent creates is
   * the Canvas's, as it would be had the Chat created it.
   */
  private canvasChatId(): string | null {
    return canvasChatAuthority(this.input);
  }

  /**
   * The Sidekicks this Canvas manages, as `sidekicks_list` names them: every
   * one attached here, made here or later, except the Sidekick whose run made
   * this Canvas (`sidekickCanvasAdmits`).
   */
  private async canvasManagedSidekicks() {
    const canvasId = this.canvasChatId();
    if (canvasId === null) return [];
    const context = await (await this.workspace()).canvasContext({ workspaceId: this.input.workspaceId, canvasId });
    return (context?.sidekicks ?? []).filter((sidekick) => sidekick.id !== context?.writerSidekickId).map((sidekick) => ({
      sidekickId: sidekick.id, name: sidekick.name, status: sidekick.status, canEdit: true, madeHere: sidekick.madeHere,
      agentId: agentIdForAddress({ parentKind: "automation", parentId: sidekick.id, substreamId: asSubstreamId("0") }),
    }));
  }

  /**
   * Archive a Sidekick this Canvas's Chat made, named by its id or its exact
   * name. Only those: the candidates are read from this loop's own Canvas, so
   * a Chat cannot archive a Sidekick another Canvas made or one merely
   * attached here.
   */
  async archiveSidekick(reference: string) {
    if (this.input.executionPrincipal.type !== "user") throw new AgentCommunicationError("sidekick_contact_user_unavailable");
    const named = reference.trim().toLowerCase();
    const canvasId = this.canvasChatId();
    if (canvasId === null) throw new AgentCommunicationError("sidekick_archive_not_made_here");
    const context = await (await this.workspace()).canvasContext({ workspaceId: this.input.workspaceId, canvasId });
    const made = (context?.sidekicks ?? []).filter((sidekick) => sidekick.madeHere)
      .map((sidekick) => ({ sidekickId: sidekick.id, name: sidekick.name }));
    const matches = made.filter((sidekick) => sidekick.sidekickId === named || sidekick.name.trim().toLowerCase() === named);
    if (matches.length !== 1) {
      throw new AgentCommunicationError(matches.length ? "sidekick_archive_ambiguous" : "sidekick_archive_not_made_here",
        made.map((sidekick) => sidekick.name));
    }
    const target = matches[0]!;
    const userId = this.input.executionPrincipal.userId;
    const member = await this.env.DB.prepare(
      "SELECT role, access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
    ).bind(this.input.workspaceId, userId).first<{ role: "owner" | "admin" | "member" | null; access_class: string | null }>();
    if (!member) throw new AgentCommunicationError("sidekick_contact_forbidden");
    await (await this.workspace()).sidekickRemove({ workspaceId: this.input.workspaceId, automationId: target.sidekickId,
      actor: { userId: asUserId(userId), actorRole: member.access_class === "guest" ? null : member.role, participantOfOwningWorkstream: false } });
    return { sidekickId: target.sidekickId, name: target.name, archived: true };
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
          && (error.code === "sidekick_contact_forbidden" || error.code === "sidekick_contact_user_unavailable")) return null;
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
  constructor(readonly code: string, madeHere: string[] = []) {
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
      sidekick_contact_user_unavailable: "Ask your coordinator to contact the Sidekick. This execution has no user identity for Sidekick access.",
      sidekick_edit_requires_manager: "Tell the person that only the people who manage this Sidekick can change it. Its wizard was not messaged.",
      sidekick_archive_not_made_here: "No Sidekick this Canvas made has that id or exact name. Use sidekicks_list to see the ones it made (madeHere); a Sidekick made elsewhere is archived from its own page.",
      sidekick_archive_ambiguous: "Several Sidekicks this Canvas made have that name. Pass the sidekickId from sidekicks_list instead.",
      sidekick_change_outside_run: "Use sidekicks_list and message the Sidekick's authoring agentId. Only a Sidekick run can request a change to its own Sidekick this way.",
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
    if (code === "sidekick_archive_not_made_here" || code === "sidekick_archive_ambiguous") {
      // The names are this Canvas's own Sidekicks, which its context already lists.
      this.details = { reason: "Nothing was archived.", retryable: false, available: madeHere };
    }
    if (code === "sidekick_contact_forbidden") {
      this.details = {
        reason: "This action was not performed. For setup here, refresh sidekicks_list. For an explicitly named target, use find_sidekick or report its refusal without replacing it. This refusal does not establish a connector or scheduling blocker.",
        retryable: false,
        available: ["sidekicks_list", "find_sidekick", "create_sidekick"],
      };
    }
  }
}
