import { useEffect, useState } from 'react';

import { WORKSTREAM_NAMING_GRACE_MS } from '@avalon/contracts';

/** What every surface that renders a title skeleton needs to decide. */
export interface NameableWorkstream {
  titleStatus: 'naming' | 'automatic' | 'settled';
  /** When the work stream was created — the instant the grace runs from. */
  createdAt?: string;
}

/**
 * Whether to hold this work stream's title for a name that is still coming.
 *
 * `titleStatus` alone is not enough. The API stops reporting `naming` past the
 * grace, but that only applies to a *read*, and every surface that shows a
 * title reads it out of the cache the sockets push into rather than refetching
 * on its own — so a client that held a `naming` row when the rename event
 * failed to reach it would keep that row, and the skeleton, for the session.
 * Worse, nothing later corrects it: the relaxation the server applies is
 * derived at read time and advances no row version, so a fresh directory page
 * carrying `automatic` is dropped by the state ledger as a repeat of what the
 * client already has. The same rule applied to what the client already holds
 * closes that: past the grace the provisional title is the title, whatever the
 * row still says.
 *
 * A creation time that cannot be read is treated as past the grace for the same
 * reason. The skeleton is a promise that a name is seconds away, and a row that
 * cannot say when it was created cannot say the promise is still live — so it
 * shows the title it has rather than shimmering for good.
 */
export function useNamingSkeleton(workstream: NameableWorkstream): boolean {
  const naming = workstream.titleStatus === 'naming';
  const createdAt = Date.parse(workstream.createdAt ?? '');
  const expiresAt = naming && Number.isFinite(createdAt)
    ? createdAt + WORKSTREAM_NAMING_GRACE_MS
    : null;
  const [expired, setExpired] = useState(() => expiresAt === null || Date.now() >= expiresAt);

  useEffect(() => {
    if (expiresAt === null) {
      setExpired(true);
      return undefined;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return undefined;
    }
    // The name almost always arrives long before this fires; the timer exists
    // for the case where nothing arrives at all.
    setExpired(false);
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return naming && !expired;
}
