import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { ApiError, asApiError } from "../src/lib/api-error";
import { errorHandler } from "../src/middleware/errors";
import { createTestEnv } from "./helpers/cloudflare-test";

/**
 * What a Durable Object's thrown `ApiError` looks like on the Worker side: the
 * name, message, and own fields survive the RPC boundary, the prototype does
 * not. Built the way workerd rebuilds it rather than with `new ApiError`, so
 * this proves the handler reads the shape and not the class.
 */
function crossedRpc(status: number, code: string, message: string, details?: Record<string, unknown>): Error {
  const error = new Error(message);
  error.name = "ApiError";
  Object.assign(error, { status, code, ...(details ? { details } : {}) });
  return error;
}

async function respond(thrown: unknown): Promise<Response> {
  const app = new Hono<HonoAppEnv>();
  app.onError(errorHandler);
  app.get("/probe", () => {
    throw thrown;
  });
  return app.request("/probe", {}, createTestEnv({ AVALON_REGION: "global" }));
}

describe("an ApiError thrown inside a Durable Object", () => {
  it("keeps its status and code once it crosses the RPC boundary", async () => {
    const response = await respond(crossedRpc(404, "sidekick_not_found", "This Sidekick was deleted"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "sidekick_not_found", message: "This Sidekick was deleted" },
    });
  });

  it("carries its details through as well", async () => {
    const response = await respond(crossedRpc(409, "sidekick_definition_not_ready", "Not ready", { revision: 2 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { revision: 2 } } });
  });

  it("is still an internal error when only the name matches", async () => {
    const impostor = new Error("no fields");
    impostor.name = "ApiError";
    const response = await respond(impostor);
    expect(response.status).toBe(500);
    expect(asApiError(impostor)).toBeNull();
    expect(asApiError(new ApiError(404, "x", "y"))).toBeInstanceOf(ApiError);
  });
});
