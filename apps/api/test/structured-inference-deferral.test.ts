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
      activity: "channel_naming",
      routing: { model: "test/model", fallbackModels: [], reasoningEffort: "medium" },
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
      const request = fetcher.mock.calls[0] as unknown as [RequestInfo, RequestInit];
      expect(JSON.parse(String(request[1].body)).reasoning).toEqual({ effort: "medium" });

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

  it("meters the call as its declared activity with the provider-reported cost", async () => {
    const usageSend = vi.fn(async (body: unknown) => { void body; });
    const deferred: Promise<unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "test/model-resolved",
      choices: [{ message: { content: JSON.stringify({ accepted: true }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.0021 },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await runStructuredInference(createTestEnv({
      AVALON_REGION: "global",
      APP_ENV: "test",
      OPENROUTER_API_KEY: "test-key",
      LOG_LEVEL: "error",
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn() }),
      USAGE_QUEUE: createCloudflareTestBinding<Queue>({ send: usageSend }),
    }), {
      role: "workstream_naming",
      activity: "channel_naming",
      routing: { model: "test/model", fallbackModels: [] },
      context: { workspaceId: "workspace-1", workstreamId: "workstream-1" },
      messages: [{ role: "user", content: "Name this" }],
      schemaName: "naming_test",
      jsonSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false },
      parse: (value) => value as { accepted: boolean },
      defer: (promise) => { deferred.push(promise); },
    });
    await Promise.all(deferred);

    expect(usageSend).toHaveBeenCalledTimes(1);
    expect(usageSend.mock.calls[0]![0]).toMatchObject({
      workspaceId: "workspace-1",
      activity: "channel_naming",
      costMicrousd: 2_100,
      refs: { workstreamId: "workstream-1", substreamId: "0" },
    });
  });
});
