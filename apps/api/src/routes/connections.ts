import { Hono, type Context } from "hono";
import { zValidator } from "../middleware/validation";
import {
  CreateWebhookConnectionRequestSchema,
  IdSchema,
  ScopeSchema,
} from "@avalon/contracts";
import type { ConnectorOAuthProvider } from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { ApiError } from "../lib/api-error";
import { connectorAttemptTarget, desktopHandoffUrl } from "../lib/desktop-handoff";
import { logEvent } from "../observability/logger";
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
import { SlackAgentService } from "../services/slack-agent-service";

const idParam = z.object({ id: IdSchema });
const oauthAttemptParam = z.object({ attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) });
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
const slackStart = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("workspace"),
    capabilities: z.array(z.enum(["slack.agent", "slack.notifications.write"])).min(1),
  }),
  z.object({
    scope: z.literal("personal"),
    capabilities: z.array(z.enum([
      "slack.search", "slack.messages.read", "slack.files.read", "slack.messages.write",
      "slack.conversations.write", "slack.reactions.write", "slack.canvases.read",
      "slack.canvases.write", "slack.users.read",
    ])).min(1),
  }),
]);
const xCreate = z.object({
  scope: ScopeSchema,
  capabilities: z.array(z.literal("x.read")).min(1),
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
const slackLink = z.object({ token: z.string().min(20).max(500) });

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
connectionRoutes.post("/slack/start", zValidator("json", slackStart), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).beginProvider("slack", c.req.valid("json"))),
);
connectionRoutes.post("/x", zValidator("json", xCreate), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).createX(c.req.valid("json")), 201),
);
connectionRoutes.post("/slack/link/preview", zValidator("json", slackLink), async (c) =>
  c.json(await new SlackAgentService(c.env).previewLink(getAuth(c), c.req.valid("json").token)),
);
connectionRoutes.post("/slack/link", zValidator("json", slackLink), async (c) =>
  c.json(await new SlackAgentService(c.env).linkUser(getAuth(c), c.req.valid("json").token)),
);
connectionRoutes.get("/oauth-attempts/:attemptId", zValidator("param", oauthAttemptParam), async (c) =>
  c.json(await new ConnectionService(c.env, getAuth(c)).getOAuthAttempt(c.req.valid("param").attemptId)),
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

export const connectionCallbackRoutes = new Hono<HonoAppEnv>();

type CallbackContext = Context<HonoAppEnv>;

async function recoverConnectorCallback(
  c: CallbackContext,
  provider: ConnectorOAuthProvider,
  errorCode: string,
  recover: () => Promise<string>,
): Promise<string> {
  try {
    return await recover();
  } catch (recoveryError) {
    logEvent(c, "error", "connector_oauth_recovery_failed", {
      provider,
      code: recoveryError instanceof ApiError ? recoveryError.code : "connector_oauth_recovery_failed",
    });
    return connectorAttemptTarget(c.env, {
      provider,
      status: "failed",
      errorCode,
    });
  }
}

async function connectorCallback(
  c: CallbackContext,
  provider: ConnectorOAuthProvider,
  query: z.infer<typeof googleCallback>,
  complete: (service: ConnectionService, code: string, state: string) => Promise<string>,
): Promise<Response> {
  const service = new ConnectionService(c.env);
  c.header("Cache-Control", "no-store");
  try {
    const target = query.error
      ? await service.completeProviderDenial(provider, query.state)
      : await complete(service, query.code!, query.state);
    return c.redirect(desktopHandoffUrl(c.env, target), 302);
  } catch (error) {
    const errorCode = error instanceof ApiError ? error.code : "connector_oauth_failed";
    logEvent(c, error instanceof ApiError ? "warn" : "error", "connector_oauth_callback_failed", {
      provider,
      code: errorCode,
    });
    const target = await recoverConnectorCallback(
      c,
      provider,
      errorCode,
      () => service.failProviderAttempt(provider, query.state, errorCode),
    );
    return c.redirect(desktopHandoffUrl(c.env, target), 302);
  }
}

connectionCallbackRoutes.get("/github/setup", zValidator("query", githubSetup), async (c) => {
  const query = c.req.valid("query");
  const sharedIngress = isSharedGitHubIngress(c.env, c.req.url);
  c.header("Cache-Control", "no-store");
  try {
    if (sharedIngress) {
      return c.redirect(
        await new GitHubRoutingService(c.env).setupGitHub(query.installation_id, query.state),
        302,
      );
    }
    const setup = await new ConnectionService(c.env).setupGitHub(query.installation_id, query.state);
    return c.redirect(setup.url, 302);
  } catch (error) {
    const errorCode = error instanceof ApiError ? error.code : "github_setup_failed";
    logEvent(c, error instanceof ApiError ? "warn" : "error", "github_oauth_setup_failed", {
      code: errorCode,
    });
    const target = await recoverConnectorCallback(c, "github", errorCode, () => sharedIngress
      ? new GitHubRoutingService(c.env).failGitHubSetup(query.state, errorCode)
      : new ConnectionService(c.env).failProviderAttempt("github", query.state, errorCode));
    return c.redirect(desktopHandoffUrl(c.env, target), 302);
  }
});
connectionCallbackRoutes.get("/github/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "github", query, (service, code, state) => service.completeGitHub(code, state));
});
connectionCallbackRoutes.get("/google/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "google", query, (service, code, state) => service.completeGoogle(code, state));
});
connectionCallbackRoutes.get("/linear/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "linear", query, (service, code, state) => service.completeProvider("linear", code, state));
});
connectionCallbackRoutes.get("/notion/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "notion", query, (service, code, state) => service.completeProvider("notion", code, state));
});
connectionCallbackRoutes.get("/slack/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "slack", query, (service, code, state) => service.completeProvider("slack", code, state));
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
