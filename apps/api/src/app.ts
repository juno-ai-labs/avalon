import { connectorMaintenanceOperatorRoutes } from './routes/connector-maintenance-operations';
import { accessOperatorRoutes } from './routes/access-operations';
import { Hono } from "hono";
import { searchRoutes } from "./routes/search";
import type { HonoAppEnv } from "./env";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { requireAuth, requireIdentityAuth } from "./middleware/auth";
import { requestContext, securityMiddleware } from "./middleware/request-context";
import { apiOperationTelemetry } from "./middleware/api-operation-telemetry";
import { workspaceRealtimeInvalidation } from "./middleware/workspace-realtime";
import { authRoutes } from "./routes/auth";
import { devRoutes } from "./routes/dev";
import { automationRoutes, sidekickRoutes } from "./routes/automations";
import { conversationRoutes } from "./routes/conversations";
import { connectionCallbackRoutes, connectionRoutes, webhookIngestionRoutes } from "./routes/connections";
import { digestRoutes } from "./routes/digest";
import { featureFlagRoutes } from "./routes/feature-flags";
import { healthRoutes } from "./routes/health";
import { onboardingRoutes } from "./routes/onboarding";
import { noteRoutes } from "./routes/notes";
import { projectRoutes } from "./routes/projects";
import { realtimeRoutes } from "./routes/realtime";
import { resourceRoutes } from "./routes/resources";
import { resendInboundRoutes } from "./routes/resend";
import { socketRoutes } from "./routes/socket";
import { speechRoutes } from "./routes/speech";
import { workspaceRoutes } from "./routes/workspace";
import { workspaceMembershipRoutes } from "./routes/workspace-membership";
import { workstreamRoutes } from "./routes/workstreams";
import { workOpportunityRoutes } from "./routes/work-opportunities";
import { slackIngressRoutes } from "./routes/slack";
import { authenticatedTelemetryRoutes, publicTelemetryRoutes } from "./routes/telemetry";
import { telemetryOperatorRoutes } from './routes/telemetry-operations';
import { workspaceOperatorRoutes } from './routes/workspace-operations';
import { demoOperatorRoutes } from './routes/demo-operations';
import {
  isAllowedGitHubIngressRoute,
  isSharedGitHubIngress,
} from "./services/github-routing-service";
import {
  isAllowedLinearIngressRoute,
  isSharedLinearIngress,
} from "./services/linear-routing-service";
import {
  isAllowedNotionIngressRoute,
  isSharedNotionIngress,
} from "./lib/notion-ingress";
import {
  isAllowedSlackIngressRoute,
  isSharedSlackIngress,
} from "./services/slack-routing-service";

import { privateAccessRoutes } from "./routes/private-access";

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

  app.get("/", (c) => c.json({ service: "avalon-api", region: c.env.AVALON_REGION }));
  app.route("/health", healthRoutes);
  app.route("/access", privateAccessRoutes);
  app.route("/auth", authRoutes);
  // Development tooling; every handler re-checks the dev gate itself.
  app.route("/dev", devRoutes);
  app.route("/connections", connectionCallbackRoutes);
  app.route("/ingest", webhookIngestionRoutes);
  app.route("/ingest/resend", resendInboundRoutes);
  app.route("/socket", socketRoutes);
  app.route("/slack", slackIngressRoutes);
  app.route("/telemetry", publicTelemetryRoutes);
  app.route('/internal/telemetry', telemetryOperatorRoutes);
  app.route('/internal/demos', demoOperatorRoutes);
  app.route('/internal/connector-maintenance', connectorMaintenanceOperatorRoutes);
  app.route('/internal/access', accessOperatorRoutes);
  app.route('/internal/workspaces', workspaceOperatorRoutes);

  const identityApi = new Hono<HonoAppEnv>();
  // Both sub-apps are root-mounted. Hono runs their wildcard middleware in
  // order for protected routes, so `requireAuth` reuses this identity result.
  identityApi.use("*", requireIdentityAuth);
  identityApi.route("/onboarding", onboardingRoutes);
  identityApi.route("/feature-flags", featureFlagRoutes);
  identityApi.route("/telemetry", authenticatedTelemetryRoutes);
  app.route("/", identityApi);

  const protectedApi = new Hono<HonoAppEnv>();
  protectedApi.use("*", requireAuth);
  protectedApi.use("*", workspaceRealtimeInvalidation);
  protectedApi.route("/workspace", workspaceRoutes);
  protectedApi.route("/workspaces", workspaceMembershipRoutes);
  protectedApi.route("/workstreams", workstreamRoutes);
  protectedApi.route("/work-opportunities", workOpportunityRoutes);
  protectedApi.route("/notes", noteRoutes);
  protectedApi.route("/projects", projectRoutes);
  protectedApi.route("/digest", digestRoutes);
  protectedApi.route("/automations", automationRoutes);
  protectedApi.route("/sidekicks", sidekickRoutes);
  protectedApi.route("/conversations", conversationRoutes);
  protectedApi.route("/connections", connectionRoutes);
  protectedApi.route("/resources", resourceRoutes);
  protectedApi.route("/search", searchRoutes);
  protectedApi.route("/speech", speechRoutes);
  protectedApi.route("/realtime", realtimeRoutes);
  app.route("/", protectedApi);

  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}

export const app = createApp();
