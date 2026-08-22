import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  COLOR,
  markdownToEmailHtml,
  markdownToEmailPreheader,
  markdownToEmailText,
  RULE_STYLE,
} from "./email-markdown";
import { escapeHtml, sendResendEmail, singleLine } from "./resend";
import { shouldSuppressAutomationResult } from "./slack-agent-service";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";

const MAX_RESULT_LENGTH = 40_000;

const EMAIL_ERRORS = {
  unavailable: { code: "automation_email_unavailable", message: "Automation result email is temporarily unavailable" },
  failed: { code: "automation_email_failed", message: "The automation result email could not be sent" },
};

export interface AutomationResultEmail {
  workspaceId: string;
  automationSubscriptionId: string;
  workstreamId: string;
  title: string;
  text: string;
  outcomeStatus: "completed" | "needs_input" | "failed" | "stopped";
}

export type AutomationEmailDelivery = "sent" | "skipped";

interface EmailDeliveryTargetRow {
  id: string;
  user_id: string;
  email_address: string;
  last_delivered_workstream_id: string | null;
}

/**
 * Sends one automation run's result to the email address frozen on the
 * subscription when it was saved. The Avalon work stream remains the canonical
 * record; this is an additional copy, so a suppressed or empty result is not
 * mailed and a target that has already received this work stream is skipped.
 */
export async function deliverAutomationResultEmail(
  env: Env,
  input: AutomationResultEmail,
  request: typeof fetch = fetch,
): Promise<AutomationEmailDelivery> {
  if (shouldSuppressAutomationResult(input.text)) return "skipped";
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const target = await env.DB.prepare(
    `SELECT dt.id, dt.user_id, dt.email_address, dt.last_delivered_workstream_id
     FROM automation_delivery_targets dt
     WHERE dt.workspace_id = ? AND dt.automation_subscription_id = ?
       AND dt.target_type = 'email' AND dt.status = 'active'
       AND dt.email_address IS NOT NULL`,
  ).bind(input.workspaceId, input.automationSubscriptionId).first<EmailDeliveryTargetRow>();
  if (!target) return "skipped";
  const membership = await workspaceRegionalDatabase(env).prepare(
    `SELECT 1 FROM workspace_members
      WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
  ).bind(input.workspaceId, target.user_id).first();
  if (!membership) return "skipped";
  if (target.last_delivered_workstream_id === input.workstreamId) return "skipped";

  const name = singleLine(input.title) || "Avalon automation";
  const subject = input.outcomeStatus === "needs_input" ? `Action needed · ${name}` : name;
  const body = resultBody(input.text);
  const workstreamUrl = `avalon://workstreams/${encodeURIComponent(input.workstreamId)}`;

  let delivery;
  try {
    delivery = await sendResendEmail(env, {
      recipientEmail: target.email_address,
      subject,
      html: resultEmailHtml({ name, subject, body, workstreamUrl }),
      text: [subject, "", markdownToEmailText(body), "", `Open in Avalon: ${workstreamUrl}`].join("\n"),
      idempotencyKey: `avalon-automation-result/${target.id}/${input.workstreamId}`,
      category: "automation_result",
      region: env.AVALON_REGION,
      sender: "notification",
      errors: EMAIL_ERRORS,
    }, request);
  } catch (error) {
    // The address is frozen at save time, so a rejected address never fixes
    // itself. Marking the target needs_input surfaces it on the automation
    // rather than repeating the same failure on every run in silence.
    const permanent = error instanceof ApiError && error.details?.retryable === false;
    await recordEmailDeliveryFailure(
      env,
      target.id,
      permanent ? "needs_input" : "active",
      error instanceof Error ? error.message : "Automation email delivery failed",
    );
    throw error;
  }
  // Non-production runs never send, so nothing is recorded as delivered.
  if (delivery === "skipped") return "skipped";

  const at = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE automation_delivery_targets
     SET status = 'active', last_delivered_at = ?, last_delivered_workstream_id = ?,
         last_error_json = NULL, updated_at = ?
     WHERE id = ?`,
  ).bind(at, input.workstreamId, at, target.id).run();
  return "sent";
}

async function recordEmailDeliveryFailure(
  env: Env,
  targetId: string,
  status: "active" | "needs_input",
  message: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE automation_delivery_targets SET status = ?, last_error_json = ?, updated_at = ? WHERE id = ?",
  ).bind(status, JSON.stringify({ code: "email_delivery_failed", message }), new Date().toISOString(), targetId).run();
}

function resultBody(text: string): string {
  const normalized = text.trim().replace(/\r\n/gu, "\n");
  if (normalized.length <= MAX_RESULT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_RESULT_LENGTH - 1).trimEnd()}…`;
}

/**
 * The automation result email.
 *
 * The body is the run's final message, which is Markdown — the same text the
 * work stream shows. A mail client renders none of it, so it goes through the
 * shared `email-markdown` renderer rather than being escaped and line-broken:
 * before that, a briefing arrived as `## Heading` and `**bold**` in the
 * reader's inbox. The shell around it is the digest email's, because the two
 * are the same product arriving the same way.
 */
function resultEmailHtml(input: { name: string; subject: string; body: string; workstreamUrl: string }): string {
  const heading = escapeHtml(input.subject);
  const name = escapeHtml(input.name);
  const workstreamUrl = escapeHtml(input.workstreamUrl);
  // What a phone shows beside the subject: the result's own opening words,
  // which are what decide whether this is read now or later.
  const preheader = escapeHtml(markdownToEmailPreheader(input.body));
  return `<!doctype html>
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;height:100%;background:${COLOR.canvas}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <title>${heading}</title>
  </head>
  <body style="margin:0;padding:0;width:100%;height:100%;background:${COLOR.canvas};color:${COLOR.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLOR.canvas};padding:36px 14px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">

          <tr><td style="padding:0 4px 14px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${COLOR.brand}">Avalon</td>
              <td align="right" style="font-size:12px;color:${COLOR.mutedDeep}">Automation</td>
            </tr></table>
          </td></tr>

          <tr><td style="background:${COLOR.surface};border:1px solid ${COLOR.line};border-radius:16px;padding:32px 30px">

            <h1 style="margin:0 0 18px;font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-.02em;color:${COLOR.ink}">${heading}</h1>

            <hr style="${RULE_STYLE}">

            ${markdownToEmailHtml(input.body)}

            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px"><tr><td style="border-radius:10px;background:${COLOR.brand}">
              <a href="${workstreamUrl}" style="display:inline-block;padding:13px 22px;font-size:14px;font-weight:700;color:${COLOR.onBrand};text-decoration:none">Open in Avalon &rarr;</a>
            </td></tr></table>

          </td></tr>

          <tr><td style="padding:20px 4px 0">
            <p style="margin:0;font-size:11.5px;line-height:1.6;color:${COLOR.mutedDeep}">Sent by your Avalon automation “${name}”. Generated by AI — check anything important.</p>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
