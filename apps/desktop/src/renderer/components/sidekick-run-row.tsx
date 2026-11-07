import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { Message } from '../lib/types';
import { RelativeTime } from './relative-time';
import { AutomationGlyph } from './workstream-glyph';

type RunState = NonNullable<NonNullable<Message['automationActivation']>['run']>['state'];
type RunTrigger = NonNullable<NonNullable<Message['automationActivation']>['trigger']>;

const STATE_LABEL: Record<RunState, string> = {
  pending: 'Starting',
  running: 'Working',
  needs_input: 'Needs input',
  completed: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: 'Asked',
  schedule: 'Scheduled',
  external_event: 'Event',
  inbound_email: 'Email',
};

/** The search a Sidekick screen reads to show one run's own conversation in place of the shared one. */
export function sidekickRunSearch(runId: string): string {
  return `?run=${encodeURIComponent(runId)}`;
}

/**
 * A run's row in its Sidekick's shared conversation: collapsed to what
 * started it, where it stands, how many steps it took, and its reply.
 * Expanding shows the whole reply and the way into the run's own
 * conversation, a child of the Sidekick whose substream id is the run id.
 * The row is the server's projection of the run (`automation_activation` with
 * `run`), so it moves as the run does; `docs/automation-lifecycle.md` owns it.
 */
export function SidekickRunRow({ message }: { message: Message }): React.JSX.Element | null {
  const activation = message.automationActivation;
  const run = activation?.run;
  if (!activation || !run || !activation.runId) return null;
  const summary = [
    `Run · ${activation.trigger ? TRIGGER_LABEL[activation.trigger] : 'Run'}`,
    STATE_LABEL[run.state],
    `${run.stepCount} ${run.stepCount === 1 ? 'step' : 'steps'}`,
  ].join(' · ');
  return <article aria-label={`${activation.automationName} run`} className="sidekick-run-row" data-state={run.state} id={`message-${message.id}`}>
    <details>
      <summary>
        <ChevronRight aria-hidden="true" className="disclosure-chevron" size={13} />
        <span className="sidekick-run-row-glyph"><AutomationGlyph id={activation.automationId} /></span>
        <span className="sidekick-run-row-summary">{summary}</span>
        <RelativeTime className="sidekick-run-row-time" value={message.createdAt} />
      </summary>
      {run.reply && <p className="sidekick-run-row-reply">{run.reply}</p>}
      <Link className="sidekick-run-row-open" to={{ search: sidekickRunSearch(activation.runId) }}>Open run</Link>
    </details>
    {run.reply && <p aria-hidden="true" className="sidekick-run-row-preview">{run.reply}</p>}
  </article>;
}
