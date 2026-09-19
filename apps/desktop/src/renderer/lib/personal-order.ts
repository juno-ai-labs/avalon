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
 * Whether two references name the same container.
 *
 * One implementation, used by every reader of the ordering, because the answer
 * is not uniform across the kinds: a Space's Channels and a Channel's Breakouts
 * are addressed by a kind *and* an id, and the Organization's Spaces by the
 * kind alone — a session is signed into one Organization, so there is nothing
 * there to tell apart. A caller writing the comparison itself would either read
 * an id that is not there or invent one, which is how one arrangement comes to
 * be filed under two keys.
 */
export function sameContainer(left: OrderedContainer, right: OrderedContainer): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'organization' || right.kind === 'organization' || left.id === right.id;
}

/**
 * What this person last committed for one container, or nothing.
 *
 * The ordering is a list of `{ container, itemIds }` rather than a map, because
 * the key of the two kinds that have one is a *pair*, and a map would have to
 * encode it into a string that every reader parses back. Finding an entry is a
 * scan of a list that holds one row per container this person has ever
 * arranged.
 */
export function storedOrderFor(
  ordering: PersonalOrder | undefined,
  container: OrderedContainer,
): string[] {
  return (ordering ?? []).find((entry) => sameContainer(entry.container, container))?.itemIds ?? [];
}

/** `ids` with `id` lifted out and put back at `index`, which is what one drag or one key press does. */
export function moveWithin(ids: readonly string[], id: string, index: number): string[] {
  const without = ids.filter((candidate) => candidate !== id);
  const bounded = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, bounded), id, ...without.slice(bounded)];
}

/**
 * What a finished drag should commit, or `null` when there is nothing to send.
 *
 * Every hand-arranged list in the app ends a drag with the same three
 * questions, and one of them is easy to get wrong twice: the arrangement has to
 * be compared against **the order the server last confirmed**, never against
 * the one the drag is building. A list rendered mid-drag *is* that arrangement,
 * so a call site that reaches for the list it is drawing compares the drag with
 * itself, concludes nothing moved, and silently drops every drop. That bug was
 * written twice while this feature was being built, which is why the comparison
 * lives here and takes `stored` as its own argument rather than being
 * re-derived at four call sites.
 *
 * `cancelled` is a drag backed out of — Escape, or a release nothing accepted —
 * and must not be the same thing as finishing one.
 */
export function committedOrder(
  arranged: readonly string[] | null,
  stored: readonly string[],
  cancelled: boolean,
): string[] | null {
  if (arranged === null || cancelled) return null;
  return arranged.join() === stored.join() ? null : [...arranged];
}
