import type { SidekickSourceRequestView, SidekickSourcesResult } from '@rally/contracts';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import { connectorBrandMark } from '../lib/plugin-marks';
import { Avatar, Button, ConnectorMark } from './primitives';

/**
 * Sidekick sources as people read them (`docs/sidekick-sources.md`): the
 * Approve and Decline pair, the card a conversation draws for an ask, and the
 * Sidekick panel's Sources section. Presentation only: the host reads, sends
 * the answers and names its failures.
 */

export const SIDEKICK_SOURCES_EXPLANATION = 'Events from these people’s accounts can start this Sidekick.';

export type SourceDecision = 'approve' | 'decline';

/** What is asked for: a connector's events. */
export interface SourceAsk {
  connectorType: string;
  eventTypes: readonly string[];
}

/** The host's words for a connector and its events ("Gmail", "New email"). */
export type SourceWords = (ask: SourceAsk) => { connector: string; events: string };

type SourcePerson = SidekickSourceRequestView['person'];

/** Typographic quotes around a person's own written condition. */
function quoted(condition: string): string {
  return `“${condition}”`;
}

function PersonAvatar({ person }: { person: SourcePerson }): React.JSX.Element {
  return <Avatar member={{ id: person.userId, name: person.displayName, email: '', timezone: '',
    ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}), presentation: person.presentation ?? null }} size="small" />;
}

/**
 * Approve and Decline for one request, the same pair on every surface that
 * shows one. It is the request's state as much as its controls: while nobody
 * has chosen both are outlines, and once the person asked chooses, their
 * choice is filled (Approve green, Decline red) and the other stays an
 * outline. Only the person asked is handed `onDecide`; for everyone else, and
 * once answered, the buttons cannot be pressed.
 */
export function SourceDecisionButtons({ state, subject, onDecide, deciding = null, waitingFor }: {
  state: 'pending' | 'approved' | 'declined';
  /** What is being answered, for the buttons' names: "your Gmail for Deals". */
  subject: string;
  /** Present only for the person asked. */
  onDecide?: ((decision: SourceDecision) => void) | undefined;
  /** The answer in flight; both buttons hold until it is acknowledged. */
  deciding?: SourceDecision | null;
  /** Who alone can answer, said on hover while a reader cannot. */
  waitingFor?: string | undefined;
}): React.JSX.Element {
  const live = state === 'pending' && onDecide !== undefined;
  const button = (decision: SourceDecision, label: string, chosen: boolean): React.JSX.Element => <Button
    aria-label={`${label} ${subject}`}
    aria-pressed={chosen}
    className={clsx('source-decision-button', `is-${decision}`, chosen && 'is-chosen')}
    disabled={!live || deciding !== null}
    onClick={() => onDecide?.(decision)}
  >{label}</Button>;
  return <div
    className={clsx('source-decision', live && 'is-live')}
    data-state={state}
    title={state === 'pending' && !live && waitingFor ? `Only ${waitingFor} can answer` : undefined}
  >
    {button('decline', 'Decline', state === 'declined')}
    {button('approve', 'Approve', state === 'approved')}
  </div>;
}

/** Where a request stands, in words, for a reader who is told rather than asked. */
function standing(request: SidekickSourceRequestView): string {
  switch (request.state) {
    case 'pending': return 'Waiting for an answer';
    case 'approved': return 'Approved';
    case 'declined': return 'Declined';
    case 'cancelled': return 'Replaced by a newer request';
  }
}

function subjectOf(request: SidekickSourceRequestView, connector: string): string {
  return `${request.yours ? 'your' : `${request.person.displayName}’s`} ${connector} for ${request.sidekickName}`;
}

/**
 * The card an ask draws in the conversation it was made from. Everyone who
 * can open the conversation sees what was asked, of whom, and where each
 * person stands; only the person asked can press their own row's buttons.
 */
