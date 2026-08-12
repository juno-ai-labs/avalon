import { Hono } from "hono";
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
  HyperSightPreferenceSchema,
  HyperSightSchema,
  MessageSchema,
  ParticipantSchema,
  ReorderWorkstreamPinsRequestSchema,
  ResourceSchema,
  UpdateHyperSightPreferenceRequestSchema,
  UpdateHyperSightRequestSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamContextSchema,
  WorkstreamDetailSchema,
  WorkstreamSchema,
} from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { getAuth } from "../middleware/auth";
import { WorkstreamService } from "../services/workstream-service";
import { HyperSightService } from "../services/hypersight-service";

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

workstreamRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(WorkstreamPageSchema.parse(await new WorkstreamService(c.env, getAuth(c)).list(
    query.limit,
    query.before,
    query.includeSystem === "true",
  )));
});
workstreamRoutes.post("/", zValidator("json", CreateWorkstreamRequestSchema), async (c) => {
  const body = c.req.valid("json");
  // This is the one create path where a person is at a keyboard, so it is the
  // only one that can claim an objective was authored rather than derived.
  return c.json(CreatedWorkstreamSchema.parse(await new WorkstreamService(c.env, getAuth(c), requestDeferral(c)).create({
    ...body,
    descriptionSource: body.objective ? "authored" : "derived",
  })), 201);
});
// Registered ahead of every `/:id` route so the literal segment is never read
// as an id, whatever order Hono would otherwise resolve them in.
workstreamRoutes.put("/pins", zValidator("json", ReorderWorkstreamPinsRequestSchema), async (c) =>
  c.json(PinnedWorkstreamsSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).reorderPins(c.req.valid("json").workstreamIds))),
);
workstreamRoutes.put("/:id/pin", zValidator("param", idParam), async (c) =>
  c.json(PinnedWorkstreamsSchema.parse(await new WorkstreamService(c.env, getAuth(c)).pin(c.req.valid("param").id))),
);
workstreamRoutes.delete("/:id/pin", zValidator("param", idParam), async (c) =>
  c.json(PinnedWorkstreamsSchema.parse(await new WorkstreamService(c.env, getAuth(c)).unpin(c.req.valid("param").id))),
);
workstreamRoutes.get("/:id/context", zValidator("param", idParam), async (c) =>
  c.json(WorkstreamContextSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).context(c.req.valid("param").id))),
);
workstreamRoutes.get("/:id/hypersight", zValidator("param", idParam), async (c) =>
  c.json(HyperSightSchema.parse(await new HyperSightService(c.env, getAuth(c)).get(c.req.valid("param").id))),
);
workstreamRoutes.get("/:id/hypersight/preference", zValidator("param", idParam), async (c) =>
  c.json(HyperSightPreferenceSchema.parse(
    await new HyperSightService(c.env, getAuth(c)).getPreference(c.req.valid("param").id),
  )),
);
workstreamRoutes.put(
  "/:id/hypersight/preference",
  zValidator("param", idParam),
  zValidator("json", UpdateHyperSightPreferenceRequestSchema),
  async (c) => c.json(HyperSightPreferenceSchema.parse(
    await new HyperSightService(c.env, getAuth(c)).updatePreference(
      c.req.valid("param").id,
      c.req.valid("json"),
    ),
  )),
);
workstreamRoutes.put("/:id/hypersight", zValidator("param", idParam), zValidator("json", UpdateHyperSightRequestSchema), async (c) =>
  c.json(HyperSightSchema.parse(await new HyperSightService(c.env, getAuth(c)).update(
    c.req.valid("param").id,
    c.req.valid("json"),
  ))),
);
workstreamRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const detail = await new WorkstreamService(c.env, getAuth(c)).get(c.req.valid("param").id);
  return c.json(WorkstreamDetailSchema.parse(detail));
});
workstreamRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", UpdateWorkstreamRequestSchema), async (c) =>
  c.json(WorkstreamSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).update(c.req.valid("param").id, c.req.valid("json")))),
);
workstreamRoutes.patch("/:id/read-state", zValidator("param", idParam), zValidator("json", AcknowledgeWorkstreamReadRequestSchema), async (c) =>
  c.json(WorkstreamSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).acknowledgeRead(c.req.valid("param").id, c.req.valid("json")))),
);
workstreamRoutes.post("/:id/read-state/mark-unread", zValidator("param", idParam), async (c) =>
  c.json(WorkstreamSchema.parse(await new WorkstreamService(c.env, getAuth(c)).markUnread(c.req.valid("param").id))),
);
workstreamRoutes.get("/:id/messages", zValidator("param", idParam), zValidator("query", messageQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(MessagePageSchema.parse(await new WorkstreamService(c.env, getAuth(c)).messages(
    c.req.valid("param").id,
    query.limit,
    query.before,
    query.after,
    query.around,
  )));
});
workstreamRoutes.post("/:id/messages", zValidator("param", idParam), zValidator("json", CreateMessageRequestSchema), async (c) => {
  const result = await new WorkstreamService(c.env, getAuth(c), requestDeferral(c))
    .createMessage(c.req.valid("param").id, c.req.valid("json"));
  return c.json(CreatedMessageSchema.parse(result), 201);
});
workstreamRoutes.post("/:id/participants", zValidator("param", idParam), zValidator("json", AddParticipantRequestSchema), async (c) =>
  c.json(ParticipantSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).addParticipant(c.req.valid("param").id, c.req.valid("json").userId)), 201),
);
workstreamRoutes.delete("/:id/participants/:userId", zValidator("param", participantParam), async (c) => {
  const param = c.req.valid("param");
  await new WorkstreamService(c.env, getAuth(c)).removeParticipant(param.id, param.userId);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/resources", zValidator("param", idParam), zValidator("json", resourceBody), async (c) =>
  c.json(ResourceSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).attachResource(c.req.valid("param").id, c.req.valid("json").resourceId)), 201),
);
workstreamRoutes.delete("/:id/resources/:resourceId", zValidator("param", resourceParam), async (c) => {
  const param = c.req.valid("param");
  await new WorkstreamService(c.env, getAuth(c)).detachResource(param.id, param.resourceId);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/elicitations/:elicitationId/answer", zValidator("param", elicitationParam), zValidator("json", AnswerElicitationRequestSchema), async (c) => {
  const param = c.req.valid("param");
  return c.json(AnsweredElicitationSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).answerElicitation(param.id, param.elicitationId, c.req.valid("json"))));
});
workstreamRoutes.post("/:id/activities/:suggestionId/accept", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  return c.json(ResolvedSuggestionSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).resolveSuggestion(param.id, param.suggestionId, "accepted")));
});
workstreamRoutes.post("/:id/activities/:suggestionId/dismiss", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  return c.json(ResolvedSuggestionSchema.parse(
    await new WorkstreamService(c.env, getAuth(c)).resolveSuggestion(param.id, param.suggestionId, "dismissed")));
});
workstreamRoutes.post("/:id/stop", zValidator("param", idParam), async (c) => {
  await new WorkstreamService(c.env, getAuth(c)).stop(c.req.valid("param").id);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/retry", zValidator("param", idParam), async (c) =>
  c.json(RetriedRunSchema.parse(await new WorkstreamService(c.env, getAuth(c)).retry(c.req.valid("param").id)), 202),
);
workstreamRoutes.get("/:id/socket", zValidator("param", idParam), async (c) =>
  c.json(SocketTicketSchema.parse(await new WorkstreamService(c.env, getAuth(c)).socketTicket(c.req.valid("param").id))),
);
