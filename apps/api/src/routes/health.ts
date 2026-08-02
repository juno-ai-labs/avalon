import { Hono } from "hono";
import type { HonoAppEnv } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";

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
  checks.googleOAuth = {
    ok: Boolean(c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET),
    message: c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET ? "configured" : "not configured",
  };
  checks.resend = {
    ok: Boolean(c.env.RESEND_API_KEY && c.env.RESEND_FROM_EMAIL),
    message: c.env.RESEND_API_KEY && c.env.RESEND_FROM_EMAIL ? "configured" : "not configured",
  };
  const required = [checks.d1, checks.r2, checks.durableObjects, checks.queue, checks.workflows];
  const ok = required.every((check) => check?.ok);
  return c.json({ ok, region: c.env.AVALON_REGION, environment: c.env.APP_ENV, checks }, ok ? 200 : 503);
});
