import { describe, expect, it, vi } from "vitest";

import {
  DurableAgentDrain,
  DurableAgentKeepAlive,
  durableAgentRetryDelay,
} from "../src/durable-objects/durable-agent-runtime";

describe("DurableAgentKeepAlive", () => {
  it("shares one heartbeat across nested operations and reschedules after the last disposer", async () => {
    const reschedule = vi.fn(async () => undefined);
    const keepAlive = new DurableAgentKeepAlive(reschedule);

    const disposeFirst = await keepAlive.keepAlive();
    const disposeSecond = await keepAlive.keepAlive();

    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(keepAlive.active).toBe(true);
    expect(keepAlive.alarmDueAt(50_000, 10_000, 30_000)).toBe(40_000);

    disposeFirst();
    expect(keepAlive.active).toBe(true);
    expect(reschedule).toHaveBeenCalledTimes(1);

    disposeSecond();
    await vi.waitFor(() => expect(reschedule).toHaveBeenCalledTimes(2));
    expect(keepAlive.active).toBe(false);
    expect(keepAlive.alarmDueAt(50_000, 10_000, 30_000)).toBe(50_000);

    disposeSecond();
    expect(reschedule).toHaveBeenCalledTimes(2);
  });

  it("always releases a keep-alive reference when an operation fails", async () => {
    const reschedule = vi.fn(async () => undefined);
    const keepAlive = new DurableAgentKeepAlive(reschedule);

    await expect(keepAlive.while(async () => {
      throw new Error("operation_failed");
    })).rejects.toThrow("operation_failed");

    await vi.waitFor(() => expect(reschedule).toHaveBeenCalledTimes(2));
    expect(keepAlive.active).toBe(false);
  });
});

describe("DurableAgentDrain", () => {
  it("runs at most one drain per isolate and permits another after settlement", async () => {
    const drain = new DurableAgentDrain();
    const operation = vi.fn();
    const settled = vi.fn(async () => undefined);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    operation.mockImplementationOnce(async () => blocked);

    const first = drain.resume(operation, settled);
    const duplicate = drain.resume(operation, settled);

    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    expect(drain.active).toBe(true);

    release();
    await first;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(drain.active).toBe(false);

    operation.mockResolvedValueOnce(undefined);
    await drain.resume(operation, settled);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledTimes(2);
  });
});

describe("durableAgentRetryDelay", () => {
  it("backs off from five seconds and caps at five minutes", () => {
    expect(durableAgentRetryDelay(0)).toBe(5_000);
    expect(durableAgentRetryDelay(1)).toBe(5_000);
    expect(durableAgentRetryDelay(2)).toBe(10_000);
    expect(durableAgentRetryDelay(100)).toBe(300_000);
  });
});
