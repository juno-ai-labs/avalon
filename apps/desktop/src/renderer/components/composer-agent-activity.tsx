import { useState } from 'react';

/** Keep the last label behind the composer while its slot closes. */
export function ComposerAgentActivity({ count, kind = 'background' }: { count?: number | null; kind?: 'background' | 'sidekick' }): React.JSX.Element {
  const active = count != null && count > 0;
  const [display, setDisplay] = useState({ input: count, count: active ? count : 0, previous: null as number | null });
  if (count !== display.input) {
    setDisplay({
      input: count,
      count: active ? count : display.count,
      previous: active && display.input != null && display.input > 0 ? display.count : null,
    });
  }
  const noun = kind === 'sidekick' ? (display.count === 1 ? 'Sidekick' : 'Sidekicks') : `background ${display.count === 1 ? 'agent' : 'agents'}`;
  const label = `${display.count} ${noun} running`;
  return (
    <div aria-hidden={!active} aria-label={active ? label : undefined} className="background-agent-count" data-active={active} role="status">
      <div className="background-agent-reveal">
        <div aria-hidden="true" className="background-agent-label">
          <span className="background-agent-wheel" data-direction={display.previous != null && display.count < display.previous ? 'down' : 'up'} key={display.count}>
            {display.previous != null && <span className="background-agent-digit background-agent-digit-out background-agent-shimmer" onAnimationEnd={(event) => {
              if (event.animationName === 'background-agent-digit-out') setDisplay(current => ({ ...current, previous: null }));
            }}>{display.previous}</span>}
            <span className={`background-agent-digit background-agent-shimmer${display.previous != null ? ' background-agent-digit-in' : ''}`}>{display.count}</span>
          </span>
          <span className="background-agent-shimmer">{noun} running</span>
        </div>
      </div>
    </div>
  );
}
