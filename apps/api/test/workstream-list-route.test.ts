import { asUserId, asWorkspaceId, asWorkstreamId, WorkstreamSchema } from "@rally/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workstreamRoutes } from "../src/routes/workstreams";
import { WorkstreamDirectoryService } from "../src/services/workstream-directory-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { openWorkstreamAuthorityForTest } from "./helpers/durable-authority";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000008b1");
const USER_ID = asUserId("00000000-0000-7000-8000-0000000008b2");
const VISITED_ID = asWorkstreamId("00000000-0000-7000-8000-0000000008b3");
const UNVISITED_ID = asWorkstreamId("00000000-0000-7000-8000-0000000008b4");
const AT = "2026-09-14T20:00:00.000Z";

function workstream(id: string, lastAccessedAt: string | null) {
  return WorkstreamSchema.parse({
    id,
    workspaceId: WORKSPACE_ID,
    title: id === VISITED_ID ? "Recently visited" : "Newer but unvisited",
    objective: "",
    emailAddress: null,
    createdByUserId: null,
    harnessStatus: "idle",
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: AT,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    scope: "workspace",
    lastAccessedAt,
  });
}

function routedApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (context, next) => {
    context.set("auth", {
      sessionId: "session",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      region: "global",
      role: "member",
    });
    await next();
  });
  app.route("/workstreams", workstreamRoutes);
  app.onError(errorHandler);
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe("the work-stream list route", () => {
  it("preserves the workspace directory's personal-access order", async () => {
    const database = migratedSqliteDatabase();
    openWorkstreamAuthorityForTest(database);
    const items = [
      workstream(VISITED_ID, "2026-09-14T21:00:00.000Z"),
      workstream(UNVISITED_ID, null),
    ];
    const list = vi.spyOn(WorkstreamDirectoryService.prototype, "list").mockResolvedValue({
      items,
      stateVersions: items.map((item, index) => ({
        workstreamId: item.id,
        commonEventId: `00000000-0000-7000-8000-0000000008c${index}`,
        viewerEventId: null,
        authorityGeneration: 1,
        commonWaterline: 1,
        viewerWaterline: 0,
      })),
      nextCursor: null,
      directoryWaterline: 1,
    });

    try {
      const response = await routedApp().request(
        "https://api.example.com/workstreams?limit=20&includeSystem=true",
        undefined,
        createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error", DB: sqliteD1(database) }),
      );

      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ id: string; scope: string }> };
      expect(body.items.map(({ id, scope }) => ({ id, scope }))).toEqual([
        { id: VISITED_ID, scope: "workspace" },
        { id: UNVISITED_ID, scope: "workspace" },
      ]);
      expect(list).toHaveBeenCalledWith(20, undefined, true);
    } finally {
      database.close();
    }
  });
});
