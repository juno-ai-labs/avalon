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
}

export function AgentWorkTiming({
  active,
  durationMs,
  startedAt,
}: AgentWorkTimingProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  const activeDuration = active && startedAt !== undefined
    ? Math.max(0, now - startedAt)
    : 0;
  const verb = active ? 'working' : 'worked';
  const label = `${verb} for ${formatDuration(durationMs + activeDuration) ?? '0ms'}`;

  return (
    <div
      aria-label={label}
      aria-live={active ? 'off' : 'polite'}
      className={clsx('agent-work-timing', active && 'agent-work-timing-active')}
    >
      <ThinkingOrb
        aria-hidden="true"
        className="agent-work-timing-orb"
        paused={!active}
        size={20}
        state="solving"
        theme="dark"
      />
      <span className="agent-work-timing-label">{label}</span>
    </div>
  );
}
