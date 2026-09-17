import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import { prepareSessionImport, resolveSessionImportFiles } from "../services/session-import-files";
import { SessionImportPreviewSchema, SessionImportPreviewRequestSchema, SessionImportRequestSchema } from "@rally/contracts";
import { previewSessionImport, sessionShareUrl } from "../services/session-import";
import { SidekickAttachmentsSchema } from "@rally/contracts";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono, type Context } from "hono";
import { requireSendableMessageLength, zValidator } from "../middleware/validation";
import {
  AcknowledgeWorkstreamReadRequestSchema,
  AddParticipantRequestSchema,
  ApplyWorkstreamBatchRequestSchema,
  CreateWorkstreamRequestSchema,
  IdSchema,
  ParticipantSchema,
  PreviewWorkstreamBatchRequestSchema,
  ReorderWorkstreamPinsRequestSchema,
  UpdateWorkstreamRequestSchema,
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
import { ConversationService } from "../services/conversation-service";
import { WorkstreamService } from "../services/workstream-service";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { WorkstreamDirectoryService } from "../services/workstream-directory-service";
import { WorkstreamObjectCreationService } from "../services/workstream-object-creation-service";
import { WorkstreamBatchUpdateService } from "../services/workstream-batch-update";
import { requireOpenWorkstreamAuthority } from "../services/workstream-authority";
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry, telemetryOperationId } from '../telemetry/api-emitter';

const idParam = z.object({ id: IdSchema });
const participantParam = z.object({ id: IdSchema, userId: IdSchema });
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

/**
 * Response contracts for the shapes this route composes itself. The single
 * entities come straight from `@rally/contracts`; these are the envelopes
 * around them, and they are what the desktop client parses on arrival.
 */
const WorkstreamPageSchema = z.object({
  items: z.array(WorkstreamSchema),
  nextCursor: z.string().nullable(),
});
const CreatedWorkstreamSchema = z.strictObject({
  workstream: WorkstreamSchema,
  turnId: IdSchema,
  harnessRunId: IdSchema.nullable(),
});
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
  subscriptionBootstrap: z.boolean().optional(),
});

export const workstreamRoutes = new Hono<HonoAppEnv>();
workstreamRoutes.get("/:id/recommended-sidekicks", zValidator("param", idParam), async (c) =>
  c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getAuth(c)).recommendedSidekicks(c.req.valid("param").id))));
workstreamRoutes.put("/:id/recommended-sidekicks/:sidekickId", zValidator("param", z.object({ id: IdSchema, sidekickId: IdSchema })), async (c) => {
  const { id, sidekickId } = c.req.valid("param");
  return c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getAuth(c)).setSidekickRecommendation(id, sidekickId, true)));
});
workstreamRoutes.delete("/:id/recommended-sidekicks/:sidekickId", zValidator("param", z.object({ id: IdSchema, sidekickId: IdSchema })),
  zValidator("query", z.object({ substreamId: z.union([z.literal("0"), IdSchema]).default("0") })), async (c) => {
    const { id, sidekickId } = c.req.valid("param");
    return c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getAuth(c)).setSidekickRecommendation(id, sidekickId, false, c.req.valid("query").substreamId)));
  });
workstreamRoutes.get("/:id/sidekicks", zValidator("param", idParam), async (c) =>
  c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getAuth(c)).sidekickAttachments(c.req.valid("param").id))));
