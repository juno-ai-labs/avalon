import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TelemetryDeliveryRpcBinding } from "../src/telemetry/telemetry-delivery-contract";

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

import TelemetryDeliveryWorker from "../src/telemetry-delivery-worker";

const input = {
  host: "https://us.i.posthog.com",
  projectToken: "test-token",
  webBaseUrl: "https://rallywith.ai",
  rows: [],
} satisfies Parameters<TelemetryDeliveryRpcBinding["deliverTelemetryBatch"]>[0];

function createWorker(): TelemetryDeliveryWorker {
  return new TelemetryDeliveryWorker(undefined as never, undefined as never);
}

describe("TelemetryDeliveryWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["deliverTelemetryBatch", "sendPostHogBatch"],
    ["deliverJavascriptExceptionBatch", "sendPostHogJavascriptExceptionBatch"],
    ["deliverCrashBatch", "sendPostHogCrashBatch"],
    ["deliverProfileBatch", "sendPostHogProfileBatch"],
  ] as const)("delegates %s to %s", async (method, adapter) => {
    const result = { result: "delivered" as const };
    adapterMocks[adapter].mockResolvedValue(result);
    const worker = createWorker();

    await expect(worker[method](input)).resolves.toEqual({ postHog: result });
    expect(adapterMocks[adapter]).toHaveBeenCalledOnce();
    expect(adapterMocks[adapter]).toHaveBeenCalledWith(input);
  });

  it("keeps fetch unreachable as a public delivery path", () => {
    const worker = createWorker();

    expect(worker.fetch().status).toBe(404);
  });
});
