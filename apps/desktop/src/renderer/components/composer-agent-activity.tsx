import type { CanvasRunningActivity } from '@rally/contracts/canvases';
import { useState } from 'react';
import { RollingSlot } from './rolling-cycle';

/** The running count, rolling the way it moved: up for more, down for fewer. */
function RunningCount({ count }: { count: number }): React.JSX.Element {
  const [shown, setShown] = useState({ count, direction: 'up' as 'up' | 'down' });
  if (count !== shown.count) setShown({ count, direction: count < shown.count ? 'down' : 'up' });
  return <RollingSlot className="background-agent-count" direction={shown.direction} itemClassName="background-agent-shimmer" valueKey={count}>{count}</RollingSlot>;
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
