import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { errorHandler } from "../src/middleware/errors";
import { workstreamRoutes } from "../src/routes/workstreams";
import { WorkstreamService } from "../src/services/workstream-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000008a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000008a2");
const ACTOR_ID = asUserId("00000000-0000-7000-8000-0000000008a3");
const TARGET_ID = "00000000-0000-7000-8000-0000000008a4";

afterEach(() => vi.restoreAllMocks());

function routedApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (context, next) => {
    context.set("auth", {
      sessionId: "session",
      workspaceId: WORKSPACE_ID,
      userId: ACTOR_ID,
      region: "global",
      role: "member",
    });
    await next();
  });
  app.route("/workstreams", workstreamRoutes);
  app.onError(errorHandler);
  return app;
}

describe("the participant removal route", () => {
  it("given the service accepts, when a participant is deleted, then both path parameters reach it and the answer is an empty 204", async () => {
    const remove = vi.spyOn(WorkstreamService.prototype, "removeParticipant").mockResolvedValue();

    const response = await routedApp().request(
      `https://api.example.com/workstreams/${WORKSTREAM_ID}/participants/${TARGET_ID}`,
      { method: "DELETE" },
      createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error" }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    // In that order: the two path parameters are both ids of the same shape,
    // so a route that transposed them would remove the actor from a Channel
    // named after the person it was asked to remove.
    expect(remove).toHaveBeenCalledWith(WORKSTREAM_ID, TARGET_ID);
  });

  it("given the service refuses, when a participant is deleted, then the refusal reaches the client with its own status and code", async () => {
    // `workstream_participant_required` is a real refusal on this path: the
    // last active participant cannot be removed, and the decision is the main
    // conversation's, on the far side of a Durable Object RPC hop. What is
    // being proved here is only what the route adds — that it awaits the
    // service rather than answering 204 while the rejection goes unhandled,
    // and that `errorHandler` renders the code rather than a 500.
    vi.spyOn(WorkstreamService.prototype, "removeParticipant")
      .mockRejectedValue(new ApiError(
        409,
        "workstream_participant_required",
        "At least one participant must remain in this work stream",
      ));

    const response = await routedApp().request(
      `https://api.example.com/workstreams/${WORKSTREAM_ID}/participants/${TARGET_ID}`,
      { method: "DELETE" },
      createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workstream_participant_required" },
    });
  });
});
