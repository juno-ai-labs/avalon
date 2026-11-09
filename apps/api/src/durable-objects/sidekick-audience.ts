/**
 * Who a Sidekick's instructions may be offered to: the one audience rule
 * `SidekickDO` applies to a skill read and the Channel rail applies to what it
 * lists. `docs/automation-lifecycle.md` owns it.
 */

export interface SidekickAudienceSubject {
  scope: string;
  authorUserId: string;
  /** Null on a directory row that has not been republished since it gained the column. */
  runAsUserId: string | null;
}

export interface SidekickAudience {
  /** The person asking; null for a read on nobody's behalf. */
  principalUserId: string | null;
  conversationParentId: string;
  audienceScope: "personal" | "workspace";
  /** The receiving conversation's participants. */
  audienceUserIds: readonly string[];
}

/**
 * A personal Sidekick is offered only where everyone present is its author or
 * whoever it runs as, never in an Organization-wide conversation; an
 * Organization Sidekick anywhere.
 */
export function sidekickAudienceAllows(sidekick: SidekickAudienceSubject, audience: SidekickAudience): boolean {
  if (sidekick.scope === "personal") {
    const people = new Set([sidekick.authorUserId, sidekick.runAsUserId]);
    if (audience.principalUserId === null || !people.has(audience.principalUserId)
      || audience.audienceScope === "workspace" || audience.audienceUserIds.length === 0
      || audience.audienceUserIds.some((id) => !people.has(id))) return false;
  }
  return true;
}
