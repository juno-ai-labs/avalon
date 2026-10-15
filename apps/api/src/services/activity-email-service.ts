import type { Region } from "@rally/contracts";

import type { Env } from "../env";
import { escapeHtml, sendResendEmail, singleLine, type ResendDelivery } from "./resend";

const EMAIL_ERRORS = {
  unavailable: { code: "activity_email_unavailable", message: "Activity email is temporarily unavailable" },
  failed: { code: "activity_email_failed", message: "The Activity email could not be sent" },
};

const MAX_BODY_LENGTH = 320;

/**
 * One Activity row by email: a thread or breakout somebody started, or a run
 * Rally finished, for a person who chose email for that kind. Worded as the
 * sidebar and the push word it, so the three read the same.
 */
export interface ActivityEmail {
  /** The Activity row's own id, so a retried send is one email. */
  itemId: string;
  recipientUserId: string;
  recipientEmail: string;
  workspaceName: string;
  title: string;
  body: string;
  url: string;
  region: Region;
}

export async function sendActivityEmail(
  env: Env,
  input: ActivityEmail,
  request: typeof fetch = fetch,
): Promise<ResendDelivery> {
  const title = singleLine(input.title);
  const workspaceName = singleLine(input.workspaceName);
  const body = excerpt(input.body);
  return sendResendEmail(env, {
    recipientEmail: input.recipientEmail,
    subject: title,
    html: activityEmailHtml({ title, workspaceName, body, url: input.url }),
    text: [title, ...(body ? ["", body] : []), "", `In ${workspaceName}.`, "", `Open in Rally: ${input.url}`].join("\n"),
    idempotencyKey: `rally-activity/${input.itemId}/${input.recipientUserId}`,
    category: "activity",
    region: input.region,
    sender: "notification",
    errors: EMAIL_ERRORS,
  }, request);
}

function excerpt(value: string): string {
  const normalized = singleLine(value);
  if (normalized.length <= MAX_BODY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_BODY_LENGTH - 1).trimEnd()}…`;
}

/** The mention email's card, carrying the Activity row's own words. */
export function activityEmailHtml(input: { title: string; workspaceName: string; body: string; url: string }): string {
  const title = escapeHtml(input.title);
  const workspaceName = escapeHtml(input.workspaceName);
  const url = escapeHtml(input.url);
  const body = input.body
    ? `<tr><td style="padding:18px 20px;background:#20241e;border-left:3px solid #CEDC00;border-radius:8px;font-size:15px;line-height:1.55;color:#e2e5dc">${escapeHtml(input.body)}</td></tr>`
    : "";
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Rally</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:24px;line-height:1.3;color:#f2f3ec">${title}</h1></td></tr>
          <tr><td style="padding-bottom:18px;font-size:15px;line-height:1.6;color:#c9ccc4">In ${workspaceName}.</td></tr>
          ${body}
          <tr><td style="padding-top:28px"><a href="${url}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Open in Rally</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
