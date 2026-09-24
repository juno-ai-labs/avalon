import { describe, expect, it, vi } from "vitest";

import { inferencePricingWorker } from "../src/inference-pricing-worker";
import {
  loadOpenRouterContextWindows,
  refreshOpenRouterContextWindows,
} from "../src/services/openrouter-context-windows";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";

const KEY = "openrouter:context-windows:v1";
const NOW = Date.UTC(2026, 8, 23);

describe("OpenRouter context window snapshot", () => {
  it("writes one complete daily snapshot and reads its model windows", async () => {
    let stored: string | null = null;
    const get = vi.fn(async () => stored ? JSON.parse(stored) as unknown : null);
    const put = vi.fn(async (_key: string, value: string) => { stored = value; });
    const env = { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get, put }) };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [
      { id: "test/model", context_length: 128_000 },
      { id: "test/other", top_provider: { context_length: 64_000 } },
      { id: "test/invalid", context_length: -1 },
    ] }));

    await refreshOpenRouterContextWindows(env, { fetch: fetcher, now: () => NOW });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toBe(KEY);
    expect(get).not.toHaveBeenCalled();
    expect(await loadOpenRouterContextWindows(env)).toEqual({
      "test/model": 128_000,
      "test/other": 64_000,
    });
    expect(get).toHaveBeenCalledWith(KEY, "json");
  });

  it("keeps the previous snapshot when the catalog is unavailable or empty", async () => {
    const put = vi.fn();
    const env = { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ put }) };
    await expect(refreshOpenRouterContextWindows(env, {
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
    })).rejects.toThrow("OpenRouter model catalog failed (503)");
    await expect(refreshOpenRouterContextWindows(env, {
      fetch: vi.fn<typeof fetch>(async () => Response.json({ data: [] })),
    })).rejects.toThrow("OpenRouter model catalog contains no context windows");
    expect(put).not.toHaveBeenCalled();
  });

  it("falls back to an empty map for a missing or malformed snapshot", async () => {
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ version: 1, fetchedAtMs: NOW, windows: { "test/model": -1 } });
    const env = { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get }) };
    expect(await loadOpenRouterContextWindows(env)).toEqual({});
    expect(await loadOpenRouterContextWindows(env)).toEqual({});
  });

  it("refreshes context windows on the daily cron", async () => {
    const put = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "test/model", context_length: 100 }] }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await inferencePricingWorker.scheduled(createCloudflareTestBinding<ScheduledController>({
        cron: "0 0 * * *",
        scheduledTime: NOW,
        noRetry: vi.fn(),
      }), { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ put }) });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(put).toHaveBeenCalledOnce();
      expect(put.mock.calls[0]?.[0]).toBe(KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
