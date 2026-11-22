import { nowIso } from "@rally/db";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { logWarn } from "../observability/logger";

/**
 * Shadow bans (`docs/shadow-ban.md`). The guard itself is a trigger on
 * `workspaces` (migration 0137): it aborts the insert of an Organization whose
 * creator is banned. This module sets the flag and turns that abort into what
 * the caller should be told.
 */

/** The message the trigger aborts with, which D1 carries in its error text. */
const SHADOW_BAN_ABORT = "account_shadow_banned";

export function isShadowBanAbort(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SHADOW_BAN_ABORT);
}

/**
 * What a failed Organization creation is thrown as. A trigger abort becomes a
 * refusal; anything else is returned as it came.
 *
 * A person is told only that the request could not be completed: the ban is a
 * shadow ban, so the account does not learn of it from the app. An operator
 * creating through the engineering MCP is told the reason, since they are the
 * one who can lift it. The log line is the only place a person's refusal is named.
 */
export function shadowBanRefusal(
  env: Env, error: unknown, context: { userId: string; workspaceId: string }, audience: "person" | "operator" = "person",
): unknown {
  if (!isShadowBanAbort(error)) return error;
  logWarn(env, "shadow_ban_refused", { action: "create_organization", user_id: context.userId, workspace_id: context.workspaceId });
  return audience === "operator"
    ? new ApiError(409, SHADOW_BAN_ABORT,
      "The creator's account is shadow banned, so it cannot create an Organization. Lift the ban with set_user_shadow_ban first.")
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
