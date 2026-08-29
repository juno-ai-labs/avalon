import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { formatDuration } from '../lib/format';

export interface AgentWorkTimingProps {
  active: boolean;
  /** Completed time accumulated before the currently active segment. */
  durationMs: number;
  /** Start of the active segment. Omit it to keep the active total paused. */
  startedAt?: number;
  monotonicStartedAt?: number;
  /** Recovered stops are known only by the later durable recovery boundary. */
  timingAccuracy?: 'observed' | 'upper_bound';
  activeVerb?: string;
  completedVerb?: string;
  /**
   * Drawn in the orb's place. A grouped plugin row names the plugin it is
   * timing, and its mark is what says which one — a second spinner beside
   * every mark says only that something is running, which the mark and the
   * shimmering label already say.
   */
  icon?: React.ReactNode;
}

export function AgentCompactionIndicator(): React.JSX.Element {
  return (
    <div
      aria-atomic="true"
      aria-label="Rally is compacting the conversation context"
      aria-live="polite"
      className="agent-work-timing agent-work-timing-active"
      role="status"
    >
      <ThinkingOrb
        aria-hidden="true"
        className="agent-work-timing-orb"
        size={20}
        speed={1}
        state="solving"
        theme="dark"
      />
      <span aria-hidden="true" className="agent-work-timing-label">
        Compacting conversation context…
      </span>
    </div>
  );
}

export function AgentWorkTiming({
  active,
  activeVerb = 'working',
  completedVerb = 'worked',
  durationMs,
  icon,
  monotonicStartedAt,
  timingAccuracy = 'observed',
  startedAt,
}: AgentWorkTimingProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || (startedAt === undefined && monotonicStartedAt === undefined)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active, monotonicStartedAt, startedAt]);

  const running = active && (monotonicStartedAt !== undefined || startedAt !== undefined);
  const activeDuration = running
    ? monotonicStartedAt !== undefined
      ? Math.max(0, performance.now() - monotonicStartedAt)
      : Math.max(0, now - startedAt!)
    : 0;
  const verb = active ? activeVerb : completedVerb;
  const duration = formatDuration(durationMs + activeDuration) ?? '0ms';
  const label = timingAccuracy === 'upper_bound' && !active
    ? `${verb} for at most ${duration}`
    : `${verb} for ${duration}`;
  // The elapsed time changes ten times a second, so a live region carrying it
  // would read the row out continuously. While the segment runs the name is the
  // verb alone, which is stable: "Rally is working", "Slack is working".
  const accessibleLabel = active
    ? activeVerb === 'working' ? 'Rally is working' : activeVerb
    : label;

  return (
    <div
      aria-atomic="true"
      aria-label={accessibleLabel}
      aria-live="polite"
      className={clsx('agent-work-timing', running && 'agent-work-timing-active')}
      role="status"
    >
      {icon ?? (
        <ThinkingOrb
          aria-hidden="true"
          className="agent-work-timing-orb"
          paused={!running}
          size={20}
          // thinking-orbs@0.2.0 draws animation time zero when speed is zero.
          speed={running ? 1 : 0}
          state="solving"
          theme="dark"
        />
      )}
      <span aria-hidden="true" className="agent-work-timing-label">{label}</span>
    </div>
  );
}
