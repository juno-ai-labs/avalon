import { describe, expect, it } from 'vitest';
import { NetworkRecoveryInbox, parseNetworkRecoveryState } from './network-recovery';

describe('network recovery preload inbox', () => {
  it('retains a reset before subscribers mount and cannot regress on late IPC replies', () => {
    const inbox = new NetworkRecoveryInbox();
    inbox.receive({ generation: 1, phase: 'resetting' });
    expect(inbox.state).toEqual({ generation: 1, phase: 'resetting' });
    inbox.receive({ generation: 0, phase: 'idle' });
    const phases: string[] = [];
    inbox.subscribe((state) => phases.push(state.phase));
    inbox.receive({ generation: 1, phase: 'awaiting_live' });
    inbox.receive({ generation: 1, phase: 'resetting' });
    inbox.receive({ generation: 1, phase: 'idle' });
    inbox.receive({ generation: 1, phase: 'awaiting_live' });
    expect(phases).toEqual(['awaiting_live', 'idle']);
    expect(inbox.state).toEqual({ generation: 1, phase: 'idle' });
  });

  it('rejects malformed main-process recovery states', () => {
    expect(parseNetworkRecoveryState({ generation: -1, phase: 'resetting' })).toBeNull();
    expect(parseNetworkRecoveryState({ generation: 1, phase: 'ready' })).toBeNull();
    expect(parseNetworkRecoveryState(null)).toBeNull();
  });
});
