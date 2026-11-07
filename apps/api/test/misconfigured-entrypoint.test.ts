import "../../../tests/isolated-region";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { healthRoutes } from "../src/routes/health";
import { misconfiguredResponse } from "../src/lib/misconfigured-response";
import { createInvalidTestEnv } from "./helpers/cloudflare-test";

/**
 * The answer a misconfigured deployment gives, and why it carries CORS headers
 * of its own.
 *
 * The environment assertion runs at the entrypoint so it can name the offending
 * keys once per isolate — which also puts this response outside every
 * middleware the app installs, `cors()` included. A browser will not expose a
 * cross-origin response it cannot validate, so without these headers the client
 * reports a network error and the `service_misconfigured` code, the one signal
 * this path exists to send, never arrives.
 */
const ORIGIN = "app://avalon";

function envWith(allowedOrigins: string | undefined): Env {
  return createInvalidTestEnv({ ALLOWED_ORIGINS: allowedOrigins });
}

function requestFrom(origin: string | null, method = "GET"): Request {
  return new Request("https://api.with-avalon.com/workstreams", {
    method,
    ...(origin ? { headers: { origin } } : {}),
  });
}

describe("the misconfigured-deployment response", () => {
  it("is readable by a client the environment lists", async () => {
    const response = misconfiguredResponse(requestFrom(ORIGIN), envWith(`${ORIGIN},http://127.0.0.1:5173`));

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(await response.json()).toMatchObject({ error: { code: "service_misconfigured" } });
  });

  it("answers the preflight, so the real request is attempted at all", () => {
    const response = misconfiguredResponse(requestFrom(ORIGIN, "OPTIONS"), envWith(ORIGIN));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("echoes nothing for an origin the environment does not list", () => {
    const response = misconfiguredResponse(
      requestFrom("https://attacker.example"),
      envWith(`${ORIGIN},http://127.0.0.1:5173`),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes nothing when `ALLOWED_ORIGINS` is itself the broken variable", () => {
    // A misconfigured deployment is not a reason to widen the boundary, and
    // this is the case where the allowlist cannot be consulted at all.
    const response = misconfiguredResponse(requestFrom(ORIGIN), envWith(undefined));

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the health probe under a misconfigured environment", () => {
  it("reports a bad region and environment rather than failing on them", async () => {
    // `/health` is exempt from the entrypoint assertion because it is the probe
    // a misconfiguration is diagnosed with. Enum-validating these two fields
    // would have put `AVALON_REGION` and `APP_ENV` — the variables most likely
    // to be the wrong ones — into the one response that has to survive them
    // being wrong, and the parse would answer a bare 500 naming nothing.
    const app = new Hono<HonoAppEnv>();
    app.route("/health", healthRoutes);
    const env = createInvalidTestEnv({
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }), first: async () => ({ ok: 1 }) }) },
      PAYLOADS: { list: async () => ({ objects: [] }) },
      AVALON_REGION: "enterprise-west-1",
      APP_ENV: "prod",
    });

    const response = await app.request("/health", undefined, env);

    // 503 here is the probe's own verdict on a half-bound environment, and it
    // carries the document. The failure this guards against is a 500 whose body
    // is `{error: {code: "internal_error"}}` — the response schema refusing to
    // describe the very misconfiguration the caller is asking about.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      region: "enterprise-west-1",
      environment: "prod",
      checks: { d1: { ok: true } },
    });
  });

  it("fails the probe on the contract alone, when every other required check passes", async () => {
    // The discriminating case. Every other required check is satisfied here, so
    // the 503 can only come from `envContract` — which is the property that
    // matters and the one a partial-env test cannot pin, because such an env
    // fails several checks and would answer 503 either way.
    const app = new Hono<HonoAppEnv>();
    app.route("/health", healthRoutes);
    const room = { fetch: async () => new Response(null, { status: 200 }) };
    const response = await app.request("/health", undefined, createInvalidTestEnv({
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }), first: async () => ({ ok: 1 }) }) },
      PAYLOADS: { list: async () => ({ objects: [] }) },
      SUBSTREAM_AGENTS: { idFromName: () => "id", get: () => room },
      ACTIVITY_QUEUE: { send: () => undefined },
      CONNECTOR_POLL_WORKFLOW: { create: () => undefined },
      CONNECTOR_EVENT_WORKFLOW: { create: () => undefined },
      WORKSTREAM_EMAIL_ADDRESS_KEY: "a".repeat(48),
      WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
      AVALON_REGION: "global",
      // Development, so the production-only checks stay out of `required` and
      // the contract is the single remaining fault.
      APP_ENV: "development",
    }));

    const body = await response.json() as {
      ok: boolean;
      checks: Record<string, { ok: boolean; message: string }>;
    };
    // Every check the probe blocks on, other than the contract, is satisfied.
    // The unsatisfied remainder — openRouter, the OAuth pairs, resend — are
    // deliberately non-blocking and do not decide `ok`.
    for (const name of ["d1", "r2", "durableObjects", "queue", "workflows", "workstreamEmailRegistry"]) {
      expect(body.checks[name]).toEqual({ ok: true, message: expect.any(String) });
    }
    expect(body.checks.envContract?.ok).toBe(false);
    // Development names them, which is the half of the disclosure split that
    // reaches a body at all.
    expect(body.checks.envContract?.message).toContain("SESSION_SIGNING_KEY is missing");
    // So this can only be the contract. Drop `envContract` from the required
    // set and both of these become 200/true — which is the bug being fixed.
    expect(body.ok).toBe(false);
    expect(response.status).toBe(503);
  });

  it("still answers when the region and environment are absent entirely", async () => {
    // The two fields the response itself is built from are contract fields
    // too. `z.string()` rejects `undefined`, so without a fallback a Worker
    // missing either one throws inside the parse and answers a bare 500 —
    // failing on two of the very violations this route exists to report.
    const app = new Hono<HonoAppEnv>();
    app.route("/health", healthRoutes);
    const response = await app.request("/health", undefined, createInvalidTestEnv({
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }), first: async () => ({ ok: 1 }) }) },
      PAYLOADS: { list: async () => ({ objects: [] }) },
    }));

    expect(response.status).toBe(503);
    const body = await response.json() as {
      region: string;
      environment: string;
      checks: { envContract?: { ok: boolean; message: string } };
    };
    expect(body.region).toBe("unset");
    expect(body.environment).toBe("unset");
    expect(body.checks.envContract?.ok).toBe(false);
    expect(body.checks.envContract?.message).toContain("the Worker cannot serve requests");
  });

  it("fails on the one fault that stops every other route, and names its keys", async () => {
    // The entrypoint refuses everything else on this and answers a body that
    // deliberately names nothing, because the keys are secrets. This probe is
    // the exemption to that refusal, so it is the place the names belong — and
    // it has to go `ok: false` here, or `health:regions` reports a Worker that
    // cannot serve a request as healthy. That is what let a real enterprise outage sit.
    const app = new Hono<HonoAppEnv>();
    app.route("/health", healthRoutes);
    const response = await app.request("/health", undefined, createInvalidTestEnv({
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }), first: async () => ({ ok: 1 }) }) },
      PAYLOADS: { list: async () => ({ objects: [] }) },
      AVALON_REGION: "global",
      APP_ENV: "production",
    }));

    expect(response.status).toBe(503);
    const body = await response.json() as {
      ok: boolean;
      checks: { envContract: { ok: boolean; message: string } };
    };
    expect(body.ok).toBe(false);
    expect(body.checks.envContract.ok).toBe(false);
    // Production withholds the key list: it is an inventory of the secrets this
    // Worker is running without, and nothing authenticates this route. The
    // names go to `env_contract_failed` instead.
    expect(body.checks.envContract.message)
      .toBe("the Worker cannot serve requests; see the env_contract_failed log");
    expect(body.checks.envContract.message).not.toContain("GOOGLE_OAUTH_CLIENT_ID");
  });

  it("reports the Global-only login secrets as required in every region but enterprise", async () => {
    // The exemption `/health` relies on cuts both ways: it is the one endpoint
    // still answering when `AVALON_REGION` is wrong, so it must not report the
    // key the entrypoint is failing on as fine. Only enterprise — the region the
    // architecture says never carries this pair — takes the relaxed reading.
    const app = new Hono<HonoAppEnv>();
    app.route("/health", healthRoutes);
    const report = async (region: string, configured = false) => {
      const response = await app.request("/health", undefined, createInvalidTestEnv({
        DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }), first: async () => ({ ok: 1 }) }) },
        PAYLOADS: { list: async () => ({ objects: [] }) },
        AVALON_REGION: region,
        APP_ENV: "production",
        ...(configured
          ? { GOOGLE_OAUTH_CLIENT_ID: "login-client", GOOGLE_OAUTH_CLIENT_SECRET: "login-secret" }
          : {}),
      }));
      const body = await response.json() as { checks: { googleLoginOAuth: { ok: boolean; message: string } } };
      return body.checks.googleLoginOAuth;
    };

    expect(await report("global")).toEqual({ ok: false, message: "not configured" });
    expect(await report("enterprise")).toEqual({ ok: true, message: "not required outside Global" });
    // A typo'd region is the case this exists for: it must read like Global,
    // not like enterprise, or the probe reassures an operator about the exact key
    // `env_contract_failed` is naming.
    expect(await report("gobal")).toEqual({ ok: false, message: "not configured" });
    expect(await report("enterprise-west-1")).toEqual({ ok: false, message: "not configured" });
    // And enterprise holding the pair is a secret outside its blast radius, not a pass.
    expect(await report("enterprise", true))
      .toEqual({ ok: false, message: "configured outside Global; remove it from this region" });
    expect(await report("global", true)).toEqual({ ok: true, message: "configured" });
  });
});
