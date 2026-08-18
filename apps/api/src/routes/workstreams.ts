import { Hono, type Context } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AcknowledgeWorkstreamReadRequestSchema,
  ActivitySuggestionSchema,
  AddParticipantRequestSchema,
  AnswerElicitationRequestSchema,
  CreateMessageRequestSchema,
  CreateWorkstreamRequestSchema,
  ElicitationSchema,
  IdSchema,
  BlockDashboardPreferenceSchema,
  BlockDashboardSchema,
  MessageSchema,
  ParticipantSchema,
  ReorderWorkstreamPinsRequestSchema,
  ResourceSchema,
  UpdateBlockDashboardPreferenceRequestSchema,
  UpdateBlockDashboardRequestSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamContextSchema,
  WorkstreamDetailSchema,
  WorkstreamSchema,
  TerminalWorkstreamStateSchema,
} from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { getAuth } from "../middleware/auth";
import { WorkstreamService } from "../services/workstream-service";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { WorkstreamDirectoryService } from "../services/workstream-directory-service";
import { WorkstreamObjectCreationService } from "../services/workstream-object-creation-service";
import { readWorkstreamAuthorityControl } from "../services/workstream-authority";
import { BlockDashboardService } from "../services/block-dashboard-service";
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry, telemetryOperationId } from '../telemetry/api-emitter';
import { parseTerminalRegionConfiguration } from "../services/terminal/contract";
import { createDaytonaTerminalProvider } from "../services/terminal/daytona-provider";
import { TerminalWorkstreamService } from "../services/terminal/workstream-state";

const idParam = z.object({ id: IdSchema });
const participantParam = z.object({ id: IdSchema, userId: IdSchema });
const resourceParam = z.object({ id: IdSchema, resourceId: IdSchema });
const elicitationParam = z.object({ id: IdSchema, elicitationId: IdSchema });
const suggestionParam = z.object({ id: IdSchema, suggestionId: IdSchema });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  before: z.string().datetime({ offset: true }).optional(),
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
 * entities come straight from `@avalon/contracts`; these are the envelopes
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
const SocketTicketSchema = z.object({ url: z.string().min(1), ticket: z.string().min(1) });

export const workstreamRoutes = new Hono<HonoAppEnv>();

function terminalWorkstreamService(c: Context<HonoAppEnv>): TerminalWorkstreamService {
  const configuration = parseTerminalRegionConfiguration(c.env);
  const provider = configuration.capability === "supported"
    ? createDaytonaTerminalProvider(configuration)
    : null;
  return new TerminalWorkstreamService(
    c.env,
    getAuth(c),
    provider,
  );
}

async function authoritativeWorkstreamClient(
  c: Context<HonoAppEnv>,
  workstreamId: string,
): Promise<WorkstreamObjectClient | null> {
  const authority = await readWorkstreamAuthorityControl(c.env);
  return authority.phase === "durable_object_open"
    ? new WorkstreamObjectClient(c.env, getAuth(c), workstreamId)
    : null;
}

workstreamRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  const authority = await readWorkstreamAuthorityControl(c.env);
  const service = authority.phase === "durable_object_open"
    ? new WorkstreamDirectoryService(c.env, getAuth(c))
    : new WorkstreamService(c.env, getAuth(c));
  return c.json(WorkstreamPageSchema.parse(await service.list(
    query.limit, query.before, query.includeSystem === "true",
  )));
});
workstreamRoutes.post("/", zValidator("json", CreateWorkstreamRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const auth = getAuth(c);
  const operationId = telemetryOperationId(c.req.header('x-avalon-operation-id'));
  // This is the one create path where a person is at a keyboard, so it is the
  // only one that can claim an objective was authored rather than derived.
  const authority = await readWorkstreamAuthorityControl(c.env);
  const created = CreatedWorkstreamSchema.parse(authority.phase === "durable_object_open"
    ? await new WorkstreamObjectCreationService(c.env, auth).create({
        ...body,
        descriptionSource: body.objective ? "authored" : "derived",
      })
    : await new WorkstreamService(c.env, auth, requestDeferral(c)).create({
        ...body,
        descriptionSource: body.objective ? "authored" : "derived",
        ...(operationId ? { telemetryOperationId: operationId } : {}),
      }));
  if (operationId) {
    const event = apiTelemetryEnvelope(
      c.env, 'workstream_create_completed', { result: 'success' }, operationId, 'workspace-user',
      c.env.AVALON_REGION, operationId,
    );
    requestDeferral(c)(emitAuthenticatedApiTelemetry(c.env, auth, event).catch(() => undefined));
  }
  return c.json(CreatedWorkstreamSchema.parse(created), 201);
});
// Registered ahead of every `/:id` route so the literal segment is never read
// as an id, whatever order Hono would otherwise resolve them in.
workstreamRoutes.put("/pins", zValidator("json", ReorderWorkstreamPinsRequestSchema), async (c) => {
  const authority = await readWorkstreamAuthorityControl(c.env);
  const result = authority.phase === "durable_object_open"
    ? await new WorkstreamDirectoryService(c.env, getAuth(c)).reorderPins(c.req.valid("json").workstreamIds)
    : await new WorkstreamService(c.env, getAuth(c)).reorderPins(c.req.valid("json").workstreamIds);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.put("/:id/pin", zValidator("param", idParam), async (c) => {
  const authority = await readWorkstreamAuthorityControl(c.env);
  const result = authority.phase === "durable_object_open"
    ? await new WorkstreamDirectoryService(c.env, getAuth(c)).pin(c.req.valid("param").id)
    : await new WorkstreamService(c.env, getAuth(c)).pin(c.req.valid("param").id);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.delete("/:id/pin", zValidator("param", idParam), async (c) => {
  const authority = await readWorkstreamAuthorityControl(c.env);
  const result = authority.phase === "durable_object_open"
    ? await new WorkstreamDirectoryService(c.env, getAuth(c)).unpin(c.req.valid("param").id)
    : await new WorkstreamService(c.env, getAuth(c)).unpin(c.req.valid("param").id);
  return c.json(PinnedWorkstreamsSchema.parse(result));
});
workstreamRoutes.get("/:id/context", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(WorkstreamContextSchema.parse(client
    ? await client.context()
    : await new WorkstreamService(c.env, getAuth(c)).context(id)));
});
workstreamRoutes.get("/:id/block-dashboard", zValidator("param", idParam), async (c) =>
  c.json(BlockDashboardSchema.parse(await new BlockDashboardService(c.env, getAuth(c)).get(c.req.valid("param").id))),
);
workstreamRoutes.get("/:id/block-dashboard/preference", zValidator("param", idParam), async (c) =>
  c.json(BlockDashboardPreferenceSchema.parse(
    await new BlockDashboardService(c.env, getAuth(c)).getPreference(c.req.valid("param").id),
  )),
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
workstreamRoutes.get("/:id/terminal", zValidator("param", idParam), async (c) =>
  c.json(TerminalWorkstreamStateSchema.parse(
    await terminalWorkstreamService(c).get(c.req.valid("param").id),
  )),
);
workstreamRoutes.post("/:id/terminal/start-fresh", zValidator("param", idParam), async (c) =>
  c.json(TerminalWorkstreamStateSchema.parse(
    await terminalWorkstreamService(c).startFresh(c.req.valid("param").id),
  )),
);
workstreamRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  const detail = client
    ? await client.get()
    : await new WorkstreamService(c.env, getAuth(c)).get(id);
  return c.json(WorkstreamDetailSchema.parse(detail));
});
workstreamRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", UpdateWorkstreamRequestSchema), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(WorkstreamSchema.parse(client
    ? await client.update(c.req.valid("json"))
    : await new WorkstreamService(c.env, getAuth(c)).update(id, c.req.valid("json"))));
});
workstreamRoutes.patch("/:id/read-state", zValidator("param", idParam), zValidator("json", AcknowledgeWorkstreamReadRequestSchema), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(WorkstreamSchema.parse(client
    ? await client.acknowledgeRead(c.req.valid("json"))
    : await new WorkstreamService(c.env, getAuth(c)).acknowledgeRead(id, c.req.valid("json"))));
});
workstreamRoutes.post("/:id/read-state/mark-unread", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(WorkstreamSchema.parse(client
    ? await client.markUnread()
    : await new WorkstreamService(c.env, getAuth(c)).markUnread(id)));
});
workstreamRoutes.get("/:id/messages", zValidator("param", idParam), zValidator("query", messageQuery), async (c) => {
  const query = c.req.valid("query");
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(MessagePageSchema.parse(client
    ? await client.messages(query.limit, query.before, query.after, query.around)
    : await new WorkstreamService(c.env, getAuth(c)).messages(
      id, query.limit, query.before, query.after, query.around,
    )));
});
workstreamRoutes.post("/:id/messages", zValidator("param", idParam), zValidator("json", CreateMessageRequestSchema), async (c) => {
  const operationId = telemetryOperationId(c.req.header('x-avalon-operation-id'));
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  const result = client
    ? await client.createMessage(c.req.valid("json"))
    : await new WorkstreamService(c.env, getAuth(c), requestDeferral(c)).createMessage(id, {
        ...c.req.valid("json"),
        ...(operationId ? { telemetryOperationId: operationId } : {}),
      });
  return c.json(CreatedMessageSchema.parse(result), 201);
});
workstreamRoutes.post("/:id/participants", zValidator("param", idParam), zValidator("json", AddParticipantRequestSchema), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(ParticipantSchema.parse(client
    ? await client.addParticipant(c.req.valid("json").userId)
    : await new WorkstreamService(c.env, getAuth(c)).addParticipant(id, c.req.valid("json").userId)), 201);
});
workstreamRoutes.delete("/:id/participants/:userId", zValidator("param", participantParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  await (client
    ? client.removeParticipant(param.userId)
    : new WorkstreamService(c.env, getAuth(c)).removeParticipant(param.id, param.userId));
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/resources", zValidator("param", idParam), zValidator("json", resourceBody), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(ResourceSchema.parse(client
    ? await client.attachResource(c.req.valid("json").resourceId)
    : await new WorkstreamService(c.env, getAuth(c)).attachResource(id, c.req.valid("json").resourceId)), 201);
});
workstreamRoutes.delete("/:id/resources/:resourceId", zValidator("param", resourceParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  await (client
    ? client.detachResource(param.resourceId)
    : new WorkstreamService(c.env, getAuth(c)).detachResource(param.id, param.resourceId));
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/elicitations/:elicitationId/answer", zValidator("param", elicitationParam), zValidator("json", AnswerElicitationRequestSchema), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  return c.json(AnsweredElicitationSchema.parse(client
    ? await client.answerElicitation(param.elicitationId, c.req.valid("json"))
    : await new WorkstreamService(c.env, getAuth(c)).answerElicitation(param.id, param.elicitationId, c.req.valid("json"))));
});
workstreamRoutes.post("/:id/activities/:suggestionId/accept", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  return c.json(ResolvedSuggestionSchema.parse(
    client
      ? await client.resolveSuggestion(param.suggestionId, "accepted")
      : await new WorkstreamService(c.env, getAuth(c)).resolveSuggestion(param.id, param.suggestionId, "accepted")));
});
workstreamRoutes.post("/:id/activities/:suggestionId/dismiss", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  const client = await authoritativeWorkstreamClient(c, param.id);
  return c.json(ResolvedSuggestionSchema.parse(
    client
      ? await client.resolveSuggestion(param.suggestionId, "dismissed")
      : await new WorkstreamService(c.env, getAuth(c)).resolveSuggestion(param.id, param.suggestionId, "dismissed")));
});
workstreamRoutes.post("/:id/stop", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  await (client ? client.stop() : new WorkstreamService(c.env, getAuth(c)).stop(id));
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/retry", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id;
  const client = await authoritativeWorkstreamClient(c, id);
  return c.json(RetriedRunSchema.parse(client
    ? await client.retry()
    : await new WorkstreamService(c.env, getAuth(c)).retry(id)), 202);
});
workstreamRoutes.get("/:id/socket", zValidator("param", idParam), async (c) =>
  c.json(SocketTicketSchema.parse(await new WorkstreamService(c.env, getAuth(c)).socketTicket(c.req.valid("param").id, "0"))),
);
workstreamRoutes.get("/:id/substreams/:substreamId/socket", zValidator("param", substreamSocketParam), async (c) =>
  c.json(SocketTicketSchema.parse(await new WorkstreamService(c.env, getAuth(c)).socketTicket(
    c.req.valid("param").id,
    c.req.valid("param").substreamId,
  ))),
);
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
