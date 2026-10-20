import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import type { PreparedConversation } from "@rally/contracts";
import { type AgentModelOverride, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { PrivateChildPreparationOperationSchema, type PrivateChildPreparationOperation } from "@rally/contracts/conversation-parent";
import type { SubstreamCreationResult, SubstreamOpeningMessage } from "@rally/contracts/substream-creation";
import type { AuthContext, Env } from "../env";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { ApiError } from "../lib/api-error";
import { ConversationService } from "./conversation-service";
import {
  membershipInitializerRegistry,
  substreamContextPipeline,
  SUBSTREAM_CONTEXT_POLICY,
  SUBSTREAM_MEMBERSHIP_POLICY,
} from "./substream-context";
import {
  createSubstreamContextTransformServicesWithGateway,
  substreamSummaryGateway,
  type SubstreamSummaryGateway,
} from "./substream-context-summary";
import { provisionalWorkstreamDescription } from "./workstream-description-service";
import { nameWorkstream, provisionalWorkstreamTitle } from "./workstream-naming-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import {
  bootstrapConversationChildRuntime,
  provisionWorkstreamObject,
  warmConversationChildRuntime,
} from "./workstream-runtime-database";
import { noFlowSpan, type FlowSpan } from "../observability/tracing";
import { Preparation } from "./harness-preparation";
import { diagnosticErrorCode, logStructuredEvent } from "../observability/logger";

/**
 * The title preparation reserves a child under.
 *
 * Preparation runs before the opening message exists — it is about the context,
 * not the words — so this is a placeholder in the parent's registry rather than
 * a name anybody sees: confirmation replaces it with the message's first line,
 * and the naming pass replaces that.
 */
export const RESERVED_SUBSTREAM_TITLE = "New substream";

