import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryQuitBarrier } from './telemetry-quit-barrier';

afterEach(() => vi.useRealTimers());

describe('TelemetryQuitBarrier', () => {
  it('holds repeated quit attempts for one flush and then permits the resumed quit', async () => {
    let finishFlush!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    const resume = vi.fn();
    const barrier = new TelemetryQuitBarrier(flush, 1_000);

    expect(barrier.hold(resume)).toBe(true);
    expect(barrier.hold(resume)).toBe(true);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    finishFlush();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());

    expect(barrier.hold(resume)).toBe(false);
  });

  it('always resumes quitting after the bounded timeout', async () => {
    vi.useFakeTimers();
    const resume = vi.fn();
    const barrier = new TelemetryQuitBarrier(() => new Promise<void>(() => undefined), 750);

    expect(barrier.hold(resume)).toBe(true);
    await vi.advanceTimersByTimeAsync(750);

    expect(resume).toHaveBeenCalledOnce();
    expect(barrier.hold(resume)).toBe(false);
  });
});
