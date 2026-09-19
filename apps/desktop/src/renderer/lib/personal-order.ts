import type { OrderedContainer, PersonalOrder } from '@rally/contracts';

/**
 * The one rule every hand-arranged list in the app is drawn by.
 *
 * Three lists are ordered per person — the Organization's Spaces, the Channels
 * placed in one Space, the Breakouts under one Channel — and a fourth, the
 * pinned Channels, is ordered by a table of its own. All four are the same
 * question: given the items I am about to draw and the arrangement this person
 * last committed, in what order do they go.
 *
 * Stored ids first, in stored order; then everything the arrangement never
 * mentioned, in the order the list already had. An id the list does not carry
 * is dropped rather than drawn as a gap — a Space has been left, a Channel
 * archived, a Breakout deleted, or, for a Channel's Breakouts, the server
 * stored an id it was never able to check in the first place.
 *
 * Pure, and the only implementation: an ordering applied one way in one section
 * and another way in the next is how two lists of the same rows come to
 * disagree about which is first.
 */
export function orderByStoredIds<T>(
  items: readonly T[],
  storedIds: readonly string[],
  idOf: (item: T) => string,
): T[] {
  if (storedIds.length === 0) return [...items];
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const ordered = storedIds.flatMap((id) => byId.get(id) ?? []);
  const seen = new Set(ordered.map((item) => idOf(item)));
  return [...ordered, ...items.filter((item) => !seen.has(idOf(item)))];
}

/**
 * What this person last committed for one container, or nothing.
 *
 * The ordering is a list of `{ container, itemIds }` rather than a map, because
 * the key is a *pair* — a kind and an id — and a map would have to encode it
 * into a string that every reader parses back. Finding an entry is a scan of a
 * list that holds one row per container this person has ever arranged.
 */
export function storedOrderFor(
  ordering: PersonalOrder | undefined,
  container: OrderedContainer,
): string[] {
  return (ordering ?? []).find((entry) =>
    entry.container.kind === container.kind && entry.container.id === container.id)?.itemIds ?? [];
}

/** `ids` with `id` lifted out and put back at `index`, which is what one drag or one key press does. */
export function moveWithin(ids: readonly string[], id: string, index: number): string[] {
  const without = ids.filter((candidate) => candidate !== id);
  const bounded = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, bounded), id, ...without.slice(bounded)];
}
