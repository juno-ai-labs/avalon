import { Hono } from "hono";
import type { HonoAppEnv } from "./env";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { requireAuth, requireIdentityAuth } from "./middleware/auth";
import { requestContext, securityMiddleware } from "./middleware/request-context";
import { authRoutes } from "./routes/auth";
import { automationRoutes, subscriptionRoutes, templateRoutes } from "./routes/automations";
import { connectionCallbackRoutes, connectionRoutes, webhookIngestionRoutes } from "./routes/connections";
import { healthRoutes } from "./routes/health";
import { onboardingRoutes } from "./routes/onboarding";
import { resourceRoutes } from "./routes/resources";
import { socketRoutes } from "./routes/socket";
import { workspaceRoutes } from "./routes/workspace";
import { workstreamRoutes } from "./routes/workstreams";
import {
  isAllowedGitHubIngressRoute,
  isSharedGitHubIngress,
} from "./services/github-routing-service";

export function createApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", requestContext);
  for (const middleware of securityMiddleware()) app.use("*", middleware);
  app.use("*", async (c, next) => {
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
    await next();
  });

  app.get("/", (c) => c.json({ service: "avalon-api", region: c.env.AVALON_REGION }));
  app.route("/health", healthRoutes);
  app.route("/auth", authRoutes);
  app.route("/connections", connectionCallbackRoutes);
  app.route("/ingest", webhookIngestionRoutes);
  app.route("/socket", socketRoutes);

  const identityApi = new Hono<HonoAppEnv>();
  identityApi.use("*", requireIdentityAuth);
  identityApi.route("/onboarding", onboardingRoutes);
  app.route("/", identityApi);

  const protectedApi = new Hono<HonoAppEnv>();
  protectedApi.use("*", requireAuth);
  protectedApi.route("/workspace", workspaceRoutes);
  protectedApi.route("/workstreams", workstreamRoutes);
  protectedApi.route("/automations", automationRoutes);
  protectedApi.route("/automation-templates", templateRoutes);
  protectedApi.route("/automation-subscriptions", subscriptionRoutes);
  protectedApi.route("/connections", connectionRoutes);
  protectedApi.route("/resources", resourceRoutes);
  app.route("/", protectedApi);

  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}

export const app = createApp();
