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
      role: "resource_naming",
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

  it.each(["model", "fallback"] as const)("keeps Azure-only %s overrides out of the direct Canvas gateway", async (field) => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      void url; void init;
      return new Response(JSON.stringify({
      choices: [{ message: { content: '{"accepted":true}' } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const deferred: Promise<unknown>[] = [];
    const result = await runStructuredInference(createTestEnv({
      OPENROUTER_API_KEY: "test-key", LOG_LEVEL: "error",
      AGENT_MODEL_ROUTING_JSON: { canvas: {
        model: field === "model" ? "openai/gpt-5.6-sol" : "custom/primary",
        fallbackModels: field === "fallback" ? ["openai/gpt-5.6-sol"] : [],
      } },
    }), {
      role: "canvas", activity: "channel_naming", context: {},
      messages: [{ role: "user", content: "Return the decision" }],
      schemaName: "provider_policy_test", jsonSchema: { type: "object" },
      parse: (value) => value, defer: (promise) => { deferred.push(promise); },
    });
    await Promise.all(deferred);
    expect(result.model).toBe("openai/gpt-6.1-sol");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).model).toBe("openai/gpt-6.1-sol");
  });

  it("refuses a persisted Azure-only route before contacting OpenRouter", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(runStructuredInference(createTestEnv({}), {
      role: "resource_naming", activity: "channel_naming", context: {},
      routing: { model: "custom/primary", fallbackModels: ["openai/gpt-5.6-sol"] },
      messages: [], schemaName: "provider_policy_test", jsonSchema: {}, parse: (value) => value,
    })).rejects.toMatchObject({ code: "agent_model_routing:routing:azure_only_model" });
    expect(fetcher).not.toHaveBeenCalled();
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
      role: "resource_naming",
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
