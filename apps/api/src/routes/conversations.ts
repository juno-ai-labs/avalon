import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono } from "hono";
import { requireSendableMessageLength, zValidator } from "../middleware/validation";
import {
  ConversationSuggestionDismissResultSchema,
  AcknowledgeWorkstreamReadRequestSchema,
  AgentModelOverrideSchema,
  ConversationMergeChannelsSchema,
  ConversationMergeRequestSchema,
  ConversationMergeResultSchema,
  CreateMessageRequestSchema,
  IdSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamMessageAdmissionReceiptSchema,
  WorkstreamResourceSchema,
  ResourceSchema,
  WorkstreamBootSchema,
  WorkstreamSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { requestDeferral } from "../lib/defer";
import { workspaceRealtimeInvalidation } from "../middleware/workspace-realtime";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { requestFlowSpan } from "../observability/tracing";
import { ConversationMergeService } from "../services/conversation-merge-service";
import { ConversationService } from "../services/conversation-service";
import { WorkstreamService } from "../services/workstream-service";
import { ConversationAccessDecisionResultSchema, ConversationAccessPreviewSchema, ConversationAccessRequestResultSchema, SidekickAttachmentsSchema, SidekickRecommendationOptionsSchema } from "@rally/contracts";
import { ConversationAccessRequestService } from "../services/conversation-access-request-service";
import { telemetryOperationId } from "../telemetry/api-emitter";
import { SubstreamCreationService } from "../services/substream-creation-service";
import {
  SubstreamCreationResultSchema,
  SubstreamOpeningMessageSchema,
  SubstreamPreparationPreviewSchema,
} from "@rally/contracts/substream-creation";
import { asSubstreamId, asWorkstreamId } from "@rally/contracts";
import { MutatePrivateChildParticipantResultSchema } from "@rally/contracts/conversation-parent";

const parentParam = z.object({ parentId: IdSchema });
const resourceParam = parentParam.extend({ resourceId: IdSchema });
const resourceBody = z.object({ resourceId: IdSchema });
const substreamSocketParam = parentParam.extend({ substreamId: z.union([z.literal("0"), IdSchema]) });
/**
 * `ticketId` is part of the response so the desktop can print the id the room
 * will report consuming — a socket upgrade carries no request id of its own, so
 * it is the only thing that joins a slow room back to the client that asked for
 * it. It identifies a one-minute credential, not the credential.
 */
const SocketTicketSchema = z.object({
  url: z.string().min(1),
  ticket: z.string().min(1),
  ticketId: IdSchema.optional(),
  subscriptionBootstrap: z.boolean().optional(),
});
const SocketTicketQuerySchema = z.object({
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  speculative: z.literal("true").transform(() => true).optional(),
});

/**
 * One parent's conversations, whichever kind of parent it is.
 *
 * The parent decides who may read; the conversation object holds the
 * transcript. A work stream and an automation are opened, attached to, and
 * subscribed to through the same three routes.
 */
export const conversationRoutes = new Hono<HonoAppEnv>();
// Report an oversized opening before session work, as workstream creation does.
// This guard only rejects; every accepted body still passes workspace auth.
conversationRoutes.post("/:parentId/substreams/confirm", requireSendableMessageLength("opening.text"));
conversationRoutes.post("/:parentId/merge", requireSendableMessageLength("body"));
conversationRoutes.use("*",requireWorkspaceAuth);
conversationRoutes.use("*",workspaceRealtimeInvalidation);
// Exact-conversation recovery works independently of Main and sibling feeds.
conversationRoutes.get("/:parentId/substreams/:substreamId",zValidator("param",substreamSocketParam),async (c) => {
  const { parentId,substreamId } = c.req.valid("param");
  const client = await new ConversationService(c.env,getWorkspaceAuth(c)).client(parentId,true,substreamId);
  const boot = await client.boot();
  return c.json(WorkstreamBootSchema.parse({ ...boot.workstream,transcript:boot.transcript }));
});
conversationRoutes.post("/:parentId/substreams/:substreamId/resources",zValidator("param",substreamSocketParam),zValidator("json",resourceBody),async (c) => {
  const { parentId,substreamId } = c.req.valid("param");
  const client = await new ConversationService(c.env,getWorkspaceAuth(c)).writableClient(parentId,substreamId);
  return c.json(WorkstreamResourceSchema.parse(await client.attachResource(c.req.valid("json").resourceId)),201);
});
conversationRoutes.delete("/:parentId/substreams/:substreamId/resources/:resourceId",zValidator("param",substreamSocketParam.extend({ resourceId:IdSchema })),async (c) => {
  const { parentId,substreamId,resourceId } = c.req.valid("param");
  const client = await new ConversationService(c.env,getWorkspaceAuth(c)).writableClient(parentId,substreamId);
  await client.detachResource(resourceId);
  return c.body(null,204);
});
/**
 * The Channels this thread can merge into for this person, earliest placement
 * first: the order the client offers them in, so its default is the server's
 * (docs/conversation-merge.md).
 */
conversationRoutes.get("/:parentId/merge-channels",
  zValidator("param", parentParam),
  async (c) => {
    const channels = await new ConversationMergeService(c.env, getWorkspaceAuth(c))
      .writableChannels(c.req.valid("param").parentId);
    return c.json(ConversationMergeChannelsSchema.parse({ channels }));
  });
/**
 * Merge-back (docs/conversation-merge.md). With `breakoutId`, that Breakout's
 * result goes into this Thread's Main as a message that wakes no agent;
 * without it, this Thread's result goes into one of its Channels. The server
 * writes every tag; the body's `resource://` embeds become readable by the
 * merge's audience. A retry with the same `clientMessageId` writes nothing.
 */
conversationRoutes.post("/:parentId/merge",
  zValidator("param", parentParam),
  zValidator("json", ConversationMergeRequestSchema),
  async (c) => {
    const result = await new ConversationMergeService(c.env, getWorkspaceAuth(c))
      .merge(c.req.valid("param").parentId, c.req.valid("json"));
    return c.json(ConversationMergeResultSchema.parse(result), result.replayed ? 200 : 201);
  });
/**
 * Ordinary message admission for an authenticated client that does not hold a
 * conversation socket. Rally's conversation screen keeps using its admitted
 * socket; narrow command clients such as Sideline use this route rather than
 * manufacturing an impersonation relationship for the signed-in user.
 */
conversationRoutes.post("/:parentId/substreams/:substreamId/messages",
  requireSendableMessageLength("text"),
  zValidator("param", substreamSocketParam),
  zValidator("json", CreateMessageRequestSchema),
  async (c) => {
    const { parentId, substreamId } = c.req.valid("param");
    const input = c.req.valid("json");
    const operationId = telemetryOperationId(
      readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID),
    );
    const client = await new ConversationService(c.env, getWorkspaceAuth(c))
        .writableClient(parentId, substreamId);
    return c.json(WorkstreamMessageAdmissionReceiptSchema.parse(await client.createMessage({
      ...input,
      ...(operationId ? { telemetryOperationId: operationId } : {}),
      telemetryRequestReceivedAt: c.get("requestReceivedAt"),
      telemetryJourney: "message_send",
    })), 201);
  });
