import { providerWebhookMaxBytes, readBoundedRequestBytes } from "../lib/bounded-request-body";
import { AshbyIngestionResultSchema } from "../services/ashby-routing-service";
import { ConnectorApiKeyGuidanceCatalog, ConnectorInstallationReadResponseSchema, ConnectorInstallationMutationResponseSchema, ConnectorInstallationSetupResponseSchema, ConnectionTestResponseSchema } from "@rally/contracts";
import { AshbyEventSelectionSchema } from "@rally/connectors";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { Hono, type Context } from "hono";
import { zValidator } from "../middleware/validation";
import {
  ConnectionSchema,
  ConnectionToolCountSchema,
  ConnectorOAuthAttemptSchema,
  ConnectorOAuthStartSchema,
  ConnectorResourceAuthorizationStartSchema,
  CreateCustomMcpConnectionRequestSchema,
  CreateWebhookConnectionRequestSchema,
  CustomMcpConnectionSettingsSchema,
  StartCustomMcpConnectionRequestSchema,
  UpdateCustomMcpToolPolicyRequestSchema,
  GitHubRepositoryAccessSettingsSchema,
  IdSchema,
  ScopeSchema,
  StartConnectorResourceAuthorizationRequestSchema,
  UpdateGitHubRepositoryAccessSettingsSchema,
} from "@rally/contracts";
import type { ConnectorOAuthProvider } from "@rally/contracts";
import { z } from "zod";
import { telemetryOperationId } from "../telemetry/api-emitter";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { noteChangedConnection } from "../middleware/workspace-realtime";
import { ApiError } from "../lib/api-error";
import { classifyConnectorOAuthCallbackFailure } from "../lib/connector-oauth-error";
import { desktopHandoffUrl, unknownConnectorAttemptFailureTarget, type ConnectorHandoff } from "../lib/desktop-handoff";
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
import {
  isSharedNotionIngress,
  notionIngressIsElsewhere,
  notionIngressUrl,
} from "../lib/notion-ingress";
import { NotionRoutingService } from "../services/notion-routing-service";
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
const notionStart = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("personal"),
    capabilities: z.array(z.literal("notion.personal.mcp")).length(1),
  }),
  z.object({
    scope: z.literal("workspace"),
    capabilities: z.array(z.enum([
      "notion.read", "notion.insert", "notion.update", "notion.comment.read", "notion.comment.insert",
    ])).min(1),
  }),
]);
const apolloStart = z.object({
  scope: z.literal("personal"),
  capabilities: z.array(z.literal("apollo.personal.mcp")).length(1),
});
const firefliesStart = z.object({
  scope: z.literal("personal"),
  capabilities: z.array(z.literal("fireflies.personal.read")).length(1),
});
const granolaStart = z.object({
  scope: z.literal("personal"),
  capabilities: z.array(z.literal("granola.personal.read")).length(1),
});
const granolaWorkspace = z.strictObject({
  idempotencyKey: z.string().uuid().optional(),
  apiKey: z.string().trim().regex(ConnectorApiKeyGuidanceCatalog.granola.format.pattern),
  capabilities: z.array(z.literal("granola.workspace.read")).length(1),
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
    capabilities: z.array(z.enum([
      "slack.search", "slack.messages.read", "slack.files.read", "slack.users.read",
      "slack.messages.write", "slack.conversations.write", "slack.reactions.write",
      "slack.agent", "slack.notifications.write",
    ])).min(1),
  }),
  z.object({
    scope: z.literal("personal"),
    capabilities: z.array(z.literal("slack.personal.mcp")).length(1),
  }),
]);
const xCreate = z.object({
  scope: z.literal("workspace"),
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
  picked_file_ids: z.string().optional(),
}).refine((value) => Boolean(value.code || value.error), { message: "Google returned neither a code nor an error" });
const slackLink = z.object({ token: z.string().min(20).max(500) });
/**
 * Response contracts for this route's envelopes. The connector entities come
 * from `@rally/contracts`; the wrappers, the webhook credentials and the
 * provider acknowledgements are shaped here.
 */
