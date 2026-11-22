import { nowIso } from "@rally/db";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { logWarn } from "../observability/logger";

/**
 * Shadow bans (`docs/shadow-ban.md`). The guard itself is two triggers on
 * `workspace_members` (migration 0137): they abort any write that would give a
 * banned account a new relationship with an Organization. This module sets the
 * flag and turns that abort into what each caller should be told.
 */

/** The message the triggers abort with, which D1 carries in its error text. */
const SHADOW_BAN_ABORT = "account_shadow_banned";

export function isShadowBanAbort(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SHADOW_BAN_ABORT);
}

export interface ShadowBanRefusalContext {
  /** What was being tried, as the log names it. */
  action: "create_organization" | "add_member" | "accept_invitation" | "promote_guest" | "claim_share";
  /** The account the write was for. Null when one write covered several: an operator's create with initial members, a share to several addresses. */
  userId: string | null;
  workspaceId: string;
}

/** The one log line a refused write leaves, since the person refused is told nothing that names it. */
export function logShadowBanRefusal(env: Env, context: ShadowBanRefusalContext): void {
  logWarn(env, "shadow_ban_refused", {
    action: context.action, user_id: context.userId, workspace_id: context.workspaceId,
  });
}

/**
 * What a failed membership write is thrown as. A trigger abort becomes a
 * refusal; anything else is returned as it came.
 *
 * A person is told only that the request could not be completed: the ban is a
 * shadow ban, so neither the account nor whoever tried to add it learns of it
 * from the app. An operator acting through the engineering MCP is told the
 * reason, since they are the one who can lift it.
 */
export function shadowBanRefusal(
  env: Env, error: unknown, context: ShadowBanRefusalContext, audience: "person" | "operator" = "person",
): unknown {
  if (!isShadowBanAbort(error)) return error;
  logShadowBanRefusal(env, context);
  return audience === "operator"
    ? new ApiError(409, SHADOW_BAN_ABORT,
      "That account is shadow banned, so it cannot create or join an Organization. Lift the ban with set_user_shadow_ban first.")
    : new ApiError(409, "request_unavailable", "Rally could not complete this request.", undefined, SHADOW_BAN_ABORT);
}

/**
 * Set or lift the ban on one account in this deployment. Setting a ban that is
 * already set keeps its original time, so repeating either call changes nothing.
 */
export async function setUserShadowBan(env: Env, input: { userId: string; banned: boolean }): Promise<{
  userId: string; email: string; shadowBannedAt: string | null;
}> {
  const row = await env.DB.prepare(
    `UPDATE users SET shadow_banned_at = CASE WHEN ?1 = 1 THEN COALESCE(shadow_banned_at, ?2) ELSE NULL END
      WHERE id = ?3
      RETURNING id, email, shadow_banned_at`,
  ).bind(input.banned ? 1 : 0, nowIso(), input.userId).first<{ id: string; email: string; shadow_banned_at: string | null }>();
  if (!row) throw new ApiError(404, "user_not_found", "No user has that ID in this region");
  return { userId: row.id, email: row.email, shadowBannedAt: row.shadow_banned_at };
}
