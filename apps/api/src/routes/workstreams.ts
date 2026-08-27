import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono, type Context } from "hono";
import { requireSendableMessageLength, zValidator } from "../middleware/validation";
import {
  AcknowledgeWorkstreamReadRequestSchema,
  ActivitySuggestionSchema,
  AddParticipantRequestSchema,
  ApplyWorkstreamBatchRequestSchema,
  AnswerElicitationRequestSchema,
  CreateMessageRequestSchema,
  CreateWorkstreamRequestSchema,
  ElicitationSchema,
  IdSchema,
  BlockDashboardPreferenceSchema,
  BlockDashboardSchema,
  MessageSchema,
  ParticipantSchema,
  PreviewWorkstreamBatchRequestSchema,
  ReorderWorkstreamPinsRequestSchema,
  WorkstreamResourceSchema,
  UpdateBlockDashboardPreferenceRequestSchema,
  UpdateBlockDashboardRequestSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamBootSchema,
  WorkstreamBatchAcceptedSchema,
  WorkstreamBatchPreviewSchema,
  WorkstreamSchema,
  WorkspaceWorkstreamCursorSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { getAuth } from "../middleware/auth";
import { ApiError } from "../lib/api-error";
import { requestFlowSpan, type FlowSpan, type PerfFlow } from "../observability/tracing";
import { WorkstreamService } from "../services/workstream-service";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { WorkstreamDirectoryService } from "../services/workstream-directory-service";
import { WorkstreamObjectCreationService } from "../services/workstream-object-creation-service";
import { WorkstreamBatchUpdateService } from "../services/workstream-batch-update";
import { requireOpenWorkstreamAuthority } from "../services/workstream-authority";
import { BlockDashboardService } from "../services/block-dashboard-service";
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry, telemetryOperationId } from '../telemetry/api-emitter';

const idParam = z.object({ id: IdSchema });
const participantParam = z.object({ id: IdSchema, userId: IdSchema });
const resourceParam = z.object({ id: IdSchema, resourceId: IdSchema });
const elicitationParam = z.object({ id: IdSchema, elicitationId: IdSchema });
const suggestionParam = z.object({ id: IdSchema, suggestionId: IdSchema });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  // Timestamps are still accepted for clients holding pre-cutover cursors;
  // WorkspaceDO emits an opaque `(last_activity_at, workstream_id)` cursor so
  // tied timestamps cannot skip.
  before: z.union([
    z.string().datetime({ offset: true }),
    WorkspaceWorkstreamCursorSchema,
  ]).optional(),
  // Opt-in, because these are machinery. It widens what is shown, never who may
  // see it: a system work stream still requires participation.
  includeSystem: z.enum(["true", "false"]).default("false"),
});
const messageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  around: z.coerce.number().int().positive().optional(),
}).refine(
  (query) => [query.before, query.after, query.around].filter((value) => value !== undefined).length <= 1,
  "Use only one transcript cursor",
);
const resourceBody = z.object({ resourceId: IdSchema });
const substreamSocketParam = idParam.extend({ substreamId: z.union([z.literal("0"), IdSchema]) });

/**
 * Response contracts for the shapes this route composes itself. The single
 * entities come straight from `@rally/contracts`; these are the envelopes
 * around them, and they are what the desktop client parses on arrival.
 */
const WorkstreamPageSchema = z.object({
  items: z.array(WorkstreamSchema),
  nextCursor: z.string().nullable(),
});
const MessagePageSchema = z.object({
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
  newerCursor: z.string().nullable(),
});
const CreatedWorkstreamSchema = z.object({
  workstream: WorkstreamSchema,
  messageId: IdSchema,
  harnessRunId: IdSchema.nullable(),
});
const CreatedMessageSchema = z.object({
  message: MessageSchema,
  agentInvoked: z.boolean(),
  harnessRunId: IdSchema.nullable(),
});
const AnsweredElicitationSchema = z.object({
  elicitation: ElicitationSchema.optional(),
  harnessRunId: IdSchema.nullable(),
});
const ResolvedSuggestionSchema = z.object({
  suggestion: ActivitySuggestionSchema.optional(),
  resourceId: IdSchema.nullable(),
});
const RetriedRunSchema = z.object({ harnessRunId: IdSchema });
/**
 * What every pin mutation answers with: the caller's pinned work streams, in
 * their order. Pinning, unpinning, and reordering all return the same list
 * rather than the row that moved, so a client applies one response the same way
 * whichever of the three it made.
 */
const PinnedWorkstreamsSchema = z.object({ items: z.array(WorkstreamSchema) });
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
});

export const workstreamRoutes = new Hono<HonoAppEnv>();


