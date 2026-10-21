/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { azureRealtimeWebSocketUrl, forwardTranscriptionAudio } from "../src/services/realtime-transcription-service";

describe("realtime transcription in workerd", () => {
  it("uses an HTTPS fetch URL for the outbound WebSocket upgrade", () => {
    const url = azureRealtimeWebSocketUrl({
      AZURE_OPENAI_ENDPOINT: "https://avalon.openai.azure.com/ignored/path",
    } as Pick<Env, "AZURE_OPENAI_ENDPOINT">);
    expect(url).toBe("https://avalon.openai.azure.com/openai/v1/realtime?intent=transcription");
    expect(() => new Request(url, { headers: { Upgrade: "websocket" } })).not.toThrow();
  });

  it("forwards a catch-up burst and its commit without losing PCM", async () => {
    // Transport runs on real sockets; canonical WorkspaceDO admission is
    // covered separately in workspace-transcription-admission.test.ts.
    const input = new WebSocketPair();
    const output = new WebSocketPair();
    const client = input[0];
    const server = input[1];
    const upstream = output[0];
    const provider = output[1];
    client.accept();
    server.accept({ allowHalfOpen: true });
    upstream.accept({ allowHalfOpen: true });
    provider.accept();
    forwardTranscriptionAudio(server, upstream);
    const received: Array<{ type: string; audio?: string }> = [];
    provider.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; audio?: string };
      received.push(message);
      if (message.type === "input_audio_buffer.commit") {
        provider.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Complete." }));
      }
    });
    try {
      const completion = new Promise<string>((resolve, reject) => {
        client.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
        client.addEventListener("close", (event) => reject(new Error(`Dictation closed: ${event.reason}`)), { once: true });
      });
      for (let index = 0; index < 40; index += 1) {
        client.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(String.fromCharCode(index, 0)) }));
      }
      client.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      expect(JSON.parse(await completion)).toEqual({ type: "conversation.item.input_audio_transcription.completed", transcript: "Complete." });
      expect(received.map((message) => message.type)).toEqual([
        ...new Array(40).fill("input_audio_buffer.append"), "input_audio_buffer.commit",
      ]);
      expect(received.flatMap((message) => message.audio ? [...atob(message.audio)].map((byte) => byte.charCodeAt(0)) : []))
        .toEqual(Array.from({ length: 80 }, (_, index) => index % 2 === 0 ? index / 2 : 0));
    } finally {
      for (const socket of [client, server, upstream, provider]) socket.close(1000, "Test complete");
    }
  });
});
