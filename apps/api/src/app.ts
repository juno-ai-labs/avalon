import { messageIssueRoutes } from "./routes/message-issues";
import { sharingRoutes } from "./routes/sharing";
import { canvasRoutes } from "./routes/canvases";
import { createBrowserRoutes } from "./routes/browser";
import { daytonaWebhookRoutes } from "./routes/daytona";
import { Hono } from "hono";
import type { HonoAppEnv } from "./env";
import {
  isAllowedNotionIngressRoute,
  isSharedNotionIngress,
} from "./lib/notion-ingress";
import { apiOperationTelemetry } from "./middleware/api-operation-telemetry";
import { auditSupportWrites, refuseSupportSession, requireAuth, requireIdentityAuth, requireWorkspaceAuth } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { requestContext, securityMiddleware } from "./middleware/request-context";
import { workspaceRealtimeInvalidation } from "./middleware/workspace-realtime";
import { accessOperatorRoutes } from './routes/access-operations';
import { authRoutes } from "./routes/auth";
import { automationRoutes, sidekickRoutes } from "./routes/automations";
import { connectionCallbackRoutes, connectionRoutes, webhookIngestionRoutes } from "./routes/connections";
import { connectorMaintenanceOperatorRoutes } from './routes/connector-maintenance-operations';
import { conversationRoutes } from "./routes/conversations";
import { demoOperatorRoutes } from './routes/demo-operations';
import { devRoutes } from "./routes/dev";
import { digestRoutes } from "./routes/digest";
import { featureFlagRoutes } from "./routes/feature-flags";
import { faviconRoutes } from "./routes/favicons";
import { healthRoutes } from "./routes/health";
import { onboardingRoutes } from "./routes/onboarding";
import { projectRoutes } from "./routes/projects";
import { spaceReadRoutes, spaceRoutes } from "./routes/spaces";
import { navigationRoutes } from "./routes/navigation";
import { pushDeviceRoutes } from "./routes/push-devices";
import { realtimeRoutes } from "./routes/realtime";
import { resendInboundRoutes } from "./routes/resend";
import { resourceRoutes } from "./routes/resources";
import { searchRoutes } from "./routes/search";
import { slackIngressRoutes } from "./routes/slack";
import { socketRoutes } from "./routes/socket";
import { speechRoutes } from "./routes/speech";
import { authenticatedTelemetryRoutes, publicTelemetryRoutes } from "./routes/telemetry";
import { linkRoutes } from "./routes/links";
import { telemetryOperatorRoutes } from './routes/telemetry-operations';
import { workOpportunityRoutes } from "./routes/work-opportunities";
import { deviceTimezoneRoutes, workspaceMembers, workspaceProfile, workspaceRoutes, workspaceSocketTicket } from "./routes/workspace";
import { workspaceMembershipRoutes } from "./routes/workspace-membership";
import { workspaceOperatorRoutes } from './routes/workspace-operations';
import { workstreamCreateRoutes, workstreamRoutes } from "./routes/workstreams";
import {
  isAllowedGitHubIngressRoute,
  isSharedGitHubIngress,
} from "./services/github-routing-service";
import {
  isAllowedLinearIngressRoute,
  isSharedLinearIngress,
} from "./services/linear-routing-service";
import {
  isAllowedSlackIngressRoute,
  isSharedSlackIngress,
} from "./services/slack-routing-service";

import { privateAccessRoutes } from "./routes/private-access";
import { conversationAccessRoutes } from "./routes/conversation-access";

