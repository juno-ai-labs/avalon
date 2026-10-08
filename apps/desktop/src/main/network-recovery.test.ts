import { describe, expect, it, vi } from 'vitest';
import { NetworkRecovery } from './network-recovery';
import type { NetworkTicketObservation } from '../common/network-recovery';

const target = '/workspace/socket';
const other = '/conversations/00000000-0000-7000-8000-000000000001/substreams/0/socket';
function observation(outcome: NetworkTicketObservation['outcome'], generation = 0, key = target): NetworkTicketObservation {
  return { generation, outcome, target: key };
}
function harness() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((finish, fail) => { resolve = finish; reject = fail; });
  const close = { promise, resolve, reject };
  const closeConnections = vi.fn(() => close.promise);
  const publish = vi.fn();
  const record = vi.fn();
  const recovery = new NetworkRecovery({ closeConnections, publish, record });
  return { close, closeConnections, publish, record, recovery };
}

describe('desktop session network recovery', () => {
  it('requires consecutive timeouts for the same ticket and coalesces the reset', async () => {
    const { recovery, close, closeConnections } = harness();
    recovery.observe(observation('timeout'));
    recovery.observe(observation('timeout', 0, other));
    expect(closeConnections).not.toHaveBeenCalled();
    recovery.observe(observation('accepted'));
    recovery.observe(observation('timeout'));
    expect(closeConnections).not.toHaveBeenCalled();
    recovery.observe(observation('failed'));
    recovery.observe(observation('timeout'));
    expect(closeConnections).not.toHaveBeenCalled();
    recovery.observe(observation('timeout'));
    expect(closeConnections).toHaveBeenCalledTimes(1);
    expect(recovery.state).toEqual({ generation: 1, phase: 'resetting' });
    recovery.observe(observation('timeout', 1, other));
    recovery.observe(observation('timeout', 1, other));
    expect(closeConnections).toHaveBeenCalledTimes(1);
    close.resolve();
    await close.promise;
    expect(recovery.state).toEqual({ generation: 1, phase: 'awaiting_live' });
  });

  it('ignores old requests and rearms only after a live response from the new generation', async () => {
    const { recovery, close, closeConnections, record } = harness();
    recovery.observe(observation('timeout'));
    recovery.observe(observation('timeout'));
    close.resolve();
    await close.promise;
    recovery.observe(observation('live'));
    recovery.observe(observation('accepted', 1));
    recovery.observe(observation('timeout', 1));
    recovery.observe(observation('timeout', 1));
    expect(closeConnections).toHaveBeenCalledTimes(1);
    expect(recovery.state.phase).toBe('awaiting_live');
    recovery.observe(observation('live', 1));
    expect(recovery.state.phase).toBe('idle');
    expect(record).toHaveBeenCalledWith({ kind: 'desktop_network_recovery', generation: 1, phase: 'live_restored' });
    recovery.observe(observation('timeout', 1));
    recovery.observe(observation('timeout', 1));
    expect(closeConnections).toHaveBeenCalledTimes(2);
  });

  it('releases the recovery barrier when resetting connections fails', async () => {
    const { recovery, close, record } = harness();
    recovery.observe(observation('timeout'));
    recovery.observe(observation('timeout'));
    close.reject(new Error('platform reset failed'));
    await close.promise.catch(() => undefined);
    expect(recovery.state).toEqual({ generation: 1, phase: 'awaiting_live' });
    expect(record).toHaveBeenCalledWith({ kind: 'desktop_network_recovery', generation: 1, phase: 'reset_failed' });
  });
});
