import type { NetworkRecoveryDiagnostic, NetworkRecoveryState, NetworkTicketObservation } from '../common/network-recovery';

// Chosen by the user for this recovery mechanism on 2026-10-05. A reset
// interrupts other in-flight Chromium requests, so one slow ticket only retries.
export const NETWORK_RECOVERY_TICKET_TIMEOUTS = 2;

/** Session-wide escalation beneath, rather than replacement of, socket retries. */
export class NetworkRecovery {
  private current: NetworkRecoveryState = { generation: 0, phase: 'idle' };
  private readonly timeouts = new Map<string, number>();

  constructor(private readonly dependencies: {
    closeConnections: () => Promise<void>;
    publish: (state: NetworkRecoveryState) => void;
    record: (diagnostic: NetworkRecoveryDiagnostic) => void;
  }) {}

  get state(): NetworkRecoveryState { return { ...this.current }; }

  observe(observation: NetworkTicketObservation): void {
    // An aborted pre-reset request or a socket opened under that request may
    // finish late. Neither may trigger another reset or declare recovery.
    if (observation.generation !== this.current.generation || this.current.phase === 'resetting') return;
    if (observation.outcome === 'live') {
      this.timeouts.delete(observation.target);
      if (this.current.phase === 'awaiting_live') {
        this.timeouts.clear();
        this.record('live_restored');
        this.update('idle');
      }
      return;
    }
    if (observation.outcome === 'accepted' || observation.outcome === 'failed') {
      this.timeouts.delete(observation.target);
      return;
    }
    const count = (this.timeouts.get(observation.target) ?? 0) + 1;
    this.timeouts.set(observation.target, count);
    this.record('ticket_timeout', count);
    // Do not keep resetting during an outage. A live response in this new
    // generation, not a ticket or transport open, rearms recovery.
    if (this.current.phase !== 'idle' || count < NETWORK_RECOVERY_TICKET_TIMEOUTS) return;
    this.timeouts.clear();
    this.current = { generation: this.current.generation + 1, phase: 'resetting' };
    this.record('reset_started', count);
    this.dependencies.publish(this.state);
    void this.reset();
  }

  private async reset(): Promise<void> {
    try {
      await this.dependencies.closeConnections();
      this.record('reset_finished');
    } catch {
      // A failed reset leaves ordinary socket retries available. Never reload
      // a window, clear its storage, or replay its interrupted mutations.
      this.record('reset_failed');
    } finally {
      this.update('awaiting_live');
    }
  }

  private update(phase: NetworkRecoveryState['phase']): void {
    this.current = { ...this.current, phase };
    this.dependencies.publish(this.state);
  }

  private record(phase: NetworkRecoveryDiagnostic['phase'], consecutiveTimeouts?: number): void {
    this.dependencies.record({ kind: 'desktop_network_recovery', generation: this.current.generation, phase,
      ...(consecutiveTimeouts === undefined ? {} : { consecutiveTimeouts }) });
  }
}
