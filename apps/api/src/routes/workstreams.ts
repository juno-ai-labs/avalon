import { prepareSessionImport } from "../services/session-import-files";
import {
  SessionImportAbandonRequestSchema,
  SessionImportBreakoutRequestSchema,
  SessionImportBreakoutStartRequestSchema,
  SessionImportDiscardRequestSchema,
  SessionImportRequestSchema,
  SessionImportRunSchema,
  SessionImportSourceResponseSchema,
  SessionImportStartRequestSchema,
  SessionImportUpdateRequestSchema,
  SessionImportUpdateResponseSchema,
} from "@rally/contracts";
import { SubstreamCreationResultSchema } from "@rally/contracts/substream-creation";
import { SessionImportRunService, assertImportIdentity } from "../services/session-import-run-service";
import { MemoryForgetResponseSchema, MemoryReviewSchema } from "@rally/contracts";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono, type Context } from "hono";
import { requireSendableMessageLength, zValidator } from "../middleware/validation";
import {
  AcknowledgeWorkstreamReadRequestSchema,
  AddParticipantRequestSchema,
  ApplyWorkstreamBatchRequestSchema,
  ChannelAccessSchema,
  CreateWorkstreamRequestSchema,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  IdSchema,
  ParticipantSchema,
  PreviewWorkstreamBatchRequestSchema,
  ReorderWorkstreamPinsRequestSchema,
  SpaceIdSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamBatchAcceptedSchema,
  WorkstreamBatchPreviewSchema,
  WorkstreamSchema,
  WorkspaceWorkstreamCursorSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { getAuth, getWorkspaceAuth } from "../middleware/auth";
import { ApiError } from "../lib/api-error";
import { requireCurrentClientContract, requireSessionImportClientContract } from "../lib/client-contract";
import { requestFlowSpan, type FlowSpan, type PerfFlow } from "../observability/tracing";
import { ChannelAccessService } from "../services/channel-access-service";
import { ConversationService } from "../services/conversation-service";
import { WorkstreamService } from "../services/workstream-service";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { WorkstreamDirectoryService } from "../services/workstream-directory-service";
import { WorkstreamObjectCreationService } from "../services/workstream-object-creation-service";
import { WorkstreamBatchUpdateService } from "../services/workstream-batch-update";
import { requireOpenWorkstreamAuthority } from "../services/workstream-authority";
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry, telemetryOperationId } from '../telemetry/api-emitter';

const ChannelLinkSpacesSchema = z.strictObject({ spaceIds: z.array(SpaceIdSchema) });
const idParam = z.object({ id: IdSchema });
const participantParam = z.object({ id: IdSchema, userId: IdSchema });
/** A Thread's Main (`"0"`, the default) or one of its Breakouts. */
const conversationQuery = z.object({ substreamId: z.union([z.literal("0"), IdSchema]).default("0") });
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
/**
 * What Rally remembers about this Thread, or one of its Breakouts by
 * `substreamId`: the facts whose subject is that conversation, as the person
 * may see them from inside it. `docs/agent-memory.md` owns which and who may
 * remove them.
 */
workstreamRoutes.get("/:id/memory", zValidator("param", idParam), zValidator("query", conversationQuery), async (c) =>
  c.json(MemoryReviewSchema.parse(await new WorkstreamService(c.env, getAuth(c))
    .getConversationMemory(c.req.valid("param").id, c.req.valid("query").substreamId))));
workstreamRoutes.delete("/:id/memory/:factId", zValidator("param", z.object({ id: IdSchema, factId: z.string().min(1) })),
  zValidator("query", conversationQuery), async (c) =>
    c.json(MemoryForgetResponseSchema.parse(await new WorkstreamService(c.env, getAuth(c))
      .forgetConversationMemory(c.req.valid("param").id, c.req.valid("param").factId, c.req.valid("query").substreamId))));



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
 * The Durable-Object client for one work stream. Ordinary Channel routes go
 * straight to the object after the completed authority cutover; creation still
 * reads the D1 generation needed for its receipt.
 */
async function authoritativeWorkstreamClient(
  c: Context<HonoAppEnv>,
  workstreamId: string,
  traced?: { span: FlowSpan; flow: PerfFlow },
): Promise<WorkstreamObjectClient> {
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
  // Every row now carries its Spaces, and a build from before the cutover
  // parses this page with a schema that has never heard of them.
  requireCurrentClientContract((name) => c.req.header(name));
  const service = new WorkstreamDirectoryService(c.env, getAuth(c));
  return c.json(WorkstreamPageSchema.parse(await service.list(
    query.limit, query.before, query.includeSystem === "true",
  )));
});
/**
 * Start a conversation import: reserve the Channel and start the agent that
 * reads the conversation in the person's Rally browser. The desktop then
 * drives the agent's browser actions on the returned conversation's socket.
 */
