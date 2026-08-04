import { Hono } from "hono";
import type { HonoAppEnv } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";

export const healthRoutes = new Hono<HonoAppEnv>();

healthRoutes.get("/", async (c) => {
  const checks: Record<string, { ok: boolean; message: string }> = {};
  try {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    checks.d1 = { ok: row?.ok === 1, message: row?.ok === 1 ? "available" : "query failed" };
  } catch {
    checks.d1 = { ok: false, message: "unavailable" };
  }
  try {
    await c.env.PAYLOADS.list({ limit: 1 });
    checks.r2 = { ok: true, message: "available" };
  } catch {
    checks.r2 = { ok: false, message: "unavailable" };
  }
  try {
    const rooms = durableObjectNamespaceForRegion(c.env.WORKSTREAM_ROOMS, c.env.AVALON_REGION, c.env.APP_ENV);
    const id = rooms.idFromName(`health:${c.env.AVALON_REGION}`);
    const response = await rooms.get(id).fetch("https://room.internal/health");
    checks.durableObjects = { ok: response.ok, message: response.ok ? "available" : `returned ${response.status}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown Durable Object error";
    console.warn("Durable Object health check failed", { region: c.env.AVALON_REGION, reason });
    checks.durableObjects = {
      ok: false,
      message: c.env.APP_ENV === "development" ? reason : "unavailable",
    };
  }
  checks.queue = {
    ok: typeof c.env.ACTIVITY_QUEUE?.send === "function",
    message: typeof c.env.ACTIVITY_QUEUE?.send === "function" ? "binding available" : "binding unavailable",
  };
  checks.workflows = {
    ok: typeof c.env.WORKSTREAM_LOOP_WORKFLOW?.create === "function" && typeof c.env.CONNECTOR_POLL_WORKFLOW?.create === "function",
    message: typeof c.env.WORKSTREAM_LOOP_WORKFLOW?.create === "function" ? "bindings available" : "binding unavailable",
  };
  checks.openRouter = {
    ok: Boolean(c.env.OPENROUTER_API_KEY && c.env.OPENROUTER_PRIMARY_MODEL),
    message: c.env.OPENROUTER_API_KEY && c.env.OPENROUTER_PRIMARY_MODEL ? "configured" : "not configured",
  };
  checks.googleLoginOAuth = {
    ok: Boolean(c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET),
    message: c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET ? "configured" : "not configured",
  };
  checks.googleConnectorOAuth = {
    ok: Boolean(c.env.GOOGLE_CONNECTOR_OAUTH_CLIENT_ID && c.env.GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET),
    message: c.env.GOOGLE_CONNECTOR_OAUTH_CLIENT_ID && c.env.GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET
      ? "configured"
      : "not configured",
  };
  checks.resend = {
    ok: Boolean(c.env.RESEND_API_KEY && c.env.RESEND_FROM_EMAIL),
    message: c.env.RESEND_API_KEY && c.env.RESEND_FROM_EMAIL ? "configured" : "not configured",
  };
  const linearValues = [
    c.env.LINEAR_OAUTH_CLIENT_ID?.trim(),
    c.env.LINEAR_OAUTH_CLIENT_SECRET?.trim(),
    c.env.LINEAR_WEBHOOK_SECRET?.trim(),
  ];
  const anyLinearConfigured = linearValues.some(Boolean);
  const linearIdentityConfigured = linearValues.every(Boolean);
  const linearRoutingConfigured = c.env.AVALON_REGION === "global"
    ? typeof c.env.EU_LINEAR_BRIDGE?.ingestLinear === "function"
    : typeof c.env.GLOBAL_LINEAR_ROUTER?.registerLinearRoute === "function"
      && typeof c.env.GLOBAL_LINEAR_ROUTER?.setLinearRouteStatus === "function";
  checks.linear = {
    ok: linearIdentityConfigured && linearRoutingConfigured,
    message: !linearIdentityConfigured
      ? "OAuth or webhook identity is not configured"
      : linearRoutingConfigured
        ? "one public app and regional router configured"
        : "regional router binding unavailable",
  };
  try {
    const registry = await new WorkstreamEmailRoutingService(c.env).ping();
    checks.workstreamEmailRegistry = {
      ok: registry.region === "global",
      message: c.env.AVALON_REGION === "global"
        ? "authoritative Global registry available"
        : "authoritative Global registry available through RPC",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown registry error";
    console.warn("Work-stream email registry health check failed", {
      region: c.env.AVALON_REGION,
      reason,
    });
    checks.workstreamEmailRegistry = {
      ok: false,
      message: c.env.APP_ENV === "development" ? reason : "unavailable",
    };
  }
  const receivingKeyConfigured = Boolean(c.env.RESEND_RECEIVING_API_KEY ?? c.env.RESEND_API_KEY);
  const inboundConfigured = c.env.AVALON_REGION === "global"
    ? receivingKeyConfigured
      && Boolean(c.env.RESEND_WEBHOOK_SIGNING_SECRET ?? c.env.RESEND_WEBHOOK_SECRET)
      && typeof c.env.EU_INBOUND_EMAIL_BRIDGE?.ingestResendEmail === "function"
    : receivingKeyConfigured;
  checks.inboundEmail = {
    ok: inboundConfigured,
    message: inboundConfigured ? "configured" : "not configured",
  };
  const required = [
    checks.d1,
    checks.r2,
    checks.durableObjects,
    checks.queue,
    checks.workflows,
    checks.workstreamEmailRegistry,
  ];
  if (c.env.APP_ENV === "production") required.push(checks.inboundEmail);
  if (anyLinearConfigured) required.push(checks.linear);
  const ok = required.every((check) => check?.ok);
  return c.json({ ok, region: c.env.AVALON_REGION, environment: c.env.APP_ENV, checks }, ok ? 200 : 503);
});
