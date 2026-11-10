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
  const { backgroundAgents, sidekicks } = activity ?? { backgroundAgents: 0, sidekicks: 0 };
  const labels = [];
  if (backgroundAgents > 0) labels.push(`${backgroundAgents} background ${backgroundAgents === 1 ? 'agent' : 'agents'} running`);
  if (sidekicks > 0) labels.push(`${sidekicks} ${sidekicks === 1 ? 'Sidekick' : 'Sidekicks'} running`);
  return <>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{labels.join(' · ')}</span>
    {labels.length > 0 && <div className="composer-agent-activity" aria-hidden="true">
      {backgroundAgents > 0 && <span><RunningCount count={backgroundAgents} />{' '}
        <span className="background-agent-shimmer">background {backgroundAgents === 1 ? 'agent' : 'agents'} running</span></span>}
      {backgroundAgents > 0 && sidekicks > 0 && ' · '}
      {sidekicks > 0 && <span><RunningCount count={sidekicks} />{' '}
        <span className="background-agent-shimmer">{sidekicks === 1 ? 'Sidekick' : 'Sidekicks'} running</span></span>}
    </div>}
  </>;
}
