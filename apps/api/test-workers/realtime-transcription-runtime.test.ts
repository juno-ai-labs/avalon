/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { AuthContext, Env } from "../src/env";
import { workspaceDOName } from "../src/durable-objects/names";
import { azureRealtimeWebSocketUrl, RealtimeTranscriptionService } from "../src/services/realtime-transcription-service";
import { issueTranscriptionSocketTicket } from "../src/services/socket-service";

afterEach(() => vi.unstubAllGlobals());

describe("realtime transcription in workerd", () => {
  it("uses an HTTPS fetch URL for the outbound WebSocket upgrade", () => {
    const url = azureRealtimeWebSocketUrl({
      AZURE_OPENAI_ENDPOINT: "https://avalon.openai.azure.com/ignored/path",
    } as Pick<Env, "AZURE_OPENAI_ENDPOINT">);

    expect(url).toBe("https://avalon.openai.azure.com/openai/v1/realtime?intent=transcription");
    expect(() => new Request(url, { headers: { Upgrade: "websocket" } })).not.toThrow();
  });
  it.each(["steady", "burst"])("forwards identical PCM and its commit under %s delivery", async (delivery) => {
    const workspaceId = asWorkspaceId(crypto.randomUUID());
    const auth: AuthContext = {
      sessionId: "dictation-runtime-session",
      userId: asUserId(crypto.randomUUID()),
      workspaceId,
      region: "global",
      role: "owner",
    };
    const environment: Env = {
      ...env,
      AZURE_OPENAI_ENDPOINT: "https://dictation-provider.test",
      AZURE_OPENAI_API_KEY: "test-not-a-provider-key",
      AZURE_OPENAI_REALTIME_DEPLOYMENT: "test-transcription",
    };
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, placement_affinity TEXT NOT NULL
    )`).run();
    await env.DB.prepare("INSERT INTO workspaces (id, region, placement_affinity) VALUES (?, 'global', 'wnam')")
      .bind(workspaceId).run();
    await env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId))
      .initializeWorkspace(workspaceId, "wnam");

    // Only Azure is doubled: both WebSocket pairs, admission, and the proxy's
    // message delivery run in real workerd.
    const providerPair = new WebSocketPair();
    const provider = providerPair[1];
    provider.accept({ allowHalfOpen: true });
    const received: Array<{ type: string; audio?: string }> = [];
    provider.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; audio?: string };
      received.push(message);
      if (message.type === "input_audio_buffer.commit") {
        provider.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Complete." }));
      }
    });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 101, webSocket: providerPair[0] }));
    const deferred: Promise<void>[] = [];
    const ticket = await issueTranscriptionSocketTicket(environment, auth);
    const response = await new RealtimeTranscriptionService(environment, (promise) => { deferred.push(promise); })
      .upgrade(ticket, new Request("https://api.test/socket/transcription", {
        headers: { Upgrade: "websocket", Origin: "app://avalon" },
      }));
    expect(response.status).toBe(101);
    const client = response.webSocket!;
    client.accept();
    try {
      const completion = new Promise<string>((resolve, reject) => {
        client.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
        client.addEventListener("close", (event) => reject(new Error(`Dictation closed: ${event.reason}`)), { once: true });
      });
      // Both schedules deliver the same distinguishable PCM samples. A
      // catch-up burst exceeds the former 30-message-per-second cap.
      for (let index = 0; index < 40; index += 1) {
        client.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(String.fromCharCode(index, 0)) }));
        if (delivery === "steady") await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      client.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      expect(JSON.parse(await completion)).toEqual({ type: "conversation.item.input_audio_transcription.completed", transcript: "Complete." });
      expect(received.slice(1).map((message) => message.type)).toEqual([
        ...new Array(40).fill("input_audio_buffer.append"), "input_audio_buffer.commit",
      ]);
      expect(received.flatMap((message) => message.audio ? [...atob(message.audio)].map((byte) => byte.charCodeAt(0)) : []))
        .toEqual(Array.from({ length: 80 }, (_, index) => index % 2 === 0 ? index / 2 : 0));
    } finally {
      client.close(1000, "Test complete");
      provider.close(1000, "Test complete");
      await Promise.all(deferred);
    }
  });
});
