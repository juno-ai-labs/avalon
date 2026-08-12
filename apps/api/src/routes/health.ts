import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { logEvent } from "../observability/logger";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";

/** The probe's own shape — this route owns it, so the contract lives here. */
const HealthCheckSchema = z.object({ ok: z.boolean(), message: z.string() });
/**
 * `region` and `environment` are reported as-is rather than enum-validated.
 *
 * This is the probe a misconfigured deployment is diagnosed with — it is exempt
 * from the environment assertion in `index.ts` for exactly that reason. An enum
 * here would put the two variables most likely to be wrong, `AVALON_REGION` and
 * `APP_ENV`, into the one response that has to survive them being wrong: the
 * parse would throw and the route would answer a bare 500 naming nothing.
 * The probe's job is to describe the environment, not to assert it.
 */
const HealthResponseSchema = z.object({
  ok: z.boolean(),
  region: z.string(),
  environment: z.string(),
  checks: z.record(z.string(), HealthCheckSchema),
});

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
    logEvent(c, "warn", "durable_object_health_check_failed", { reason });
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
  // Flagship bindings are always remote, so this is unavailable under
  // `wrangler dev --local` by design and is only required in production, where
  // an unbound app would silently drop every agent onto the model variables.
  checks.featureFlags = {
    ok: typeof c.env.FLAGS?.getObjectValue === "function",
    message: typeof c.env.FLAGS?.getObjectValue === "function"
      ? "binding available"
      : "binding unavailable; agents use the OPENROUTER_* variables",
  };
  checks.openRouter = {
    ok: Boolean(c.env.OPENROUTER_API_KEY && c.env.OPENROUTER_PRIMARY_MODEL),
    message: c.env.OPENROUTER_API_KEY && c.env.OPENROUTER_PRIMARY_MODEL ? "configured" : "not configured",
  };
  // Identity sign-in is a Global-only surface, so EU reporting "not configured"
  // forever was a permanent false negative — noise that a real fault would have
  // had to be spotted inside.
  const googleLoginConfigured = Boolean(c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET);
  checks.googleLoginOAuth = c.env.AVALON_REGION === "global"
    ? {
        ok: googleLoginConfigured,
        message: googleLoginConfigured ? "configured" : "not configured",
      }
    : {
        ok: true,
        message: googleLoginConfigured
          ? "configured; not used outside Global"
          : "not required outside Global",
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
    logEvent(c, "warn", "workstream_email_registry_health_check_failed", { reason });
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
  if (c.env.APP_ENV === "production") required.push(checks.inboundEmail, checks.featureFlags);
  if (anyLinearConfigured) required.push(checks.linear);
  const ok = required.every((check) => check?.ok);
  return c.json(
    HealthResponseSchema.parse({ ok, region: c.env.AVALON_REGION, environment: c.env.APP_ENV, checks }),
    ok ? 200 : 503,
  );
});