conversationRoutes.get("/:parentId/substreams/:substreamId/sidekick-recommendation-options", zValidator("param", substreamSocketParam), async (c) => {
  const { parentId, substreamId } = c.req.valid("param");
  return c.json(SidekickRecommendationOptionsSchema.parse(await new WorkstreamService(c.env, getWorkspaceAuth(c))
    .sidekickRecommendationOptions(parentId, substreamId)));
});
conversationRoutes.get("/:parentId/substreams/:substreamId/recommended-sidekicks",zValidator("param",substreamSocketParam),async (c) => {
  const { parentId,substreamId } = c.req.valid("param");
  return c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env,getWorkspaceAuth(c)).recommendedSidekicks(parentId,substreamId)));
});
for (const method of ["put", "delete"] as const) {
  conversationRoutes[method]("/:parentId/substreams/:substreamId/recommended-sidekicks/:sidekickId",
    zValidator("param", substreamSocketParam.extend({ sidekickId: IdSchema })), async (c) => {
      const { parentId, substreamId, sidekickId } = c.req.valid("param");
      return c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getWorkspaceAuth(c))
        .setSidekickRecommendation(parentId, sidekickId, method === "put", substreamId)));
    });
}
conversationRoutes.get("/:parentId/substreams/:substreamId/sidekicks", zValidator("param", substreamSocketParam), async (c) => {
  const { parentId, substreamId } = c.req.valid("param");
  return c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getWorkspaceAuth(c)).sidekickAttachments(parentId, undefined, substreamId)));
});
conversationRoutes.delete("/:parentId/substreams/:substreamId/sidekicks/:sidekickId", zValidator("param", substreamSocketParam.extend({ sidekickId: IdSchema })), async (c) => {
  const { parentId, substreamId, sidekickId } = c.req.valid("param");
  return c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getWorkspaceAuth(c)).sidekickAttachments(parentId, sidekickId, substreamId)));
});
conversationRoutes.post("/:parentId/substreams/prepare", zValidator("param", parentParam), zValidator("json", z.strictObject({
  operationId: IdSchema,
  // Optional because the launch surface has no title field: a substream is
  // named from the message that starts it, and the placeholder the parent
  // reserves it under is replaced at confirmation. A caller that has a title
  // of its own may still say so.
  title: z.string().trim().min(1).max(500).optional(),
  throughTurnId: z.string().min(1).nullable(),
})), async (c) => {
  const auth = getWorkspaceAuth(c);
  const parentId = c.req.valid("param").parentId;
  const operation = await requestFlowSpan(c, "substream.prepare", { flow: "substream_prepare" }, (span) =>
    new SubstreamCreationService(c.env, auth).prepare(parentId, c.req.valid("json"), span));
  const prepared = operation.preparedContext;
  if (!prepared) throw new Error("substream_preparation_missing_context");
  return c.json(SubstreamPreparationPreviewSchema.parse({
    operationId: operation.operationId, substreamId: operation.substreamId, title: operation.title,
    context: {
      source: { workspaceId: auth.workspaceId, workstreamId: asWorkstreamId(parentId), substreamId: asSubstreamId("0") },
      throughTurnId: prepared.capture?.throughTurnId ?? null,
      policyRevision: operation.recipe.policy.revision,
      contentHash: prepared.contentHash,
      parts: prepared.parts.map((part) => part.content),
    },
  }));
});
conversationRoutes.post("/:parentId/substreams/confirm", zValidator("param", parentParam), zValidator("json", z.strictObject({
  operationId: IdSchema,
  /** The instruction the substream is created with, where the caller sent one. */
  opening: SubstreamOpeningMessageSchema.nullish(),
  /**
   * Pins every run of this substream to one model, ahead of the
   * `agent-model-workstream` flag, exactly as `POST /workstreams` pins a work
   * stream. Sent only by the launch composer's developer-mode selector.
   *
   * A sibling of `opening` rather than a field inside it: the pin belongs to
   * the child being created, not to the turn that starts it, and a substream
   * created without an opening message can carry one just the same.
   *
   * It is not inherited from the parent. A substream of a pinned work stream
   * that names nothing here is unpinned and follows the flag, which is what
   * every substream created before this field existed already does.
   */
  modelOverride: AgentModelOverrideSchema.optional(),
})), async (c) => {
  const requestReceivedAt = c.get("requestReceivedAt");
  const body = c.req.valid("json");
  const result = await requestFlowSpan(c, "substream.create", { flow: "substream_create" }, (span) =>
    new SubstreamCreationService(c.env, getWorkspaceAuth(c), requestDeferral(c)).confirm(
      c.req.valid("param").parentId,
      body.operationId,
      body.opening ?? null,
      body.modelOverride ?? null,
      undefined,
      span,
      requestReceivedAt,
    ));
  return c.json(SubstreamCreationResultSchema.parse(result));
});
const childParticipantBody = z.strictObject({ userId: IdSchema, operationId: IdSchema });
conversationRoutes.post("/:parentId/substreams/cancel", zValidator("param", parentParam), zValidator("json", z.strictObject({
  operationId: IdSchema,
})), async (c) => {
  await new SubstreamCreationService(c.env, getWorkspaceAuth(c)).cancel(c.req.valid("param").parentId, c.req.valid("json").operationId);
  return c.body(null, 204);
});
conversationRoutes.post("/:parentId/substreams/:substreamId/participants", zValidator("param", substreamSocketParam),
  zValidator("json", childParticipantBody), async (c) => {
    const param = c.req.valid("param");
    return c.json(MutatePrivateChildParticipantResultSchema.parse(await new SubstreamCreationService(c.env, getWorkspaceAuth(c)).changeParticipant(
      param.parentId, param.substreamId, c.req.valid("json"), true,
    )));
  });
