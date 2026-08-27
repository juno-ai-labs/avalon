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
  it("preserves the service's active-project audience fence", async () => {
    const remove = vi.spyOn(WorkstreamService.prototype, "removeParticipant")
      .mockRejectedValue(new ApiError(
        409,
        "project_audience_managed_by_project",
        "Change project participants before removing this person",
      ));

    const response = await routedApp().request(
      `https://api.example.com/workstreams/${WORKSTREAM_ID}/participants/${TARGET_ID}`,
      { method: "DELETE" },
      createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "project_audience_managed_by_project",
      },
    });
    expect(remove).toHaveBeenCalledWith(WORKSTREAM_ID, TARGET_ID);
  });
});
