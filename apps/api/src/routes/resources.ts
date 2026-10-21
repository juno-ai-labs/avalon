import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono, type Context } from "hono";
import { zValidator } from "../middleware/validation";
import { IdSchema, ResourceRevisionSchema, ResourceSchema } from "@rally/contracts";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { workspaceRealtimeInvalidation } from "../middleware/workspace-realtime";
import { getRequestMembership, getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { ArtifactOpenService } from "../services/artifact-open-service";
import { ResourceService } from "../services/resource-service";
import { ConversationService } from "../services/conversation-service";

const idParam = z.object({ id: IdSchema });
const versionParam = idParam.extend({ version: z.coerce.number().int().positive() });
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
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ResourcePageSchema = z.object({
  items: z.array(ResourceSchema),
  complete: z.boolean().optional(),
  nextCursor: z.string().nullable(),
});
const ResourceRevisionListSchema = z.array(ResourceRevisionSchema);
const WatchStateSchema = z.object({ watchEnabled: z.boolean() });
const ArtifactOpenResultSchema = z.strictObject({
  openUrl: HttpUrlSchema,
  canonicalUrl: HttpUrlSchema,
  artifactId: IdSchema,
  mode: z.enum(["static", "active"]),
  stateful: z.boolean(),
});
const tableParam = idParam.extend({
  // Model-designed names, so the shape is bounded but not otherwise assumed;
  // whether the table exists is answered by the live schema, not by this.
  table: z.string().min(1).max(200),
});
const tableQuery = z.object({ offset: z.coerce.number().int().nonnegative().default(0) });
const ArtifactDataSchemaSchema = z.strictObject({
  tables: z.array(z.object({
    name: z.string(),
    columns: z.array(z.object({ name: z.string(), type: z.string() })),
    rowCount: z.number().int().nonnegative(),
  })),
});
const ArtifactDataPageSchema = z.strictObject({
  // Visitor-written values under model-designed columns: untrusted content the
  // renderer displays as text and never as markup.
  rows: z.array(z.record(z.string(), z.unknown())),
  csv: z.string(),
});
const ArtifactErrorListSchema = z.array(z.strictObject({
  occurredAt: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  requestPath: z.string(),
  // Model-authored text, so it is bounded here as well as at the write: this
  // reaches a renderer that will display it.
  message: z.string().max(4_000),
  stack: z.string().max(8_000).nullable(),
}));

export const resourceRoutes = new Hono<HonoAppEnv>();
resourceRoutes.use("*",requireWorkspaceAuth);
resourceRoutes.use("*",workspaceRealtimeInvalidation);

function resourceReader(c: Context<HonoAppEnv>): ResourceService {
  const auth = getWorkspaceAuth(c);
  return new ResourceService(c.env, auth, undefined,
    getRequestMembership(c));
}

function artifactReader(c: Context<HonoAppEnv>): ArtifactOpenService {
  return new ArtifactOpenService(c.env, getWorkspaceAuth(c), getRequestMembership(c));
}

resourceRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(ResourcePageSchema.parse(await resourceReader(c).list({
    ...(query.q ? { query: query.q } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: query.limit,
  })));
});

resourceRoutes.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw new ApiError(422, "file_required", "A file field is required");
  const draftId = IdSchema.safeParse(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.DRAFT_ID));
  if (!draftId.success) throw new ApiError(422, "draft_id_required", "A valid draft attachment ID is required");
  const title = typeof body.title === "string" ? body.title : undefined;
  // A long paste arrives as plain text under a stand-in name; the service
  // decides what type it is and what to call it before storing it.
  return c.json(ResourceSchema.parse(await new ResourceService(c.env, getWorkspaceAuth(c))
    .upload(file, title, draftId.data, undefined, body.pastedText === "true")), 201);
});
resourceRoutes.post("/resolve", zValidator("json", resolveBody), async (c) =>
  c.json(ResourceSchema.parse(await new ResourceService(c.env, getWorkspaceAuth(c)).resolve(c.req.valid("json"))), 201),
);
resourceRoutes.get("/:id", zValidator("param", idParam), async (c) =>
  c.json(ResourceSchema.parse(await resourceReader(c).get(c.req.valid("param").id))),
);
resourceRoutes.get("/:id/content", zValidator("param", idParam), async (c) =>
  resourceReader(c).content(c.req.valid("param").id),
);
/**
 * Mint this person's access to a live artifact.
 *
 * `POST` rather than `GET` because it *creates* something — a single-use code —
 * and because a `GET` would be prefetchable and cacheable, both of which are
 * wrong for a credential. The response's `openUrl` carries the code in its
 * fragment, which a browser never sends to a server, so the code stays out of
 * every request log on the way to the artifact origin.
 */
