import type { SpaceSummary } from '@rally/contracts';
import { compareAlphabeticalName } from '@rally/ui/lib/alphabetical';
import { useMemo } from 'react';

type SpaceChoice = { id: string; name: string; systemRole: SpaceSummary['systemRole'] };

/**
 * Spaces as every Space picker offers them: General first and named **All**,
 * the name the sidebar's first pill gives it, then the rest A–Z. General holds
 * every Channel, so a picker that starts on its first choice starts there.
 */
export function spaceChoices<T extends SpaceChoice>(spaces: readonly T[]): T[] {
  return spaces
    .map((space) => space.systemRole === 'general' ? { ...space, name: 'All' } : space)
    .sort((left, right) => Number(right.systemRole === 'general') - Number(left.systemRole === 'general')
      || compareAlphabeticalName(left, right));
}

/** `spaceChoices` for a component: every Space picker reads its list through this. */
export function useSpaceChoices<T extends SpaceChoice>(spaces: readonly T[]): T[] {
  return useMemo(() => spaceChoices(spaces), [spaces]);
}
