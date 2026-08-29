import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { RealtimeTranscriptionService } from "../src/services/realtime-transcription-service";
import { issueTranscriptionSocketTicket } from "../src/services/socket-service";
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

  activeSessions(): number {
    return Number(this.database.prepare(
      "SELECT COUNT(*) AS count FROM realtime_transcription_sessions",
    ).get()?.count ?? 0);
  }
}

type SocketEvent = { code?: number; data?: unknown; reason?: string };

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly sent: string[] = [];
  acceptedWith: WebSocketAcceptOptions | undefined;
  readyState = FakeSocket.OPEN;
  private readonly listeners = new Map<string, Array<(event: SocketEvent) => void>>();

  accept(options?: WebSocketAcceptOptions): void {
    this.acceptedWith = options;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function"
      ? listener as unknown as (event: SocketEvent) => void
      : (event: SocketEvent) => listener.handleEvent(event as unknown as Event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = FakeSocket.CLOSING;
  }

  emit(type: string, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is closed");
    this.sent.push(data);
  }
}

class FakeResponse {
  readonly status: number;
  readonly webSocket: WebSocket | undefined;

  constructor(_body: BodyInit | null, init: ResponseInit & { webSocket?: WebSocket } = {}) {
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
}

const auth: AuthContext = {
  sessionId: "session-1",
  userId: asUserId("00000000-0000-7000-8000-000000000001"),
  workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000002"),
  region: "global",
  role: "owner",
};

function request(): Request {
  return {
    headers: new Headers({ Origin: "app://avalon", Upgrade: "websocket" }),
  } as Request;
}

function env(database: SqliteD1Database): Env {
  return createTestEnv({
    DB: createTestD1Database(database),
    SESSION_SIGNING_KEY: "test-signing-key",
    AVALON_REGION: "global",
    ALLOWED_ORIGINS: "app://avalon",
    AZURE_OPENAI_ENDPOINT: "https://avalon.openai.azure.com",
    AZURE_OPENAI_API_KEY: "test-api-key",
    AZURE_OPENAI_REALTIME_DEPLOYMENT: "gpt-live-transcribe",
  });
}

function installSocketRuntime(upstream: FakeSocket): { pairs: Array<{ client: FakeSocket; server: FakeSocket }> } {
  const pairs: Array<{ client: FakeSocket; server: FakeSocket }> = [];
  class FakeWebSocketPair {
    readonly 0: FakeSocket;
    readonly 1: FakeSocket;

    constructor() {
      this[0] = new FakeSocket();
      this[1] = new FakeSocket();
      pairs.push({ client: this[0], server: this[1] });
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  vi.stubGlobal("Response", FakeResponse);
  vi.stubGlobal("fetch", vi.fn(async () => ({ webSocket: upstream })));
  return { pairs };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("realtime transcription proxy", () => {
  it("opens the Azure upgrade over HTTPS and releases the lease when the client closes", async () => {
    const database = new SqliteD1Database();
    const upstream = new FakeSocket();
    const { pairs } = installSocketRuntime(upstream);
    const deferred: Promise<void>[] = [];
    const environment = env(database);
    const ticket = await issueTranscriptionSocketTicket(environment, auth);

    try {
      const response = await new RealtimeTranscriptionService(
        environment,
        (promise) => deferred.push(promise),
      ).upgrade(ticket, request());

      expect(response.status).toBe(101);
      expect(fetch).toHaveBeenCalledWith(
        "https://avalon.openai.azure.com/openai/v1/realtime?intent=transcription",
        expect.objectContaining({ headers: expect.objectContaining({ Upgrade: "websocket" }) }),
      );
      expect(upstream.acceptedWith).toEqual({ allowHalfOpen: true });
      expect(pairs[0]?.server.acceptedWith).toEqual({ allowHalfOpen: true });
      expect(JSON.parse(upstream.sent[0] ?? "{}")).toMatchObject({
        type: "session.update",
        session: { audio: { input: { transcription: { model: "gpt-live-transcribe" } } } },
      });
      expect(database.activeSessions()).toBe(1);

      pairs[0]?.server.emit("close", { code: 1000, reason: "Client closed" });
      await Promise.all(deferred);

      expect(upstream.closes).toContainEqual({ code: 1000, reason: "Client closed" });
      expect(database.activeSessions()).toBe(0);
    } finally {
      database.database.close();
    }
  });

  it("closes both sockets and releases the lease when the frame-rate policy is exceeded", async () => {
    // Only Date is faked: the limiter's window must not advance between the
    // upgrade and the 31st frame, while releaseAndReport's retry setTimeout
    // has to stay real for `await Promise.all(deferred)` to settle.
    vi.useFakeTimers({ toFake: ["Date"] });
    const database = new SqliteD1Database();
    const upstream = new FakeSocket();
    const { pairs } = installSocketRuntime(upstream);
    const deferred: Promise<void>[] = [];
    const environment = env(database);
    const ticket = await issueTranscriptionSocketTicket(environment, auth);

    try {
      await new RealtimeTranscriptionService(
        environment,
        (promise) => deferred.push(promise),
      ).upgrade(ticket, request());
      const server = pairs[0]!.server;
      for (let index = 0; index < 31; index += 1) {
        server.emit("message", {
          data: JSON.stringify({ type: "input_audio_buffer.append", audio: "AQID" }),
        });
      }
      await Promise.all(deferred);

      expect(server.sent.map((message) => JSON.parse(message))).toContainEqual({
        type: "error",
        error: {
          code: "dictation_frame_rate_limit",
          message: "Dictation audio arrived too quickly.",
        },
      });
      expect(server.closes).toContainEqual({ code: 1008, reason: "Dictation audio arrived too quickly." });
      expect(upstream.closes).toContainEqual({ code: 1008, reason: "Dictation audio arrived too quickly." });
      expect(database.activeSessions()).toBe(0);
    } finally {
      database.database.close();
    }
  });

  it("does not close a healthy transcription session after the former five-minute limit", async () => {
    vi.useFakeTimers();
    const database = new SqliteD1Database();
    const upstream = new FakeSocket();
    const { pairs } = installSocketRuntime(upstream);
    const environment = env(database);
    const ticket = await issueTranscriptionSocketTicket(environment, auth);

    try {
      await new RealtimeTranscriptionService(environment).upgrade(ticket, request());
      await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);

      expect(pairs[0]!.server.closes).toEqual([]);
      expect(upstream.closes).toEqual([]);
    } finally {
      database.database.close();
    }
  });
});
