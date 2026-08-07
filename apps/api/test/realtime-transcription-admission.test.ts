import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { __realtimeTranscriptionTesting } from "../src/services/realtime-transcription-service";
import type { TranscriptionSocketClaims } from "../src/services/socket-service";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: SQLInputValue[]): D1PreparedStatement {
    return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<T>;
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
    return new SqliteD1Statement(this.database, sql) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
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

  afterEach(() => adapter?.database.close());

  it("consumes each signed ticket exactly once", async () => {
    adapter = new SqliteD1Database();
    const env = { DB: adapter as unknown as D1Database } as Env;
    const ticketClaims = claims("ticket-1");
    const sessionId = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, ticketClaims);

    await expect(
      __realtimeTranscriptionTesting.reserveTranscriptionSession(env, ticketClaims),
    ).rejects.toMatchObject({ status: 401, code: "socket_ticket_replayed" });

    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, sessionId);
  });

  it("bounds concurrent sessions and keeps a rejected ticket consumed", async () => {
    adapter = new SqliteD1Database();
    const env = { DB: adapter as unknown as D1Database } as Env;
    const first = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-1"));
    const second = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-2"));
    const rejectedClaims = claims("ticket-3");

    await expect(
      __realtimeTranscriptionTesting.reserveTranscriptionSession(env, rejectedClaims),
    ).rejects.toMatchObject({ status: 429, code: "dictation_concurrency_limit" });
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, first);
    await expect(
      __realtimeTranscriptionTesting.reserveTranscriptionSession(env, rejectedClaims),
    ).rejects.toMatchObject({ status: 401, code: "socket_ticket_replayed" });

    const replacement = await __realtimeTranscriptionTesting.reserveTranscriptionSession(env, claims("ticket-4"));
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, second);
    await __realtimeTranscriptionTesting.releaseTranscriptionSession(env, replacement);
  });

  it("bounds aggregate workspace concurrency across distinct users", async () => {
    adapter = new SqliteD1Database();
    const env = { DB: adapter as unknown as D1Database } as Env;
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
      __realtimeTranscriptionTesting.releaseTranscriptionSession(env, sessionId)));
  });
});