resourceRoutes.post("/:id/artifact/open", zValidator("param", idParam), async (c) => {
  const service = artifactReader(c);
  return c.json(ArtifactOpenResultSchema.parse(await service.open(c.req.valid("param").id)));
});
/** What the artifact's server module threw, for the rail to show a participant. */
resourceRoutes.get("/:id/artifact/errors", zValidator("param", idParam), async (c) =>
  c.json(ArtifactErrorListSchema.parse(
    await artifactReader(c).errors(c.req.valid("param").id),
  )),
);
/** The tables a stateful artifact keeps, for the rail's Data view. */
resourceRoutes.get("/:id/artifact/data", zValidator("param", idParam), async (c) =>
  c.json(ArtifactDataSchemaSchema.parse(
    await artifactReader(c).describeData(c.req.valid("param").id),
  )),
);
/**
 * One page of one table, as rows and as CSV.
 *
 * Both come from one read, so the export can never disagree with what the view
 * showed. The table name is admitted against the live schema inside the facet.
 */
resourceRoutes.get(
  "/:id/artifact/data/:table",
  zValidator("param", tableParam),
  zValidator("query", tableQuery),
  async (c) => {
    const param = c.req.valid("param");
    return c.json(ArtifactDataPageSchema.parse(
      await artifactReader(c)
        .pageData(param.id, param.table, c.req.valid("query").offset),
    ));
  },
);
resourceRoutes.get("/:id/versions", zValidator("param", idParam), async (c) =>
  c.json(ResourceRevisionListSchema.parse(
    await resourceReader(c).versions(c.req.valid("param").id),
  )),
);
resourceRoutes.get("/:id/versions/:version", zValidator("param", versionParam), async (c) => {
  const param = c.req.valid("param");
  return c.json(ResourceRevisionSchema.parse(
    await resourceReader(c).version(param.id, param.version),
  ));
});
resourceRoutes.get("/:id/versions/:version/content", zValidator("param", versionParam), async (c) => {
  const param = c.req.valid("param");
  return resourceReader(c).versionContent(param.id, param.version, "original");
});
resourceRoutes.get("/:id/versions/:version/preview", zValidator("param",versionParam),async(c)=>{
  const param=c.req.valid('param');
  return resourceReader(c).versionPreview(param.id,param.version);
});
resourceRoutes.get("/:id/versions/:version/site-preview", zValidator("param", versionParam), zValidator("query",z.object({path:z.string().default('/')})), async (c) => {
  const param = c.req.valid("param");
  return resourceReader(c).annotationSitePreview(param.id,param.version,c.req.valid('query').path);
});
resourceRoutes.get("/:id/versions/:version/model-content", zValidator("param", versionParam), async (c) => {
  const param = c.req.valid("param");
  return resourceReader(c).versionContent(param.id, param.version, "model");
});
resourceRoutes.get("/:id/preview", zValidator("param", idParam), async (c) =>
  resourceReader(c).preview(c.req.valid("param").id, c.req.raw.signal, c.req.header("if-none-match")),
);
resourceRoutes.delete("/:id", zValidator("param", idParam), async (c) => {
  await new ResourceService(c.env, getWorkspaceAuth(c)).deleteDraft(c.req.valid("param").id);
  return c.body(null, 204);
});
resourceRoutes.post("/:id/hydrate", zValidator("param", idParam), async (c) =>
  c.json(ResourceSchema.parse(await new ResourceService(c.env, getWorkspaceAuth(c)).hydrate(c.req.valid("param").id))),
);
// Watches deliver updates to Main; a child-only share cannot change that feed.
resourceRoutes.post("/:id/watch", zValidator("param", idParam), zValidator("json", watchBody), async (c) => {
  const auth = getWorkspaceAuth(c);
  const { workstreamId } = c.req.valid("json");
  await new ConversationService(c.env, auth).writableClient(workstreamId);
  return c.json(WatchStateSchema.parse(
    await new ResourceService(c.env, auth).watch(c.req.valid("param").id, workstreamId)));
});
resourceRoutes.delete("/:id/watch", zValidator("param", idParam), zValidator("query", watchQuery), async (c) => {
  const auth = getWorkspaceAuth(c);
  const { workstreamId } = c.req.valid("query");
  await new ConversationService(c.env, auth).writableClient(workstreamId);
  await new ResourceService(c.env, auth).unwatch(c.req.valid("param").id, workstreamId);
  return c.body(null, 204);
});
