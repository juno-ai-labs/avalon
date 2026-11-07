/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import type { AgentLoopDO } from "../src/durable-objects/agent-loop-do";

const KEY = "openrouter:context-windows:v1";

it("reads the window snapshot once while resident and reloads it after eviction", async () => {
  const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName(
    "global",
    asWorkspaceId("00000000-0000-7000-8000-00000000c711"),
    asWorkstreamId("00000000-0000-7000-8000-00000000c712"),
    asSubstreamId("00000000-0000-7000-8000-00000000c713"),
  ));
  const original = await env.INFERENCE_PRICING_CACHE.get(KEY);
  const snapshot = (tokens: number) => JSON.stringify({
    version: 1,
    fetchedAtMs: Date.now(),
    windows: { "test/model": tokens },
  });
  const read = () => runInDurableObject(stub, (instance: AgentLoopDO) =>
    (instance as unknown as { contextWindowTokensByModel(): Promise<Readonly<Record<string, number>>> })
      .contextWindowTokensByModel());
  try {
    await env.INFERENCE_PRICING_CACHE.put(KEY, snapshot(100));
    expect(await read()).toEqual({ "test/model": 100 });
    await env.INFERENCE_PRICING_CACHE.put(KEY, snapshot(200));
    expect(await read()).toEqual({ "test/model": 100 });
    await evictDurableObject(stub);
    expect(await read()).toEqual({ "test/model": 200 });
  } finally {
    if (original === null) await env.INFERENCE_PRICING_CACHE.delete(KEY);
    else await env.INFERENCE_PRICING_CACHE.put(KEY, original);
  }
});

it("retries a missing snapshot on the next run instead of retaining the fallback", async () => {
  const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName(
    "global",
    asWorkspaceId("00000000-0000-7000-8000-00000000c711"),
    asWorkstreamId("00000000-0000-7000-8000-00000000c712"),
    asSubstreamId("00000000-0000-7000-8000-00000000c714"),
  ));
  const original = await env.INFERENCE_PRICING_CACHE.get(KEY);
  const read = () => runInDurableObject(stub, (instance: AgentLoopDO) =>
    (instance as unknown as { contextWindowTokensByModel(): Promise<Readonly<Record<string, number>>> })
      .contextWindowTokensByModel());
  try {
    await env.INFERENCE_PRICING_CACHE.delete(KEY);
    expect(await read()).toEqual({});
    await env.INFERENCE_PRICING_CACHE.put(KEY, JSON.stringify({
      version: 1,
      fetchedAtMs: Date.now(),
      windows: { "test/model": 100 },
    }));
    expect(await read()).toEqual({ "test/model": 100 });
  } finally {
    if (original === null) await env.INFERENCE_PRICING_CACHE.delete(KEY);
    else await env.INFERENCE_PRICING_CACHE.put(KEY, original);
  }
});
