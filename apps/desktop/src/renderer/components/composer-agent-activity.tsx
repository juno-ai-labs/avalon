import type { CanvasRunningActivity } from '@rally/contracts/canvases';
import { useState } from 'react';

/** Preserve the previous value for the existing directional count wheel. */
function RunningCount({ count }: { count: number }): React.JSX.Element {
  const [display, setDisplay] = useState({ count, previous: null as number | null });
  if (count !== display.count) setDisplay({ count, previous: display.count });
  return <span className="background-agent-wheel" data-direction={display.previous != null && count < display.previous ? 'down' : 'up'} key={count}>
    {display.previous != null && <span className="background-agent-digit background-agent-digit-out background-agent-shimmer" onAnimationEnd={(event) => {
      if (event.animationName === 'background-agent-digit-out') setDisplay(current => ({ ...current, previous: null }));
    }}>{display.previous}</span>}
    <span className={`background-agent-digit background-agent-shimmer${display.previous != null ? ' background-agent-digit-in' : ''}`}>{count}</span>
  </span>;
}

/** Live execution only. Unknown, disconnected and zero counts occupy no space. */
export function ComposerAgentActivity({ activity }: { activity: CanvasRunningActivity | undefined }): React.JSX.Element | null {
  if (!activity || (activity.backgroundAgents === 0 && activity.sidekicks === 0)) return null;
  const labels = [];
  if (activity.backgroundAgents > 0) labels.push(`${activity.backgroundAgents} background ${activity.backgroundAgents === 1 ? 'agent' : 'agents'} running`);
  if (activity.sidekicks > 0) labels.push(`${activity.sidekicks} ${activity.sidekicks === 1 ? 'Sidekick' : 'Sidekicks'} running`);
  return <div className="composer-agent-activity" role="status" aria-live="polite" aria-atomic="true" aria-label={labels.join(' · ')}>
    <span aria-hidden="true">
      {activity.backgroundAgents > 0 && <span><RunningCount count={activity.backgroundAgents} />{' '}
        <span className="background-agent-shimmer">background {activity.backgroundAgents === 1 ? 'agent' : 'agents'} running</span></span>}
      {activity.backgroundAgents > 0 && activity.sidekicks > 0 && ' · '}
      {activity.sidekicks > 0 && <span><RunningCount count={activity.sidekicks} />{' '}
        <span className="background-agent-shimmer">{activity.sidekicks === 1 ? 'Sidekick' : 'Sidekicks'} running</span></span>}
    </span>
  </div>;
}
