import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono } from "hono";
import { requireSendableMessageLength, zValidator } from "../middleware/validation";
import {
  IdSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamResourceSchema,
  WorkstreamBootSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { requestDeferral } from "../lib/defer";
import { getAuth } from "../middleware/auth";
import { requestFlowSpan } from "../observability/tracing";
import { ConversationService } from "../services/conversation-service";
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
conversationRoutes.post("/:parentId/substreams/prepare", zValidator("param", parentParam), zValidator("json", z.strictObject({
  operationId: IdSchema,
  // Optional because the launch surface has no title field: a substream is
  // named from the message that starts it, and the placeholder the parent
  // reserves it under is replaced at confirmation. A caller that has a title
  // of its own may still say so.
  title: z.string().trim().min(1).max(500).optional(),
  throughTurnId: z.string().min(1).nullable(),
})), async (c) => {
  const auth = getAuth(c);
  const parentId = c.req.valid("param").parentId;
  const operation = await new SubstreamCreationService(c.env, auth).prepare(parentId, c.req.valid("json"));
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
conversationRoutes.post("/:parentId/substreams/confirm", requireSendableMessageLength("opening.text"), zValidator("param", parentParam), zValidator("json", z.strictObject({
  operationId: IdSchema,
  /** The instruction the substream is created with, where the caller sent one. */
  opening: SubstreamOpeningMessageSchema.nullish(),
})), async (c) => {
  const body = c.req.valid("json");
  const result = await new SubstreamCreationService(c.env, getAuth(c), requestDeferral(c)).confirm(
    c.req.valid("param").parentId, body.operationId, body.opening ?? null,
  );
  return c.json(SubstreamCreationResultSchema.parse(result));
});
const childParticipantBody = z.strictObject({ userId: IdSchema, operationId: IdSchema });
conversationRoutes.post("/:parentId/substreams/cancel", zValidator("param", parentParam), zValidator("json", z.strictObject({
  operationId: IdSchema,
})), async (c) => {
  await new SubstreamCreationService(c.env, getAuth(c)).cancel(c.req.valid("param").parentId, c.req.valid("json").operationId);
  return c.body(null, 204);
});
conversationRoutes.post("/:parentId/substreams/:substreamId/participants", zValidator("param", substreamSocketParam),
  zValidator("json", childParticipantBody), async (c) => {
    const param = c.req.valid("param");
    return c.json(MutatePrivateChildParticipantResultSchema.parse(await new SubstreamCreationService(c.env, getAuth(c)).changeParticipant(
      param.parentId, param.substreamId, c.req.valid("json"), true,
    )));
  });
conversationRoutes.post("/:parentId/substreams/:substreamId/participants/remove", zValidator("param", substreamSocketParam),
  zValidator("json", childParticipantBody), async (c) => {
    const param = c.req.valid("param");
    return c.json(MutatePrivateChildParticipantResultSchema.parse(await new SubstreamCreationService(c.env, getAuth(c)).changeParticipant(
      param.parentId, param.substreamId, c.req.valid("json"), false,
    )));
  });
/** Rename the child's conversation, or archive its parent-owned directory entry. */
conversationRoutes.patch("/:parentId/substreams/:substreamId", zValidator("param", substreamSocketParam),
  zValidator("json", z.strictObject({
    title: UpdateWorkstreamRequestSchema.shape.title,
    archived: z.boolean().optional(),
  }).refine((body) => (body.title !== undefined) !== (body.archived !== undefined),
    "Change either the title or archive state in one request")), async (c) => {
    const param = c.req.valid("param");
    const body = c.req.valid("json");
    if (param.substreamId === "0") {
      throw new ApiError(400, "private_substream_required", "Address the work stream itself to change its main conversation.");
    }
    if (body.archived !== undefined) {
      await new SubstreamCreationService(c.env, getAuth(c)).archive(param.parentId, param.substreamId, body.archived);
    }
    if (body.title !== undefined) {
      const client = await new ConversationService(c.env, getAuth(c)).writableClient(param.parentId, param.substreamId);
      await client.update({ title: body.title });
    }
    return c.body(null, 204);
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
      new ConversationService(c.env, getAuth(c)).client(parentId, true));
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
  const client = await new ConversationService(c.env, getAuth(c)).writableClient(c.req.valid("param").parentId);
  return c.json(WorkstreamResourceSchema.parse(await client.attachResource(c.req.valid("json").resourceId)), 201);
});
conversationRoutes.delete("/:parentId/resources/:resourceId", zValidator("param", resourceParam), async (c) => {
  const param = c.req.valid("param");
  const client = await new ConversationService(c.env, getAuth(c)).writableClient(param.parentId);
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
        new ConversationService(c.env, getAuth(c), requestDeferral(c)).socketTicket(
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