workstreamRoutes.post("/import/runs", zValidator("json", SessionImportStartRequestSchema), async (c) => {
  requireSessionImportClientContract((name) => c.req.header(name));
  const result = await new SessionImportRunService(c.env, getAuth(c), requestDeferral(c)).start(c.req.valid("json"));
  return c.json(SessionImportRunSchema.parse(result), 201);
});
/** Take back a failed start's import by its create key; see `abandon`. */
workstreamRoutes.post("/import/abandon", zValidator("json", SessionImportAbandonRequestSchema), async (c) => {
  await new SessionImportRunService(c.env, getAuth(c), requestDeferral(c)).abandon(c.req.valid("json").clientMessageId);
  return c.body(null, 204);
});
/** Run the import agent again on a Channel imported before. */
workstreamRoutes.post("/:id/import/runs", zValidator("param", idParam), async (c) => {
  requireSessionImportClientContract((name) => c.req.header(name));
  const result = await new SessionImportRunService(c.env, getAuth(c), requestDeferral(c)).startUpdate(c.req.valid("param").id);
  return c.json(SessionImportRunSchema.parse(result), 201);
});
/** Open a reserved Channel with the conversation the agent read. */
workstreamRoutes.post("/:id/import/complete", zValidator("param", idParam), zValidator("json", SessionImportRequestSchema), async (c) => {
  const result = await new SessionImportRunService(c.env, getAuth(c), requestDeferral(c))
    .complete(c.req.valid("param").id, c.req.valid("json"));
  return c.json(CreatedWorkstreamSchema.parse(result), 201);
});
/**
 * Start importing a conversation as a Breakout of this thread: reserve the
 * Breakout and start the agent, exactly as a new-thread import does.
 */
workstreamRoutes.post("/:id/import/breakouts/runs", zValidator("param", idParam), zValidator("json", SessionImportBreakoutStartRequestSchema), async (c) => {
  requireSessionImportClientContract((name) => c.req.header(name));
  const result = await new SessionImportRunService(c.env, getAuth(c), requestDeferral(c))
    .startBreakout(c.req.valid("param").id, c.req.valid("json"));
  return c.json(SessionImportRunSchema.parse(result), 201);
});
/** Open the reserved Breakout with the conversation the agent read. */
workstreamRoutes.post("/:id/import/breakouts/complete", zValidator("param", idParam), zValidator("json", SessionImportBreakoutRequestSchema), async (c) => {
  const result = await new SessionImportRunService(c.env, getAuth(c), requestDeferral(c))
    .completeBreakout(c.req.valid("param").id, c.req.valid("json"));
  return c.json(SubstreamCreationResultSchema.parse(result), 201);
});
/** Stop an import's agent; for a Channel that never opened, archive it too. */
workstreamRoutes.post("/:id/import/discard", zValidator("param", idParam), zValidator("json", SessionImportDiscardRequestSchema), async (c) => {
  const body = c.req.valid("json");
  await new SessionImportRunService(c.env, getAuth(c), requestDeferral(c)).discard({
    workstreamId: c.req.valid("param").id, substreamId: body.substreamId, clientMessageId: body.clientMessageId,
    ...(body.breakout ? { breakout: true } : {}),
  });
  return c.body(null, 204);
});
workstreamRoutes.get("/:id/import/source", zValidator("param", idParam), async (c) => {
  const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
  return c.json(SessionImportSourceResponseSchema.parse({ source: await client.importedSessionSource() }));
});
workstreamRoutes.post("/:id/import/update", zValidator("param", idParam),
  zValidator("json", SessionImportUpdateRequestSchema), async (c) => {
    const body = c.req.valid("json");
    assertImportIdentity(body);
    const client = await authoritativeWorkstreamClient(c, c.req.valid("param").id);
    const checkpoint = await client.importedSessionCheckpoint();
    const recorded = await client.importedSessionSource();
    if (!recorded) throw new ApiError(409, "session_import_source_missing", "This thread has no updateable source session");
    if (body.source.provider !== recorded.provider || body.source.sessionId !== recorded.sessionId
      || body.source.url !== recorded.url) {
      throw new ApiError(409, "session_import_source_mismatch", "Select the original source conversation for this thread");
    }
    const ids = body.content.messages.map((message) => message.sourceMessageId!);
    if (new Set(ids).size !== ids.length) throw new ApiError(422, "session_import_duplicate_message", "The source contains duplicate message IDs");
    if (checkpoint.some((entry, index) => ids[index] !== entry.sourceMessageId)) {
      throw new ApiError(409, "session_import_branch_changed", "The source removed or reordered earlier messages. Import this branch into a new thread");
    }
    const conversation = await prepareSessionImport(c.env, getAuth(c), body, body.clientMessageId,
      new Map(checkpoint.map((message) => [message.sourceMessageId, message.sourceRevision])));
    return c.json(SessionImportUpdateResponseSchema.parse(await client.updateImportedSession(body.clientMessageId, conversation)));
  });
/**
 * Starting a thread, for members and guests alike. Mounted on the identity
 * layer rather than under `requireAuth`: a guest may start a thread in a
 * Channel they take part in, and `WorkspaceDO.reserveChannelInSpaces` decides
 * which Channels a person may start one in. Every other `/workstreams` route
 * stays a member's.
 */
