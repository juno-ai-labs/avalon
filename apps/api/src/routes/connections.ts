import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import {
  CreateWebhookConnectionRequestSchema,
  CreateWebMonitorRequestSchema,
  IdSchema,
  ScopeSchema,
} from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { ConnectionService } from "../services/connection-service";
import {
  GitHubRoutingService,
  isSharedGitHubIngress,
} from "../services/github-routing-service";
import { ProviderWebhookService } from "../services/provider-webhook-service";
import {
  isSharedLinearIngress,
  LinearRoutingService,
} from "../services/linear-routing-service";

const idParam = z.object({ id: IdSchema });
const googleStart = z.object({
  scope: ScopeSchema,
  capabilities: z.array(z.enum([
    "gmail.read",
    "gmail.draft",
    "gmail.send",
    "calendar.read",
    "calendar.write",
    "drive.read",
    "docs.read",
    "docs.write",
    "sheets.read",
    "sheets.write",
  ])).min(1),
});
const linearStart = z.object({
  scope: ScopeSchema,
  capabilities: z.array(z.enum([
    "linear.read",
    "linear.issue.create",
    "linear.comment.create",
    "linear.write",
    "linear.agent",
  ])).min(1),
});
const notionStart = z.object({
  scope: z.literal("personal"),
  capabilities: z.array(z.enum(["notion.read", "notion.insert", "notion.update", "notion.comment.read", "notion.comment.insert"])).min(1),
});
const githubStart = z.object({
  scope: ScopeSchema,
  capabilities: z.array(z.enum([
    "github.metadata.read",
    "github.contents.read",
    "github.issues.read",
    "github.issues.write",
    "github.pull_requests.read",
    "github.pull_requests.write",
    "github.actions.read",
    "github.checks.read",
  ])).min(1),
});
const githubSetup = z.object({
  installation_id: z.string().regex(/^\d{1,32}$/u),
  state: z.string().min(20).max(200),
  setup_action: z.enum(["install", "update"]).optional(),
});
const googleCallback = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(20),
  error: z.string().min(1).optional(),
}).refine((value) => Boolean(value.code || value.error), { message: "Google returned neither a code nor an error" });

export const connectionRoutes = new Hono<HonoAppEnv>();

connectionRoutes.get("/", async (c) => c.json({ items: await new ConnectionService(c.env, getAuth(c)).list() }));
connectionRoutes.post("/google/start", zValidator("json", googleStart), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).beginGoogle(c.req.valid("json"))),
);
connectionRoutes.post("/linear/start", zValidator("json", linearStart), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).beginProvider("linear", c.req.valid("json"))),
);
connectionRoutes.post("/github/start", zValidator("json", githubStart), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).beginGitHub(c.req.valid("json"))),
);
connectionRoutes.post("/notion/start", zValidator("json", notionStart), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).beginProvider("notion", c.req.valid("json"))),
);
connectionRoutes.post("/:id/reconnect", zValidator("param", idParam), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).reconnect(c.req.valid("param").id)),
);
connectionRoutes.post("/:id/test", zValidator("param", idParam), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).test(c.req.valid("param").id)),
);
connectionRoutes.delete("/:id", zValidator("param", idParam), async (c) => {
  await new ConnectionService(c.env, getAuth(c)).disable(c.req.valid("param").id);
  return c.body(null, 204);
});
connectionRoutes.post("/webhook", zValidator("json", CreateWebhookConnectionRequestSchema), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).createWebhook(c.req.valid("json")), 201),
);
connectionRoutes.post("/web-monitor", zValidator("json", CreateWebMonitorRequestSchema), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).createWebMonitor(c.req.valid("json")), 201),
);

export const connectionCallbackRoutes = new Hono<HonoAppEnv>();
connectionCallbackRoutes.get("/github/setup", zValidator("query", githubSetup), async (c) => {
  const query = c.req.valid("query");
  if (isSharedGitHubIngress(c.env, c.req.url)) {
    return c.redirect(
      await new GitHubRoutingService(c.env).setupGitHub(query.installation_id, query.state),
      302,
    );
  }
  const setup = await new ConnectionService(c.env).setupGitHub(query.installation_id, query.state);
  return c.redirect(setup.url, 302);
});
connectionCallbackRoutes.get("/github/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  if (query.error) return c.text("GitHub connection was not authorized", 401);
  return c.redirect(await new ConnectionService(c.env).completeGitHub(query.code!, query.state), 302);
});
connectionCallbackRoutes.get("/google/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  if (query.error) return c.text("Google connection was not authorized", 401);
  return c.redirect(await new ConnectionService(c.env).completeGoogle(query.code!, query.state), 302);
});
connectionCallbackRoutes.get("/linear/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  if (query.error) return c.text("Linear connection was not authorized", 401);
  return c.redirect(await new ConnectionService(c.env).completeProvider("linear", query.code!, query.state), 302);
});
connectionCallbackRoutes.get("/notion/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  if (query.error) return c.text("Notion connection was not authorized", 401);
  return c.redirect(await new ConnectionService(c.env).completeProvider("notion", query.code!, query.state), 302);
});

export const webhookIngestionRoutes = new Hono<HonoAppEnv>();
webhookIngestionRoutes.post("/github", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const result = isSharedGitHubIngress(c.env, c.req.url)
    ? await new GitHubRoutingService(c.env).ingestGitHub(rawBody, c.req.raw.headers)
    : await new ProviderWebhookService(c.env).ingestGitHub(rawBody, c.req.raw.headers);
  return c.json(result, result.duplicate ? 200 : 202);
});
webhookIngestionRoutes.post("/linear", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const result = isSharedLinearIngress(c.env, c.req.url)
    ? await new LinearRoutingService(c.env).ingestLinear(rawBody, c.req.raw.headers)
    : await new ProviderWebhookService(c.env).ingestLinear(rawBody, c.req.raw.headers);
  // Linear treats every non-200 response as a failed delivery and retries it.
  // A verified delivery has been durably recorded before this returns, so both
  // first deliveries and duplicates must be acknowledged with an exact 200.
  return c.json(result, 200);
});
webhookIngestionRoutes.post("/notion", async (c) => {
  const result = await new ProviderWebhookService(c.env).ingestNotion(
    new Uint8Array(await c.req.arrayBuffer()),
    c.req.raw.headers,
    c.req.query("setup") ?? null,
  );
  return c.json(result, result.duplicate ? 200 : 202);
});
webhookIngestionRoutes.post("/webhook/:id", zValidator("param", idParam), async (c) => {
  const result = await new ConnectionService(c.env).ingestWebhook(
    c.req.valid("param").id,
    await c.req.text(),
    c.req.header("x-avalon-signature") ?? null,
  );
  return c.json(result, result.duplicate ? 200 : 202);
});
