import type { SidekickDelegatesResult } from '@rally/contracts';
import { Avatar, Button } from './primitives';

export const SIDEKICK_DELEGATION_EXPLANATION = 'This Sidekick can act as the people listed here, using their current access to carry out its work.';
export const SIDEKICK_DELEGATION_DISCLOSURE = 'Managers can change its configured work. Results may be shared with its configured destinations and everyone who can read its existing Sidekick history. Allowing access adds no readers. Withdrawing stops future use of your access; completed work remains in shared history.';

export function SidekickDelegationDisclosure(): React.JSX.Element {
  return <div className="sidekick-delegation-disclosure"><p>{SIDEKICK_DELEGATION_EXPLANATION}</p><p>{SIDEKICK_DELEGATION_DISCLOSURE}</p></div>;
}

/** The host owns reads, acknowledgements and uncertain outcomes. No optimistic consent. */
export function SidekickDelegationList({ data, loading, offline, needsRefresh, pendingUserIds, onSetOwn, onRemove, onRefresh }: {
  data?: SidekickDelegatesResult | undefined;
  loading: boolean;
  offline: boolean;
  needsRefresh: boolean;
  pendingUserIds: ReadonlySet<string>;
  onSetOwn: (allowed: boolean) => void;
  onRemove: (userId: string) => void;
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
    {data?.you.allowed ? <details className="sidekick-delegation-disclosure"><summary>Configured work and shared history</summary><p>{SIDEKICK_DELEGATION_DISCLOSURE}</p></details>
      : <p className="sidekick-delegation-disclosure">{SIDEKICK_DELEGATION_DISCLOSURE}</p>}
    {offline && <p role="status">Offline · {data ? 'Showing the last confirmed list.' : 'Connect to load delegation.'}</p>}
    {!data && loading && <p role="status">Loading delegation…</p>}
    {data && <>
      {data.delegates.length === 0 && <p>No one currently allows this Sidekick to act as them</p>}
      {data.delegates.length > 0 && <ul className="sidekick-delegates" aria-label="People allowed to act">
        {data.delegates.map((delegate) => <li key={delegate.userId}>
          {person(delegate, delegate.eligible)}
          {data.canManage && delegate.userId !== data.you.userId && <Button
            disabledReason={reason ?? (pendingUserIds.has(delegate.userId) ? 'Waiting for this delegation change.' : undefined)}
            onClick={() => onRemove(delegate.userId)} aria-label={`Remove ${delegate.displayName} from delegation`}>
            {pendingUserIds.has(delegate.userId) ? 'Removing…' : 'Remove'}
          </Button>}
        </li>)}
      </ul>}
      <Button disabledReason={reason ?? (pendingUserIds.has(data.you.userId) ? 'Waiting for your delegation change.' : undefined)}
        onClick={() => onSetOwn(!data.you.allowed)}>
        {pendingUserIds.has(data.you.userId) ? 'Saving…' : data.you.allowed ? 'Stop allowing this Sidekick to act as me' : 'Allow this Sidekick to act as me'}
      </Button>
      {creatorNotAllowed && data.creator && <div className="sidekick-delegate-inactive">{person(data.creator, null)}</div>}
    </>}
    {needsRefresh && <Button disabledReason={offline ? 'Go online to refresh delegation.' : undefined} onClick={onRefresh}>Refresh delegation</Button>}
  </section>;
}
