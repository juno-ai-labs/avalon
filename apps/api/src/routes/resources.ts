import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import { IdSchema } from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { getAuth } from "../middleware/auth";
import { ResourceService } from "../services/resource-service";

const idParam = z.object({ id: IdSchema });
const resolveBody = z.object({
  connectionId: IdSchema,
  provider: z.string().min(1).max(80),
  providerResourceId: z.string().min(1).max(500),
  resourceType: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  canonicalUrl: z.string().url().nullable().optional(),
});
const watchBody = z.object({ workstreamId: IdSchema });
const watchQuery = z.object({ workstreamId: IdSchema });
const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const resourceRoutes = new Hono<HonoAppEnv>();

resourceRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(await new ResourceService(c.env, getAuth(c)).list({
    ...(query.q ? { query: query.q } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: query.limit,
  }));
});

resourceRoutes.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw new ApiError(422, "file_required", "A file field is required");
  const title = typeof body.title === "string" ? body.title : undefined;
  return c.json(await new ResourceService(c.env, getAuth(c)).upload(file, title), 201);
});
resourceRoutes.post("/resolve", zValidator("json", resolveBody), async (c) =>
  c.json(await new ResourceService(c.env, getAuth(c)).resolve(c.req.valid("json")), 201),
);
resourceRoutes.get("/:id", zValidator("param", idParam), async (c) =>
  c.json(await new ResourceService(c.env, getAuth(c)).get(c.req.valid("param").id)),
);
resourceRoutes.get("/:id/content", zValidator("param", idParam), async (c) =>
  new ResourceService(c.env, getAuth(c)).content(c.req.valid("param").id),
);
resourceRoutes.post("/:id/hydrate", zValidator("param", idParam), async (c) =>
  c.json(await new ResourceService(c.env, getAuth(c)).hydrate(c.req.valid("param").id)),
);
resourceRoutes.post("/:id/watch", zValidator("param", idParam), zValidator("json", watchBody), async (c) =>
  c.json(await new ResourceService(c.env, getAuth(c)).watch(c.req.valid("param").id, c.req.valid("json").workstreamId)),
);
resourceRoutes.delete("/:id/watch", zValidator("param", idParam), zValidator("query", watchQuery), async (c) => {
  await new ResourceService(c.env, getAuth(c)).unwatch(c.req.valid("param").id, c.req.valid("query").workstreamId);
  return c.body(null, 204);
});
