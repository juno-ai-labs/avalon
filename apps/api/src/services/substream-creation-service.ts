import { asSubstreamId, asUserId, asWorkstreamId } from "@rally/contracts";
import { PrivateChildPreparationOperationSchema, type PrivateChildPreparationOperation } from "@rally/contracts/conversation-parent";
import type { AuthContext, Env } from "../env";
import { conversationObjectName, workstreamDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { ApiError } from "../lib/api-error";
import { ConversationService } from "./conversation-service";
import {
  membershipInitializerRegistry,
  substreamContextPipeline,
  SUBSTREAM_CONTEXT_POLICY,
  SUBSTREAM_MEMBERSHIP_POLICY,
} from "./substream-context";
import { createSubstreamContextTransformServices } from "./substream-context-summary";
import { bootstrapConversationChildRuntime, provisionWorkstreamObject } from "./workstream-runtime-database";

/** One parent-owned operation survives preparation, preview, confirmation and retries. */
export class SubstreamCreationService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  private async parent(parentId: string) {
    const parent = await new ConversationService(this.env, this.auth).authorizeViewer(parentId);
    if (parent.kind !== "workstream" || parent.archived) {
      throw new ApiError(409, "substream_parent_unavailable", "Substreams require an active work stream.");
    }
    return durableObjectStubForWorkspace(this.env, this.env.WORKSTREAM_DOS, this.auth.workspaceId,
      workstreamDOName(this.env.AVALON_REGION, this.auth.workspaceId, asWorkstreamId(parentId)));
  }

  async prepare(parentId: string, input: { operationId: string; title: string; throughTurnId: string | null }): Promise<PrivateChildPreparationOperation> {
    const parent = await this.parent(parentId);
    const address = { workspaceId: this.auth.workspaceId, parentId, operationId: input.operationId };
    // Look up first: a retry after a deployment keeps its old policy revision.
    const prior = PrivateChildPreparationOperationSchema.nullable().parse(await parent.readPrivateChildPreparation(address));
    if (prior && (prior.creatorUserId !== this.auth.userId || prior.title !== input.title
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
      operation = PrivateChildPreparationOperationSchema.parse(await parent.beginPrivateChildPreparation({
        ...address, creatorUserId: this.auth.userId, title: input.title, sourceSubstreamId: "0",
        sourceThroughTurnId: input.throughTurnId, recipe: substreamContextPipeline.plan(SUBSTREAM_CONTEXT_POLICY),
        membershipInitializer: { ...SUBSTREAM_MEMBERSHIP_POLICY, memberUserIds: [...memberUserIds] },
      }));
    }
    if (operation.status === "failed") throw new ApiError(409, "substream_creation_cancelled", "This creation request is no longer active.");
    if (operation.preparedContext) return operation;
    if (operation.recipe.capture === "source" && !operation.capture) {
      const source = { workspaceId: this.auth.workspaceId, workstreamId: asWorkstreamId(parentId), substreamId: asSubstreamId("0") };
      const main = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
        conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, parentId, "0"));
      const capture = await main.captureInitialSubstreamContext({
        source, operationId: input.operationId, userId: this.auth.userId, throughTurnId: input.throughTurnId,
      });
      operation = PrivateChildPreparationOperationSchema.parse(await parent.savePrivateChildCapture({ ...address, capture }));
    }
    const preparedContext = await substreamContextPipeline.prepare({
      recipe: operation.recipe, capture: operation.capture, completedParts: operation.completedParts,
      services: createSubstreamContextTransformServices(this.env, {
        workspaceId: this.auth.workspaceId, workstreamId: asWorkstreamId(parentId), substreamId: operation.substreamId,
        userId: this.auth.userId, requestId: operation.operationId,
      }),
      onPartPrepared: async (part) => { await parent.savePrivateChildPart({ ...address, part }); },
    });
    // Recheck authority after inference, before exposing the captured content.
    await this.parent(parentId);
    return PrivateChildPreparationOperationSchema.parse(await parent.savePreparedPrivateChildContext({ ...address, preparedContext }));
  }

  async confirm(parentId: string, operationId: string): Promise<{ substreamId: string }> {
    const parent = await this.parent(parentId);
    const address = { workspaceId: this.auth.workspaceId, parentId, operationId };
    const existing = PrivateChildPreparationOperationSchema.nullable().parse(await parent.readPrivateChildPreparation(address));
    if (!existing || existing.creatorUserId !== this.auth.userId) {
      throw new ApiError(404, "substream_preparation_not_found", "Creation request not found.");
    }
    let operation: PrivateChildPreparationOperation;
    try {
      operation = PrivateChildPreparationOperationSchema.parse(await parent.claimPrivateChildConfirmation({
        ...address, actorUserId: this.auth.userId,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes("private_child_preparation_failed")) {
        throw new ApiError(409, "substream_creation_cancelled", "This creation request was cancelled.");
      }
      if (error instanceof Error && error.message.includes("private_child_context_not_prepared")) {
        throw new ApiError(409, "substream_context_not_prepared", "Prepare the starting context first.");
      }
      throw error;
    }
    if (operation.status === "ready") return { substreamId: operation.substreamId };
    if (operation.status !== "confirming" || !operation.preparedContext) {
      throw new ApiError(409, "substream_context_not_prepared", "Prepare the starting context first.");
    }
    await bootstrapConversationChildRuntime(this.env, this.auth.workspaceId, "workstream", parentId, operation.substreamId);
    await provisionWorkstreamObject(this.env, {
      workspaceId: this.auth.workspaceId, workstreamId: parentId, substreamId: operation.substreamId,
      title: operation.title, titleStatus: "settled", objective: "", scope: "personal",
      createdByUserId: this.auth.userId,
      participantUserIds: operation.membershipInitializer.memberUserIds,
      harnessStatus: "idle",
      emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: operation.createdAt,
    });
    const target = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
      conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, parentId, operation.substreamId));
    await target.installPreparedSubstreamContext({
      workspaceId: this.auth.workspaceId, workstreamId: parentId, substreamId: operation.substreamId, operationId,
    });
    await this.parent(parentId);
    await parent.setPrivateChildTerminalStatus({ ...address, status: "ready", errorCode: null });
    return { substreamId: operation.substreamId };
  }

  async changeParticipant(parentId: string, substreamId: string, input: {
    userId: string; operationId: string;
  }, active: boolean) {
    const parent = await this.parent(parentId);
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
      if (error.message.includes("private_child_member_not_admitted_to_parent")) {
        throw new ApiError(409, "substream_member_needs_workstream_access",
          "Add this person to the work stream before adding them to a substream.");
      }
      if (error.message.includes("private_child_participant_required")) {
        throw new ApiError(403, "substream_participant_required",
          active
            ? "Only a participant can add somebody to this substream."
            : "A substream keeps at least one participant.");
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
  async archive(parentId: string, substreamId: string, archived: boolean) {
    const parent = await this.parent(parentId);
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
      if (error instanceof Error && error.message.includes("private_child_participant_required")) {
        throw new ApiError(403, "substream_participant_required", "Only a participant can archive this substream.");
      }
      if (error instanceof Error && error.message.includes("private_child_not_ready")) {
        throw new ApiError(404, "substream_not_found", "Substream not found.");
      }
      throw error;
    }
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