export function createApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", requestContext);
  for (const middleware of securityMiddleware()) app.use("*", middleware);
  app.use("*", async (c, next) => {
    const requestUrl = new URL(c.req.url);
    if (requestUrl.pathname.startsWith("/slack/") && !isSharedSlackIngress(c.env, requestUrl)) {
      return c.json({
        error: {
          code: "not_found",
          message: "The requested API route does not exist",
          requestId: c.get("requestId") ?? null,
        },
      }, 404);
    }
    if (
      isSharedGitHubIngress(c.env, c.req.url)
      && !isAllowedGitHubIngressRoute(c.req.method, new URL(c.req.url).pathname)
    ) {
      return c.json({
        error: {
          code: "not_found",
          message: "The requested API route does not exist",
          requestId: c.get("requestId") ?? null,
        },
      }, 404);
    }
    if (
      isSharedLinearIngress(c.env, c.req.url)
      && !isAllowedLinearIngressRoute(c.req.method, new URL(c.req.url).pathname)
    ) {
      return c.json({
        error: {
          code: "not_found",
          message: "The requested API route does not exist",
          requestId: c.get("requestId") ?? null,
        },
      }, 404);
    }
    if (
      isSharedNotionIngress(c.env, c.req.url)
      && !isAllowedNotionIngressRoute(c.req.method, new URL(c.req.url).pathname)
    ) {
      return c.json({
        error: {
          code: "not_found",
          message: "The requested API route does not exist",
          requestId: c.get("requestId") ?? null,
        },
      }, 404);
    }
    if (
      isSharedSlackIngress(c.env, c.req.url)
      && !isAllowedSlackIngressRoute(c.req.method, new URL(c.req.url).pathname)
    ) {
      return c.json({
        error: {
          code: "not_found",
          message: "The requested API route does not exist",
          requestId: c.get("requestId") ?? null,
        },
      }, 404);
    }
    await next();
  });
  app.use("*", apiOperationTelemetry());
  app.use("*", auditSupportWrites);

  app.get("/", (c) => c.json({ service: "avalon-api", region: c.env.AVALON_REGION }));
  app.route("/health", healthRoutes);
  app.route("/access", privateAccessRoutes);
  app.route("/conversation-access", conversationAccessRoutes);
  app.route("/auth", authRoutes);
  app.route("/browser",createBrowserRoutes((request,c) => {
    let executionContext;
    try { executionContext = c.executionCtx; } catch { /* Route tests have no Worker context. */ }
    return app.fetch(request,c.env,executionContext);
  }));
  // Development tooling; every handler re-checks the dev gate itself.
  app.route("/dev", devRoutes);
  app.route("/connections", connectionCallbackRoutes);
  app.route("/ingest", webhookIngestionRoutes);
  app.route("/ingest/resend", resendInboundRoutes);
  app.route("/ingest/daytona", daytonaWebhookRoutes);
  app.route("/socket", socketRoutes);
  app.route("/slack", slackIngressRoutes);
  app.route("/telemetry", publicTelemetryRoutes);
  app.route("/links", linkRoutes);
  app.route('/internal/telemetry', telemetryOperatorRoutes);
  app.route('/internal/demos', demoOperatorRoutes);
  app.route('/internal/connector-maintenance', connectorMaintenanceOperatorRoutes);
  app.route('/internal/access', accessOperatorRoutes);
  app.route('/internal/workspaces', workspaceOperatorRoutes);

  const identityApi = new Hono<HonoAppEnv>();
  // Both sub-apps are root-mounted. Hono runs their wildcard middleware in
  // order for protected routes, so `requireAuth` reuses this identity result.
  identityApi.use("*", requireIdentityAuth);
  // Account setup and device registration mint or bind beyond one
  // Organization; a support session may do neither.
  identityApi.use("/onboarding/*", refuseSupportSession);
  identityApi.use("/push-devices/*", refuseSupportSession);
  identityApi.route("/onboarding", onboardingRoutes);
  // Before the member-only `/workspace` routes, so a guest reaches these too.
  identityApi.get("/workspace/socket", requireWorkspaceAuth, workspaceSocketTicket);
  identityApi.get("/workspace", requireWorkspaceAuth, workspaceProfile);
  identityApi.get("/workspace/members", requireWorkspaceAuth, workspaceMembers);
  // Starting a thread: a guest may start one in a Channel they take part in.
  // Only `POST /workstreams` itself; every other `/workstreams` route falls
  // through to the member-only mount below.
  identityApi.post("/workstreams", requireWorkspaceAuth, workspaceRealtimeInvalidation);
  identityApi.route("/workstreams", workstreamCreateRoutes);
  // A support session's device is the impersonator's, not the person's.
  identityApi.use("/workspace/me/device-timezone", requireWorkspaceAuth, refuseSupportSession);
  identityApi.route("/workspace/me/device-timezone", deviceTimezoneRoutes);
  identityApi.route("/conversations", conversationRoutes);
  identityApi.route("/message-issues", messageIssueRoutes);
  identityApi.route("/sharing", sharingRoutes);
  identityApi.route("/resources", resourceRoutes);
  identityApi.route("/canvases", canvasRoutes);
  identityApi.route("/automations", automationRoutes);
  identityApi.route("/sidekicks", sidekickRoutes);
  identityApi.route("/feature-flags", featureFlagRoutes);
  identityApi.route("/telemetry", authenticatedTelemetryRoutes);
  // Members and guests alike: each answers only for what this person may
  // already reach (their own devices, their search audience, text they send).
  identityApi.route("/push-devices", pushDeviceRoutes);
  identityApi.route("/search", searchRoutes);
  identityApi.route("/speech", speechRoutes);
  identityApi.route("/spaces", spaceReadRoutes);
  identityApi.route("/navigation", navigationRoutes);
  app.route("/", identityApi);

  const protectedApi = new Hono<HonoAppEnv>();
  protectedApi.use("*", requireAuth);
  protectedApi.use("*", workspaceRealtimeInvalidation);
  protectedApi.route("/workspace", workspaceRoutes);
  protectedApi.route("/workspaces", workspaceMembershipRoutes);
  protectedApi.route("/workstreams", workstreamRoutes);
  protectedApi.route("/work-opportunities", workOpportunityRoutes);
  protectedApi.route("/projects", projectRoutes);
  protectedApi.route("/spaces", spaceRoutes);
  protectedApi.route("/digest", digestRoutes);
  protectedApi.route("/connections", connectionRoutes);
  protectedApi.route("/favicons", faviconRoutes);
  protectedApi.route("/realtime", realtimeRoutes);
  app.route("/", protectedApi);

  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}

export const app = createApp();