const ConnectionPageSchema = z.object({ items: z.array(ConnectionSchema) });
const ConnectorCatalogSchema = z.object({ availableConnectorTypes: z.array(z.string().min(1)) });
const CreatedConnectionSchema = z.object({ connection: ConnectionSchema });
const WebhookCredentialsSchema = z.object({
  endpoint: z.string().min(1),
  signingSecret: z.string().min(1),
  signatureFormat: z.string().min(1),
});
const WebhookConnectionSchema = WebhookCredentialsSchema.extend({ connection: ConnectionSchema });
const SlackLinkPreviewSchema = z.object({
  teamId: z.string().min(1),
  slackUserId: z.string().min(1),
  workspaceName: z.string(),
});
const SlackLinkedSchema = z.object({
  linked: z.literal(true),
  teamId: z.string().min(1),
  slackUserId: z.string().min(1),
});
/** What a provider is told about a delivery it just made. */
const WebhookIngestionSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  activityCount: z.number().int().nonnegative(),
});
const ConnectorWebhookIngestionSchema = z.object({
  duplicate: z.boolean(),
  activityId: IdSchema.nullable().optional(),
  /** Activities the delivery implied and the adapter derived, stored beside the named one. */
  derivedActivityIds: z.array(IdSchema).optional(),
});
/** A Fireflies delivery is an activity, or the dashboard's test event answered on its own. */
const FirefliesWebhookResponseSchema = z.union([z.strictObject({ ping: z.literal(true) }), ConnectorWebhookIngestionSchema]);

export const connectionRoutes = new Hono<HonoAppEnv>();

async function bindConnectorTelemetry(
  c: Context<HonoAppEnv>,
  service: ConnectionService,
  result: z.infer<typeof ConnectorOAuthStartSchema>,
): Promise<z.infer<typeof ConnectorOAuthStartSchema>> {
  const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
  const telemetryVersion = c.req.query('telemetryVersion') === '2' ? 2 : 1;
  if (operationId) await service.bindOAuthTelemetry(result.attemptId, operationId, telemetryVersion);
  return result;
}

/**
 * How this start returns to its client. The browser asks with
 * `?handoff=browser` and returns to its completion page; a desktop build sends
 * its deep-link version.
 */
function desktopHandoffVersion(c: Context<HonoAppEnv>): ConnectorHandoff {
  if (c.req.query('handoff') === 'browser') return 'browser';
  return c.req.query('desktopHandoffVersion') === '2' ? 2 : 1;
}

connectionRoutes.get("/", async (c) =>
  c.json(ConnectionPageSchema.parse({ items: await new ConnectionService(c.env, getAuth(c)).list() })));
