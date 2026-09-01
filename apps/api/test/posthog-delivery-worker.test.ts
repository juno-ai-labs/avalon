import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PostHogDeliveryRpcBinding } from "../src/telemetry/posthog-delivery-contract";

const adapterMocks = vi.hoisted(() => ({
  sendPostHogBatch: vi.fn(),
  sendPostHogCrashBatch: vi.fn(),
  sendPostHogJavascriptExceptionBatch: vi.fn(),
  sendPostHogProfileBatch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

vi.mock("../src/telemetry/posthog-adapter", () => adapterMocks);

import PostHogDeliveryWorker from "../src/posthog-delivery-worker";

const input = {
  host: "https://us.i.posthog.com",
  projectToken: "test-token",
  webBaseUrl: "https://rallywith.ai",
  rows: [],
} satisfies Parameters<PostHogDeliveryRpcBinding["sendTelemetryBatch"]>[0];

function createWorker(): PostHogDeliveryWorker {
  return new PostHogDeliveryWorker(undefined as never, undefined as never);
}

describe("PostHogDeliveryWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["sendTelemetryBatch", "sendPostHogBatch"],
    ["sendJavascriptExceptionBatch", "sendPostHogJavascriptExceptionBatch"],
    ["sendCrashBatch", "sendPostHogCrashBatch"],
    ["sendProfileBatch", "sendPostHogProfileBatch"],
  ] as const)("delegates %s to %s", async (method, adapter) => {
    const result = { result: "delivered" as const };
    adapterMocks[adapter].mockResolvedValue(result);
    const worker = createWorker();

    await expect(worker[method](input)).resolves.toBe(result);
    expect(adapterMocks[adapter]).toHaveBeenCalledOnce();
    expect(adapterMocks[adapter]).toHaveBeenCalledWith(input);
  });

  it("keeps fetch unreachable as a public delivery path", () => {
    const worker = createWorker();

    expect(worker.fetch().status).toBe(404);
  });
});
