import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Env, HonoAppEnv } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { errorHandler } from "../src/middleware/errors";
import { createTestEnv } from "./helpers/cloudflare-test";

function testEnv(): Env {
  return createTestEnv({
    ALLOWED_ORIGINS: "app://avalon",
    AVALON_REGION: "global",
    LOG_LEVEL: "info",
  });
}

/** A route that serves a row its own response contract rejects. */
function appServingABrokenRow(): Hono<HonoAppEnv> {
  const schema = z.object({ id: z.string(), lastActivityAt: z.string().datetime() });
  const app = new Hono<HonoAppEnv>();
  app.onError(errorHandler);
  app.get("/workstreams/:id", (c) =>
    c.json(schema.parse({ id: c.req.param("id"), lastActivityAt: null })));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("response contract failures", () => {
  it("names the offending field in the log without leaking it to the member", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await appServingABrokenRow().request(
      "https://api.example.com/workstreams/019fec70-fba0-7b0e-9f7a-3dd1ef56520f",
      { method: "GET" },
      testEnv(),
    );

    expect(response.status).toBe(500);
    // The member-facing envelope is unchanged: a response that failed its own
    // contract is an internal error and says nothing more.
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred",
        requestId: null,
      },
    });

    // The operator-facing log is what was missing: a bare `internal_error` named
    // neither the route nor the field, so 131 identical failures in a day could
    // not be diagnosed from logs at all.
    expect(logged).toHaveBeenCalledTimes(1);
    const entry = logged.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "error",
      event: "request_failed",
      code: "internal_error",
      status: 500,
      error_name: "ZodError",
      method: "GET",
      path: "/workstreams/019fec70-fba0-7b0e-9f7a-3dd1ef56520f",
      // The route template as well as the resolved path: without it, 131
      // failures on one work stream are 131 distinct log lines rather than one
      // group, which is how the original burst stayed hard to see.
      route: "/workstreams/:id",
      validation_issues: [{ path: "lastActivityAt", code: "invalid_type" }],
    });
  });

  it("leaves a typed API error's log shape alone", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono<HonoAppEnv>();
    app.onError(errorHandler);
    app.get("/boom", () => {
      throw new ApiError(404, "not_found", "The thing is missing");
    });

    const response = await app.request("https://api.example.com/boom", { method: "GET" }, testEnv());

    expect(response.status).toBe(404);
    expect(logged).toHaveBeenCalledTimes(1);
    const entry = logged.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "warn", code: "not_found", status: 404, error_name: "ApiError" });
    // Route and issue paths are added for a failed response contract only; a
    // deliberate 4xx already carries its own code.
    expect(entry).not.toHaveProperty("validation_issues");
    expect(entry).not.toHaveProperty("path");
  });

  it("keeps a code a Durable Object threw across the RPC hop on the row, and only a code", async () => {
    // A plain `Error` arrives from the hop with its message and nothing else,
    // and the row withheld it: `internal_error`, `Error`, no reason. A message
    // with the shape of a code cannot be prose, so it is carried; one without
    // — provider text, a member's words — still is not.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono<HonoAppEnv>();
    app.onError(errorHandler);
    app.get("/refused", () => {
      throw new Error("admit_external_event_invalid:event.eventSequence:invalid_type");
    });
    app.get("/prose", () => {
      throw new Error("Provider included customer@example.com in its response");
    });
    app.get("/interpolated", () => {
      throw new Error("memory_table_value_type:Customer_Email:string");
    });

    const refused = await app.request("https://api.example.com/refused", { method: "GET" }, testEnv());
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(logged.mock.calls[0]![0]).toMatchObject({
      code: "internal_error",
      error_name: "Error",
      error_code: "admit_external_event_invalid:event.eventSequence:invalid_type",
    });

    await app.request("https://api.example.com/prose", { method: "GET" }, testEnv());
    const prose = logged.mock.calls[1]![0] as Record<string, unknown>;
    expect(prose).toMatchObject({ code: "internal_error", error_name: "Error" });
    expect(prose).not.toHaveProperty("error_code");
    expect(JSON.stringify(prose)).not.toContain("customer@example.com");
    // The list row reads the code without expanding the entry.
    expect(logged.mock.calls[0]![0]).toMatchObject({
      message: "request_failed 500 internal_error admit_external_event_invalid:event.eventSequence:invalid_type",
    });

    // Code-shaped is not trusted: a member-chosen name after a colon stays off.
    await app.request("https://api.example.com/interpolated", { method: "GET" }, testEnv());
    const interpolated = logged.mock.calls[2]![0] as Record<string, unknown>;
    expect(interpolated).not.toHaveProperty("error_code");
    expect(JSON.stringify(interpolated)).not.toContain("Customer_Email");
  });
});