/**
 * Marks the span failed with the API error's own code before the throw
 * continues. The runtime records that a span threw, but not *what* — and the
 * code is the difference between a 409 idempotency conflict, which is a fast
 * and correct outcome, and a Durable Object that refused, which is not.
 */
async function recordFailure<T>(
  span: FlowSpan,
  fallbackCode: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    span.setError(error instanceof ApiError ? error.code : fallbackCode);
    throw error;
  }
}

/**
 * The Durable-Object client for one work stream. The object is the only
 * execution arm: a stack that never opened the authority gets the 503 refusal
 * from `requireOpenWorkstreamAuthority` rather than legacy code.
 *
 * The authority read is a D1 round trip on the front of every one of these
 * routes, so a traced caller names it as a step rather than letting it fall
 * into whatever runs next.
 */
async function authoritativeWorkstreamClient(
  c: Context<HonoAppEnv>,
  workstreamId: string,
  traced?: { span: FlowSpan; flow: PerfFlow },
): Promise<WorkstreamObjectClient> {
  if (traced) await traced.span.step("authority.read", () => requireOpenWorkstreamAuthority(c.env));
  else await requireOpenWorkstreamAuthority(c.env);
  return new WorkstreamObjectClient(
    c.env,
    getAuth(c),
    workstreamId,
    "0",
    // The object's spans nest under this one automatically: a Durable Object
    // call is a traced binding call, and everything inside it runs in this
    // span's async context.
    traced !== undefined,
  );
}

workstreamRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  await requireOpenWorkstreamAuthority(c.env);
  const service = new WorkstreamDirectoryService(c.env, getAuth(c));
  return c.json(WorkstreamPageSchema.parse(await service.list(
    query.limit, query.before, query.includeSystem === "true",
  )));
});
workstreamRoutes.post("/", requireSendableMessageLength("openingMessage"),
  zValidator("json", CreateWorkstreamRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const auth = getAuth(c);
  const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
  return requestFlowSpan(c, "workstream.create", { flow: "workstream_create" }, async (span) => {
    // This is the one create path where a person is at a keyboard, so it is the
    // only one that can claim an objective was authored rather than derived.
    //
    // The authority read is a step rather than an untimed await: it is a D1
    // round trip on the front of the create, and an unstepped one would be
    // charged to whichever step closed next.
    await span.step("authority.read", () => requireOpenWorkstreamAuthority(c.env));
    span.setAttributes({
      "rally.workstream.attachment_count": body.attachmentIds?.length ?? 0,
      "rally.workstream.participant_count": body.participantUserIds?.length ?? 0,
      ...(operationId ? { "rally.operation.id": operationId } : {}),
    });
    const created = CreatedWorkstreamSchema.parse(
      await recordFailure(span, "workstream_create_failed", () =>
        new WorkstreamObjectCreationService(c.env, auth, requestDeferral(c)).create({
          ...body,
          descriptionSource: body.objective ? "authored" : "derived",
          // The one caller whose `participantUserIds` is people somebody picked
          // by hand, which is what makes telling them the right thing to do.
        }, { span, notifyParticipants: true }))
    );
    span.setAttributes({
      "rally.workstream.id": created.workstream.id,
      "rally.harness_run.id": created.harnessRunId,
    });
    if (operationId) {
      const event = apiTelemetryEnvelope(
        c.env, 'workstream_create_completed', { result: 'success' }, operationId, 'workspace-user',
        c.env.AVALON_REGION, operationId,
      );
      requestDeferral(c)(emitAuthenticatedApiTelemetry(c.env, auth, event).catch(() => undefined));
    }
    return c.json(CreatedWorkstreamSchema.parse(created), 201);
  });
});
// Registered ahead of every `/:id` route so the literal segment is never read
// as an id, whatever order Hono would otherwise resolve them in.
workstreamRoutes.post("/batch/preview", zValidator("json", PreviewWorkstreamBatchRequestSchema), async (c) => {
  await requireOpenWorkstreamAuthority(c.env);
  const result = await new WorkstreamBatchUpdateService(c.env, getAuth(c))
    .preview(c.req.valid("json").filter);
  return c.json(WorkstreamBatchPreviewSchema.parse(result));
});
workstreamRoutes.post("/batch", zValidator("json", ApplyWorkstreamBatchRequestSchema), async (c) => {
  await requireOpenWorkstreamAuthority(c.env);
  const result = await new WorkstreamBatchUpdateService(c.env, getAuth(c))
    .enqueue(c.req.valid("json"));
  return c.json(WorkstreamBatchAcceptedSchema.parse(result), 202);
});
workstreamRoutes.put("/pins", zValidator("json", ReorderWorkstreamPinsRequestSchema), async (c) => {
  await requireOpenWorkstreamAuthority(c.env);
  const result = await new WorkstreamDirectoryService(c.env, getAuth(c)).reorderPins(c.req.valid("json").workstreamIds);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.put("/:id/pin", zValidator("param", idParam), async (c) => {
  await requireOpenWorkstreamAuthority(c.env);
  const result = await new WorkstreamDirectoryService(c.env, getAuth(c)).pin(c.req.valid("param").id);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.delete("/:id/pin", zValidator("param", idParam), async (c) => {
  await requireOpenWorkstreamAuthority(c.env);
  const result = await new WorkstreamDirectoryService(c.env, getAuth(c)).unpin(c.req.valid("param").id);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.get("/:id/block-dashboard", zValidator("param", idParam), async (c) =>
  c.json(BlockDashboardSchema.parse(await new BlockDashboardService(c.env, getAuth(c)).get(c.req.valid("param").id))),
);
workstreamRoutes.put(
  "/:id/block-dashboard/preference",
  zValidator("param", idParam),
  zValidator("json", UpdateBlockDashboardPreferenceRequestSchema),
  async (c) => c.json(BlockDashboardPreferenceSchema.parse(
    await new BlockDashboardService(c.env, getAuth(c)).updatePreference(
      c.req.valid("param").id,
      c.req.valid("json"),
    ),
  )),
);
workstreamRoutes.put("/:id/block-dashboard", zValidator("param", idParam), zValidator("json", UpdateBlockDashboardRequestSchema), async (c) =>
  c.json(BlockDashboardSchema.parse(await new BlockDashboardService(c.env, getAuth(c)).update(
    c.req.valid("param").id,
    c.req.valid("json"),
  ))),
);
workstreamRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id;
  const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
  return requestFlowSpan(c, "workstream.detail.read", {
    flow: "workstream_open",
    identity: { workstreamId: id },
    attributes: {
      ...(operationId ? { "rally.operation.id": operationId } : {}),
    },
  }, async (span) => {
    const client = await authoritativeWorkstreamClient(c, id, { span, flow: "workstream_open" });
    // This route is the socket-first reader's explicit recovery twin. The room
    // answers detail and both transcript windows in one call. HyperSight's
    // optional preference belongs to the independently-started WorkstreamDO
    // control socket and must never extend recovery latency either.
    const boot = await span.step(
      "workstream.detail.load",
      () => client.boot(),
    );
    span.setAttributes({
      "rally.workstream.participant_count": boot.workstream.participants.length,
      "rally.workstream.resource_count": boot.workstream.resources.length,
      "rally.workstream.harness_status": boot.workstream.harnessStatus,
      "rally.boot.message_count": boot.messageFeed.items.length,
      "rally.boot.resumed": boot.resumeFeed !== null,
    });
    return c.json(WorkstreamBootSchema.parse({
      ...boot.workstream,
      transcript: boot.transcript,
      messageFeed: boot.messageFeed,
      resumeFeed: boot.resumeFeed,
    }));
  });
});
workstreamRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", UpdateWorkstreamRequestSchema), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(WorkstreamSchema.parse(await client.update(c.req.valid("json"))));
});
workstreamRoutes.patch("/:id/read-state", zValidator("param", idParam), zValidator("json", AcknowledgeWorkstreamReadRequestSchema), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(WorkstreamSchema.parse(await client.acknowledgeRead(c.req.valid("json"))));
});
workstreamRoutes.post("/:id/read-state/mark-unread", zValidator("param", idParam), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(WorkstreamSchema.parse(await client.markUnread()));
});
workstreamRoutes.get("/:id/messages", zValidator("param", idParam), zValidator("query", messageQuery), async (c) => {
  const query = c.req.valid("query");
  const id = c.req.valid("param").id;
  return requestFlowSpan(c, "workstream.transcript.read", {
    flow: "workstream_open",
    identity: { workstreamId: id },
  }, async (span) => {
    const client = await authoritativeWorkstreamClient(c, id, { span, flow: "workstream_open" });
    const page = await span.step("workstream.transcript.load", () =>
      client.messages(query.limit, query.before, query.after, query.around));
    span.setAttributes({
      "rally.transcript.requested_limit": query.limit,
      "rally.transcript.message_count": page.items.length,
      "rally.transcript.cursor": query.before !== undefined ? "before" : query.after !== undefined ? "after" : query.around !== undefined ? "around" : "latest",
    });
    return c.json(MessagePageSchema.parse(page));
  });
});
workstreamRoutes.post("/:id/messages", zValidator("param", idParam), requireSendableMessageLength("text"),
  zValidator("json", CreateMessageRequestSchema), async (c) => {
  const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
  const id = c.req.valid("param").id;
  const body = c.req.valid("json");
  return requestFlowSpan(c, "workstream.message.send", {
    flow: "workstream_message_send",
    identity: { workstreamId: id },
    attributes: {
      "rally.transport": "http",
      "rally.message.client_id": body.clientMessageId,
      "rally.message.attachment_count": body.attachmentIds?.length ?? 0,
      ...(operationId ? { "rally.operation.id": operationId } : {}),
    },
  }, async (span) => {
    const client = await authoritativeWorkstreamClient(c, id, { span, flow: "workstream_message_send" });
    const result = await span.step("workstream.message.write", () => client.createMessage(body));
    span.setAttributes({
      "rally.agent.invoked": result.agentInvoked,
      "rally.harness_run.id": result.harnessRunId,
    });
    return c.json(CreatedMessageSchema.parse(result), 201);
  });
});
workstreamRoutes.post("/:id/participants", zValidator("param", idParam), zValidator("json", AddParticipantRequestSchema), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(ParticipantSchema.parse(await client.addParticipant(c.req.valid("json").userId)), 201);
});
workstreamRoutes.delete("/:id/participants/:userId", zValidator("param", participantParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  await client.removeParticipant(param.userId);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/resources", zValidator("param", idParam), zValidator("json", resourceBody), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(WorkstreamResourceSchema.parse(await client.attachResource(c.req.valid("json").resourceId)), 201);
});
workstreamRoutes.delete("/:id/resources/:resourceId", zValidator("param", resourceParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  await client.detachResource(param.resourceId);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/elicitations/:elicitationId/answer", zValidator("param", elicitationParam), zValidator("json", AnswerElicitationRequestSchema), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  return c.json(AnsweredElicitationSchema.parse(
    await client.answerElicitation(param.elicitationId, c.req.valid("json")),
  ));
});
workstreamRoutes.post("/:id/activities/:suggestionId/accept", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  return c.json(ResolvedSuggestionSchema.parse(await client.resolveSuggestion(param.suggestionId, "accepted")));
});
workstreamRoutes.post("/:id/activities/:suggestionId/dismiss", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  return c.json(ResolvedSuggestionSchema.parse(await client.resolveSuggestion(param.suggestionId, "dismissed")));
});
workstreamRoutes.post("/:id/stop", zValidator("param", idParam), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  await client.stop();
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/retry", zValidator("param", idParam), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(RetriedRunSchema.parse(await client.retry()), 202);
});
workstreamRoutes.get("/:id/socket", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id;
  return requestFlowSpan(c, "workstream.socket.ticket", {
    flow: "workstream_open",
    identity: { workstreamId: id, substreamId: "0" },
  }, async (span) => {
    const issued = await span.step("workstream.socket.ticket.issue", () =>
      new WorkstreamService(c.env, getAuth(c)).socketTicket(id, "0"));
    // The upgrade this authorizes is a new connection, which the platform
    // traces as its own invocation with its own trace id. The ticket id is the
    // attribute both traces carry, and the only thing that joins them.
    span.setAttributes({
      "rally.socket.ticket_id": issued.ticketId,
    });
    return c.json(SocketTicketSchema.parse(issued));
  });
});
workstreamRoutes.get("/:id/substreams/:substreamId/socket", zValidator("param", substreamSocketParam), async (c) => {
  const param = c.req.valid("param");
  return requestFlowSpan(c, "workstream.socket.ticket", {
    flow: "workstream_open",
    identity: { workstreamId: param.id, substreamId: param.substreamId },
  }, async (span) => {
    const issued = await span.step("workstream.socket.ticket.issue", () =>
      new WorkstreamService(c.env, getAuth(c)).socketTicket(param.id, param.substreamId));
    span.setAttributes({
      "rally.socket.ticket_id": issued.ticketId,
    });
    return c.json(SocketTicketSchema.parse(issued));
  });
});
workstreamRoutes.get("/:id/control-socket", zValidator("param", idParam), async (c) =>
  c.json(SocketTicketSchema.parse(await new WorkstreamService(c.env, getAuth(c))
    .workstreamControlSocketTicket(c.req.valid("param").id))),
);
workstreamRoutes.get(
  "/:id/block-dashboard/blocks/:blockId/socket",
  zValidator("param", idParam.extend({ blockId: IdSchema })),
  async (c) => c.json(SocketTicketSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).blockDashboardBlockSocketTicket(
      c.req.valid("param").id,
      c.req.valid("param").blockId,
    ),
  )),
);
