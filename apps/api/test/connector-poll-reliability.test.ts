import type { NormalizedActivity } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import {
  __integrationTesting,
  advanceOwningPollTarget,
  commitConnectorCursor,
} from "../src/services/integrations";
import { createTestD1Database } from "./helpers/cloudflare-test";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const connectionId = "00000000-0000-7000-8000-000000000002";
const scheduleId = "00000000-0000-7000-8000-000000000003";

function activity(): Omit<NormalizedActivity, "id"> {
  return {
    workspaceId,
    region: "global",
    connectionId,
    connectionScope: "workspace",
    connectionOwnerUserId: null,
    provider: "google",
    providerEventId: "history-1:message-1:added",
    eventType: "email.received",
    resourceType: "gmail_thread",
    providerResourceId: "thread-1",
    actor: {},
    subject: {},
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:01.000Z",
    title: "Mail arrived",
    summary: "Summary",
    textSnippet: "Snippet",
    payloadRef: null,
    visibility: { scope: "workspace" },
    targetUserIds: [],
    entityKeys: ["thread-1"],
    dedupeKey: "mail-dedupe-1",
    rawContentHash: null,
    metadata: {},
  };
}

describe("connector poll reliability", () => {
  it("recovers the canonical pending activity after an injected lost insert response", async () => {
    let canonicalId: string | null = null;
    let loseFirstInsertResponse = true;
    const database = createTestD1Database({
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...bound: unknown[]) {
            values = bound;
            return statement;
          },
          async first() {
            if (!sql.includes("INSERT INTO activities")) throw new Error("unexpected first query");
            if (!canonicalId) canonicalId = String(values[0]);
            if (loseFirstInsertResponse) {
              loseFirstInsertResponse = false;
              throw new Error("injected response loss after commit");
            }
            return null;
          },
          async all() {
            if (!sql.includes("processing_status IN ('pending', 'failed')")) {
              throw new Error("unexpected all query");
            }
            return {
              results: [{ id: canonicalId, processing_status: "pending" }],
              success: true,
              meta: {},
            };
          },
        };
        return statement;
      },
    });

    await expect(
      __integrationTesting.persistPolledActivity(database, activity()),
    ).rejects.toThrow("injected response loss");
    await expect(
      __integrationTesting.persistPolledActivity(database, activity()),
    ).resolves.toEqual([canonicalId]);
  });

  it("does not let a stale concurrent poll overwrite a newer cursor", async () => {
    const currentCursor = JSON.stringify({ gmail: { historyId: "newer" } });
    const database = createTestD1Database({
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async run() {
            if (!sql.includes("AND cursor_json = ?5")) throw new Error("cursor update is not guarded");
            return { success: true, meta: { changes: 0 } };
          },
          async first() {
            return { cursor_json: currentCursor };
          },
        };
        return statement;
      },
    });

    await expect(commitConnectorCursor(
      database,
      { workspaceId, connectionId },
      {
        baseCursorJson: JSON.stringify({ gmail: { historyId: "old" } }),
        cursorJson: JSON.stringify({ gmail: { historyId: "stale-result" } }),
      },
      "2026-01-01T00:00:02.000Z",
    )).resolves.toBe("superseded");
  });

  it("advances the owning schedule or resource watch instead of the unused connection timestamp", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const database = createTestD1Database({
      prepare(sql: string) {
        const recorded = { sql, values: [] as unknown[] };
        statements.push(recorded);
        return {
          bind(...values: unknown[]) {
            recorded.values = values;
            return this;
          },
        };
      },
      async batch() {
        return [
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 0 } },
        ];
      },
    });

    await expect(advanceOwningPollTarget(
      database,
      { workspaceId, connectionId, pollScheduleId: scheduleId },
      "2026-01-01T00:00:05.000Z",
      "2026-01-01T00:00:02.000Z",
    )).resolves.toBe(true);
    expect(statements.map(({ sql }) => sql).join("\n")).toContain("UPDATE schedules");
    expect(statements.map(({ sql }) => sql).join("\n")).toContain("UPDATE resource_watches");
    expect(statements.map(({ sql }) => sql).join("\n")).not.toContain("UPDATE connector_connections");
  });
});
