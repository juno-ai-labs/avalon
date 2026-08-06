import { describe, expect, it, vi } from "vitest";
import { providerJson, readResponseBytes } from "./provider-utils";

describe("bounded provider responses", () => {
  it("stops a streaming response as soon as it exceeds the byte budget", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
        controller.enqueue(new TextEncoder().encode("789012"));
      },
      cancel: cancelled,
    }));

    await expect(readResponseBytes(response, 10)).rejects.toMatchObject({
      code: "payload_too_large",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("parses JSON only after reading it within the byte budget", async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }));

    await expect(providerJson(fetcher, "https://provider.example/data", {}, 64))
      .resolves.toEqual({ ok: true });
  });

  it("preserves a provider Retry-After delay on HTTP 429", async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"ratelimited"}', {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7" },
    }));

    await expect(providerJson(fetcher, "https://provider.example/data"))
      .rejects.toMatchObject({ details: { status: 429, retryAfterMs: 7_000 } });
  });
});
