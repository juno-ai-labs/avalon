import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __realtimeTranscriptionTesting } from "../src/services/realtime-transcription-service";
import type { TranscriptionSocketClaims } from "../src/services/socket-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: SQLInputValue[]): D1PreparedStatement {
    return createTestD1PreparedStatement(new SqliteD1Statement(this.database, this.sql, values));
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return createTestD1Result<T>({
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    });
  }
}

class SqliteD1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(readFileSync(
      new URL("../../../packages/db/migrations/0040_realtime_transcription_admission.sql", import.meta.url),
      "utf8",
    ));
  }

  prepare(sql: string): D1PreparedStatement {
    return createTestD1PreparedStatement(new SqliteD1Statement(this.database, sql));
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }

  sessionExpiry(sessionId: string): number {
    return Number(this.database.prepare(
      "SELECT expires_at FROM realtime_transcription_sessions WHERE id = ?",
    ).get(sessionId)?.expires_at ?? 0);
  }
}

function claims(ticketId: string, userId = "user-1"): TranscriptionSocketClaims {
  return {
    ticketId,
    userId,
    workspaceId: "workspace-1",
    region: "global",
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
  };
}

describe("realtime transcription admission", () => {
  let adapter: SqliteD1Database | undefined;

  afterEach(() => {
    adapter?.database.close();
    vi.useRealTimers();
  });

  it("consumes each signed ticket exactly once", async () => {
    adapter = new SqliteD1Database();
    const env = createTestEnv({ DB: createTestD1Database(adapter) });
    const ticketClaims = claims("ticket-1");
    const sessionId = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, ticketClaims);

    await expect(
      __realtimeTranscriptionTesting.reserveTranscriptionSession(env, ticketClaims),
    ).rejects.toMatchObject({ status: 401, code: "socket_ticket_replayed" });

    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "workspace-1", sessionId);
  });

  it("bounds concurrent sessions and keeps a rejected ticket consumed", async () => {
    adapter = new SqliteD1Database();
    const env = createTestEnv({ DB: createTestD1Database(adapter) });
    const first = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-1"));
    const second = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-2"));
    const rejectedClaims = claims("ticket-3");

    await expect(
      __realtimeTranscriptionTesting.reserveTranscriptionSession(env, rejectedClaims),
    ).rejects.toMatchObject({ status: 429, code: "dictation_concurrency_limit" });
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "workspace-1", first);
    await expect(
      __realtimeTranscriptionTesting.reserveTranscriptionSession(env, rejectedClaims),
    ).rejects.toMatchObject({ status: 401, code: "socket_ticket_replayed" });

    const replacement = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-4"));
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "workspace-1", second);
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "workspace-1", replacement);
  });

  it("bounds aggregate workspace concurrency across distinct users", async () => {
    adapter = new SqliteD1Database();
    const env = createTestEnv({ DB: createTestD1Database(adapter) });
    const sessions: string[] = [];
    for (let index = 0; index < __realtimeTranscriptionTesting.limits.maxConcurrentWorkspaceSessions; index += 1) {
      sessions.push(await __realtimeTranscriptionTesting.reserveTranscriptionSession(
        env,
        claims(`ticket-${index}`, `user-${index}`),
      ));
    }

    await expect(__realtimeTranscriptionTesting.reserveTranscriptionSession(
      env,
      claims("ticket-over-workspace-limit", "another-user"),
    )).rejects.toMatchObject({ status: 429, code: "dictation_concurrency_limit" });

    await Promise.all(sessions.map((sessionId) =>
      __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "workspace-1", sessionId)));
  });

  it("renews a live session lease without replacing the transcription session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T18:00:00.000Z"));
    adapter = new SqliteD1Database();
    const env = createTestEnv({ DB: createTestD1Database(adapter) });
    const sessionId = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-renew"));
    const originalExpiry = adapter.sessionExpiry(sessionId);

    vi.setSystemTime(new Date("2026-08-07T18:01:00.000Z"));
    await __realtimeTranscriptionTesting.renewTranscriptionSession(env, "workspace-1", sessionId);

    expect(adapter.sessionExpiry(sessionId)).toBe(originalExpiry + 60);
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "workspace-1", sessionId);
  });
});
