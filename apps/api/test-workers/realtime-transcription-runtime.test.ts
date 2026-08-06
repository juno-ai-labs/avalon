/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { azureRealtimeWebSocketUrl } from "../src/services/realtime-transcription-service";

describe("realtime transcription in workerd", () => {
  it("uses an HTTPS fetch URL for the outbound WebSocket upgrade", () => {
    const url = azureRealtimeWebSocketUrl({
      AZURE_OPENAI_ENDPOINT: "https://avalon.openai.azure.com/ignored/path",
    } as Pick<Env, "AZURE_OPENAI_ENDPOINT">);

    expect(url).toBe("https://avalon.openai.azure.com/openai/v1/realtime?intent=transcription");
    expect(() => new Request(url, { headers: { Upgrade: "websocket" } })).not.toThrow();
  });
});
