import { AutomationAttentionReasonSchema } from "@rally/contracts";
import type { AutomationAttentionReason, AutomationSummary } from "@rally/contracts";

import { SIDEBAR_LIST_LIMIT } from "../services/sidebar-reads";

/**
 * The reads of the content-free `automation_directory` projection that more than
 * one caller needs: the attention parse, and the sidebar's automation list.
 *
 * Here rather than beside either caller because the automation RPC surface and
 * the socket layer's sidebar push read the same rows, and both have to agree on
 * how a stored `attention_code` becomes a contract reason.
 */

/**
 * The stored attention code as the contract spells it.
 *
 * `attention_code` is a free `TEXT` column — the cutover and the agent both
 * write it — so the value is parsed rather than asserted on the way out. The
 * write path below admits only the contract's reasons, which is why this can
 * be strict: a row outside them is a projection that should never have been
 * accepted, and every caller of this hands its rows to the same schema at the
 * route or socket boundary a moment later anyway.
 */
export function automationAttention(code: string | null): AutomationAttentionReason | null {
  return code === null ? null : AutomationAttentionReasonSchema.parse(code);
}

/**
 * The automations the sidebar opens with, read straight from this object.
 *
 * The REST list reconciles each automation's email route against the Global
 * registry before answering. That is a network call, and this runs on the
 * socket handler's single thread with the directory read beside it, so the
 * address is served as stored and reconciled by the next `automations`
 * refresh. No sidebar row renders it. `sidebar-reads.ts` holds the reasoning
 * along with the statement both callers use.
 */
export function listSidebarAutomations(
  storage: DurableObjectStorage,
  workspaceId: string,
  userId: string,
): AutomationSummary[] {
return storage.sql.exec<{
  automation_id: string;
  lifecycle: "draft" | "activating" | "active" | "paused";
  title: string;
  description: string;
  scope: "personal" | "workspace";
  next_run_at: number | null;
  attention_code: string | null;
  projected_at: number;
}>(`SELECT automation_id, lifecycle, title, description, scope, next_run_at,
          attention_code, projected_at
      FROM automation_directory
     WHERE workspace_id = ? AND lifecycle <> 'deleted'
       AND (scope = 'workspace' OR author_user_id = ?)
     ORDER BY title COLLATE NOCASE, automation_id
     LIMIT ?`, workspaceId, userId, SIDEBAR_LIST_LIMIT).toArray().map((row) => ({
  id: row.automation_id,
  name: row.title || "New automation",
  description: row.description,
  emailAddress: null,
  scope: row.scope,
  status: row.lifecycle === "draft"
    ? "draft"
    : row.lifecycle === "paused"
      ? "paused"
      : row.attention_code ? "error" : "active",
  attention: automationAttention(row.attention_code),
  nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
  lastRunAt: null,
  updatedAt: new Date(row.projected_at).toISOString(),
  updateAvailable: false,
}));
}
