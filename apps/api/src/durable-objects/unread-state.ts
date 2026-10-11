/**
 * Where a reader stands against a conversation's attention waterline.
 *
 * One derivation for every kind that carries the waterline columns — a thread
 * (`channels` / `channel_viewers`), a breakout (`breakouts` /
 * `breakout_viewers`) and a Channel (`spaces` / `space_reads`) — so the three
 * cannot drift apart on what "unread" means.
 *
 * `seen` falls back to `trackingStart` when the reader has no position yet,
 * which is what stops a conversation nobody has opened from reading as unread
 * to everyone who can list it. A manual mark wins over the waterline; without
 * one, the first unread is the ordinal after the read position, clamped to
 * the latest.
 */
export interface UnreadPosition {
  latest: number;
  seen: number | null;
  trackingStart: number;
  manual: number | null;
}

export interface UnreadState {
  readThrough: number;
  firstUnread: number | null;
  hasUnread: boolean;
}

export function unreadState(position: UnreadPosition): UnreadState {
  const readThrough = position.seen ?? position.trackingStart;
  const firstUnread = position.manual
    ?? (position.latest > readThrough ? Math.min(position.latest, readThrough + 1) : null);
  return { readThrough, firstUnread, hasUnread: firstUnread !== null };
}
