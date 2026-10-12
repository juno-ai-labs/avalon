import { describe, expect, it, vi } from 'vitest';
import { retryTransient } from './retry-transient';

const transient = (error: unknown) => error instanceof Error && error.message === 'offline';

describe('retryTransient', () => {
  it('succeeds on the third try after two transient failures, waiting between tries', async () => {
    const waits: number[] = [];
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('renewed');

    const result = await retryTransient(attempt, {
      attempts: 3, delaysMs: [1_000, 2_000], transient, wait: async (ms) => { waits.push(ms); },
    });

    expect(result).toBe('renewed');
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it('throws the last transient failure once every try is spent', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(retryTransient(attempt, {
      attempts: 3, delaysMs: [0], transient, wait: async () => undefined,
    })).rejects.toThrow('offline');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('never retries a failure that is not transient', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('refused'));

    await expect(retryTransient(attempt, {
      attempts: 3, delaysMs: [0], transient, wait: async () => undefined,
    })).rejects.toThrow('refused');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