export function SidekickSourceRequestCardView({ requests, words, live = true, onDecide, deciding = null, details }: {
  /** The requests of one ask, as this reader may see them; `undefined` while the first read is out. */
  requests: readonly SidekickSourceRequestView[] | undefined;
  words: SourceWords;
  /** False while `requests` is what the tool answered rather than the live read: nothing can be pressed. */
  live?: boolean;
  onDecide?: ((request: SidekickSourceRequestView, decision: SourceDecision) => void) | undefined;
  deciding?: { requestId: string; decision: SourceDecision } | null;
  /** The host's failure notice, which draws nothing or its Details button. */
  details?: ReactNode;
}): React.JSX.Element {
  const ask = requests?.[0];
  if (!ask) {
    return <article aria-label="Source request" className="connector-connection-card source-request-card">
      <p className="source-request-card-status" role="status">{requests ? 'This request is not available.' : 'Loading request…'}</p>
      {details}
    </article>;
  }
  const { connector, events } = words(ask);
  const mark = connectorBrandMark(ask.connectorType, connector);
  return <article aria-label={`Source request for ${ask.sidekickName}`} className="connector-connection-card source-request-card">
    <div className="connector-connection-card-header">
      {mark && <span aria-hidden="true" className="provider-icon"><ConnectorMark mark={mark} /></span>}
      <div className="connector-connection-card-body">
        <strong>Start {ask.sidekickName} from {connector}</strong>
        <p>{events}{ask.condition ? `, only when ${quoted(ask.condition)}` : ''}</p>
        <small>Asked by {ask.requestedByName}. Only the person asked can answer.</small>
      </div>
    </div>
    <ul aria-label="People asked" className="source-request-people">
      {requests.map((request) => <li key={request.requestId}>
        <PersonAvatar person={request.person} />
        <span className="source-request-person">
          {request.person.displayName}
          {request.yours && <small>You</small>}
          <span className="sr-only">: {standing(request)}</span>
        </span>
        {request.state === 'cancelled'
          ? <span className="source-request-replaced">Replaced by a newer request</span>
          : <SourceDecisionButtons
            deciding={deciding?.requestId === request.requestId ? deciding.decision : null}
            onDecide={live && request.yours && onDecide ? (decision) => onDecide(request, decision) : undefined}
            state={request.state}
            subject={subjectOf(request, connector)}
            waitingFor={request.person.displayName}
          />}
      </li>)}
    </ul>
    {details}
  </article>;
}

/**
 * The Sidekick panel's Sources section: whose events can start the Sidekick,
 * and who has been asked. It sits beside delegation and is not delegation: a
 * source lets events in and lends no account.
 */
export function SidekickSourcesList({ data, loading, words, onDecide, deciding = null, onWithdraw, withdrawing = null }: {
  data?: SidekickSourcesResult | undefined;
  loading: boolean;
  words: SourceWords;
  onDecide: (request: SidekickSourceRequestView, decision: SourceDecision) => void;
  deciding?: { requestId: string; decision: SourceDecision } | null;
  /** The viewer takes their own source back. */
  onWithdraw: (connectionId: string) => void;
  /** The connection whose withdrawal is in flight. */
  withdrawing?: string | null;
}): React.JSX.Element {
  const who = (person: SourcePerson, yours: boolean): React.JSX.Element => <span>
    {person.displayName}{yours && <small>You</small>}
  </span>;
  return <section aria-labelledby="sidekick-sources-heading" className="sidekick-profile-section sidekick-sources">
    <h2 id="sidekick-sources-heading">Sources</h2>
    <p className="sidekick-delegation-disclosure">{SIDEKICK_SOURCES_EXPLANATION}</p>
    {!data && loading && <p role="status">Loading sources…</p>}
    {data && <>
      {data.sources.length === 0 && <p className="sidekick-sources-empty">Nothing lets events in from a person’s account.</p>}
      {data.sources.length > 0 && <ul aria-label="Sources" className="sidekick-delegates">
        {data.sources.map((source) => <li key={`${source.person.userId}:${source.connectionId}`}>
          <PersonAvatar person={source.person} />
          <span className="sidekick-delegate-copy">
            {who(source.person, source.yours)}
            <small>{source.connectionName} · {words(source).events}</small>
            {source.condition && <small>Only when {quoted(source.condition)}</small>}
            {!source.available && <small>Unavailable — restore Organization membership</small>}
          </span>
          {source.yours && <Button
            aria-label={`Stop allowing ${source.connectionName}`}
            disabled={withdrawing !== null}
            onClick={() => onWithdraw(source.connectionId)}
          >{withdrawing === source.connectionId ? 'Stopping…' : 'Stop allowing'}</Button>}
        </li>)}
      </ul>}
      {data.requests.length > 0 && <ul aria-label="People asked" className="sidekick-delegates sidekick-source-requests">
        {data.requests.map((request) => {
          const { connector, events } = words(request);
          const answerable = request.yours && request.state === 'pending';
          return <li key={request.requestId}>
            <PersonAvatar person={request.person} />
            <span className="sidekick-delegate-copy">
              {who(request.person, request.yours)}
              <small>Asked by {request.requestedByName} · {events} in {connector}</small>
              {request.condition && <small>Only when {quoted(request.condition)}</small>}
              {!answerable && <small>{standing(request)}</small>}
              {answerable && <SourceDecisionButtons
                deciding={deciding?.requestId === request.requestId ? deciding.decision : null}
                onDecide={(decision) => onDecide(request, decision)}
                state="pending"
                subject={subjectOf(request, connector)}
              />}
            </span>
          </li>;
        })}
      </ul>}
    </>}
  </section>;
}
