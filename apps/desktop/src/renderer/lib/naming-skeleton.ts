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
 * A creation time that is missing or unparsable — the two ways `Date.parse`
 * here returns something non-finite — is treated as past the grace for the same
 * reason. The skeleton is a promise that a name is seconds away, and a row that
 * cannot say when it was created cannot say the promise is still live, so it
 * shows the title it has rather than shimmering for good.
 */
export function useNamingSkeleton(workstream: NameableWorkstream): boolean {
  const naming = workstream.titleStatus === 'naming';
  const createdAt = Date.parse(workstream.createdAt ?? '');
  const expiresAt = naming && Number.isFinite(createdAt)
    ? createdAt + WORKSTREAM_NAMING_GRACE_MS
    : null;
  // The answer is derived from this row's own deadline on every render, and
  // never held in state. The work-stream header stays mounted across work
  // streams by design, so state carried over from the last one would answer for
  // this one until an effect ran after paint — showing a fresh work stream's
  // request text for a frame before the skeleton replaced it, and the reverse
  // for a settled one. The timer below exists only to schedule the re-render at
  // the instant the grace lapses; it decides nothing.
  const [, scheduleExpiryRender] = useState(0);

  useEffect(() => {
    if (expiresAt === null) return undefined;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return undefined;
    // The name almost always arrives long before this fires; the timer exists
    // for the case where nothing arrives at all.
    const timer = setTimeout(() => scheduleExpiryRender((render) => render + 1), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return expiresAt !== null && Date.now() < expiresAt;
}
