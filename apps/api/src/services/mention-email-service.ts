import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import type { Region } from "@rally/contracts";

import type { Env } from "../env";
import { escapeHtml, sendResendEmail, singleLine } from "./resend";
import { conversationCanonicalUrl } from "./conversation-link-service";

const MAX_MESSAGE_EXCERPT_LENGTH = 320;

const EMAIL_ERRORS = {
  unavailable: { code: "mention_email_unavailable", message: "Mention email is temporarily unavailable" },
  failed: { code: "mention_email_failed", message: "The mention email could not be sent" },
};

export interface WorkstreamMentionEmail {
  /** The Canvas or Sidekick link, when the caller already resolved it. */
  url?: string;
  messageId: string;
  recipientUserId: string;
  recipientEmail: string;
  recipientName: string;
  authorName: string;
  workspaceName: string;
  workspaceId: string;
  workstreamId: string;
  substreamId?: string;
  workstreamTitle: string;
  workstreamEmailAddress: string | null;
  messageText: string;
  region: Region;
}

export type MentionEmailDelivery = "sent" | "skipped";

export async function sendWorkstreamMentionEmail(
  env: Env,
  input: WorkstreamMentionEmail,
  request: typeof fetch = fetch,
): Promise<MentionEmailDelivery> {
  const authorName = singleLine(input.authorName);
  const workspaceName = singleLine(input.workspaceName);
  const workstreamTitle = singleLine(input.workstreamTitle);
  const recipientName = singleLine(input.recipientName);
  const excerpt = messageExcerpt(input.messageText);
  // A mail client will not linkify `rallywithai://`, and a recipient reading on a
  // phone has no desktop app to hand it to. The canonical HTTPS link is a real
  // link in every client and still ends at the same work stream.
  const workstreamUrl = input.url ?? await conversationCanonicalUrl(env, {
    region: input.region, workspaceId: input.workspaceId, parentId: input.workstreamId,
  });
  // A Thread or Breakout has no link now that no surface opens one; an email
  // that could only point at nothing is not sent.
  if (!workstreamUrl) return "skipped";
  const replyTo = input.workstreamEmailAddress?.trim() || null;
  const subject = `${authorName} mentioned you in ${workstreamTitle}`;
  const text = [
    recipientName ? `Hi ${recipientName},` : "You were mentioned in Rally.",
    "",
    `${authorName} mentioned you in "${workstreamTitle}" in ${workspaceName}.`,
    ...(excerpt ? ["", `"${excerpt}"`] : []),
    "",
    `Open in Rally: ${workstreamUrl}`,
    ...(replyTo ? ["", "Reply to this email to continue the thread."] : []),
  ].join("\n");

  return sendResendEmail(env, {
    recipientEmail: input.recipientEmail,
    subject,
    html: mentionEmailHtml({
      authorName,
      workspaceName,
      workstreamTitle,
      recipientName,
      excerpt,
      workstreamUrl,
      replyTo,
    }),
    text,
    idempotencyKey: `avalon-workstream-mention/${input.messageId}/${input.recipientUserId}`,
    category: "workstream_mention",
    region: input.region,
    ...(replyTo ? { replyTo } : {}),
    sender: "notification",
    errors: EMAIL_ERRORS,
  }, request);
}

/**
 * The quoted line a mention email carries.
 *
 * A citation is reduced first, for the reason the `person:` / `person://` strip
 * beside it already exists: this quotes an agent's message text, and every
 * internal syntax in it — a mention's UUID, a `resource://` target, a bare
 * `[^1]` — is something a mail client shows verbatim.
 *
 * Without its source list, and for two reasons. This excerpt is HTML-escaped
 * into a `<td>` and quoted into the plain-text body, so a Markdown source list
 * would arrive as literal syntax either way. And it is *one line*: `singleLine`
 * below would flatten a bibliography into the quote, where it competes with the
 * length budget — truncating mid-entry on a long message and doubling the
 * quote on a short one. A "you were mentioned" excerpt wants the sentence, not
 * the sources.
 */
function messageExcerpt(value: string): string {
  const normalized = singleLine(rewriteMessageAsPlainText(value, { sources: "none" }));
  if (normalized.length <= MAX_MESSAGE_EXCERPT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_MESSAGE_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function mentionEmailHtml(input: {
  authorName: string;
  workspaceName: string;
  workstreamTitle: string;
  recipientName: string;
  excerpt: string;
  workstreamUrl: string;
  replyTo: string | null;
}): string {
  const authorName = escapeHtml(input.authorName);
  const workspaceName = escapeHtml(input.workspaceName);
  const workstreamTitle = escapeHtml(input.workstreamTitle);
  const recipientName = escapeHtml(input.recipientName);
  const excerpt = escapeHtml(input.excerpt);
  const workstreamUrl = escapeHtml(input.workstreamUrl);
  const greeting = recipientName ? `Hi ${recipientName},` : "You were mentioned in Rally.";
  const quote = excerpt
    ? `<tr><td style="padding:18px 20px;background:#20241e;border-left:3px solid #CEDC00;border-radius:8px;font-size:15px;line-height:1.55;color:#e2e5dc">${excerpt}</td></tr>`
    : "";
  const reply = input.replyTo
    ? `<tr><td style="padding-top:18px;font-size:13px;line-height:1.6;color:#8f948b">Reply to this email to continue the thread.</td></tr>`
    : "";
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Rally</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:26px;line-height:1.25;color:#f2f3ec">You were mentioned</h1></td></tr>
          <tr><td style="padding-bottom:18px;font-size:15px;line-height:1.6;color:#c9ccc4">${greeting}<br><strong style="color:#f2f3ec">${authorName}</strong> mentioned you in <strong style="color:#f2f3ec">${workstreamTitle}</strong> in ${workspaceName}.</td></tr>
          ${quote}
          <tr><td style="padding-top:28px"><a href="${workstreamUrl}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Open in Rally</a></td></tr>
          ${reply}
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
