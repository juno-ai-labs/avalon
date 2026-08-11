import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS,
  DeveloperSettingsFlagController,
} from './developer-settings-flag';

afterEach(() => {
  vi.useRealTimers();
});

function controller(read: () => Promise<boolean>, onChange = vi.fn()): {
  controller: DeveloperSettingsFlagController;
  onChange: ReturnType<typeof vi.fn>;
} {
  return {
    controller: new DeveloperSettingsFlagController({ read, onChange, pollIntervalMs: 1_000 }),
    onChange,
  };
}

describe('developer settings flag controller', () => {
  it('starts closed and opens only once the service answers', async () => {
    const { controller: flag, onChange } = controller(async () => true);

    expect(flag.enabled()).toBe(false);

    await expect(flag.refresh()).resolves.toBe(true);
    expect(flag.enabled()).toBe(true);
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it('announces a change once rather than on every poll', async () => {
    const { controller: flag, onChange } = controller(async () => true);

    await flag.refresh();
    await flag.refresh();

    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it('closes the section when the service withdraws the flag', async () => {
    let served = true;
    const { controller: flag, onChange } = controller(async () => served);
    await flag.refresh();

    served = false;
    await expect(flag.refresh()).resolves.toBe(false);

    expect(flag.enabled()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps the last answer when a poll cannot reach the service', async () => {
    let answer: () => Promise<boolean> = async () => true;
    const { controller: flag, onChange } = controller(() => answer());
    await flag.refresh();

    answer = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    await expect(flag.refresh()).resolves.toBe(true);

    expect(flag.enabled()).toBe(true);
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it('shares one request between callers that ask at the same moment', async () => {
    const read = vi.fn(async () => true);
    const { controller: flag } = controller(read);

    await Promise.all([flag.refresh(), flag.refresh(), flag.refresh()]);

    expect(read).toHaveBeenCalledTimes(1);
    // The shared request is released once it settles, so a later poll asks again.
    await flag.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('asks again on its interval, and stops asking once stopped', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true);
    const { controller: flag } = controller(read);

    flag.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(3);

    flag.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('starts one poll timer however often it is started', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true);
    const { controller: flag } = controller(read);

    flag.start();
    await vi.advanceTimersByTimeAsync(0);
    flag.start();
    await vi.advanceTimersByTimeAsync(0);
    read.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('closes the section when it stops, as a sign-out does', async () => {
    const { controller: flag, onChange } = controller(async () => true);
    await flag.refresh();

    flag.stop();

    expect(flag.enabled()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('polls often enough to follow a flag change without a restart', () => {
    expect(DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
