import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeadline, withDeadline } from "../src/lib/deadline";

afterEach(() => {
  vi.useRealTimers();
});

describe("cancellable deadlines", () => {
  it("clears its timer on dispose so the invocation is not held open", () => {
    vi.useFakeTimers();
    const deadline = createDeadline(20_000);

    expect(vi.getTimerCount()).toBe(1);
    deadline.dispose();

    // The invariant the connector poll depends on: once the work has returned,
    // no timer remains for the Workers runtime to wait on. An
    // `AbortSignal.timeout` cannot express this, which is why it is not used.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it("is idempotent", () => {
    vi.useFakeTimers();
    const deadline = createDeadline(1_000);
    deadline.dispose();
    expect(() => deadline.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the work it guards when the deadline passes", async () => {
    const deadline = createDeadline(5);
    await expect(new Promise((_resolve, reject) => {
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
    })).rejects.toMatchObject({ name: "TimeoutError" });
    deadline.dispose();
  });

  it("disposes after the work resolves", async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    const result = await withDeadline(30_000, async (signal) => {
      captured = signal;
      expect(vi.getTimerCount()).toBe(1);
      return "polled";
    });

    expect(result).toBe("polled");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(captured?.aborted).toBe(false);
  });

  it("disposes after the work throws", async () => {
    vi.useFakeTimers();
    await expect(withDeadline(30_000, async () => {
      throw new Error("poll_failed");
    })).rejects.toThrow("poll_failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
