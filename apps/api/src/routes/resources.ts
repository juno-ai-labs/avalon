import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import { IdSchema, ResourceRevisionSchema, ResourceSchema } from "@rally/contracts";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod/v3";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { getAuth } from "../middleware/auth";
import { ResourceService } from "../services/resource-service";

const idParam = z.object({ id: IdSchema });
const versionParam = idParam.extend({ version: z.coerce.number().int().safe().positive() });
const resolveBody = z.object({
  connectionId: IdSchema,
  provider: z.string().min(1).max(80),
  providerResourceId: z.string().min(1).max(500),
  resourceType: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  canonicalUrl: HttpUrlSchema.nullable().optional(),
});
const watchBody = z.object({ workstreamId: IdSchema });
const watchQuery = z.object({ workstreamId: IdSchema });
const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().safe().min(1).max(100).default(50),
});

const ResourcePageSchema = z.object({
  items: z.array(ResourceSchema),
  nextCursor: z.string().nullable(),
});
const ResourceRevisionListSchema = z.array(ResourceRevisionSchema);
const WatchStateSchema = z.object({ watchEnabled: z.boolean() });

export const resourceRoutes = new Hono<HonoAppEnv>();

resourceRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(ResourcePageSchema.parse(await new ResourceService(c.env, getAuth(c)).list({
    ...(query.q ? { query: query.q } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: query.limit,
  })));
});

resourceRoutes.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw new ApiError(422, "file_required", "A file field is required");
  const title = typeof body.title === "string" ? body.title : undefined;
  const draftId = IdSchema.safeParse(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.DRAFT_ID));
  if (!draftId.success) throw new ApiError(422, "draft_id_required", "A valid draft attachment ID is required");
  return c.json(ResourceSchema.parse(
    await new ResourceService(c.env, getAuth(c)).upload(file, title, draftId.data)), 201);
});
resourceRoutes.post("/resolve", zValidator("json", resolveBody), async (c) =>
  c.json(ResourceSchema.parse(await new ResourceService(c.env, getAuth(c)).resolve(c.req.valid("json"))), 201),
);
resourceRoutes.get("/:id", zValidator("param", idParam), async (c) =>
  c.json(ResourceSchema.parse(await new ResourceService(c.env, getAuth(c)).get(c.req.valid("param").id))),
);
resourceRoutes.get("/:id/content", zValidator("param", idParam), async (c) =>
  new ResourceService(c.env, getAuth(c)).content(c.req.valid("param").id),
);
resourceRoutes.get("/:id/versions", zValidator("param", idParam), async (c) =>
  c.json(ResourceRevisionListSchema.parse(
    await new ResourceService(c.env, getAuth(c)).versions(c.req.valid("param").id),
  )),
);
resourceRoutes.get("/:id/versions/:version", zValidator("param", versionParam), async (c) => {
  const param = c.req.valid("param");
  return c.json(ResourceRevisionSchema.parse(
    await new ResourceService(c.env, getAuth(c)).version(param.id, param.version),
  ));
});
resourceRoutes.get("/:id/versions/:version/content", zValidator("param", versionParam), async (c) => {
  const param = c.req.valid("param");
  return new ResourceService(c.env, getAuth(c)).versionContent(param.id, param.version, "original");
});
resourceRoutes.get("/:id/versions/:version/model-content", zValidator("param", versionParam), async (c) => {
  const param = c.req.valid("param");
  return new ResourceService(c.env, getAuth(c)).versionContent(param.id, param.version, "model");
});
resourceRoutes.get("/:id/preview", zValidator("param", idParam), async (c) =>
  new ResourceService(c.env, getAuth(c)).preview(c.req.valid("param").id, c.req.raw.signal),
);
resourceRoutes.delete("/:id", zValidator("param", idParam), async (c) => {
  await new ResourceService(c.env, getAuth(c)).deleteDraft(c.req.valid("param").id);
  return c.body(null, 204);
});
resourceRoutes.post("/:id/hydrate", zValidator("param", idParam), async (c) =>
  c.json(ResourceSchema.parse(await new ResourceService(c.env, getAuth(c)).hydrate(c.req.valid("param").id))),
);
resourceRoutes.post("/:id/watch", zValidator("param", idParam), zValidator("json", watchBody), async (c) =>
  c.json(WatchStateSchema.parse(
    await new ResourceService(c.env, getAuth(c)).watch(c.req.valid("param").id, c.req.valid("json").workstreamId))),
);
resourceRoutes.delete("/:id/watch", zValidator("param", idParam), zValidator("query", watchQuery), async (c) => {
  await new ResourceService(c.env, getAuth(c)).unwatch(c.req.valid("param").id, c.req.valid("query").workstreamId);
  return c.body(null, 204);
});