workstreamRoutes.delete("/:id/sidekicks/:sidekickId", zValidator("param", z.object({ id: IdSchema, sidekickId: IdSchema })), async (c) =>
  c.json(SidekickAttachmentsSchema.parse(await new WorkstreamService(c.env, getAuth(c)).sidekickAttachments(c.req.valid("param").id, c.req.valid("param").sidekickId))));



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
workstreamRoutes.post("/import/preview", zValidator("json", SessionImportPreviewRequestSchema), async (c) => {
  return c.json(SessionImportPreviewSchema.parse(await resolveSessionImportFiles(c.env, await previewSessionImport(c.req.valid("json"), c.env))));
});
workstreamRoutes.post("/import", zValidator("json", SessionImportRequestSchema), async (c) => {
  const body = c.req.valid("json");
  if (body.source.url && sessionShareUrl(body.source.url).provider !== body.source.provider) {
    throw new ApiError(422, "invalid_session_source", "The source does not match the provider");
  }
  const conversation = await prepareSessionImport(c.env, getAuth(c), body, body.clientMessageId);
  const result = await new WorkstreamObjectCreationService(c.env, getAuth(c), requestDeferral(c)).createPrepared({
    objective: body.title,
    clientMessageId: body.clientMessageId,
    participantUserIds: [],
    scope: "personal",
  }, conversation, { reason: "session_import", contentIdentityHash: workstreamImportHash(body) });
  return c.json(CreatedWorkstreamSchema.parse(result), 201);
});
workstreamRoutes.post("/", requireSendableMessageLength("openingMessage"),
  zValidator("json", CreateWorkstreamRequestSchema), async (c) => {
  const requestReceivedAt = Date.now();
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
    const authorityControl = await span.step("authority.read", () => requireOpenWorkstreamAuthority(c.env));
    span.setAttributes({
      "rally.workstream.attachment_count": body.attachmentIds?.length ?? 0,
      "rally.workstream.participant_count": body.participantUserIds?.length ?? 0,
      ...(operationId ? { "rally.operation.id": operationId } : {}),
    });
    const result = await recordFailure(span, "workstream_create_failed", () =>
      new WorkstreamObjectCreationService(c.env, auth, requestDeferral(c)).create({
          ...body,
          descriptionSource: body.objective ? "authored" : "derived",
          // The one caller whose `participantUserIds` is people somebody picked
          // by hand, which is what makes telling them the right thing to do.
        }, {
          span,
          notifyParticipants: true,
          authorityControl,
          ...(operationId ? { telemetryOperationId: operationId } : {}),
          telemetryRequestReceivedAt: requestReceivedAt,
        }));
    const created = CreatedWorkstreamSchema.parse(result);
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
workstreamRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", UpdateWorkstreamRequestSchema), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(WorkstreamSchema.parse(await client.update(c.req.valid("json"))));
});
/**
 * A released desktop's read acknowledgement, draining.
 *
 * **Not the current route.** Acknowledging a read belongs to the conversation
 * that was read, because the waterline does: `PATCH
 * /conversations/:parentId/substreams/:substreamId/read-state`. This one stays
 * because the Worker deploys ahead of the desktop, the updater installs on
 * quit (`autoInstallOnAppQuit`), and nothing in the product refuses a client by
 * version, so a build that is open while this ships would send here for as long
 * as its window stays open. Answering 404 would not merely leave its dividers
 * up: the client re-requests a socket snapshot on a failed acknowledgement, the
 * snapshot re-runs the effect that sends one, and the pair sustains itself for
 * the life of the session. `architecture.md` kept WorkspaceDO's `create_message`
 * for the same reason on 2026-09-01.
 *
 * Main only, which is all an old client ever addressed. It goes through
 * `ConversationService` rather than the work stream's own client so the parent
 * decides, the way the current route does, rather than preserving the skipped
 * `authorizeViewer` this replaces.
 *
 * **Remove it** once no build that sends here is still running.
 */
workstreamRoutes.patch("/:id/read-state", zValidator("param", idParam), zValidator("json", AcknowledgeWorkstreamReadRequestSchema), async (c) => {
  const client = await new ConversationService(c.env, getAuth(c)).client(c.req.valid("param").id, false, "0");
  return c.json(WorkstreamSchema.parse(await client.acknowledgeRead(c.req.valid("json"))));
});
/**
 * Mark a work stream unread from the sidebar, where no conversation is open.
 *
 * Main's, and only Main's: the sidebar row's dot is drawn from Main's viewer
 * overlay, and this is addressed with no conversation on screen to name a
 * substream with. Acknowledging a read is the opposite case (the reader has a
 * conversation open, which may be a child) and lives on that conversation:
 * `PATCH /conversations/:parentId/substreams/:substreamId/read-state`.
 */
workstreamRoutes.post("/:id/read-state/mark-unread", zValidator("param", idParam), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(WorkstreamSchema.parse(await client.markUnread()));
});
workstreamRoutes.post("/:id/participants", zValidator("param", idParam), zValidator("json", AddParticipantRequestSchema), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(ParticipantSchema.parse(await client.addParticipant(c.req.valid("json").userId)), 201);
});
workstreamRoutes.delete("/:id/participants/:userId", zValidator("param", participantParam), async (c) => {
  const param = c.req.valid("param");
  await new WorkstreamService(c.env, getAuth(c)).removeParticipant(param.id, param.userId);
  return c.body(null, 204);
});
// The conversation surface — boot, resources, feed sockets — lives under
// `/conversations/:parentId`, where a work stream and an automation are
// addressed the same way. What stays here is the work stream as a workspace
// object: listing, pins, participants, its metadata, and its control socket.
workstreamRoutes.get("/:id/control-socket", zValidator("param", idParam), async (c) =>
  c.json(SocketTicketSchema.parse(await new WorkstreamService(c.env, getAuth(c))
    .workstreamControlSocketTicket(c.req.valid("param").id))),
);
