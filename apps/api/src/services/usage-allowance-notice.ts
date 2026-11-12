import { addWorkspaceTarget } from "@rally/contracts/workspace-target";

import type { Env } from "../env";
import { logStructuredEvent, diagnosticErrorCode } from "../observability/logger";
import { escapeHtml, sendEmail, singleLine } from "./email";

const EMAIL_ERRORS = {
  unavailable: { code: "usage_allowance_email_unavailable", message: "Usage allowance email is temporarily unavailable" },
  failed: { code: "usage_allowance_email_failed", message: "The usage allowance email could not be sent" },
};

/**
 * Tell an Organization's owners and administrators, once per allowance week,
 * that its included usage is spent and overages are off.
 *
 * A refusal in a Chat shows its own card, but one in a Sidekick or a background
 * agent is seen by nobody: the work stops and nothing says why. Only an owner or
 * administrator can turn overages on, so they are the ones told.
 *
 * "Once" is the delivery key, `usage_allowance_exhausted/<org>/<week>/<user>`,
 * in the shared sender's durable receipts: a later refusal that week finds the
 * receipt and sends nothing, and `review` delivery claims the key before
 * sending, so two refusals at the same moment do not both send. Never throws:
 * the caller is refusing work, and a failed email must not change that answer.
 */
export async function noticeUsageAllowanceExhausted(
  env: Env,
  input: { workspaceId: string; weekStart: string; resetsAt: string },
): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT person.id AS user_id, person.email AS email, person.name AS name, workspace.name AS workspace_name
         FROM workspace_members member
         JOIN users person ON person.id = member.user_id
         JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = ? AND member.status = 'active'
          AND member.access_class = 'member' AND member.role IN ('owner', 'admin')`,
    ).bind(input.workspaceId).all<{ user_id: string; email: string; name: string | null; workspace_name: string }>();
    for (const admin of results) {
      try {
        await sendEmail(env, usageAllowanceEmail(env, input, admin));
      } catch (error) {
        logStructuredEvent(env, "warn", "usage_allowance_email_failed", {
          workspace_id: input.workspaceId,
          error_code: diagnosticErrorCode(error, "usage_allowance_email_failed"),
        });
      }
    }
  } catch (error) {
    logStructuredEvent(env, "warn", "usage_allowance_email_failed", {
      workspace_id: input.workspaceId,
      error_code: diagnosticErrorCode(error, "usage_allowance_recipients_unavailable"),
    });
  }
}

export function usageAllowanceEmail(
  env: Pick<Env, "AVALON_REGION" | "PUBLIC_WEB_BASE_URL">,
  input: { workspaceId: string; weekStart: string; resetsAt: string },
  admin: { user_id: string; email: string; name: string | null; workspace_name: string },
) {
  const workspaceName = singleLine(admin.workspace_name);
  const firstName = singleLine(admin.name ?? "").split(" ")[0] ?? "";
  const target = addWorkspaceTarget(new URL("rallywithai://settings/workspace"), {
    region: env.AVALON_REGION,
    workspaceId: input.workspaceId,
  });
  const settingsUrl = new URL("/open", env.PUBLIC_WEB_BASE_URL);
  settingsUrl.hash = new URLSearchParams({ target: target.toString() }).toString();
  const resets = new Date(input.resetsAt).toUTCString();
  const subject = `${workspaceName} has used this week's included Rally usage`;
  const paragraphs = [
    `${workspaceName} has used its included usage for this week, and overage billing is off.`,
    "Until that changes, Rally will not answer in Chats, and Sidekicks and background agents stop when they next need a model.",
    `To keep working, turn on overage billing in Settings, Organization, Usage. Otherwise usage resumes when the allowance resets on ${resets}.`,
  ];
  const text = [firstName ? `Hi ${firstName},` : "Hi,", "", ...paragraphs.flatMap((line) => [line, ""]),
    `Open usage settings: ${settingsUrl.toString()}`].join("\n");
  const html = [
    `<p>${escapeHtml(firstName ? `Hi ${firstName},` : "Hi,")}</p>`,
    ...paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(settingsUrl.toString())}">Open usage settings</a></p>`,
  ].join("\n");
  return {
    recipientEmail: admin.email,
    subject,
    html,
    text,
    idempotencyKey: `usage_allowance_exhausted/${input.workspaceId}/${input.weekStart}/${admin.user_id}`,
    category: "usage_allowance_exhausted",
    region: env.AVALON_REGION,
    sender: "notification" as const,
    durableDelivery: "review" as const,
    errors: EMAIL_ERRORS,
  };
}
