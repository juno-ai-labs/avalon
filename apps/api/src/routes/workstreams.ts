import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AddParticipantRequestSchema,
  AnswerElicitationRequestSchema,
  CreateMessageRequestSchema,
  CreateWorkstreamRequestSchema,
  IdSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamDetailSchema,
} from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { WorkstreamService } from "../services/workstream-service";

const idParam = z.object({ id: IdSchema });
const participantParam = z.object({ id: IdSchema, userId: IdSchema });
const resourceParam = z.object({ id: IdSchema, resourceId: IdSchema });
const elicitationParam = z.object({ id: IdSchema, elicitationId: IdSchema });
const suggestionParam = z.object({ id: IdSchema, suggestionId: IdSchema });
const artifactParam = z.object({ id: IdSchema, artifactId: IdSchema });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(250).default(100), before: z.string().datetime({ offset: true }).optional() });
const messageQuery = z.object({ limit: z.coerce.number().int().min(1).max(250).default(100), before: z.coerce.number().int().positive().optional() });
const resourceBody = z.object({ resourceId: IdSchema });

export const workstreamRoutes = new Hono<HonoAppEnv>();

workstreamRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(await new WorkstreamService(c.env, getAuth(c)).list(query.limit, query.before));
});
workstreamRoutes.post("/", zValidator("json", CreateWorkstreamRequestSchema), async (c) =>
  c.json(await new WorkstreamService(c.env, getAuth(c)).create(c.req.valid("json")), 201),
);
workstreamRoutes.get("/:id/context", zValidator("param", idParam), async (c) =>
  c.json(await new WorkstreamService(c.env, getAuth(c)).context(c.req.valid("param").id)),
);
workstreamRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const detail = await new WorkstreamService(c.env, getAuth(c)).get(c.req.valid("param").id);
  return c.json(WorkstreamDetailSchema.parse(detail));
});
workstreamRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", UpdateWorkstreamRequestSchema), async (c) =>
  c.json(await new WorkstreamService(c.env, getAuth(c)).update(c.req.valid("param").id, c.req.valid("json"))),
);
workstreamRoutes.get("/:id/messages", zValidator("param", idParam), zValidator("query", messageQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(await new WorkstreamService(c.env, getAuth(c)).messages(c.req.valid("param").id, query.limit, query.before));
});
workstreamRoutes.post("/:id/messages", zValidator("param", idParam), zValidator("json", CreateMessageRequestSchema), async (c) => {
  const defer = (promise: Promise<unknown>): void => {
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      // Node-based route tests do not provide a Workers ExecutionContext. The
      // promise is already guarded by the service and may finish normally.
      void promise;
    }
  };
  const result = await new WorkstreamService(c.env, getAuth(c), defer)
    .createMessage(c.req.valid("param").id, c.req.valid("json"));
  return c.json(result, 201);
});
workstreamRoutes.post("/:id/participants", zValidator("param", idParam), zValidator("json", AddParticipantRequestSchema), async (c) =>
  c.json(await new WorkstreamService(c.env, getAuth(c)).addParticipant(c.req.valid("param").id, c.req.valid("json").userId), 201),
);
workstreamRoutes.delete("/:id/participants/:userId", zValidator("param", participantParam), async (c) => {
  const param = c.req.valid("param");
  await new WorkstreamService(c.env, getAuth(c)).removeParticipant(param.id, param.userId);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/resources", zValidator("param", idParam), zValidator("json", resourceBody), async (c) =>
  c.json(await new WorkstreamService(c.env, getAuth(c)).attachResource(c.req.valid("param").id, c.req.valid("json").resourceId), 201),
);
workstreamRoutes.delete("/:id/resources/:resourceId", zValidator("param", resourceParam), async (c) => {
  const param = c.req.valid("param");
  await new WorkstreamService(c.env, getAuth(c)).detachResource(param.id, param.resourceId);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/elicitations/:elicitationId/answer", zValidator("param", elicitationParam), zValidator("json", AnswerElicitationRequestSchema), async (c) => {
  const param = c.req.valid("param");
  return c.json(await new WorkstreamService(c.env, getAuth(c)).answerElicitation(param.id, param.elicitationId, c.req.valid("json")));
});
workstreamRoutes.post("/:id/activities/:suggestionId/accept", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  return c.json(await new WorkstreamService(c.env, getAuth(c)).resolveSuggestion(param.id, param.suggestionId, "accepted"));
});
workstreamRoutes.post("/:id/activities/:suggestionId/dismiss", zValidator("param", suggestionParam), async (c) => {
  const param = c.req.valid("param");
  return c.json(await new WorkstreamService(c.env, getAuth(c)).resolveSuggestion(param.id, param.suggestionId, "dismissed"));
});
workstreamRoutes.post("/:id/stop", zValidator("param", idParam), async (c) => {
  await new WorkstreamService(c.env, getAuth(c)).stop(c.req.valid("param").id);
  return c.body(null, 204);
});
workstreamRoutes.post("/:id/retry", zValidator("param", idParam), async (c) =>
  c.json(await new WorkstreamService(c.env, getAuth(c)).retry(c.req.valid("param").id), 202),
);
workstreamRoutes.get("/:id/socket", zValidator("param", idParam), async (c) =>
  c.json(await new WorkstreamService(c.env, getAuth(c)).socketTicket(c.req.valid("param").id)),
);
workstreamRoutes.get("/:id/artifacts/:artifactId/content", zValidator("param", artifactParam), async (c) => {
  const param = c.req.valid("param");
  const artifact = await new WorkstreamService(c.env, getAuth(c)).artifactContent(param.id, param.artifactId);
  return new Response(artifact.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${artifact.fileName}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
      "Content-Type": artifact.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
