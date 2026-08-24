import { z } from "zod";

import type { ContentAudience } from "./audience-containment";

/**
 * The columns that decide who a connector activity may reach, under the names
 * D1 returns them. Every one is optional so a caller holding a narrower row
 * projection passes it without a cast.
 */
export interface ActivityVisibilityRow {
  connection_scope?: unknown;
  connection_owner_user_id?: unknown;
  target_user_ids_json?: unknown;
  visibility_json?: unknown;
}

/**
 * Who an activity may be shown to, or null when it is unrestricted.
 *
 * The one implementation of a rule several surfaces depend on: the activity
 * queue consults it before letting a personal automation see an activity,
 * suggestion batching partitions on it, and origin attachment refuses anything
 * it answers non-null for. A second copy of this logic is how one surface ends
 * up broadcasting what another correctly withheld — the case that matters is a
 * message in a private Slack channel, which arrives on the *workspace* Slack
 * connection and carries its restriction in `visibility` rather than in the
 * connection's scope.
 *
 * An empty array is meaningfully different from null: it means "restricted to
 * nobody", which `workspaceAutomationAllowed: false` asserts.
 */
export function restrictedActivityUserIds(activity: ActivityVisibilityRow): string[] | null {
  if (activity.connection_scope === "personal") {
    return typeof activity.connection_owner_user_id === "string" && activity.connection_owner_user_id
      ? [activity.connection_owner_user_id]
      : [];
  }
  const explicitTargets = parseStrings(activity.target_user_ids_json);
  const visibility = parseRecord(activity.visibility_json);
  if (explicitTargets.length > 0) return explicitTargets;
  for (const candidate of [visibility.targetUserIds, visibility.allowedUserIds]) {
    const restricted = z.array(z.string()).safeParse(candidate);
    if (restricted.success && restricted.data.length > 0) return [...new Set(restricted.data)];
  }
  return visibility.workspaceAutomationAllowed === false ? [] : null;
}

export function activityContentAudience(activity: ActivityVisibilityRow): ContentAudience | null {
  const restrictedUserIds = restrictedActivityUserIds(activity);
  if (restrictedUserIds === null) return { scope: "workspace" };
  return restrictedUserIds.length > 0
    ? { scope: "users", userIds: restrictedUserIds }
    : null;
}

/**
 * Whether an activity may be shown to everyone who can see the work stream it
 * would be attached to.
 *
 * Deliberately stricter than "may this member see it". A resource row is listed
 * to every member of the work stream it hangs off and is broadcast over
 * `resource_attached` — `WORKSTREAM_RESOURCES_SQL` applies no connection-scope
 * filter — so an activity restricted to *anyone*, including to the very member
 * starting the work, cannot become one without widening it.
 */
export function activityIsWorkspaceVisible(activity: ActivityVisibilityRow): boolean {
  return restrictedActivityUserIds(activity) === null;
}

function parseStrings(value: unknown): string[] {
  const parsed = z.array(z.string()).safeParse(parseJson(value));
  return parsed.success ? parsed.data : [];
}

function parseRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
