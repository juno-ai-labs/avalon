import { addWorkspaceTarget } from "@rally/contracts/workspace-target";

import type { Env } from "../env";
import { logStructuredEvent, diagnosticErrorCode } from "../observability/logger";
import { ApiError } from "../lib/api-error";
import { escapeHtml, sendEmail, singleLine } from "./email";
import { publishOrganizationUsage } from "./usage-metering";

const EMAIL_ERRORS = {
  unavailable: { code: "usage_allowance_email_unavailable", message: "Usage allowance email is temporarily unavailable" },
  failed: { code: "usage_allowance_email_failed", message: "The usage allowance email could not be sent" },
};

/**
 * Tell an Organization's owners and administrators, once per allowance week,
 * that its included usage is spent and overages are off. Only they can turn
 * overages on, and a refusal in a Sidekick or background agent shows nobody.
 *
 * Once is the delivery key below in the shared email receipts. The recipients
 * query skips anyone whose key already has a receipt in any state, so after the
 * first send a refusal costs one query and sends nothing; a refusal racing the
 * first send loses the `review` claim, which is the same outcome. Never throws:
 * callers defer it, and a failed email must not change a refusal.
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
         LEFT JOIN email_delivery_receipts receipt
           ON receipt.delivery_key = ? || person.id AND receipt.state <> 'pending'
        WHERE member.workspace_id = ? AND member.status = 'active'
          AND member.access_class = 'member' AND member.role IN ('owner', 'admin')
          AND receipt.delivery_key IS NULL`,
    ).bind(deliveryKeyPrefix(input), input.workspaceId)
      .all<{ user_id: string; email: string; name: string | null; workspace_name: string }>();
    // Recipients left means this is the week's first refusal: tell open
    // windows now, or a rail warning waits until something else rereads usage.
    if (results.length > 0) await publishOrganizationUsage(env, input.workspaceId);
    for (const admin of results) {
      try {
        await sendEmail(env, usageAllowanceEmail(env, input, admin));
      } catch (error) {
        // Another refusal holds the claim, or an earlier attempt's outcome is
        // under review: either way this key is already handled.
        if (error instanceof ApiError && error.diagnosticCode === "email_delivery_review_required") continue;
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

function deliveryKeyPrefix(input: { workspaceId: string; weekStart: string }): string {
  return `usage_allowance_exhausted/${input.workspaceId}/${input.weekStart}/`;
}

export function usageAllowanceEmail(
  env: Pick<Env, "AVALON_REGION" | "PUBLIC_WEB_BASE_URL" | "BROWSER_APP_ORIGIN">,
  input: { workspaceId: string; weekStart: string; resetsAt: string },
  admin: { user_id: string; email: string; name: string | null; workspace_name: string },
) {
  const workspaceName = singleLine(admin.workspace_name);
  const firstName = singleLine(admin.name ?? "").split(" ")[0] ?? "";
  const target = addWorkspaceTarget(new URL("rallywithai://settings/billing"), {
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
    `To keep working, turn on overage billing in Settings, Organization, Billing. Otherwise usage resumes when the allowance resets on ${resets}.`,
  ];
  // `/open` hands off to the desktop app only. The browser app has no
  // Organization-addressed Settings URL, so its link opens Settings in
  // whichever Organization that browser last used; the text names the path.
  const links = [
    { label: "Open usage settings in the Rally app", url: settingsUrl.toString() },
    ...(env.BROWSER_APP_ORIGIN
      ? [{ label: "Open usage settings in your browser", url: new URL("/#/settings?section=billing", env.BROWSER_APP_ORIGIN).toString() }]
      : []),
  ];
  const text = [firstName ? `Hi ${firstName},` : "Hi,", "", ...paragraphs.flatMap((line) => [line, ""]),
    ...links.map((link) => `${link.label}: ${link.url}`)].join("\n");
  const html = [
    `<p>${escapeHtml(firstName ? `Hi ${firstName},` : "Hi,")}</p>`,
    ...paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`),
    ...links.map((link) => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`),
  ].join("\n");
  return {
    recipientEmail: admin.email,
    subject,
    html,
    text,
    idempotencyKey: `${deliveryKeyPrefix(input)}${admin.user_id}`,
    category: "usage_allowance_exhausted",
    region: env.AVALON_REGION,
    sender: "notification" as const,
    durableDelivery: "review" as const,
    errors: EMAIL_ERRORS,
  };
}
