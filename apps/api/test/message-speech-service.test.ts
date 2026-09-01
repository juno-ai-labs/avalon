import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AzureAudioClient } from "../src/services/multimodal-generation/azure-audio-client";
import {
  splitSpeechText,
  streamMessageSpeech,
} from "../src/services/message-speech-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const env = {
  AZURE_INFERENCE_ENDPOINT: "https://monad-prod-resource.services.ai.azure.com",
  AZURE_INFERENCE_API_KEY: "test-key",
};

describe("message speech streaming", () => {
  it("is mounted behind the regional authenticated API", async () => {
    const response = await createApp().request("https://api.example.com/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "Private response" }),
    }, createTestEnv({
      ALLOWED_ORIGINS: "app://rallywithai",
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
    }));

    expect(response.status).toBe(401);
  });

  it("speaks the complete markdown as plain text and streams every Azure chunk in order", async () => {
    const requested: string[] = [];
    const client: AzureAudioClient = {
      generate: vi.fn(),
      streamPcm: vi.fn(async ({ text }) => {
        requested.push(text);
        const byte = requested.length;
        return { body: new ReadableStream({ start(controller) {
          controller.enqueue(Uint8Array.of(byte, byte));
          controller.close();
        } }) };
      }),
    };
    const markdown = `## Visible heading\n\n${"Hidden **detail**. ".repeat(300)}`;

    const result = await streamMessageSpeech({
      env,
      markdown,
      signal: new AbortController().signal,
      client,
    });
    const bytes = await collect(result.body);

    expect(requested.join(" ")).toContain("Visible heading");
    expect(requested.join(" ")).toContain("Hidden detail.");
    expect(requested.join(" ")).not.toContain("**");
    expect(requested.every((chunk) => [...chunk].length <= 4_096)).toBe(true);
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(bytes).toEqual(Uint8Array.from(requested.flatMap((_, index) => [index + 1, index + 1])));
  });

  it("never splits a surrogate pair and prefers a natural boundary", () => {
    expect(splitSpeechText("one two three 😀 four five", 14)).toEqual([
      "one two three",
      "😀 four five",
    ]);
  });

  it("cancels the current provider stream when playback disconnects", async () => {
    const providerCancelled = vi.fn();
    const client: AzureAudioClient = {
      generate: vi.fn(),
      streamPcm: vi.fn(async () => ({ body: new ReadableStream({
        pull(controller) { controller.enqueue(Uint8Array.of(0, 0)); },
        cancel: providerCancelled,
      }) })),
    };
    const speech = await streamMessageSpeech({
      env,
      markdown: "Speak until stopped.",
      signal: new AbortController().signal,
      client,
    });
    const reader = speech.body.getReader();
    await reader.read();

    await reader.cancel("user stopped");

    expect(providerCancelled).toHaveBeenCalledWith("user stopped");
  });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: number[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(...next.value);
  }
  return Uint8Array.from(chunks);
}