export const workstreamCreateRoutes = new Hono<HonoAppEnv>();
workstreamCreateRoutes.post("/", requireSendableMessageLength("openingMessage"),
  zValidator("json", CreateWorkstreamRequestSchema), async (c) => {
  const requestReceivedAt = c.get("requestReceivedAt");
  const body = c.req.valid("json");
  const auth = getWorkspaceAuth(c);
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
          // A thread somebody starts in Rally is Organization-wide, unless it
          // starts in a private Channel, where `resolveSpaceWorkstreamStart`
          // narrows it to private. A Space grants no audience, so the route
          // says it rather than leaving the fail-closed default to make every
          // new thread private.
          scope: "workspace",
        }, {
          span,
          // The one caller whose `participantUserIds` is people somebody picked
          // by hand, which is what makes telling them the right thing to do.
          notifyParticipants: true,
          // And the one where a person starts a thread in a Channel, so a
          // private Channel's thread starts private.
          narrowInPrivateSpaces: true,
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
  const result = await new WorkstreamBatchUpdateService(c.env, getAuth(c))
    .preview(c.req.valid("json").filter);
  return c.json(WorkstreamBatchPreviewSchema.parse(result));
});
workstreamRoutes.post("/batch", zValidator("json", ApplyWorkstreamBatchRequestSchema), async (c) => {
  const result = await new WorkstreamBatchUpdateService(c.env, getAuth(c))
    .enqueue(c.req.valid("json"));
  return c.json(WorkstreamBatchAcceptedSchema.parse(result), 202);
});
workstreamRoutes.put("/pins", zValidator("json", ReorderWorkstreamPinsRequestSchema), async (c) => {
  const { spaceId, workstreamIds } = c.req.valid("json");
  const result = await new WorkstreamDirectoryService(c.env, getAuth(c)).reorderPins(spaceId, workstreamIds);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.put("/:id/pin", zValidator("param", idParam), zValidator("json", z.strictObject({ spaceId: SpaceIdSchema })), async (c) => {
  const result = await new WorkstreamDirectoryService(c.env, getAuth(c)).pin(c.req.valid("param").id, c.req.valid("json").spaceId);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.delete("/:id/pin", zValidator("param", idParam), zValidator("query", z.strictObject({ spaceId: SpaceIdSchema })), async (c) => {
  const result = await new WorkstreamDirectoryService(c.env, getAuth(c)).unpin(c.req.valid("param").id, c.req.valid("query").spaceId);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
// Through the service, not the object client: a narrowing has to close the
// sockets of the members it drops, which the service publishes.
workstreamRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", UpdateWorkstreamRequestSchema), async (c) => {
  // No authority read here: the service opens the object client itself, which
  // is the read. A second one is a D1 round trip on the front of every audience
  // change that can only ever answer what the first did.
  const result = await new WorkstreamService(c.env, getAuth(c)).update(c.req.valid("param").id, c.req.valid("json"));
  return c.json(WorkstreamSchema.parse(result));
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
  const participant = await new WorkstreamService(c.env, getAuth(c))
    .addParticipant(c.req.valid("param").id, c.req.valid("json").userId);
  return c.json(ParticipantSchema.parse(participant), 201);
});
/**
 * Who may read this Channel, and the Spaces it is placed in: what **Manage
 * access** renders. Gated on management access rather than on reading.
 */
workstreamRoutes.get("/:id/access", zValidator("param", idParam), async (c) => {
  const auth = getAuth(c);
  const workstreamId = c.req.valid("param").id;
  const sources = await new ChannelAccessService(c.env, auth).readSources(workstreamId);
  // The Organization's memberships beside the Channel's own provenance. They
  // agree in the steady state; while an operation is in flight or has been
  // interrupted they do not, and that difference is what **Manage access** has
  // to be able to show rather than average away.
  const workspace = await durableObjectStubForWorkspace(
    c.env, c.env.WORKSPACE_DOS, auth.workspaceId,
    workspaceDOName(c.env.AVALON_REGION, auth.workspaceId),
  );
  const memberships = await workspace.channelSpaces({
    workspaceId: asWorkspaceId(auth.workspaceId),
    userId: asUserId(auth.userId),
    workstreamId: asWorkstreamId(workstreamId),
  });
  return c.json(ChannelAccessSchema.parse({ ...sources, spaceIds: memberships.spaceIds }));
});
/** Viewer-visible Space coordinates for a copied Channel or Breakout URL. */
workstreamRoutes.get("/:id/link-spaces", zValidator("param", idParam), async (c) => {
  const auth = getAuth(c);
  const workstreamId = c.req.valid("param").id;
  await new WorkstreamService(c.env, auth).get(workstreamId);
  const workspace = await durableObjectStubForWorkspace(
    c.env, c.env.WORKSPACE_DOS, auth.workspaceId,
    workspaceDOName(c.env.AVALON_REGION, auth.workspaceId),
  );
  const memberships = await workspace.channelSpaces({
    workspaceId: asWorkspaceId(auth.workspaceId),
    userId: asUserId(auth.userId),
    workstreamId: asWorkstreamId(workstreamId),
  });
  return c.json(ChannelLinkSpacesSchema.parse(memberships));
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