connectionRoutes.get("/catalog", async (c) => c.json(ConnectorCatalogSchema.parse({
  availableConnectorTypes: new ConnectionService(c.env, getAuth(c)).availableConnectorTypes(),
})));
connectionRoutes.post("/google/start", zValidator("json", googleStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginGoogle({
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.post("/linear/start", zValidator("json", linearStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginProvider("linear", {
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.post("/github/start", zValidator("json", githubStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginGitHub({
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.post("/notion/start", zValidator("json", notionStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginProvider("notion", {
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.post("/ashby/start", zValidator("json", z.strictObject({ scope: z.literal("personal"), capabilities: z.array(z.literal("ashby.personal.mcp")).length(1) })), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(c, service,
    await service.beginProvider("ashby", { ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c) }))));
});
const AshbyWebhookResponseSchema = AshbyIngestionResultSchema;
connectionRoutes.post("/ashby/workspace", zValidator("json", z.strictObject({
  apiKey: z.string().trim().min(1), idempotencyKey: z.string().uuid(), events: AshbyEventSelectionSchema.optional(),
})), async (c) => c.json(ConnectorInstallationSetupResponseSchema.parse(await new ConnectionService(c.env, getAuth(c)).createWorkspaceInstallation({ provider: "ashby", ...c.req.valid("json") })), 201));
connectionRoutes.post("/:id/installation/api-key", zValidator("param", idParam), zValidator("json", z.strictObject({ apiKey: z.string().trim().min(1) })), async (c) =>
  c.json(ConnectorInstallationMutationResponseSchema.parse(await new ConnectionService(c.env, getAuth(c)).replaceInstallationApiKey(c.req.valid("param").id, c.req.valid("json").apiKey, c.req.raw.signal))));
connectionRoutes.get("/:id/installation", zValidator("param", idParam), async (c) =>
  c.json(ConnectorInstallationReadResponseSchema.parse(await new ConnectionService(c.env, getAuth(c)).installation(c.req.valid("param").id))));
connectionRoutes.post("/:id/installation", zValidator("param", idParam), zValidator("json", z.strictObject({
  action: z.enum(["repair", "disconnect", "forget_cleanup", "reconcile", "rotate"]), key: z.string().optional(), providerId: z.string().optional(),
})), async (c) => c.json(ConnectorInstallationMutationResponseSchema.parse(await new ConnectionService(c.env, getAuth(c)).changeInstallation(c.req.valid("param").id, c.req.valid("json")))));
connectionRoutes.post("/canva/start", zValidator("json", z.strictObject({
  scope: z.literal("personal"), capabilities: z.array(z.literal("canva.personal.mcp")).length(1),
  loopbackRedirectUri: z.string().optional(),
})), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(c, service,
    await service.beginProvider("canva", { ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c) }))));
});
connectionRoutes.post("/canva/complete", zValidator("json", z.strictObject({
  code: z.string().min(1).optional(), error: z.literal("access_denied").optional(), state: z.string().min(1),
}).refine((value) => Boolean(value.code) !== Boolean(value.error), "Supply a code or a denial")), async (c) => {
  const input = c.req.valid("json");
  await new ConnectionService(c.env, getAuth(c)).completeCanvaLoopback(input.code ?? null, input.state);
  return c.json({ ok: true });
});
connectionRoutes.post("/apollo/start", zValidator("json", apolloStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginProvider("apollo", {
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.post("/fireflies/start", zValidator("json", firefliesStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginProvider("fireflies", {
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.post("/granola/start", zValidator("json", granolaStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginProvider("granola", {
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.post("/granola/workspace", zValidator("json", granolaWorkspace), async (c) =>
  c.json(CreatedConnectionSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).createGranolaWorkspace(c.req.valid("json"))), 201),
);
connectionRoutes.post("/slack/start", zValidator("json", slackStart), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginProvider("slack", {
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
/**
 * A configured MCP server, header-authenticated. Written and proved reachable
 * before it is returned, so a typo in a URL or a header is answered here rather
 * than inside somebody's run three days later.
 */
connectionRoutes.post("/custom-mcp", zValidator("json", CreateCustomMcpConnectionRequestSchema), async (c) => {
  const created = await new ConnectionService(c.env, getAuth(c)).createCustomMcp(c.req.valid("json"));
  // Either scope: a personal server's invalidation is its owner's alone.
  noteChangedConnection(c, created.connection.id);
  return c.json(CreatedConnectionSchema.parse(created), 201);
});
connectionRoutes.post("/custom-mcp/start", zValidator("json", StartCustomMcpConnectionRequestSchema), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.beginCustomMcp({
      ...c.req.valid("json"), desktopHandoffVersion: desktopHandoffVersion(c),
    }),
  )));
});
connectionRoutes.get("/:id/tool-count", zValidator("param", idParam), async (c) =>
  c.json(ConnectionToolCountSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).getToolCount(c.req.valid("param").id, c.req.raw.signal),
  )),
);
connectionRoutes.get("/:id/custom-mcp/tools", zValidator("param", idParam), async (c) =>
  c.json(CustomMcpConnectionSettingsSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).getCustomMcpSettings(c.req.valid("param").id),
  )),
);
connectionRoutes.put(
  "/:id/custom-mcp/tool-policy",
  zValidator("param", idParam),
  zValidator("json", UpdateCustomMcpToolPolicyRequestSchema),
  async (c) => c.json(CustomMcpConnectionSettingsSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).updateCustomMcpToolPolicy(
      c.req.valid("param").id,
      c.req.valid("json").toolPolicy,
    ),
  )),
);
connectionRoutes.post("/x", zValidator("json", xCreate), async (c) =>
  c.json(CreatedConnectionSchema.parse(await new ConnectionService(c.env, getAuth(c)).createX(c.req.valid("json"))), 201),
);
connectionRoutes.post("/slack/link/preview", zValidator("json", slackLink), async (c) =>
  c.json(SlackLinkPreviewSchema.parse(await new SlackAgentService(c.env).previewLink(getAuth(c), c.req.valid("json").token))),
);
connectionRoutes.post("/slack/link", zValidator("json", slackLink), async (c) =>
  c.json(SlackLinkedSchema.parse(await new SlackAgentService(c.env).linkUser(getAuth(c), c.req.valid("json").token))),
);
connectionRoutes.get("/oauth-attempts/:attemptId", zValidator("param", oauthAttemptParam), async (c) =>
  c.json(ConnectorOAuthAttemptSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).getOAuthAttempt(c.req.valid("param").attemptId))),
);
connectionRoutes.post(
  "/:id/resource-authorizations/start",
  zValidator("param", idParam),
  zValidator("json", StartConnectorResourceAuthorizationRequestSchema),
  async (c) => c.json(ConnectorResourceAuthorizationStartSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).beginResourceAuthorization(
      c.req.valid("param").id,
      c.req.valid("json").target,
      desktopHandoffVersion(c),
    ),
  )),
);
connectionRoutes.post("/:id/reconnect", zValidator("param", idParam), async (c) => {
  const service = new ConnectionService(c.env, getAuth(c));
  return c.json(ConnectorOAuthStartSchema.parse(await bindConnectorTelemetry(
    c, service, await service.reconnect(c.req.valid("param").id, desktopHandoffVersion(c)),
  )));
});
connectionRoutes.post("/:id/test", zValidator("param", idParam), async (c) =>
  c.json(ConnectionTestResponseSchema.parse(await new ConnectionService(c.env, getAuth(c)).test(c.req.valid("param").id))),
);
connectionRoutes.get("/:id/github/repository-access", zValidator("param", idParam), async (c) =>
  c.json(GitHubRepositoryAccessSettingsSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).getGitHubRepositoryAccess(c.req.valid("param").id),
  )),
);
connectionRoutes.put(
  "/:id/github/repository-access",
  zValidator("param", idParam),
  zValidator("json", UpdateGitHubRepositoryAccessSettingsSchema),
  async (c) => c.json(GitHubRepositoryAccessSettingsSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).updateGitHubRepositoryAccess(
      c.req.valid("param").id,
      c.req.valid("json"),
    ),
  )),
);
connectionRoutes.delete("/:id", zValidator("param", idParam), async (c) => {
  await new ConnectionService(c.env, getAuth(c)).disable(c.req.valid("param").id);
  return c.body(null, 204);
});
connectionRoutes.post("/webhook", zValidator("json", CreateWebhookConnectionRequestSchema), async (c) => {
  const created = await new ConnectionService(c.env, getAuth(c)).createWebhook(c.req.valid("json"));
  noteChangedConnection(c, created.connection.id);
  return c.json(WebhookConnectionSchema.parse(created), 201);
});
connectionRoutes.post("/:id/webhook-secret/rotate", zValidator("param", idParam), async (c) =>
  c.json(WebhookCredentialsSchema.parse(
    await new ConnectionService(c.env, getAuth(c)).rotateWebhookSecret(c.req.valid("param").id))),
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
    return unknownConnectorAttemptFailureTarget(c.env, {
      provider,
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
    const failure = classifyConnectorOAuthCallbackFailure(error);
    logEvent(c, failure.level, "connector_oauth_callback_failed", {
      provider,
      code: failure.errorCode,
      ...failure.diagnostics,
    });
    const target = await recoverConnectorCallback(
      c,
      provider,
      failure.errorCode,
      () => service.failProviderAttempt(provider, query.state, failure.errorCode),
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
  const service = new ConnectionService(c.env);
  if (await service.authorizationPurpose("google", query.state) === "resource_authorization") {
    c.header("Cache-Control", "no-store");
    try {
      const target = query.error
        ? await service.completeResourceAuthorizationDenial("google", query.state)
        : await service.completeResourceAuthorization(
            "google",
            query.code!,
            query.state,
            query.picked_file_ids?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
          );
      return c.redirect(desktopHandoffUrl(c.env, target), 302);
    } catch (error) {
      const failure = classifyConnectorOAuthCallbackFailure(error);
      logEvent(c, failure.level, "connector_resource_authorization_callback_failed", {
        provider: "google",
        code: failure.errorCode,
        ...failure.diagnostics,
      });
      const target = await recoverConnectorCallback(
        c,
        "google",
        failure.errorCode,
        () => service.failProviderAttempt("google", query.state, failure.errorCode),
      );
      return c.redirect(desktopHandoffUrl(c.env, target), 302);
    }
  }
  return connectorCallback(c, "google", query, (service, code, state) => service.completeGoogle(code, state));
});
connectionCallbackRoutes.get("/linear/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "linear", query, (service, code, state) => service.completeProvider("linear", code, state));
});
/**
 * Notion registers one redirect URI for the whole public connection, so this
 * callback answers on the shared Global host for both regions and hands the
 * authorization code to the region named by the state prefix. The regional hosts
 * keep serving it too: local development points the ingress at the API itself,
 * and there the shared and regional paths are the same URL.
 */
connectionCallbackRoutes.get("/notion/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  if (!isSharedNotionIngress(c.env, c.req.url)) {
    return connectorCallback(c, "notion", query, (service, code, state) =>
      service.completeProvider("notion", code, state));
  }
  const routing = new NotionRoutingService(c.env);
  c.header("Cache-Control", "no-store");
  try {
    const target = query.error
      ? await routing.denyNotion(query.state)
      : await routing.completeNotion(query.code!, query.state);
    return c.redirect(desktopHandoffUrl(c.env, target), 302);
  } catch (error) {
    const failure = classifyConnectorOAuthCallbackFailure(error);
    logEvent(c, failure.level, "connector_oauth_callback_failed", {
      provider: "notion",
      code: failure.errorCode,
      ...failure.diagnostics,
    });
    const target = await recoverConnectorCallback(
      c,
      "notion",
      failure.errorCode,
      () => routing.failNotionAttempt(query.state, failure.errorCode),
    );
    return c.redirect(desktopHandoffUrl(c.env, target), 302);
  }
});
connectionCallbackRoutes.get("/custom-mcp/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "custom_mcp", query, (service, code, state) =>
    service.completeProvider("custom_mcp", code, state));
});
connectionCallbackRoutes.get("/ashby/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "ashby", query, (service, code, state) => service.completeProvider("ashby", code, state));
});
connectionCallbackRoutes.get("/canva/callback", zValidator("query", googleCallback), async (c) => {
  return connectorCallback(c, "canva", c.req.valid("query"), (service, code, state) => service.completeProvider("canva", code, state));
});
connectionCallbackRoutes.get("/apollo/callback", zValidator("query", googleCallback), async (c) => {
  return connectorCallback(c, "apollo", c.req.valid("query"), (service, code, state) => service.completeProvider("apollo", code, state));
});
connectionCallbackRoutes.get("/fireflies/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "fireflies", query, (service, code, state) => service.completeProvider("fireflies", code, state));
});
connectionCallbackRoutes.get("/granola/callback", zValidator("query", googleCallback), async (c) => {
  const query = c.req.valid("query");
  return connectorCallback(c, "granola", query, (service, code, state) => service.completeProvider("granola", code, state));
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
  return c.json(WebhookIngestionSchema.parse(result), result.duplicate ? 200 : 202);
});
webhookIngestionRoutes.post("/linear", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const result = isSharedLinearIngress(c.env, c.req.url)
    ? await new LinearRoutingService(c.env).ingestLinear(rawBody, c.req.raw.headers)
    : await new ProviderWebhookService(c.env).ingestLinear(rawBody, c.req.raw.headers);
  // Linear treats every non-200 response as a failed delivery and retries it.
  // A verified delivery has been durably recorded before this returns, so both
  // first deliveries and duplicates must be acknowledged with an exact 200.
  return c.json(WebhookIngestionSchema.parse(result), 200);
});
webhookIngestionRoutes.post("/notion", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const setupNonce = c.req.query("setup") ?? null;
  // Only the shared ingress replicates the captured token to the other region,
  // and `setup=` carries a nonce that only the shared host can consume.
  // Accepting that challenge on a regional host would store a token here,
  // answer 200, and leave the other region unable to verify anything —
  // surfacing much later as a total delivery failure for every workspace it
  // owns. Refuse instead, and name the registered host.
  if (setupNonce !== null && notionIngressIsElsewhere(c.env, c.req.url)) {
    throw new ApiError(
      400,
      "notion_setup_wrong_host",
      `Send the Notion webhook verification to ${notionIngressUrl(c.env)}, the host the subscription is registered against`,
    );
  }
  const result = isSharedNotionIngress(c.env, c.req.url)
    ? await new NotionRoutingService(c.env).ingestNotion(rawBody, c.req.raw.headers, setupNonce)
    : await new ProviderWebhookService(c.env).ingestNotion(rawBody, c.req.raw.headers, setupNonce);
  // Notion requires a successful 2xx response; acknowledge verified durable
  // deliveries consistently with 200 so setup and normal delivery semantics
  // do not depend on whether a receipt was already present.
  return c.json(WebhookIngestionSchema.parse(result), 200);
});
webhookIngestionRoutes.post("/ashby/:id", zValidator("param", idParam), async (c) => {
  const body = await readBoundedRequestBytes(c.req.raw, providerWebhookMaxBytes(c.env));
  const id = c.req.valid("param").id;
  const result = await new ConnectionService(c.env).ingestAshbyWebhook(id, body, c.req.raw.headers);
  return c.json(AshbyWebhookResponseSchema.parse(result), 200);
});
webhookIngestionRoutes.post("/fireflies/:id", zValidator("param", idParam), async (c) => {
  const body = await readBoundedRequestBytes(c.req.raw, providerWebhookMaxBytes(c.env));
  const result = await new ConnectionService(c.env).ingestFirefliesWebhook(
    c.req.valid("param").id,
    body,
    c.req.raw.headers,
  );
  return c.json(FirefliesWebhookResponseSchema.parse(result), "ping" in result || result.duplicate ? 200 : 202);
});
webhookIngestionRoutes.post("/granola/:id", zValidator("param", idParam), async (c) => {
  const result = await new ConnectionService(c.env).ingestGranolaWebhook(
    c.req.valid("param").id,
    new Uint8Array(await c.req.arrayBuffer()),
    {
      webhookId: c.req.header("webhook-id") ?? null,
      webhookTimestamp: c.req.header("webhook-timestamp") ?? null,
      webhookSignature: c.req.header("webhook-signature") ?? null,
    },
  );
  return c.json(ConnectorWebhookIngestionSchema.parse(result), result.duplicate ? 200 : 202);
});
webhookIngestionRoutes.post("/webhook/:id", zValidator("param", idParam), async (c) => {
  const result = await new ConnectionService(c.env).ingestWebhook(
    c.req.valid("param").id,
    new Uint8Array(await c.req.arrayBuffer()),
    readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.SIGNATURE) ?? null,
  );
  return c.json(ConnectorWebhookIngestionSchema.parse(result), result.duplicate ? 200 : 202);
});
