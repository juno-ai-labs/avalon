import type { SidekickSourceRequestView, SidekickSourcesResult } from '@rally/contracts';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import { connectorBrandMark } from '../lib/plugin-marks';
import { Avatar, Button, ConnectorMark } from './primitives';

/**
 * Sidekick sources as people read them (`docs/sidekick-sources.md`): the
 * Approve and Decline pair, the card a conversation draws for an ask, and the
 * Sidekick details' Wakes on section, which lists each trigger's accounts. Presentation only: the host reads, sends
 * the answers and names its failures.
 */

/** A details block with nothing in it says so, rather than leaving a reader to wonder whether it was shown. */
export const SIDEKICK_DETAILS_NOTHING_YET = 'Nothing yet';

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
export function SourceDecisionButtons({ state, subject, onDecide, deciding = null, waitingFor, approveBlocked, approveSlot }: {
  state: 'pending' | 'approved' | 'declined';
  /** What is being answered, for the buttons' names: "your Gmail for Deals". */
  subject: string;
  /** Present only for the person asked. */
  onDecide?: ((decision: SourceDecision) => void) | undefined;
  /** The answer in flight; both buttons hold until it is acknowledged. */
  deciding?: SourceDecision | null;
  /** Who alone can answer, said on hover while a reader cannot. */
  waitingFor?: string | undefined;
  /** Why Approve cannot be pressed yet (the account is not connected); Decline still can. */
  approveBlocked?: string | undefined;
  /** Drawn in Approve's place: the host's "Connect Gmail and approve", one press for both. */
  approveSlot?: ReactNode;
}): React.JSX.Element {
  const live = state === 'pending' && onDecide !== undefined;
  // The pair is never dimmed, so a press in flight says so in words: without them nothing on
  // screen shows the answer was taken.
  const button = (decision: SourceDecision, label: string, sending: string, chosen: boolean): React.JSX.Element => <Button
    aria-busy={deciding === decision || undefined}
    aria-label={`${label} ${subject}`}
    aria-pressed={chosen}
    className={clsx('source-decision-button', `is-${decision}`, chosen && 'is-chosen')}
    disabled={!live || deciding !== null || (decision === 'approve' && approveBlocked !== undefined)}
    onClick={() => onDecide?.(decision)}
    title={decision === 'approve' && live ? approveBlocked : undefined}
  >{deciding === decision ? sending : label}</Button>;
  return <div
    className={clsx('source-decision', live && 'is-live')}
    data-state={state}
    title={state === 'pending' && !live && waitingFor ? `Only ${waitingFor} can answer` : undefined}
  >
    {button('decline', 'Decline', 'Declining…', state === 'declined')}
    {approveSlot ?? button('approve', 'Approve', 'Approving…', state === 'approved')}
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

/** Whether the person asked must still connect or reconnect before Approve, for a request still waiting. */
function connectionToMake(request: SidekickSourceRequestView): 'not_connected' | 'reconnect_required' | null {
  if (request.state !== 'pending' || request.connection === undefined || request.connection === 'connected') return null;
  return request.connection;
}

/** Whether that step is the Organization's: an administrator connects it in Settings, not the person asked. */
function organizationsStep(request: SidekickSourceRequestView): boolean {
  return request.connect?.scope === 'workspace';
}

/** What a reader who is not asked is told about that step: "Needs to reconnect Gmail". */
function connectionWords(state: 'not_connected' | 'reconnect_required', connector: string, organization = false): string {
  const verb = state === 'reconnect_required' ? 'reconnect' : 'connect';
  return organization ? `Needs an admin to ${verb} ${connector}` : `Needs to ${verb} ${connector}`;
}

/**
 * The host's "Connect Gmail and approve" for the asked person's own request
 * while its account still has to be connected, drawn in Approve's place so one
 * press does both, or the host's words for where that step is done instead.
 * Presentation does not connect anything: the host owns the OAuth flow and
 * sends the approval once the account works.
 */
export type SourceConnectStep = (request: SidekickSourceRequestView) => {
  control: ReactNode;
  /** The control connects here, so the card's title can name that step. */
  connectsHere: boolean;
};

function subjectOf(request: SidekickSourceRequestView, connector: string): string {
  return `${request.yours ? 'your' : `${request.person.displayName}’s`} ${connector} for ${request.sidekickName}`;
}

/**
 * The card an ask draws in the conversation it was made from. Everyone who
 * can open the conversation sees what was asked, of whom, and where each
 * person stands; only the person asked can press their own row's buttons.
 */
export function SidekickSourceRequestCardView({ requests, words, live = true, onDecide, deciding = null, details, connectStep }: {
  /** The requests of one ask, as this reader may see them; `undefined` while the first read is out. */
  requests: readonly SidekickSourceRequestView[] | undefined;
  words: SourceWords;
  /** False while `requests` is what the tool answered rather than the live read: nothing can be pressed. */
  live?: boolean;
  onDecide?: ((request: SidekickSourceRequestView, decision: SourceDecision) => void) | undefined;
  deciding?: { requestId: string; decision: SourceDecision } | null;
  /** The host's failure notice, which draws nothing or its Details button. */
  details?: ReactNode;
  /** Drawn for the reader's own waiting request while its account still has to be connected. */
  connectStep?: SourceConnectStep | undefined;
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
  // A reader whose own request waits on their account reads the whole card as that one step.
  const mine = connectStep ? requests.find((request) => request.yours && connectionToMake(request) && !organizationsStep(request)) : undefined;
  const mineStep = mine && live && connectStep ? connectStep(mine) : undefined;
  const mineToMake = mine && mineStep?.connectsHere ? connectionToMake(mine) : null;
  return <article aria-label={`Source request for ${ask.sidekickName}`} className="connector-connection-card source-request-card">
    <div className="connector-connection-card-header">
      {mark && <span aria-hidden="true" className="provider-icon"><ConnectorMark mark={mark} /></span>}
      <div className="connector-connection-card-body">
        <strong>{mineToMake
          ? `${mineToMake === 'reconnect_required' ? 'Reconnect' : 'Connect'} ${connector} and approve ${ask.sidekickName}`
          : `Start ${ask.sidekickName} from ${connector}`}</strong>
        <p>{events}{ask.condition ? `, only when ${quoted(ask.condition)}` : ''}</p>
        <small>Asked by {ask.requestedByName}. Only the person asked can answer.</small>
      </div>
    </div>
    <ul aria-label="People asked" className="source-request-people">
      {requests.map((request) => {
        const toMake = connectionToMake(request);
        const ownStep = toMake && request.yours && connectStep && live
          ? (request === mine && mineStep ? mineStep : connectStep(request)).control
          : undefined;
        return <li key={request.requestId}>
          <PersonAvatar person={request.person} />
          <span className="source-request-person">
            {request.person.displayName}
            {request.yours && <small>You</small>}
            {toMake && !request.yours && <small className="source-request-connection">{connectionWords(toMake, connector, organizationsStep(request))}</small>}
            <span className="sr-only">: {standing(request)}</span>
          </span>
          {request.state === 'cancelled'
            ? <span className="source-request-replaced">Replaced by a newer request</span>
            : <SourceDecisionButtons
              approveBlocked={toMake ? `${toMake === 'reconnect_required' ? 'Reconnect' : 'Connect'} ${connector} first` : undefined}
              approveSlot={ownStep}
              deciding={deciding?.requestId === request.requestId ? deciding.decision : null}
              onDecide={live && request.yours && onDecide ? (decision) => onDecide(request, decision) : undefined}
              state={request.state}
              subject={subjectOf(request, connector)}
              waitingFor={request.yours ? undefined : request.person.displayName}
            />}
        </li>;
      })}
    </ul>
    {details}
  </article>;
}

/** One trigger of a Sidekick, as its details list it under Wakes on. */
export interface WakeTrigger {
  key: string;
  /** The mark for its kind: a clock for a schedule, a hand for on request, a bolt for an event. */
  icon: ReactNode;
  /** What starts it, in one line: the schedule, or the event and its condition. */
  summary: string;
  /**
   * For a trigger an event starts: the connector and event types it listens
   * for. A null field matches anything, as a trigger that names no connector
   * or no event type gates every event reaching it. Absent for a schedule or
   * on request, which no account feeds.
   */
  listensFor?: { connectorType: string | null; eventTypes: readonly string[] | null };
  /** The Organization's own connection it watches, by name; that one needs nobody's source. */
  organizationAccount?: { connectorType: string; name: string };
}

/** Whether a person's source or request is for events this trigger listens for. */
function feeds(listensFor: NonNullable<WakeTrigger['listensFor']>, entry: SourceAsk): boolean {
  if (listensFor.connectorType !== null && listensFor.connectorType !== entry.connectorType) return false;
  return listensFor.eventTypes === null || entry.eventTypes.some((eventType) => listensFor.eventTypes!.includes(eventType));
}

/**
 * The Sidekick details' Wakes on section: every trigger with its condition,
 * and under each trigger an event starts, the accounts whose events reach it
 * (`docs/sidekick-sources.md`): the Organization's connection it watches, each
 * person's source with their own filter, and each person who has been asked.
 * A source lets events in and lends no account; that is delegation, the
 * section below. A source or request no trigger listens for is still listed,
 * under Other accounts, so its person can always see it and take it back.
 * One that feeds several triggers is listed under each, with its control on
 * the first only: the control acts on the whole source or request.
 */
export function SidekickWakesOnList({ triggers, next, data, loading = false, words, onDecide, deciding = null, onWithdraw, withdrawing = null }: {
  triggers: readonly WakeTrigger[];
  /** The next scheduled run, drawn under the triggers. */
  next?: ReactNode;
  /** Whose events may enter; `undefined` before the read, and for a host that reads none (a draft). */
  data?: SidekickSourcesResult | undefined;
  loading?: boolean;
  words: SourceWords;
  onDecide?: ((request: SidekickSourceRequestView, decision: SourceDecision) => void) | undefined;
  deciding?: { requestId: string; decision: SourceDecision } | null;
  /** The viewer takes their own source back. */
  onWithdraw?: ((connectionId: string) => void) | undefined;
  /** The connection whose withdrawal is in flight. */
  withdrawing?: string | null;
}): React.JSX.Element {
  const who = (person: SourcePerson, yours: boolean): React.JSX.Element => <span>
    {person.displayName}{yours && <small>You</small>}
  </span>;
  // The rows already drawn with their control, so a repeat under a later trigger has none.
  const controlled = new Set<string>();
  const firstListing = (key: string): boolean => {
    if (controlled.has(key)) return false;
    controlled.add(key);
    return true;
  };
  const sourceRow = (source: SidekickSourcesResult['sources'][number]): React.JSX.Element => {
    const key = `source:${source.person.userId}:${source.connectionId}:${source.condition ?? ''}`;
    const withdrawable = source.yours && onWithdraw !== undefined && firstListing(key);
    return <li key={key}>
      <PersonAvatar person={source.person} />
      <span className="sidekick-delegate-copy">
        {who(source.person, source.yours)}
        <small>{source.connectionName} · {words(source).events}</small>
        {source.condition && <small>Only when {quoted(source.condition)}</small>}
        {!source.available && <small>Unavailable — restore Organization membership</small>}
        {/* Under the copy, as a request's pair is: the details column is 340px wide. */}
        {withdrawable && <Button
          aria-label={`Stop allowing ${source.connectionName}`}
          disabled={withdrawing !== null}
          onClick={() => onWithdraw(source.connectionId)}
        >{withdrawing === source.connectionId ? 'Stopping…' : 'Stop allowing'}</Button>}
      </span>
    </li>;
  };
  const requestRow = (request: SidekickSourceRequestView): React.JSX.Element => {
    const { connector, events } = words(request);
    const key = `request:${request.requestId}`;
    const answerable = request.yours && request.state === 'pending' && onDecide !== undefined && firstListing(key);
    const toMake = connectionToMake(request);
    return <li key={key}>
      <PersonAvatar person={request.person} />
      <span className="sidekick-delegate-copy">
        {who(request.person, request.yours)}
        <small>Asked by {request.requestedByName} · {events} in {connector}</small>
        {request.condition && <small>Only when {quoted(request.condition)}</small>}
        {!answerable && <small>{standing(request)}</small>}
        {toMake && <small>{request.yours && !organizationsStep(request)
          // Connecting happens on the request's card, in the conversation it was asked from.
          ? `${toMake === 'reconnect_required' ? 'Reconnect' : 'Connect'} ${connector} from the request in its conversation first`
          : connectionWords(toMake, connector, organizationsStep(request))}</small>}
        {answerable && <SourceDecisionButtons
          approveBlocked={toMake ? `${toMake === 'reconnect_required' ? 'Reconnect' : 'Connect'} ${connector} first` : undefined}
          deciding={deciding?.requestId === request.requestId ? deciding.decision : null}
          onDecide={(decision) => onDecide(request, decision)}
          state="pending"
          subject={subjectOf(request, connector)}
        />}
      </span>
    </li>;
  };
  const listening = triggers.flatMap((trigger) => trigger.listensFor ? [trigger.listensFor] : []);
  const unheard = (entry: SourceAsk): boolean => !listening.some((listensFor) => feeds(listensFor, entry));
  const otherSources = data?.sources.filter(unheard) ?? [];
  const otherRequests = data?.requests.filter(unheard) ?? [];
  return <section aria-labelledby="sidekick-wakes-on" className="sidekick-profile-section sidekick-wakes-on">
    <h2 id="sidekick-wakes-on">Wakes on</h2>
    {triggers.length === 0 && !next
      ? <p className="sidekick-profile-empty">{SIDEKICK_DETAILS_NOTHING_YET}</p>
      : triggers.length > 0 && <ul aria-label="Triggers" className="sidekick-profile-rows">
        {triggers.map((trigger) => {
          const { listensFor, organizationAccount } = trigger;
          const sources = listensFor && data ? data.sources.filter((source) => feeds(listensFor, source)) : [];
          const requests = listensFor && data ? data.requests.filter((request) => feeds(listensFor, request)) : [];
          const organizationMark = organizationAccount
            && connectorBrandMark(organizationAccount.connectorType, words({ connectorType: organizationAccount.connectorType, eventTypes: [] }).connector);
          const none = !organizationAccount && sources.length === 0 && requests.length === 0;
          return <li className="sidekick-wake-trigger" key={trigger.key}>
            {trigger.icon}
            <div className="sidekick-wake-trigger-copy">
              <span>{trigger.summary}</span>
              {listensFor && !none && <ul aria-label={`Accounts for ${trigger.summary}`} className="sidekick-delegates sidekick-wake-accounts">
                {organizationAccount && <li key="organization">
                  <span aria-hidden="true" className="sidekick-wake-account-mark">{organizationMark && <ConnectorMark mark={organizationMark} />}</span>
                  <span className="sidekick-delegate-copy">
                    <span>{organizationAccount.name}</span>
                    <small>Organization account</small>
                  </span>
                </li>}
                {sources.map(sourceRow)}
                {requests.map(requestRow)}
              </ul>}
              {listensFor && none && (data
                ? <small className="sidekick-wake-accounts-none">No person’s account lets these events in.</small>
                : loading && <small className="sidekick-wake-accounts-none" role="status">Loading accounts…</small>)}
            </div>
          </li>;
        })}
      </ul>}
    {next}
    {(otherSources.length > 0 || otherRequests.length > 0) && <>
      <h3 className="sidekick-wake-other" id="sidekick-wake-other">Other accounts</h3>
      <p className="sidekick-delegation-disclosure">Allowed or asked for events no trigger above listens for.</p>
      <ul aria-labelledby="sidekick-wake-other" className="sidekick-delegates sidekick-wake-accounts">
        {otherSources.map(sourceRow)}
        {otherRequests.map(requestRow)}
      </ul>
    </>}
  </section>;
}
