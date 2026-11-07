import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono } from "hono";
import { requireSendableMessageLength, zValidator } from "../middleware/validation";
import {
  AcknowledgeWorkstreamReadRequestSchema,
  CreateMessageRequestSchema,
  IdSchema,
  WorkstreamMessageAdmissionReceiptSchema,
  WorkstreamResourceSchema,
  ResourceSchema,
  WorkstreamBootSchema,
  WorkstreamSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { clientReadsResolutionSuggestions } from "../lib/client-contract";
import { requestDeferral } from "../lib/defer";
import { workspaceRealtimeInvalidation } from "../middleware/workspace-realtime";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { requestFlowSpan } from "../observability/tracing";
import { ConversationService } from "../services/conversation-service";
import { telemetryOperationId } from "../telemetry/api-emitter";

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
 * transcript. A Canvas's Chat and a Sidekick's conversation are opened,
 * attached to, and subscribed to through the same routes.
 */
export const conversationRoutes = new Hono<HonoAppEnv>();
// Report an oversized message before session work. This guard only rejects;
// every accepted body still passes workspace auth.
conversationRoutes.post("/:parentId/substreams/:substreamId/messages", requireSendableMessageLength("text"));
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
 * Ordinary message admission for an authenticated client that does not hold a
 * conversation socket. Rally's conversation screen keeps using its admitted
 * socket; a narrow command client sends through this route instead.
 */
conversationRoutes.post("/:parentId/substreams/:substreamId/messages",
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
/**
 * Move this person's read waterline in one conversation.
 *
 * Substream-addressed because read state is substream-owned: every
 * `AgentLoopDO` keeps its own attention ordinals and its own
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
/** Rename an artifact this conversation generated. Every conversation that links it reads the new title. */
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
          clientReadsResolutionSuggestions((name) => c.req.header(name)),
        ));
      // The upgrade this authorizes is a new connection, which the platform
      // traces as its own invocation with its own trace id. The ticket id is the
      // attribute both traces carry, and the only thing that joins them.
      span.setAttributes({ "rally.socket.ticket_id": issued.ticketId });
      return c.json(SocketTicketSchema.parse(issued));
    });
  },
);
