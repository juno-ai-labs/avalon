import clsx from 'clsx';
import { Check, ChevronDown, CircleAlert, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { AutomationPluginActivity } from '@rally/contracts';
import { normalizeModelText } from '@rally/contracts/model-markdown';
import { formatDuration } from '../lib/format';
import { PluginFace } from './plugin-face';

/**
 * One tool call as this component needs it — a structural subset of the
 * transcript's `ToolEventData`, so either surface's events assign to it without
 * a mapping layer. Order and upserts are the caller's: the array is
 * first-arrival order, and a call that settles replaces its own entry rather
 * than appending a second one.
 */
export interface AgentRunActivity {
  id: string;
  /** Prose from the harness (`toolActivityName`), never a wire symbol. */
  name: string;
  summary?: string | undefined;
  status: 'started' | 'completed' | 'failed' | 'ambiguous';
  plugin?: AutomationPluginActivity | undefined;
  durationMs?: number | undefined;
}

export interface AgentRunStatusProps {
  events: AgentRunActivity[];
  /** When the run was submitted, in `Date.now()` time. */
  startedAt: number;
  /** Set once the run settles; the ticker stops and the record state renders. */
  completedAt?: number | undefined;
  outcome?: 'completed' | 'failed' | undefined;
  /** Before the first tool call — what the agent is doing with the request. */
  idleLabel: string;
  /** After the last tool settles, while the reply is being composed. */
  finalizingLabel: string;
}

interface TimelineEntry {
  key: string;
  name: string;
  plugin?: AutomationPluginActivity | undefined;
  summary?: string | undefined;
  count: number;
  durationMs: number;
  failed: boolean;
}

/**
 * The activity record, one row per distinct thing the run did. Repeats of the
 * same call against the same plugin — three Slack searches in a row — fold into
 * one row with a count, because the default view is a receipt rather than a
 * log: what happened, not how many wire calls it took. The row keeps the last
 * summary (the freshest result) and the sum of the calls' durations.
 */
export function foldRunActivities(events: AgentRunActivity[]): TimelineEntry[] {
  const entries = new Map<string, TimelineEntry>();
  for (const event of events) {
    const failed = event.status === 'failed' || event.status === 'ambiguous';
    const key = `${event.plugin?.pluginId ?? ''}|${event.name}|${failed ? 'failed' : 'settled'}`;
    const existing = entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.durationMs += event.durationMs ?? 0;
      if (event.summary) existing.summary = event.summary;
    } else {
      entries.set(key, {
        key,
        name: event.name,
        plugin: event.plugin,
        summary: event.summary,
        count: 1,
        durationMs: event.durationMs ?? 0,
        failed,
      });
    }
  }
  return [...entries.values()];
}

/** The providers the run touched, one face each, in first-use order. */
export function runPluginStack(events: AgentRunActivity[]): AutomationPluginActivity[] {
  const seen = new Map<string, AutomationPluginActivity>();
  for (const event of events) {
    if (event.plugin && !seen.has(event.plugin.pluginId)) seen.set(event.plugin.pluginId, event.plugin);
  }
  return [...seen.values()];
}

/** Sub-second precision reads as churn on a status line, so the floor is 1s. */
function statusDuration(elapsedMs: number): string {
  return formatDuration(Math.max(1_000, elapsedMs)) ?? '1s';
}

function GenericToolFace(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="agent-run-status-face-generic">
      <TerminalSquare size={13} />
    </span>
  );
}

/**
 * The one element a chat surface shows for a run in progress, and the compact
 * record it leaves behind: a current-activity label with an elapsed counter
 * while the run works, then a duration, the provider faces it used, and a
 * collapsed fold-out of what it did. It never moves and nothing is appended
 * around it — each event only changes what this one element says, which is the
 * point: progress without layout churn.
 */
export function AgentRunStatus({
  completedAt,
  events,
  finalizingLabel,
  idleLabel,
  outcome,
  startedAt,
}: AgentRunStatusProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const active = completedAt === undefined;

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  const timeline = useMemo(() => foldRunActivities(events), [events]);
  const pluginStack = useMemo(() => runPluginStack(events), [events]);

  // The latest call still running is what the run is doing right now; with
  // every call settled the model is composing, and before the first one it is
  // reading the request. The labels arrive as started-tense prose, so the line
  // stays in the present without this component conjugating anything.
  let activeTool: AgentRunActivity | undefined;
  for (const event of events) {
    if (event.status === 'started') activeTool = event;
  }

  const elapsed = statusDuration(Math.max(0, (completedAt ?? now) - startedAt));
  const failed = outcome === 'failed';
  const settledLabel = failed ? `Stopped after ${elapsed}` : `Ran for ${elapsed}`;
  // Constant while active so the live region announces the state change, not
  // every tick or tool hop — the visible text is aria-hidden for the same
  // reason, exactly as `AgentWorkTiming` does it.
  const accessibleLabel = active ? 'Rally is working' : `Rally ${failed ? 'stopped after' : 'ran for'} ${elapsed}`;

  return (
    <div
      aria-atomic="true"
      aria-label={accessibleLabel}
      aria-live="polite"
      className={clsx(
        'agent-run-status',
        active && 'agent-run-status-active',
        failed && 'agent-run-status-failed',
      )}
      role="status"
    >
      <div className="agent-run-status-header">
        {active ? (
          activeTool?.plugin
            ? <PluginFace plugin={activeTool.plugin} />
            : activeTool
              ? <GenericToolFace />
              : (
                  <ThinkingOrb
                    aria-hidden="true"
                    className="agent-run-status-orb"
                    size={20}
                    speed={1}
                    state="solving"
                    theme="dark"
                  />
                )
        ) : (
          <span aria-hidden="true" className={clsx('agent-run-status-outcome', failed && 'is-failed')}>
            {failed ? <CircleAlert size={13} /> : <Check size={13} />}
          </span>
        )}
        <span aria-hidden="true" className="agent-run-status-label">
          {active ? activeTool?.name ?? (events.length === 0 ? idleLabel : finalizingLabel) : settledLabel}
        </span>
        {active && <span aria-hidden="true" className="agent-run-status-timer">· Running for {elapsed}</span>}
        {!active && pluginStack.length > 0 && (
          <span className="agent-run-status-stack">
            {pluginStack.map((plugin) => <PluginFace key={plugin.pluginId} plugin={plugin} />)}
          </span>
        )}
        {!active && timeline.length > 0 && (
          <button
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide what Rally did' : 'Show what Rally did'}
            className="agent-run-status-toggle"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {events.length} {events.length === 1 ? 'step' : 'steps'}
            <ChevronDown aria-hidden="true" size={12} />
          </button>
        )}
      </div>
      {!active && expanded && timeline.length > 0 && (
        <ul className="agent-run-status-timeline">
          {timeline.map((entry) => (
            <li className={clsx('agent-run-status-activity', entry.failed && 'is-failed')} key={entry.key}>
              {entry.plugin ? <PluginFace plugin={entry.plugin} /> : <GenericToolFace />}
              <span className="agent-run-status-activity-copy">
                <strong>
                  {entry.name}
                  {entry.count > 1 && <span className="agent-run-status-count">×{entry.count}</span>}
                </strong>
                {entry.summary && <small>{normalizeModelText(entry.summary)}</small>}
              </span>
              {entry.durationMs > 0 && (
                <span className="agent-run-status-activity-duration">{formatDuration(entry.durationMs)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
