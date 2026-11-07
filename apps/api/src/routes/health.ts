import { isConfiguredRegion } from "@rally/contracts/regions";
import { configuredRegions } from "@rally/contracts/regions";
import { regionalBindings } from "../lib/regional-bindings";
import { Hono } from "hono";
import { z } from "zod";
import { assertEnvContract, EnvContractError, type HonoAppEnv } from "../env";
import {
  durableObjectStubForRegionalSingleton,
} from "../lib/durable-object-namespace";
import { logEvent } from "../observability/logger";
import { opsNotificationsConfigured } from "../observability/ops-slack-notifier";
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
  // The counterpart to the entrypoint's exemption for this route.
  //
  // `index.ts` refuses every *other* route when the environment contract fails,
  // and answers a body that deliberately names nothing, because the offending
  // keys are secrets. This route is exempt so that it can still answer — and
  // until now that was all it did: it answered, cheerfully, while the Worker
  // could not serve a single request. A probe that cannot fail on the one fault
  // that stops everything is not a probe. So run the assertion here, catch it
  // rather than throw, and report it as a required check: the response says
  // which keys, and `ok` goes false so `pnpm health:regions` and every uptime
  // monitor above it see the outage.
  try {
    assertEnvContract(c.env);
    checks.envContract = { ok: true, message: "satisfied" };
  } catch (error) {
    // A contract failure is the only expected result. Anything else is a defect
    // in the assertion itself, and folding it into a 503 health response would
    // hide it behind a plausible answer — `assertEnvContractOrLog` rethrows for
    // the same reason.
    if (!(error instanceof EnvContractError)) throw error;
    // Every other fallible check here logs; this one is the most severe the
    // probe can report and, because `/health` is the request the entrypoint
    // never asserts on, it is the only path where `env_contract_failed` would
    // otherwise never be written for the fault that stops the Worker.
    logEvent(c, "error", "env_contract_failed", { keys: error.keys });
    checks.envContract = {
      ok: false,
      // The key list is the diagnosis, and it is also an inventory of which
      // secrets this Worker is currently running without — including the
      // signing and encryption keys — on a route with no authentication,
      // mounted ahead of `protectedApi`. So the names go to the log an operator
      // can read, and reach the body only outside a deployed environment, the
      // same narrowing the Durable Object and registry checks above apply.
      message: c.env.APP_ENV === "development"
        ? `the Worker cannot serve requests: ${error.keys.join(", ")}`
        : "the Worker cannot serve requests; see the env_contract_failed log",
    };
  }
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
    const agent = durableObjectStubForRegionalSingleton(
      c.env,
      c.env.SUBSTREAM_AGENTS,
      `health:${c.env.AVALON_REGION}`,
    );
    const response = await agent.fetch("https://room.internal/health");
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
  const inferenceLakehouseBindingsAvailable = typeof c.env.INFERENCE_LAKEHOUSE_QUEUE?.send === "function"
    && typeof c.env.INFERENCE_LAKEHOUSE?.send === "function";
  checks.inferenceLakehouse = {
        ok: inferenceLakehouseBindingsAvailable,
        message: inferenceLakehouseBindingsAvailable
          ? "Global Queue and Pipeline bindings available"
          : c.env.APP_ENV === "production"
            ? "Global Queue or Pipeline binding unavailable"
            : "Pipeline binding is materialized only for hosted deployments",
      };
  const analyticsLakehouseBindingsAvailable = typeof c.env.ANALYTICS_LAKEHOUSE_QUEUE?.send === "function"
    && typeof c.env.ANALYTICS_LAKEHOUSE?.send === "function";
  checks.analyticsLakehouse = {
        ok: analyticsLakehouseBindingsAvailable,
        message: analyticsLakehouseBindingsAvailable
          ? "Global analytics Queue and Pipeline bindings available"
          : c.env.APP_ENV === "production"
            ? "Global analytics Queue or Pipeline binding unavailable"
            : "Pipeline binding is materialized only for hosted deployments",
      };
  checks.workflows = {
    ok: typeof c.env.CONNECTOR_POLL_WORKFLOW?.create === "function"
      && typeof c.env.CONNECTOR_EVENT_WORKFLOW?.create === "function",
    message: typeof c.env.CONNECTOR_POLL_WORKFLOW?.create === "function"
      && typeof c.env.CONNECTOR_EVENT_WORKFLOW?.create === "function"
      ? "bindings available"
      : "binding unavailable",
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
  checks.typeSafe = {
    ok: Boolean(c.env.TYPESAFE_API_KEY),
    message: c.env.TYPESAFE_API_KEY ? "configured" : "not configured",
  };
  // Identity sign-in is a Global-only surface, so regional reporting "not configured"
  // forever was a permanent false negative — noise that a real fault would have
  // had to be spotted inside.
  const googleLoginConfigured = Boolean(c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET);
  // Exempts regional by name rather than "not Global": an unreadable region is the
  // case where this probe most needs to complain, and the env contract holds
  // one to every rule. `/health` is reachable when the region is invalid
  // precisely so it can say so, and it must not answer "not required" then.
  if (!isConfiguredRegion(c.env.AVALON_REGION) || c.env.AVALON_REGION === "global") {
    // Global, and any region too malformed to read — the state this probe most
    // needs to complain in, since the entrypoint is failing on this very key
    // while `/health` stays exempt so it can say so.
    checks.googleLoginOAuth = {
      ok: googleLoginConfigured,
      message: googleLoginConfigured ? "configured" : "not configured",
    };
  } else if (googleLoginConfigured) {
    // Not a healthy state to confirm: the runbook installs this pair on Global
    // alone, so a regional Worker holding it is a platform login secret sitting
    // outside its blast radius — something to go remove, not to reassure about.
    checks.googleLoginOAuth = { ok: false, message: "configured outside Global; remove it from this region" };
  } else {
    checks.googleLoginOAuth = { ok: true, message: "not required outside Global" };
  }
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
  checks.pushDelivery = { ok: Boolean(c.env.APNS_AUTH_KEY && c.env.APNS_KEY_ID), message: c.env.APNS_AUTH_KEY && c.env.APNS_KEY_ID ? "configured" : "not configured" };
  checks.opsNotifications = opsNotificationsConfigured(c.env)
    ? { ok: true, message: "configured" }
    : c.env.OPS_SLACK_BOT_TOKEN?.trim() || c.env.OPS_SLACK_CHANNEL_ID?.trim()
      ? { ok: false, message: "half configured: set both OPS_SLACK_BOT_TOKEN and OPS_SLACK_CHANNEL_ID, or neither" }
      : { ok: false, message: "not configured" };
  // Reported separately, because the fallback that covers it is silent. An
  // unset notification sender sends every digest and automation result from the
  // invitations address and returns "sent" — which is how it went unnoticed for
  // the life of the feature. Not part of the required environment contract: an
  // unset sender must not 503 a region, it must be visible.
  checks.resendNotificationSender = {
    ok: Boolean(c.env.RESEND_NOTIFICATION_FROM_EMAIL?.trim()),
    message: c.env.RESEND_NOTIFICATION_FROM_EMAIL?.trim()
      ? "configured"
      : "unset; digests and automation results send from the transactional sender",
  };
  const linearValues = [
    c.env.LINEAR_OAUTH_CLIENT_ID?.trim(),
    c.env.LINEAR_OAUTH_CLIENT_SECRET?.trim(),
    c.env.LINEAR_WEBHOOK_SECRET?.trim(),
  ];
  const anyLinearConfigured = linearValues.some(Boolean);
  const linearIdentityConfigured = linearValues.every(Boolean);
  const linearRoutingConfigured = c.env.AVALON_REGION === "global"
    ? configuredRegions.filter((region) => region !== c.env.AVALON_REGION).every((region) => typeof regionalBindings(c.env, region).linear?.ingestLinear === "function")
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
      && configuredRegions.filter((region) => region !== c.env.AVALON_REGION).every((region) => typeof regionalBindings(c.env, region).inboundEmail?.ingestResendEmail === "function")
    : receivingKeyConfigured;
  checks.inboundEmail = {
    ok: inboundConfigured,
    message: inboundConfigured ? "configured" : "not configured",
  };
  const required = [
    checks.envContract,
    checks.d1,
    checks.r2,
    checks.durableObjects,
    checks.queue,
    checks.workflows,
    checks.workstreamEmailRegistry,
  ];
  if (c.env.APP_ENV === "production") {
    required.push(
      checks.inboundEmail,
      checks.featureFlags,
      checks.inferenceLakehouse,
      checks.analyticsLakehouse,
    );
  }
  if (anyLinearConfigured) required.push(checks.linear);
  const ok = required.every((check) => check?.ok);
  return c.json(
    // Absent, not merely malformed. Both fields are part of the contract this
    // route now reports on, and `z.string()` rejects `undefined` — so without a
    // fallback a Worker missing either one answers a bare 500 instead of the
    // 503 naming it, which is the failure this route exists to describe.
    HealthResponseSchema.parse({
      ok,
      region: c.env.AVALON_REGION ?? "unset",
      environment: c.env.APP_ENV ?? "unset",
      checks,
    }),
    ok ? 200 : 503,
  );
});