/**
 * A Channel's or Breakout's name and mark for a member who holds its link, and
 * whether they can open it already. Asked only after the socket ticket refuses.
 */
conversationRoutes.get("/:parentId/substreams/:substreamId/access-preview", zValidator("param", substreamSocketParam), async (c) => {
  const param = c.req.valid("param");
  return c.json(ConversationAccessPreviewSchema.parse(
    await new ConversationAccessRequestService(c.env, getWorkspaceAuth(c)).preview(param.parentId, param.substreamId),
  ));
});
/** The approver settles a request from the app: the attention menu's buttons, or the menu bar's modal. */
conversationRoutes.post("/access-requests/:requestId/:decision", zValidator("param", z.strictObject({
  requestId: IdSchema, decision: z.enum(["approve", "decline"]),
})), async (c) => {
  const param = c.req.valid("param");
  return c.json(ConversationAccessDecisionResultSchema.parse(
    await new ConversationAccessRequestService(c.env, getWorkspaceAuth(c)).decide(param.requestId, param.decision),
  ));
});
/** Email the creator a one-click approval. `docs/channel-access-requests.md`. */
conversationRoutes.post("/:parentId/substreams/:substreamId/access-requests", zValidator("param", substreamSocketParam), async (c) => {
  const param = c.req.valid("param");
  await new ConversationAccessRequestService(c.env, getWorkspaceAuth(c)).request(param.parentId, param.substreamId);
  return c.json(ConversationAccessRequestResultSchema.parse({ status: "sent" }), 202);
});
conversationRoutes.post("/:parentId/substreams/:substreamId/participants/remove", zValidator("param", substreamSocketParam),
  zValidator("json", childParticipantBody), async (c) => {
    const param = c.req.valid("param");
    return c.json(MutatePrivateChildParticipantResultSchema.parse(await new SubstreamCreationService(c.env, getWorkspaceAuth(c)).changeParticipant(
      param.parentId, param.substreamId, c.req.valid("json"), false,
    )));
  });
