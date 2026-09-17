import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { emitProductUsageTelemetry } from "../src/telemetry/product-usage";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

describe("product usage telemetry lifecycle", () => {
  it("returns before regional acceptance while keeping that work registered", async () => {
    const userId = asUserId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1");
    const workspaceId = asWorkspaceId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2");
    const eventId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3";
    const database = preRetirementProductSqliteDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${userId}', 'subject', 'member@example.com', 'Member',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
      INSERT INTO workspaces
        (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', 'UTC', '${userId}',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
    `);
    const deferred: Promise<unknown>[] = [];

    emitProductUsageTelemetry(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "production",
      APP_VERSION: "1.96.0",
      BUILD_SHA: "build-1",
    }), {
      workspaceId,
      name: "terminal_workspace_terminal",
      properties: {
        workstreamId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4",
        action: "expire",
        result: "success",
        duration: "unknown",
        repositorySelected: false,
        connectorType: "none",
        localFilesRetained: false,
      },
      operationId: eventId,
      eventId,
    }, (promise) => deferred.push(promise));

    expect(deferred).toHaveLength(1);
    expect(database.prepare(
      "SELECT event_id FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toBeUndefined();

    await Promise.all(deferred);
    expect(database.prepare(
      "SELECT event_id FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ event_id: eventId });
    database.close();
  });
});
