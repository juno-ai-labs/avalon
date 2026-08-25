import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS,
  DeveloperSettingsFlagController,
} from './developer-settings-flag';

afterEach(() => {
  vi.useRealTimers();
});

interface Harness {
  controller: DeveloperSettingsFlagController;
  onChange: ReturnType<typeof vi.fn>;
  onAvailabilityChange: ReturnType<typeof vi.fn>;
}

function controller(read: () => Promise<boolean>): Harness {
  const onChange = vi.fn();
  const onAvailabilityChange = vi.fn();
  return {
    controller: new DeveloperSettingsFlagController({
      read,
      onChange,
      onAvailabilityChange,
      pollIntervalMs: 1_000,
    }),
    onChange,
    onAvailabilityChange,
  };
}

/** A `read` whose every call is settled by hand, so a poll can be left in flight. */
function deferredReads(): {
  read: () => Promise<boolean>;
  pending: Array<(enabled: boolean) => void>;
} {
  const pending: Array<(enabled: boolean) => void> = [];
  return {
    read: () => new Promise<boolean>((resolveRead) => pending.push(resolveRead)),
    pending,
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

  it('reports an unreachable service once, and again when it recovers', async () => {
    let answer: () => Promise<boolean> = async () => true;
    const { controller: flag, onAvailabilityChange } = controller(() => answer());
    await flag.refresh();
    expect(onAvailabilityChange).not.toHaveBeenCalled();

    const failure = new Error('Rally authentication failed (500)');
    answer = async () => {
      throw failure;
    };
    await flag.refresh();
    await flag.refresh();

    // Once for the outage, not once per poll — a device keeps its last answer
    // through one, so a permanently broken poll must not be silent, and a
    // temporarily offline one must not fill the log.
    expect(onAvailabilityChange.mock.calls).toEqual([[false, failure]]);

    answer = async () => true;
    await flag.refresh();
    expect(onAvailabilityChange.mock.calls).toEqual([[false, failure], [true, undefined]]);
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

    flag.observeSession('user-1@https://api.example.com');
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(3);

    flag.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not re-ask when the same account is observed again, as a token refresh does', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true);
    const { controller: flag } = controller(read);

    flag.observeSession('user-1@https://api.example.com');
    await vi.advanceTimersByTimeAsync(0);
    flag.observeSession('user-1@https://api.example.com');
    flag.observeSession('user-1@https://api.example.com');
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(1);
    // …and the one interval it started keeps its cadence.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('asks immediately when a different account signs in', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true);
    const { controller: flag } = controller(read);

    flag.observeSession('user-1@https://api.example.com');
    await vi.advanceTimersByTimeAsync(0);
    flag.observeSession('user-2@https://api.example.com');
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('closes the section when the account changes, before the new one is answered for', async () => {
    const { read, pending } = deferredReads();
    const { controller: flag, onChange } = controller(read);
    flag.observeSession('global-identity@https://api.example.com');
    pending[0]?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(flag.enabled()).toBe(true);

    // Onboarding swaps a Global identity session for a regional one without
    // passing through signed-out, so this is an account change with no `stop()`.
    flag.observeSession('regional@https://eu.api.example.com');

    expect(flag.enabled()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);

    // And the new account's own answer is what re-opens it.
    pending[1]?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(flag.enabled()).toBe(true);
  });

  it('never applies an answer that arrives after sign-out', async () => {
    const { read, pending } = deferredReads();
    const { controller: flag, onChange } = controller(read);
    void flag.refresh();

    flag.stop();
    pending[0]?.(true);
    await Promise.resolve();
    await Promise.resolve();

    // The section was closed by the sign-out and must stay closed: the answer
    // in flight was asked as an account that is no longer signed in.
    expect(flag.enabled()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never answers one account with the request it issued as another', async () => {
    const { read, pending } = deferredReads();
    const { controller: flag, onChange } = controller(read);
    flag.observeSession('staff@https://api.example.com');

    // Signing out and straight back in as someone else, while the staff
    // account's poll is still in flight.
    flag.stop();
    flag.observeSession('customer@https://api.example.com');
    pending[0]?.(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(pending).toHaveLength(2);
    expect(flag.enabled()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    // The second account's own answer is the one that counts.
    pending[1]?.(false);
    await Promise.resolve();
    expect(flag.enabled()).toBe(false);
  });

  it('reports a poll that hangs, not just one that fails', async () => {
    vi.useFakeTimers();
    const { read, pending } = deferredReads();
    const readSpy = vi.fn(read);
    const { controller: flag, onAvailabilityChange } = controller(readSpy);

    flag.observeSession('user-1@https://api.example.com');
    await vi.advanceTimersByTimeAsync(0);
    pending[0]?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.enabled()).toBe(true);

    // Every poll from here hangs and never settles, so no rejection is ever
    // raised. Abandoning is the only evidence there is, and it has to be
    // announced — an hour of unconfirmed polls with the section still open is
    // exactly the silence this callback exists to break.
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(readSpy.mock.calls.length).toBeGreaterThan(50);
    expect(flag.enabled()).toBe(true);
    expect(onAvailabilityChange).toHaveBeenCalledWith(false, expect.any(Error));
    // Once for the outage, not once per abandoned tick.
    expect(onAvailabilityChange).toHaveBeenCalledTimes(1);
  });

  it('abandons a request that outlives a poll interval rather than waiting on it forever', async () => {
    vi.useFakeTimers();
    const { read, pending } = deferredReads();
    const readSpy = vi.fn(read);
    const { controller: flag } = controller(readSpy);

    flag.observeSession('user-1@https://api.example.com');
    await vi.advanceTimersByTimeAsync(0);
    expect(readSpy).toHaveBeenCalledTimes(1);

    // The connection hangs. Ticks inside the interval keep sharing the request…
    await vi.advanceTimersByTimeAsync(999);
    expect(readSpy).toHaveBeenCalledTimes(1);

    // …but the next one gives up on it and asks again, so a single hung
    // connection cannot stop the flag being read for the life of the process.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readSpy).toHaveBeenCalledTimes(2);

    // The abandoned request's answer is discarded when it finally arrives.
    pending[0]?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.enabled()).toBe(false);

    pending[1]?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.enabled()).toBe(true);
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
