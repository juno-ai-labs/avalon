import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useCollaborationSession } from '../lib/collaboration-session';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import { answerConversationElicitation } from '../lib/conversation-elicitation';
import { composeTranscript, orderedTranscriptMessages, transcriptOverlaysQueryKey, type TranscriptOverlay } from '../lib/transcript';
import type { AutomationSummary, Message } from '../lib/types';
import { orderedTranscriptQueryKey, useWorkstreamSocket } from '../lib/use-workstream-socket';
import { RelativeTime } from './relative-time';
import { ElicitationPanel } from './workstream-blocks';
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

// "On request", not "Asked": beside a state that can read Needs input, "Asked"
// said the run had asked a question when it had not.
const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: 'On request',
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
  // The Sidekick's own mark, from the list the workspace socket keeps; the
  // mark derived from the id while the list has not said.
  const sidekicks = useSocketOwnedList<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
  if (!activation || !run || !activation.runId) return null;
  const appearance = sidekicks?.find((sidekick) => sidekick.id === activation.automationId)?.appearance;
  const live = run.state === 'pending' || run.state === 'running';
  return <article aria-label={`${activation.automationName} run`} className="sidekick-run-row" data-state={run.state} id={`message-${message.id}`}>
    <details>
      <summary>
        <ChevronRight aria-hidden="true" className="disclosure-chevron" size={13} />
        <span className="sidekick-run-row-glyph"><AutomationGlyph {...(appearance ? { appearance } : {})} id={activation.automationId} /></span>
        <span className="sidekick-run-row-summary">
          {/* design §4: "Run 412 · <what woke it>". The run carries its
              trigger's kind, not the event's text, so the kind is what it
              says. A count of no steps says nothing yet, so it waits for the
              first. Each fact is its own unbroken span, so a narrow row
              wraps between facts ("· 6 steps") rather than inside one. */}
          <span className="sidekick-run-row-fact sidekick-run-row-name">{activation.runNumber ? `Run ${activation.runNumber}` : 'Run'}</span>
          {activation.trigger && <> · <span className="sidekick-run-row-fact">{TRIGGER_LABEL[activation.trigger]}</span></>}
          {' · '}<span className="sidekick-run-row-fact sidekick-run-row-state">
            {live && <span aria-hidden="true" className="sidekick-working-dot" />}{STATE_LABEL[run.state]}
          </span>
          {run.stepCount > 0 && <> · <span className="sidekick-run-row-fact">{run.stepCount} {run.stepCount === 1 ? 'step' : 'steps'}</span></>}
        </span>
        <RelativeTime className="sidekick-run-row-time" value={message.createdAt} />
      </summary>
      {run.reply && <p className="sidekick-run-row-reply">{run.reply}</p>}
      <Link className="sidekick-run-row-open" to={{ search: sidekickRunSearch(activation.runId) }}>Open run</Link>
    </details>
    {run.state === 'needs_input'
      // A waiting run's reply is its question; the answer form says it once
      // it arrives, and the reply stands in until then.
      ? <SidekickRunQuestion fallback={run.reply} runId={activation.runId} sidekickId={activation.automationId} />
      : run.reply && <p aria-hidden="true" className="sidekick-run-row-preview">{run.reply}</p>}
  </article>;
}

/**
 * The question a run waiting on input asked, answered where the run's row
 * is. The question lives in the run's own conversation (substream the run
 * id), so this opens that conversation's socket, the one the run's own view
 * opens, and answers through the same `answer_elicitation` command; the run's
 * row then moves on as the run does, and this unmounts. Mounted only while
 * the row says Needs input, so a shared conversation holds at most the
 * sockets of the runs waiting in it.
 */
function SidekickRunQuestion({ fallback, sidekickId, runId }: { fallback: string | null; sidekickId: string; runId: string }): React.JSX.Element | null {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const connection = useWorkstreamSocket(api, sidekickId, Boolean(api), 'active_workstream', undefined, true, runId);
  // Socket-owned, both: the connection writes the run's transcript and the
  // overlays its `elicitation_created` and `elicitation_answered` events
  // carry. These observers keep the entries alive and re-render when they
  // land; the question is read from the two composed, as the run's own view
  // reads it, so one restored only as an overlay shows, and an answer given
  // here or by anyone else closes it at once.
  const transcript = useQuery<WorkstreamTranscriptSnapshot | undefined>({
    queryKey: orderedTranscriptQueryKey(sidekickId, runId),
    queryFn: () => undefined,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const overlays = useQuery<TranscriptOverlay[]>({
    queryKey: transcriptOverlaysQueryKey(sidekickId, runId),
    queryFn: () => [],
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // A run waits on one question at a time; the newest open one is it.
  const question = composeTranscript(orderedTranscriptMessages(transcript.data, sidekickId), overlays.data ?? [])
    .filter((message) => message.messageType === 'elicitation' && message.elicitation?.status === 'open')
    .at(-1)?.elicitation;
  if (!question) return fallback ? <p aria-hidden="true" className="sidekick-run-row-preview">{fallback}</p> : null;
  return <div className="sidekick-run-row-question">
    <ElicitationPanel
      elicitation={question}
      onAnswer={(answer, customResponse) => answerConversationElicitation({
        queryClient, parentId: sidekickId, substreamId: runId, connection, elicitationId: question.id, answer, customResponse,
      })}
    />
  </div>;
}
