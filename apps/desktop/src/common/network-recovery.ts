/** Content-free state shared by every Rally window using Chromium's session. */
export interface NetworkRecoveryState {
  generation: number;
  phase: 'idle' | 'resetting' | 'awaiting_live';
}

export interface NetworkTicketObservation {
  generation: number;
  target: string;
  outcome: 'timeout' | 'accepted' | 'failed' | 'live';
}

export interface NetworkRecoveryDiagnostic {
  kind: 'desktop_network_recovery';
  generation: number;
  phase: 'ticket_timeout' | 'reset_started' | 'reset_finished' | 'reset_failed' | 'live_restored';
  consecutiveTimeouts?: number;
}

export const NETWORK_RECOVERY_IPC = {
  state: 'network-recovery:state',
  observe: 'network-recovery:observe',
  changed: 'network-recovery:changed',
} as const;

/** Dependency-free parsing for the sandboxed preload. */
export function parseNetworkRecoveryState(raw: unknown): NetworkRecoveryState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return null;
  if (!['idle', 'resetting', 'awaiting_live'].includes(String(value.phase))) return null;
  return { generation: value.generation as number, phase: value.phase as NetworkRecoveryState['phase'] };
}

export class NetworkRecoveryInbox {
  private current: NetworkRecoveryState = { generation: 0, phase: 'idle' };
  private readonly listeners = new Set<(state: NetworkRecoveryState) => void>();

  get state(): NetworkRecoveryState { return { ...this.current }; }

  receive(raw: unknown): void {
    const next = parseNetworkRecoveryState(raw);
    if (!next || next.generation < this.current.generation) return;
    const order = { resetting: 0, awaiting_live: 1, idle: 2 };
    if (next.generation === this.current.generation && order[next.phase] <= order[this.current.phase]) return;
    this.current = next;
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: (state: NetworkRecoveryState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