/** Rename the conversation, or change its parent-owned lifecycle state. */
conversationRoutes.patch("/:parentId/substreams/:substreamId", zValidator("param", substreamSocketParam),
  zValidator("json", z.strictObject({
    title: UpdateWorkstreamRequestSchema.shape.title,
    archived: z.boolean().optional(),
    resolved: z.literal(true).optional(),
  }).refine((body) => [body.title, body.archived, body.resolved].filter((value) => value !== undefined).length === 1,
    "Change one of title, archive state or resolution in one request")), async (c) => {
    const param = c.req.valid("param");
    const body = c.req.valid("json");
    if (param.substreamId === "0" && body.archived !== undefined) {
      throw new ApiError(400, "private_substream_required", "Address the thread itself to change its main conversation.");
    }
    if (body.archived !== undefined) {
      await new SubstreamCreationService(c.env, getWorkspaceAuth(c)).archive(param.parentId, param.substreamId, body.archived);
    }
    if (body.resolved) {
      await new SubstreamCreationService(c.env, getWorkspaceAuth(c)).resolve(param.parentId, param.substreamId);
    }
    if (body.title !== undefined) {
      const client = await new ConversationService(c.env, getWorkspaceAuth(c)).client(param.parentId, false, param.substreamId);
      await client.update({ title: body.title });
    }
    return c.body(null, 204);
  });
/**
 * Move this person's read waterline in one conversation.
 *
 * Substream-addressed because read state is substream-owned: every
 * `SubstreamAgent` keeps its own attention ordinals and its own
 * `member_attention` row, and a child's ordinals are deliberately not
 * comparable to Main's. Addressing the work stream instead, which is what
 * `PATCH /workstreams/:id/read-state` did, could only ever advance Main, so a
 * substream's unread divider had nothing that could clear it and stayed above
 * the reply the person was looking at for as long as the child existed.
 *
 * Read-authorized rather than writable: this records what the reader has read
 * rather than changing the conversation, and an automation's conversation stays
 * readable once the automation is archived. Refusing the acknowledgement there
 * would strand that divider the same way.
 *
 * Marking a conversation unread by hand stays on the work stream
 * (`POST /workstreams/:id/read-state/mark-unread`): it is the sidebar's action
 * on a row whose dot is Main's, taken with no conversation open and therefore
 * no substream to address. `docs/choosing-sockets-or-rest.md` holds why neither
 * moved onto the child's socket.
 */
conversationRoutes.patch("/:parentId/substreams/:substreamId/read-state",
  zValidator("param", substreamSocketParam),
  zValidator("json", AcknowledgeWorkstreamReadRequestSchema), async (c) => {
    const param = c.req.valid("param");
    const client = await new ConversationService(c.env, getWorkspaceAuth(c)).client(param.parentId, false, param.substreamId);
    return c.json(WorkstreamSchema.parse(await client.acknowledgeRead(c.req.valid("json"))));
  });
