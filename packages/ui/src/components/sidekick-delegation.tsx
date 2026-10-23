import type { SidekickDelegatesResult } from '@rally/contracts';
import { Avatar, Button } from './primitives';

export const SIDEKICK_DELEGATION_EXPLANATION = 'This Sidekick can act as the people listed here, using their current access to carry out its work.';
/** The host owns reads, acknowledgements and uncertain outcomes. No optimistic consent. */
export function SidekickDelegationList({ data, loading, offline, needsRefresh, pending, onSetOwn, onRefresh }: {
  data?: SidekickDelegatesResult | undefined;
  loading: boolean;
  offline: boolean;
  needsRefresh: boolean;
  pending: boolean;
  onSetOwn: (allowed: boolean) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const reason = offline ? 'Go online to change delegation.' : needsRefresh ? 'Refresh delegation before making another change.' : undefined;
  const creatorNotAllowed = data?.creator && !data.delegates.some((delegate) => delegate.userId === data.creatorUserId);
  const person = (identity: NonNullable<SidekickDelegatesResult['creator']>, eligible: boolean | null) => <>
    <Avatar member={{ id: identity.userId, name: identity.displayName, email: '', timezone: '',
      ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}), presentation: identity.presentation ?? null }} size="small" />
    <span className="sidekick-delegate-copy"><span>{identity.displayName}
      {identity.userId === data?.you.userId && <small>You</small>}
      {identity.userId === data?.creatorUserId && <small>Creator</small>}
    </span><small>{eligible === null ? 'Not allowed' : eligible ? 'Available' : 'Unavailable — restore Organization membership or Sidekick access'}</small></span>
  </>;
  return <section className="sidekick-profile-section sidekick-delegation" aria-labelledby="sidekick-delegation-heading">
    <h2 id="sidekick-delegation-heading">Delegation allowed</h2>
    <p className="sidekick-delegation-disclosure">{SIDEKICK_DELEGATION_EXPLANATION}</p>
    {offline && <p role="status">Offline · {data ? 'Showing the last confirmed list.' : 'Connect to load delegation.'}</p>}
    {!data && loading && <p role="status">Loading delegation…</p>}
    {data && <>
      {data.delegates.length === 0 && <p>No one currently allows this Sidekick to act as them</p>}
      {data.delegates.length > 0 && <ul className="sidekick-delegates" aria-label="People allowed to act">
        {data.delegates.map((delegate) => <li key={delegate.userId}>
          {person(delegate, delegate.eligible)}

        </li>)}
      </ul>}
      <Button disabledReason={reason ?? (pending ? 'Waiting for your delegation change.' : undefined)}
        onClick={() => onSetOwn(!data.you.allowed)}>
        {pending ? 'Saving…' : data.you.allowed ? 'Stop allowing this Sidekick to act as me' : 'Allow this Sidekick to act as me'}
      </Button>
      {creatorNotAllowed && data.creator && <div className="sidekick-delegate-inactive">{person(data.creator, null)}</div>}
    </>}
    {needsRefresh && <Button disabledReason={offline ? 'Go online to refresh delegation.' : undefined} onClick={onRefresh}>Refresh delegation</Button>}
  </section>;
}
