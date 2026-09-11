import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { formatDuration } from '../lib/format';
import { useAppearance } from '../lib/theme';

/**
 * One sentence for one state, so the row above the composer and the tooltip on
 * the Stop button inside it cannot describe the same pending stop two ways.
 */
export const STOPPING_LABEL = 'Stopping after the current response…';

export interface AgentWorkTimingProps {
  active: boolean;
  /**
   * Completed time accumulated before the currently active segment.
   *
   * Null means the duration is unknown, and the row then reads "Slack worked"
   * with no time at all. That is the honest rendering: the previous code had
   * no way to distinguish a plugin that took no measurable time from one whose
   * timing never reached the client, and printed `0ms` for both.
   */
  durationMs: number | null;
  /** Start of the active segment. Omit it to keep the active total paused. */
  startedAt?: number;
  /**
   * The local monotonic start of every segment running at once, summed into the
   * elapsed total. Usually one — a grouped plugin row can have several, because
   * a batch's tool calls run concurrently and its completed total counts each
   * of them, so the live number has to advance by each of them too.
   */
  monotonicStartedAt?: number | readonly number[];
  /** Recovered stops are known only by the later durable recovery boundary. */
  timingAccuracy?: 'observed' | 'upper_bound';
  activeVerb?: string;
  completedVerb?: string;
  /**
   * The stable name a screen reader hears while the segment runs. The visible
   * label ticks ten times a second, so a live region cannot carry it; this is
   * the sentence that stands in, and every caller that overrides `activeVerb`
   * owns one — deriving it from the verb turned a thinking row's name into the
   * bare word "thinking".
   */
  activeName?: string;
  /**
   * Drawn in the orb's place. A grouped plugin row names the plugin it is
   * timing, and its mark is what says which one — a second spinner beside
   * every mark says only that something is running, which the mark and the
   * shimmering label already say.
   */
  icon?: React.ReactNode;
}

export function AgentCompactionIndicator(): React.JSX.Element {
  const appearance = useAppearance();

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
        theme={appearance}
      />
      <span aria-hidden="true" className="agent-work-timing-label">
        Compacting conversation context…
      </span>
    </div>
  );
}

/**
 * What the composer dock says between a Stop request and the run ending.
 *
 * Stop is observed only at the loop's next safe step boundary: the response in
 * flight and every tool it already asked for settle first, and no further
 * provider request begins — `docs/workstream-durable-object.md` owns that
 * contract. A production run measured eleven seconds between the click and the
 * terminal commit. For all of it, the only sign the request had landed was a
 * spinner inside the composer's 28px Stop button and a tooltip nobody hovers,
 * while the row above went on counting "Rally is working for 42s" — so a Stop
 * that was working read as a Stop that was ignored.
 *
 * This is the acknowledgement. It borrows the activity rows' shape because it
 * is the same kind of line, but it is drawn in the dock rather than in the
 * feed: the dock is outside the scroller, and a reader who has scrolled up to
 * read history is exactly who needs to see this. `conversationShowsStoppingRow`
 * has that in full.
 *
 * It names what is being waited on rather than a duration: the only number
 * worth printing is how much longer, and nothing here can know it.
 */
export function RunStoppingIndicator(): React.JSX.Element {
  const appearance = useAppearance();

  return (
    <div
      aria-atomic="true"
      aria-label={STOPPING_LABEL}
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
        theme={appearance}
      />
      <span aria-hidden="true" className="agent-work-timing-label">{STOPPING_LABEL}</span>
    </div>
  );
}

/**
 * The label opens a row's own line, so it opens with a capital.
 *
 * Here rather than at each producer because a producer's verb is also the
 * identity that routes the row — see the invariant in
 * `docs/plugin-activity-rows.md`. Already-capitalized verbs pass through
 * unchanged, so a producer that names itself keeps saying exactly what it says.
 */
function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function AgentWorkTiming({
  active,
  activeName = 'Rally is working',
  activeVerb = 'working',
  completedVerb = 'worked',
  durationMs,
  icon,
  monotonicStartedAt,
  timingAccuracy = 'observed',
  startedAt,
}: AgentWorkTimingProps): React.JSX.Element {
  const appearance = useAppearance();
  const [now, setNow] = useState(() => Date.now());

  const monotonicStarts = monotonicStartedAt === undefined
    ? []
    : typeof monotonicStartedAt === 'number' ? [monotonicStartedAt] : monotonicStartedAt;
  // The effect keys on the starts' values, not on the array holding them: a
  // caller that rebuilds the array each render would otherwise re-arm the
  // interval on every tick it schedules.
  const monotonicKey = monotonicStarts.join(',');

  useEffect(() => {
    if (!active || (startedAt === undefined && monotonicKey === '')) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active, monotonicKey, startedAt]);

  const running = active && (monotonicStarts.length > 0 || startedAt !== undefined);
  const activeDuration = running
    ? monotonicStarts.length > 0
      ? monotonicStarts.reduce((total, start) => total + Math.max(0, performance.now() - start), 0)
      : Math.max(0, now - startedAt!)
    : 0;
  const verb = active ? activeVerb : completedVerb;
  // An unknown completed total silences the number whether or not the row is
  // still going. Printing the active segment alone would read as the whole —
  // "Rally is working for 3s" when the truth is "unknown, plus 3s" — which is
  // the same overstatement as `0ms`, one level up, and the one this change
  // exists to stop making.
  const duration = durationMs === null
    ? null
    : formatDuration(durationMs + activeDuration) ?? '0ms';
  const phrase = durationMs === null
    ? verb
    : timingAccuracy === 'upper_bound' && !active
      ? `${verb} for at most ${duration}`
      : `${verb} for ${duration}`;
  const label = sentenceCase(phrase);
  // The elapsed time changes ten times a second, so a live region carrying it
  // would read the row out continuously; `activeName` is the stable stand-in.
  const accessibleLabel = active ? activeName : label;

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
          theme={appearance}
        />
      )}
      <span aria-hidden="true" className="agent-work-timing-label">{label}</span>
    </div>
  );
}