/** One parent-owned operation survives preparation, preview, confirmation and retries. */
export class SubstreamCreationService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    /**
     * How the naming pass is kept off the caller's clock. Routes hand in a
     * `waitUntil`-backed deferral; a caller with none gets the pass awaited
     * rather than dropped, which is what the work-stream create path does for
     * the same reason.
     */
    private readonly defer?: (task: Promise<unknown>) => void,
    /**
     * `summaryGateway` replaces where the starting context's prose comes from,
     * and nothing else: the same recipe, the same capture, the same checkpoints
     * and the same authority recheck afterwards. The demo seeder passes one so a
     * seeded substream opens on the pack's own words rather than on a live
     * model's, which is what keeps a prepared demo reproducible. Every other
     * caller omits it and gets the platform's policy.
     */
    private readonly summaryGateway?: SubstreamSummaryGateway,
  ) {}

  private async parent(parentId: string, substreamId?: string) {
    const parent = await new ConversationService(this.env, this.auth).authorizeViewer(parentId, substreamId);
    if (parent.kind !== "workstream" || (parent.archived && !substreamId)) {
      throw new ApiError(409, "substream_parent_unavailable", "Breakouts require an active thread.");
    }
    return durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)));
  }

  async prepare(parentId: string, input: { operationId: string; title?: string | undefined; throughTurnId: string | null }, span: FlowSpan = noFlowSpan): Promise<PrivateChildPreparationOperation> {
    const reservedTitle = input.title ?? RESERVED_SUBSTREAM_TITLE;
    const parent = await span.step("substream.prepare.parent.authorize", () => this.parent(parentId));
    const address = { workspaceId: this.auth.workspaceId, parentId, operationId: input.operationId };
    // Look up first: a retry after a deployment keeps its old policy revision.
    const prior = PrivateChildPreparationOperationSchema.nullable().parse(
      await span.step("substream.prepare.receipt.read", () => parent.readPrivateChildPreparation(address)),
    );
    if (prior && (prior.creatorUserId !== this.auth.userId || prior.title !== reservedTitle
      || prior.sourceThroughTurnId !== input.throughTurnId)) {
      throw new ApiError(409, "substream_operation_conflict", "This creation request already has different inputs.");
    }
    let operation = prior;
    if (!operation) {
      const membershipInitializer = membershipInitializerRegistry.resolve(SUBSTREAM_MEMBERSHIP_POLICY.plugin);
      const membershipConfig = membershipInitializer.configSchema.parse(structuredClone(SUBSTREAM_MEMBERSHIP_POLICY.config));
      const memberUserIds = membershipInitializer.initialize({
        creator: this.auth.userId,
        config: membershipConfig,
      });
      operation = PrivateChildPreparationOperationSchema.parse(await span.step("substream.prepare.receipt.reserve", () => parent.beginPrivateChildPreparation({
        ...address, creatorUserId: this.auth.userId, title: reservedTitle, sourceSubstreamId: "0",
        sourceThroughTurnId: input.throughTurnId, recipe: substreamContextPipeline.plan(SUBSTREAM_CONTEXT_POLICY),
        membershipInitializer: { ...SUBSTREAM_MEMBERSHIP_POLICY, memberUserIds: [...memberUserIds] },
      })));
    }
    if (operation.status === "failed") throw new ApiError(409, "substream_creation_cancelled", "This creation request is no longer active.");
    if (operation.preparedContext) return operation;
    // Opening a new child applies the full object schema before it can accept
    // its first turn. Start the side-effect-free wake as soon as the parent has
    // reserved the child's stable id, while source capture and transformation
    // are already occupying this request. Authority remains confirmation's
    // fenced responsibility, so human think-time cannot pin an old generation.
    const reservedSubstreamId = operation.substreamId;
    const childWarmup = new Preparation(() => warmConversationChildRuntime(
      this.env,
      this.auth.workspaceId,
      parentId,
      reservedSubstreamId,
    ));
    childWarmup.get();
    if (operation.recipe.capture === "source" && !operation.capture) {
      const source = { workspaceId: this.auth.workspaceId, workstreamId: asWorkstreamId(parentId), substreamId: asSubstreamId("0") };
      const capture = await span.step("substream.prepare.source.capture", async () => {
        const main = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
          conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, parentId, "0"));
        return main.captureInitialSubstreamContext({
          source, operationId: input.operationId, userId: this.auth.userId, throughTurnId: input.throughTurnId,
        });
      });
      operation = PrivateChildPreparationOperationSchema.parse(
        await span.step("substream.prepare.capture.save", () => parent.savePrivateChildCapture({ ...address, capture })),
      );
    }
    const preparedContext = await span.step("substream.prepare.context.transform", () => substreamContextPipeline.prepare({
      recipe: operation.recipe, capture: operation.capture, completedParts: operation.completedParts,
      services: createSubstreamContextTransformServicesWithGateway(this.summaryGateway ?? substreamSummaryGateway(this.env), {
        workspaceId: this.auth.workspaceId, workstreamId: asWorkstreamId(parentId), substreamId: operation.substreamId,
        userId: this.auth.userId, requestId: operation.operationId,
      }),
      onPartPrepared: async (part) => { await parent.savePrivateChildPart({ ...address, part }); },
    }));
    // Recheck authority after inference, before exposing the captured content.
    await span.step("substream.prepare.authority.recheck", () => this.parent(parentId));
    try {
      const warmed = await span.step("substream.prepare.child.warm", () => childWarmup.get());
      logStructuredEvent(this.env, "info", "substream_child_warmed", {
        operation_id: operation.operationId,
        workspace_id: this.auth.workspaceId,
        workstream_id: parentId,
        substream_id: reservedSubstreamId,
        object_id: warmed.objectId,
        authority_mode: warmed.authorityMode,
      });
    } catch (error) {
      logStructuredEvent(this.env, "warn", "substream_child_warm_failed", {
        operation_id: operation.operationId,
        workspace_id: this.auth.workspaceId,
        workstream_id: parentId,
        substream_id: reservedSubstreamId,
        reason: diagnosticErrorCode(error, "child_warm_failed"),
      });
    }
    return PrivateChildPreparationOperationSchema.parse(
      await span.step("substream.prepare.context.save", () => parent.savePreparedPrivateChildContext({ ...address, preparedContext })),
    );
  }

  /**
   * Create the child and, in the same request, write the instruction that
   * caused it.
   *
   * The opening message is what a person pressing enter on the launch composer
   * sends, and it is not a second call: a child that exists without it is a
   * state the desktop would have to reconcile — an empty substream on screen
   * beside an error about the message that did not land. Everything after the
   * child is ready is idempotent by `clientMessageId`, so a retried confirm
   * replays the same turn rather than saying it twice.
   */
  async confirm(
    parentId: string,
    operationId: string,
    opening: SubstreamOpeningMessage | null = null,
    /**
     * The model every run of this child is pinned to, or null for the ordinary
     * unpinned case. Decided on the keystroke that submits the launch composer,
     * because that is when a person chose it — preparation runs before there is
     * a composer to choose from, and reserving a child under a pin nobody had
     * picked yet would record a decision that had not been made.
     *
     * The first confirmation is the one that writes it: a retry of a
     * confirmation that already reached `ready` replays its answer without
     * re-provisioning, so a pin that changed between the two is ignored rather
     * than applied to a child whose runs may already have started. That matches
     * what a pin is everywhere else — decided once, at creation, and fixed.
     */
    modelOverride: AgentModelOverride | null = null,
    preparedConversation?: PreparedConversation,
    span: FlowSpan = noFlowSpan,
    requestReceivedAt?: number,
  ): Promise<SubstreamCreationResult> {
    const parent = await span.step("substream.create.parent.authorize", () => this.parent(parentId));
    const address = { workspaceId: this.auth.workspaceId, parentId, operationId };
    const existing = PrivateChildPreparationOperationSchema.nullable().parse(
      await span.step("substream.create.preparation.read", () => parent.readPrivateChildPreparation(address)),
    );
    if (!existing || existing.creatorUserId !== this.auth.userId) {
      throw new ApiError(404, "substream_preparation_not_found", "Creation request not found.");
    }
    let operation: PrivateChildPreparationOperation;
    try {
      operation = PrivateChildPreparationOperationSchema.parse(await span.step("substream.create.confirmation.claim", () => parent.claimPrivateChildConfirmation({
        ...address, actorUserId: this.auth.userId,
        preparedConversationHash: preparedConversation ? workstreamImportHash(preparedConversation) : null,
      })));
    } catch (error) {
      if (error instanceof Error && error.message.includes("private_child_initialization_conflict")) {
        throw new ApiError(409, "private_child_initialization_conflict", "This preparation already has different content");
      }
      if (error instanceof Error && error.message.includes("private_child_preparation_failed")) {
        throw new ApiError(409, "substream_creation_cancelled", "This creation request was cancelled.");
      }
      if (error instanceof Error && error.message.includes("private_child_context_not_prepared")) {
        throw new ApiError(409, "substream_context_not_prepared", "Prepare the starting context first.");
      }
      throw error;
    }
    if (operation.status === "ready") {
      if (preparedConversation) {
        await span.step("substream.create.conversation.install", () =>
          this.installConversation(parentId, operation, preparedConversation));
      }
      return this.openSubstream(parentId, operation, opening, undefined, span, requestReceivedAt);
    }
    if (operation.status !== "confirming" || !operation.preparedContext) {
      throw new ApiError(409, "substream_context_not_prepared", "Prepare the starting context first.");
    }
    // Before anything is created. A seating refusal that lands after the child
    // has been provisioned leaves a substream behind for a message the person
    // was told to fix, so the seating's own question is asked one step early.
    await span.step("substream.create.participants.preflight", () => this.assertParticipantsAdmitted(parent, parentId, opening));
    // A child created with an instruction is named from it, exactly as a work
    // stream is: the first line stands while the naming pass runs, and
    // `naming` is what puts the skeleton in its header. A child created
    // without one keeps the title its caller reserved and is settled, because
    // nothing will ever arrive to name it from.
    const title = opening ? provisionalWorkstreamTitle(opening.text, operation.title) : operation.title;
    await span.step("substream.create.child.bootstrap", () => bootstrapConversationChildRuntime(this.env, this.auth.workspaceId, "workstream", parentId, operation.substreamId));
    await span.step("substream.create.child.provision", () => provisionWorkstreamObject(this.env, {
      workspaceId: this.auth.workspaceId, workstreamId: parentId, substreamId: operation.substreamId,
      title, titleStatus: opening ? "naming" : "settled",
      // The opening *line*, through the same helper the work-stream path uses,
      // for the same reason: a description is the line a sidebar shows and the
      // standing context every run starts from, and neither wanted the whole
      // of a message that may run to a hundred thousand characters. The title
      // beside it already reads the message this way.
      objective: opening ? provisionalWorkstreamDescription(opening.text, "Review the attached files") : "",
      scope: "personal",
      createdByUserId: this.auth.userId,
      participantUserIds: operation.membershipInitializer.memberUserIds,
      harnessStatus: "idle",
      emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride, now: operation.createdAt,
    }));
    const target = await span.step("substream.create.target.resolve", () =>
      durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
        conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, parentId, operation.substreamId)));
    await span.step("substream.create.context.install", () => target.installPreparedSubstreamContext({
      workspaceId: this.auth.workspaceId, workstreamId: parentId, substreamId: operation.substreamId, operationId,
    }));
    if (preparedConversation) await span.step("substream.create.conversation.install", () => this.installConversation(parentId, operation, preparedConversation));
    await span.step("substream.create.authority.recheck", () => this.parent(parentId));
    // Readiness is the publication fence, so it is the last thing that happens:
    // it is what puts the child in every member's sidebar, and nobody may see
    // one before the turn that caused it is durable. `POST /workstreams` fences
    // the same way with its route activation.
    return this.openSubstream(parentId, operation, opening, () =>
      parent.setPrivateChildTerminalStatus({ ...address, status: "ready", errorCode: null, title }), span, requestReceivedAt);
  }

  private async installConversation(parentId: string, operation: PrivateChildPreparationOperation, conversation: PreparedConversation) {
    const target = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
      conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, parentId, operation.substreamId));
    return target.installPreparedConversation({ workspaceId: this.auth.workspaceId, workstreamId: parentId,
      substreamId: operation.substreamId, operationId: operation.operationId, conversation });
  }

  /**
   * Refuse an opening whose mentions name somebody who cannot be seated, while
   * refusing still costs nothing.
   *
   * The seating's own questions, asked first: active workspace membership,
   * and, for a guest only, whether this work stream admits them — a guest is
   * seated through grants, which the parent answers. A member need not read the
   * work stream: a substream seats them on its own.
   */
  private async assertParticipantsAdmitted(
    parent: DurableObjectStub<WorkspaceDO>,
    parentId: string,
    opening: SubstreamOpeningMessage | null,
  ): Promise<void> {
    for (const userId of opening?.confirmedParticipantUserIds ?? []) {
      const member = await this.env.DB.prepare(
        `SELECT status, access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      ).bind(this.auth.workspaceId, userId).first<{ status: string; access_class: string }>();
      if (member?.status !== "active") {
        throw new ApiError(404, "workspace_member_not_found", "Workspace member not found.");
      }
      if (member.access_class === "member") continue;
      // Grant authority only: a legacy roster never seats a guest.
      const admitted = await parent.authorizeViewer({
        workspaceId: this.auth.workspaceId, parentId, userId: asUserId(userId), requireGrantAuthority: true,
      });
      if (!admitted.authorized) {
        throw new ApiError(409, "substream_guest_requires_share",
          "Share this thread with this guest before adding them to a breakout.");
      }
    }
  }

  /**
   * Write the opening turn, publish the child, and seat the people its message
   * named — in that order, because each step earns the next.
   *
   * A first confirmation arrives here with a provisioned but unpublished child
   * and hands in the transition that publishes it; a retry arrives here with
   * one that is already published and hands in nothing. Both owe the caller the
   * same answer, and `createMessage` is what makes that true — it replays the
   * canonical turn for a `clientMessageId` it has already admitted instead of
   * writing a second one.
   */
  /**
   * The Breakout a suggestion asked for is ready: its row resolves now, after
   * the child is durable and never at capture, so a failed or abandoned
   * preparation leaves the chip standing (docs/conversation-suggestions.md).
   * Best effort: the Breakout exists whatever happens to the chip.
   */
  private async resolveBreakoutSuggestion(parentId: string, operation: PrivateChildPreparationOperation, span: FlowSpan): Promise<void> {
    if (operation.sourceThroughTurnId === null) return;
    const throughTurnId = operation.sourceThroughTurnId;
    await span.step("substream.create.suggestion.resolve", async () => {
      try {
        const main = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
          conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, parentId, "0"));
        await main.resolveBreakoutSuggestion({ throughTurnId, userId: this.auth.userId });
      } catch (error) {
        logStructuredEvent(this.env, "warn", "suggestion_breakout_resolution_failed", {
          operation_id: operation.operationId,
          workspace_id: this.auth.workspaceId,
          workstream_id: parentId,
          reason: diagnosticErrorCode(error, "suggestion_breakout_resolution_failed"),
        });
      }
    });
  }

  private async openSubstream(
    parentId: string,
    operation: PrivateChildPreparationOperation,
    opening: SubstreamOpeningMessage | null,
    /**
     * The ready transition, on a confirmation that has not made it yet. Called
     * once the opening turn is durable: a child published before its message
     * lands is the empty substream in somebody's sidebar that this whole flow
     * exists to not produce.
     */
    publish?: () => Promise<unknown>,
    span: FlowSpan = noFlowSpan,
    requestReceivedAt?: number,
  ): Promise<SubstreamCreationResult> {
    const title = opening ? provisionalWorkstreamTitle(opening.text, operation.title) : operation.title;
    if (!opening) {
      await span.step("substream.create.child.publish", async () => { await publish?.(); });
      await this.resolveBreakoutSuggestion(parentId, operation, span);
      return { substreamId: operation.substreamId, title, opening: null };
    }
    const receipt = await span.step("substream.create.opening.admit", () => new WorkstreamObjectClient(
      this.env, this.auth, parentId, operation.substreamId,
    ).createMessage({
      text: opening.text,
      clientMessageId: opening.clientMessageId,
      mentions: opening.mentions,
      // Carried rather than stripped. The child refuses a mention of somebody
      // who is neither a participant nor confirmed, and it is not one yet: the
      // parent seats them below, once the child is ready enough for it to. The
      // desktop's ordinary send passes `[]` here because it has already been
      // through the parent's roster API; this path has not, and the parent
      // admission those ids need was checked before anything was created.
      confirmedParticipantUserIds: [...opening.confirmedParticipantUserIds],
      attachmentIds: opening.attachmentIds,
      telemetryOperationId: operation.operationId,
      ...(requestReceivedAt !== undefined ? {
        telemetryRequestReceivedAt: requestReceivedAt,
        telemetryJourney: "substream_create" as const,
      } : {}),
    }));
    await span.step("substream.create.child.publish", async () => { await publish?.(); });
    await this.resolveBreakoutSuggestion(parentId, operation, span);
    // Membership after publication, because the parent grants it only for a
    // child that is ready — and it is the parent's to grant: the
    // conversation-local roster the turn itself wrote gives neither discovery
    // nor socket admission. A mention notification is delivered from an outbox
    // the request does not drain, so it still finds these rows in place.
    await span.step("substream.create.participants.seat", async () => {
      for (const userId of opening.confirmedParticipantUserIds) {
        await this.changeParticipant(parentId, operation.substreamId, {
          userId, operationId: `${operation.operationId}:participant:${userId}`,
        }, true);
      }
    });
    const naming = nameWorkstream(this.env, {
      workspaceId: this.auth.workspaceId,
      workstreamId: parentId,
      substreamId: operation.substreamId,
      userId: this.auth.userId,
      objective: opening.text,
      openingMessage: opening.text,
      provisionalTitle: title,
      // The line the child was provisioned with above, which the pass replaces
      // with a summary if it still stands.
      provisionalDescription: provisionalWorkstreamDescription(opening.text, "Review the attached files"),
    });
    if (this.defer) this.defer(naming);
    else await span.step("substream.create.naming", () => naming);
    return { substreamId: operation.substreamId, title, opening: receipt.turn };
  }

  async changeParticipant(parentId: string, substreamId: string, input: {
    userId: string; operationId: string;
  }, active: boolean) {
    const parent = await this.parent(parentId, substreamId);
    await new ConversationService(this.env, this.auth).authorizeViewer(parentId, substreamId);
    if (substreamId === "0") throw new ApiError(400, "private_substream_required", "Choose a substream.");
    if (active) {
      const member = await this.env.DB.prepare(
        `SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      ).bind(this.auth.workspaceId, input.userId).first<{ status: string }>();
      if (member?.status !== "active") throw new ApiError(404, "workspace_member_not_found", "Workspace member not found.");
    }
    const request = {
      workspaceId: this.auth.workspaceId, parentId, substreamId: asSubstreamId(substreamId),
      actorUserId: this.auth.userId, userId: asUserId(input.userId), operationId: input.operationId,
    };
    try {
      return await (active ? parent.addPrivateChildParticipant(request) : parent.removePrivateChildParticipant(request));
    } catch (error) {
      // The parent refuses in prose the person in the dialog can act on. Left
      // unmapped these reach the client as an anonymous 500, which is what the
      // first real add hit: the only way to find out that a substream member
      // must already be in the work stream was to read the Worker's log.
      if (!(error instanceof Error)) throw error;
      if (error.message.includes("participant_migration_pending")) {
        throw new ApiError(409,"participant_migration_pending","Participant access is being upgraded. Try again shortly.");
      }
      if (error.message.includes("workstream_archived")) {
        throw new ApiError(409, "substream_parent_unavailable", "Restore the thread before changing this breakout.");
      }
      if (error.message.includes("private_child_guest_requires_share")) {
        throw new ApiError(409, "substream_guest_requires_share", "Share this substream with a guest instead of adding them.");
      }
      if (error.message.includes("private_child_last_participant")) {
        throw new ApiError(409, "substream_last_participant", "A substream keeps at least one participant.");
      }
      if (error.message.includes("private_child_participant_required")) {
        throw new ApiError(403, "substream_participant_required",
          active
            ? "Only a participant can add somebody to this substream."
            : "Only a participant can remove somebody from this substream.");
      }
      if (error.message.includes("private_child_archived")) {
        throw new ApiError(409, "substream_archived",
          "This substream is archived. Restore it before changing who is in it.");
      }
      if (error.message.includes("private_child_not_ready")) {
        throw new ApiError(404, "substream_not_found", "Substream not found.");
      }
      throw error;
    }
  }

  /** Members retain read access after archive, so they can also restore the child. */
  async resolve(parentId: string, substreamId: string): Promise<void> {
    const parent = await this.parent(parentId, substreamId);
    const result = await parent.resolveConversation({
      workspaceId: this.auth.workspaceId, parentId, substreamId: asSubstreamId(substreamId), userId: asUserId(this.auth.userId),
    });
    if (result.outcome === "forbidden") throw new ApiError(403, "conversation_participant_required", "Only someone who can open this conversation can resolve it.");
    if (result.outcome === "not_ready") throw new ApiError(404, "substream_not_found", "Conversation not found.");
    if (result.outcome === "archived") throw new ApiError(409, "substream_archived", "Restore this conversation before resolving it.");
  }

  async archive(parentId: string, substreamId: string, archived: boolean) {
    const parent = await this.parent(parentId, substreamId);
    if (substreamId === "0") throw new ApiError(400, "private_substream_required", "Choose a substream.");
    // Authorized in both directions by the same call, and it keeps answering
    // once the child is archived: `authorizeViewer` decides admission from
    // membership and readiness, and reports the archive separately rather than
    // folding it in — so the members of an archived substream can still reach
    // the one control that brings it back.
    await new ConversationService(this.env, this.auth).authorizeViewer(parentId, substreamId);
    try {
      return await parent.setPrivateChildArchived({
        workspaceId: this.auth.workspaceId, parentId, substreamId: asSubstreamId(substreamId),
        actorUserId: asUserId(this.auth.userId), archived,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("workstream_archived")) {
        throw new ApiError(409, "substream_parent_unavailable", "Restore the thread before changing this breakout.");
      }
      if (error instanceof Error && error.message.includes("private_child_participant_required")) {
        throw new ApiError(403, "substream_participant_required", "Only a participant can archive this substream.");
      }
      if (error instanceof Error && error.message.includes("private_child_not_ready")) {
        throw new ApiError(404, "substream_not_found", "Substream not found.");
      }
      throw error;
    }
  }

  /** Refuse a caller who may not start a Breakout in this thread, as `prepare` would first. */
  async assertCanCreate(parentId: string): Promise<void> {
    await this.parent(parentId);
  }

  /**
   * Refuse, before any costly work, a confirmation `confirm` would refuse:
   * no preparation of the caller's under this key, or one already cancelled.
   * A caller that uploads before confirming asks this first.
   */
  async assertConfirmable(parentId: string, operationId: string): Promise<void> {
    const parent = await this.parent(parentId);
    const existing = PrivateChildPreparationOperationSchema.nullable().parse(
      await parent.readPrivateChildPreparation({ workspaceId: this.auth.workspaceId, parentId, operationId }),
    );
    if (!existing || existing.creatorUserId !== this.auth.userId) {
      throw new ApiError(404, "substream_preparation_not_found", "Creation request not found.");
    }
    if (existing.status === "failed") throw new ApiError(409, "substream_creation_cancelled", "This creation request was cancelled.");
  }

  async cancel(parentId: string, operationId: string): Promise<void> {
    const parent = await this.parent(parentId);
    const address = { workspaceId: this.auth.workspaceId, parentId, operationId };
    const operation = PrivateChildPreparationOperationSchema.nullable().parse(await parent.readPrivateChildPreparation(address));
    if (!operation) return;
    if (operation.creatorUserId !== this.auth.userId) {
      throw new ApiError(404, "substream_preparation_not_found", "Creation request not found.");
    }
    if (operation.status === "confirming") {
      throw new ApiError(409, "substream_confirmation_in_progress", "This substream is already being created.");
    }
    if (operation.status === "ready") {
      throw new ApiError(409, "substream_already_created", "A ready substream cannot be cancelled.");
    }
    try {
      await parent.setPrivateChildTerminalStatus({ ...address, status: "failed", errorCode: "cancelled" });
    } catch (error) {
      if (error instanceof Error && error.message.includes("private_child_confirmation_in_progress")) {
        throw new ApiError(409, "substream_confirmation_in_progress", "This substream is already being created.");
      }
      throw error;
    }
  }
}