/**
 * Dismiss a suggestion under a turn, for everyone in the conversation. Read-
 * authorized, like acknowledging a read: it records a choice about a line only
 * readers see and changes nothing in the transcript, and the conversation
 * object refuses a suggestion it does not hold. `substreamId` names the
 * Breakout the suggestion sits in, `0` for the Thread's Main.
 * `docs/conversation-suggestions.md`.
 */
conversationRoutes.post("/:parentId/substreams/:substreamId/suggestions/:suggestionId/dismiss",
  zValidator("param", substreamSocketParam.extend({ suggestionId: IdSchema })), async (c) => {
    const param = c.req.valid("param");
    const client = await new ConversationService(c.env, getWorkspaceAuth(c)).client(param.parentId, false, param.substreamId);
    return c.json(ConversationSuggestionDismissResultSchema.parse(await client.dismissSuggestion(param.suggestionId)));
  });
conversationRoutes.get("/:parentId", zValidator("param", parentParam), async (c) => {
  const parentId = c.req.valid("param").parentId;
  const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
  return requestFlowSpan(c, "workstream.detail.read", {
    flow: "workstream_open",
    identity: { workstreamId: parentId },
    attributes: {
      ...(operationId ? { "rally.operation.id": operationId } : {}),
    },
  }, async (span) => {
    const client = await span.step("conversation.authorize", () =>
      new ConversationService(c.env, getWorkspaceAuth(c)).client(parentId, true));
    // This route is the socket-first reader's explicit recovery twin. The
    // object answers detail and its one canonical ordered transcript snapshot.
    const boot = await span.step("workstream.detail.load", () => client.boot());
    span.setAttributes({
      "rally.workstream.participant_count": boot.workstream.participants.length,
      "rally.workstream.resource_count": boot.workstream.resources.length,
      "rally.workstream.harness_status": boot.workstream.harnessStatus,
      "rally.boot.turn_count": boot.transcript.ranges.reduce(
        (count, range) => count + range.turns.length,
        boot.transcript.activeTurns.length,
      ),
    });
    return c.json(WorkstreamBootSchema.parse({
      ...boot.workstream,
      transcript: boot.transcript,
    }));
  });
});
conversationRoutes.post("/:parentId/resources", zValidator("param", parentParam), zValidator("json", resourceBody), async (c) => {
  const client = await new ConversationService(c.env, getWorkspaceAuth(c)).writableClient(c.req.valid("param").parentId);
  return c.json(WorkstreamResourceSchema.parse(await client.attachResource(c.req.valid("json").resourceId)), 201);
});
/** Rename an artifact this thread generated. Every thread that links it reads the new title. */
conversationRoutes.patch("/:parentId/resources/:resourceId", zValidator("param", resourceParam),
  zValidator("json", z.strictObject({ title: ResourceSchema.shape.title })), async (c) => {
    const param = c.req.valid("param");
    const client = await new ConversationService(c.env, getWorkspaceAuth(c)).writableClient(param.parentId);
    await client.renameResource(param.resourceId, c.req.valid("json").title);
    return c.body(null, 204);
  });
conversationRoutes.delete("/:parentId/resources/:resourceId", zValidator("param", resourceParam), async (c) => {
  const param = c.req.valid("param");
  const client = await new ConversationService(c.env, getWorkspaceAuth(c)).writableClient(param.parentId);
  await client.detachResource(param.resourceId);
  return c.body(null, 204);
});
conversationRoutes.get(
  "/:parentId/substreams/:substreamId/socket",
  zValidator("param", substreamSocketParam),
  zValidator("query", SocketTicketQuerySchema),
  async (c) => {
    const param = c.req.valid("param");
    const afterSequence = c.req.valid("query").afterSequence;
    const speculative = c.req.valid("query").speculative ?? false;
    return requestFlowSpan(c, "workstream.socket.ticket", {
      flow: "workstream_open",
      identity: { workstreamId: param.parentId, substreamId: param.substreamId },
    }, async (span) => {
      const issued = await span.step("workstream.socket.ticket.issue", () =>
        new ConversationService(c.env, getWorkspaceAuth(c), requestDeferral(c)).socketTicket(
          param.parentId,
          param.substreamId,
          afterSequence,
          speculative,
        ));
      // The upgrade this authorizes is a new connection, which the platform
      // traces as its own invocation with its own trace id. The ticket id is the
      // attribute both traces carry, and the only thing that joins them.
      span.setAttributes({ "rally.socket.ticket_id": issued.ticketId });
      return c.json(SocketTicketSchema.parse(issued));
    });
  },
);
