import { asUserId, asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { RealtimeTranscriptionService } from "../src/services/realtime-transcription-service";
import { issueTranscriptionSocketTicket } from "../src/services/socket-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

/**
 * The workspace's dictation admission, as this suite needs to see it.
 *
 * Admission itself is decided by WorkspaceDO and asserted against a real object
 * in `test-workers/workspace-transcription-admission.test.ts`. What these tests
 * are about is the proxy either side of it: that a socket takes exactly one
 * slot, and gives it back when it closes or is closed on it. So this counts
 * slots and nothing else — it used to be a hand-built SQLite copy of the
 * object's two tables, which could drift from the real schema without any test
 * noticing, and which answered questions this file never asks.
 */
class TranscriptionAdmissions {
  private readonly live = new Set<string>();
  renewals = 0;

  binding(): Env["WORKSPACE_DOS"] {
    const stub = {
      admitTranscriptionSession: async (input: { sessionId: string }) => {
        this.live.add(input.sessionId);
        return { outcome: "admitted" as const, expiresAtSeconds: 1_800_000_120 };
      },
      releaseTranscriptionSession: async (input: { sessionId: string }) => {
        this.live.delete(input.sessionId);
      },
      renewTranscriptionSession: async (input: { sessionId: string }) => {
        this.renewals += 1;
        return {
          renewed: this.live.has(input.sessionId),
          expiresAtSeconds: this.live.has(input.sessionId) ? 1_800_000_180 : null,
        };
      },
    };
    const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: () => createTestDurableObjectId("workspace-id"),
      get: () => stub,
      jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
    });
    return binding;
  }

  activeSessions(): number {
    return this.live.size;
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

function env(admissions: TranscriptionAdmissions): Env {
  return createTestEnv({
    WORKSPACE_DOS: admissions.binding(),
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
    const database = new TranscriptionAdmissions();
    const upstream = new FakeSocket();
    const { pairs } = installSocketRuntime(upstream);
    const deferred: Promise<void>[] = [];
    const environment = env(database);
    const ticket = await issueTranscriptionSocketTicket(environment, auth);

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
    const server = pairs[0]!.server;
    server.emit("message", { data: JSON.stringify({ type: "future_audio_event" }) });
    expect(server.sent).toEqual([]);
    expect(upstream.sent).toHaveLength(1);
    server.emit("message", { data: JSON.stringify({ type: "input_audio_buffer.commit", future: true }) });
    expect(JSON.parse(upstream.sent[1]!)).toEqual({ type: "input_audio_buffer.commit" });

    pairs[0]?.server.emit("close", { code: 1000, reason: "Client closed" });
    await Promise.all(deferred);

    expect(upstream.closes).toContainEqual({ code: 1000, reason: "Client closed" });
    expect(database.activeSessions()).toBe(0);
  });

  it("keeps an admitted session open through a catch-up burst and forwards its commit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const admissions = new TranscriptionAdmissions();
    const upstream = new FakeSocket();
    const { pairs } = installSocketRuntime(upstream);
    const deferred: Promise<void>[] = [];
    const environment = env(admissions);
    const ticket = await issueTranscriptionSocketTicket(environment, auth);
    await new RealtimeTranscriptionService(environment, (promise) => { deferred.push(promise); })
      .upgrade(ticket, request());
    const server = pairs[0]!.server;
    try {
      for (let index = 0; index < 40; index += 1) {
        server.emit("message", { data: JSON.stringify({
          type: "input_audio_buffer.append", audio: Buffer.from([index, 0]).toString("base64"),
        }) });
      }
      server.emit("message", { data: JSON.stringify({ type: "input_audio_buffer.commit" }) });
      expect(upstream.sent.slice(1).map((raw) => JSON.parse(raw))).toEqual([
        ...Array.from({ length: 40 }, (_, index) => ({
          type: "input_audio_buffer.append", audio: Buffer.from([index, 0]).toString("base64"),
        })),
        { type: "input_audio_buffer.commit" },
      ]);
      expect(server.closes).toEqual([]);
      expect(upstream.closes).toEqual([]);
      expect(admissions.activeSessions()).toBe(1);
    } finally {
      server.emit("close", { code: 1000, reason: "Test complete" });
      await Promise.all(deferred);
    }
  });

  it("renews the session lease on a timer while the socket is open, with no frames on it", async () => {
    vi.useFakeTimers();
    const database = new TranscriptionAdmissions();
    const upstream = new FakeSocket();
    const { pairs } = installSocketRuntime(upstream);
    const environment = env(database);
    const ticket = await issueTranscriptionSocketTicket(environment, auth);

    await new RealtimeTranscriptionService(environment).upgrade(ticket, request());
    // A socket opened while the microphone prompt is still up, or a paused
    // recording, carries nothing: the lease still has to outlive both.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(database.renewals).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(database.renewals).toBe(2);

    pairs[0]!.server.emit("close", { code: 1000, reason: "Dictation complete" });
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(database.renewals).toBe(2);
    expect(database.activeSessions()).toBe(0);
  });

  it("does not close a healthy transcription session after the former five-minute limit", async () => {
    vi.useFakeTimers();
    const database = new TranscriptionAdmissions();
    const upstream = new FakeSocket();
    const { pairs } = installSocketRuntime(upstream);
    const environment = env(database);
    const ticket = await issueTranscriptionSocketTicket(environment, auth);

    await new RealtimeTranscriptionService(environment).upgrade(ticket, request());
    await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);

    expect(pairs[0]!.server.closes).toEqual([]);
    expect(upstream.closes).toEqual([]);
  });
});
