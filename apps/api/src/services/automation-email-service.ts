import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { shouldSuppressAutomationResult } from "./slack-agent-service";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const MAX_RESEND_RESPONSE_BYTES = 32_000;
const MAX_RESULT_LENGTH = 40_000;

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
  const target = await env.DB.prepare(
    `SELECT dt.id, dt.email_address, dt.last_delivered_workstream_id
     FROM automation_delivery_targets dt
     JOIN workspace_members wm ON wm.workspace_id = dt.workspace_id AND wm.user_id = dt.user_id
       AND wm.status = 'active'
     WHERE dt.workspace_id = ? AND dt.automation_subscription_id = ?
       AND dt.target_type = 'email' AND dt.status = 'active'
       AND dt.email_address IS NOT NULL`,
  ).bind(input.workspaceId, input.automationSubscriptionId).first<EmailDeliveryTargetRow>();
  if (!target) return "skipped";
  if (target.last_delivered_workstream_id === input.workstreamId) return "skipped";

  // Local and test traffic must never send transactional email through a
  // developer's production Resend account.
  if (env.APP_ENV !== "production") return "skipped";

  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_NOTIFICATION_FROM_EMAIL?.trim() || env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    await markEmailDeliveryFailed(env, target.id, "Automation result email is not configured");
    throw new ApiError(503, "automation_email_unavailable", "Automation result email is temporarily unavailable");
  }

  const name = singleLine(input.title) || "Avalon automation";
  const subject = input.outcomeStatus === "needs_input" ? `Action needed · ${name}` : name;
  const body = resultBody(input.text);
  const workstreamUrl = `avalon://workstreams/${encodeURIComponent(input.workstreamId)}`;
  const text = [subject, "", body, "", `Open in Avalon: ${workstreamUrl}`].join("\n");

  try {
    const response = await request(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `avalon-automation-result/${target.id}/${input.workstreamId}`,
        "user-agent": "avalon-worker/0.1",
      },
      body: JSON.stringify({
        from,
        to: [target.email_address],
        subject,
        html: resultEmailHtml({ name, subject, body, workstreamUrl }),
        text,
        tags: [
          { name: "category", value: "automation_result" },
          { name: "region", value: env.AVALON_REGION },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const responseBody = await response.text();
    if (!response.ok || responseBody.length > MAX_RESEND_RESPONSE_BYTES) throw new Error("Resend rejected the automation result");
    const parsed = JSON.parse(responseBody) as { id?: unknown };
    if (typeof parsed.id !== "string" || parsed.id.length === 0 || parsed.id.length > 200) {
      throw new Error("invalid Resend response");
    }
  } catch (error) {
    await markEmailDeliveryFailed(env, target.id, error instanceof Error ? error.message : "Automation email delivery failed");
    throw new ApiError(502, "automation_email_failed", "The automation result email could not be sent");
  }

  const at = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE automation_delivery_targets
     SET last_delivered_at = ?, last_delivered_workstream_id = ?, last_error_json = NULL, updated_at = ?
     WHERE id = ?`,
  ).bind(at, input.workstreamId, at, target.id).run();
  return "sent";
}

async function markEmailDeliveryFailed(env: Env, targetId: string, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE automation_delivery_targets SET last_error_json = ?, updated_at = ? WHERE id = ?",
  ).bind(JSON.stringify({ code: "email_delivery_failed", message }), new Date().toISOString(), targetId).run();
}

function resultBody(text: string): string {
  const normalized = text.trim().replace(/\r\n/gu, "\n");
  if (normalized.length <= MAX_RESULT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_RESULT_LENGTH - 1).trimEnd()}…`;
}

function resultEmailHtml(input: { name: string; subject: string; body: string; workstreamUrl: string }): string {
  const heading = escapeHtml(input.subject);
  const name = escapeHtml(input.name);
  const body = escapeHtml(input.body).replace(/\n/gu, "<br>");
  const workstreamUrl = escapeHtml(input.workstreamUrl);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Avalon automation</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:24px;line-height:1.25;color:#f2f3ec">${heading}</h1></td></tr>
          <tr><td style="padding:18px 20px;background:#20241e;border-left:3px solid #CEDC00;border-radius:8px;font-size:15px;line-height:1.6;color:#e2e5dc">${body}</td></tr>
          <tr><td style="padding-top:28px"><a href="${workstreamUrl}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Open in Avalon</a></td></tr>
          <tr><td style="padding-top:18px;font-size:13px;line-height:1.6;color:#8f948b">Sent by your Avalon automation “${name}”. Generated by AI — review important facts and decisions.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
}
