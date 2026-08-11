import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { healthRoutes } from "../src/routes/health";
import { misconfiguredResponse } from "../src/lib/misconfigured-response";

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
  return { ALLOWED_ORIGINS: allowedOrigins } as unknown as Env;
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
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }), first: async () => ({ ok: 1 }) }) },
      PAYLOADS: { list: async () => ({ objects: [] }) },
      AVALON_REGION: "eu-west-1",
      APP_ENV: "prod",
    } as unknown as Env;

    const response = await app.request("/health", undefined, env);

    // 503 here is the probe's own verdict on a half-bound environment, and it
    // carries the document. The failure this guards against is a 500 whose body
    // is `{error: {code: "internal_error"}}` — the response schema refusing to
    // describe the very misconfiguration the caller is asking about.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      region: "eu-west-1",
      environment: "prod",
      checks: { d1: { ok: true } },
    });
  });
});
