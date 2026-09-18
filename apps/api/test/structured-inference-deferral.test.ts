import "../../../tests/isolated-region";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

import { runStructuredInference } from "../src/services/structured-inference";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("structured inference telemetry lifecycle", () => {
  it("does not make the provider request or result wait for exact archive staging", async () => {
    let releaseCapture!: () => void;
    const captureReleased = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const put = vi.fn(async () => { await captureReleased; });
    const queueSend = vi.fn(async () => {});
    const deferred: Promise<unknown>[] = [];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      model: "test/model-resolved",
      choices: [{ message: { content: JSON.stringify({ accepted: true }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    const inference = runStructuredInference(createTestEnv({
      AVALON_REGION: "global",
      APP_ENV: "test",
      OPENROUTER_API_KEY: "test-key",
      LOG_LEVEL: "error",
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put }),
      INFERENCE_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({ send: queueSend }),
      INFERENCE_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["INFERENCE_LAKEHOUSE"]>>({
        async send() {},
      }),
    }), {
      role: "workstream_naming",
      routing: { model: "test/model", fallbackModels: [] },
      context: { workspaceId: "workspace-1" },
      messages: [{ role: "user", content: "Return the decision" }],
      schemaName: "deferral_test",
      jsonSchema: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
        required: ["accepted"],
        additionalProperties: false,
      },
      parse(value) {
        return value as { accepted: boolean };
      },
      defer(promise) {
        deferred.push(promise);
      },
    });

    let inferenceSettled = false;
    void inference.then(() => { inferenceSettled = true; });
    try {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(put).toHaveBeenCalled());
      await vi.waitFor(() => expect(inferenceSettled).toBe(true));
      expect(deferred.length).toBeGreaterThanOrEqual(2);

      let archiveSettled = false;
      void Promise.all(deferred).then(() => { archiveSettled = true; });
      await Promise.resolve();
      expect(archiveSettled).toBe(false);
    } finally {
      releaseCapture();
      await expect(inference).resolves.toMatchObject({ result: { accepted: true } });
      await Promise.all(deferred);
      expect(queueSend).toHaveBeenCalledTimes(2);
    }
  });
});
