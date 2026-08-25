import { asUserId } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
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
    // The authoritative WorkspaceDO shape (unit-suffixed epoch-seconds
    // columns), minus the identity fences the double cannot satisfy.
    this.database.exec(`
      CREATE TABLE realtime_transcription_ticket_receipts (
        ticket_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        consumed_at_s INTEGER NOT NULL,
        expires_at_s INTEGER NOT NULL CHECK (expires_at_s > consumed_at_s)
      ) STRICT;
      CREATE TABLE realtime_transcription_sessions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        started_at_s INTEGER NOT NULL,
        expires_at_s INTEGER NOT NULL CHECK (expires_at_s > started_at_s)
      ) STRICT;
      CREATE INDEX realtime_transcription_sessions_user_idx
        ON realtime_transcription_sessions(workspace_id, user_id, expires_at_s);
    `);
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
      "SELECT expires_at_s FROM realtime_transcription_sessions WHERE id = ?",
    ).get(sessionId)?.expires_at_s ?? 0);
  }
}

function claims(ticketId: string, userId = asUserId("00000000-0000-4000-8000-000000000001")): TranscriptionSocketClaims {
  return {
    ticketId,
    userId,
    workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
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

    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "668953d2-25f2-44fd-8d72-1e8cf024a277", sessionId);
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
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "668953d2-25f2-44fd-8d72-1e8cf024a277", first);
    await expect(
      __realtimeTranscriptionTesting.reserveTranscriptionSession(env, rejectedClaims),
    ).rejects.toMatchObject({ status: 401, code: "socket_ticket_replayed" });

    const replacement = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-4"));
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "668953d2-25f2-44fd-8d72-1e8cf024a277", second);
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "668953d2-25f2-44fd-8d72-1e8cf024a277", replacement);
  });

  it("bounds aggregate workspace concurrency across distinct users", async () => {
    adapter = new SqliteD1Database();
    const env = createTestEnv({ DB: createTestD1Database(adapter) });
    const sessions: string[] = [];
    for (let index = 0; index < __realtimeTranscriptionTesting.limits.maxConcurrentWorkspaceSessions; index += 1) {
      sessions.push(await __realtimeTranscriptionTesting.reserveTranscriptionSession(
        env,
        claims(`ticket-${index}`, asUserId(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)),
      ));
    }

    await expect(__realtimeTranscriptionTesting.reserveTranscriptionSession(
      env,
      claims("ticket-over-workspace-limit", asUserId("00000000-0000-4000-8000-999999999999")),
    )).rejects.toMatchObject({ status: 429, code: "dictation_concurrency_limit" });

    await Promise.all(sessions.map((sessionId) =>
      __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "668953d2-25f2-44fd-8d72-1e8cf024a277", sessionId)));
  });

  it("renews a live session lease without replacing the transcription session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T18:00:00.000Z"));
    adapter = new SqliteD1Database();
    const env = createTestEnv({ DB: createTestD1Database(adapter) });
    const sessionId = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-renew"));
    const originalExpiry = adapter.sessionExpiry(sessionId);

    vi.setSystemTime(new Date("2026-08-07T18:01:00.000Z"));
    await __realtimeTranscriptionTesting.renewTranscriptionSession(env, "668953d2-25f2-44fd-8d72-1e8cf024a277", sessionId);

    expect(adapter.sessionExpiry(sessionId)).toBe(originalExpiry + 60);
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, "668953d2-25f2-44fd-8d72-1e8cf024a277", sessionId);
  });
});
