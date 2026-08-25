import { workstreamCanonicalUrl, type Region } from "@avalon/contracts";

import type { Env } from "../env";
import { escapeHtml, sendResendEmail, singleLine } from "./resend";

const MAX_OBJECTIVE_EXCERPT_LENGTH = 320;

const EMAIL_ERRORS = {
  unavailable: { code: "participant_email_unavailable", message: "Participant email is temporarily unavailable" },
  failed: { code: "participant_email_failed", message: "The participant email could not be sent" },
};

export interface WorkstreamParticipantAddedEmail {
  sourceId: string;
  recipientUserId: string;
  recipientEmail: string;
  recipientName: string;
  actorName: string;
  workspaceName: string;
  workstreamId: string;
  workstreamTitle: string;
  workstreamObjective: string;
  workstreamEmailAddress: string | null;
  region: Region;
}

export type ParticipantEmailDelivery = "sent" | "skipped";

/**
 * Tells somebody, by email, that they were added to a work stream.
 *
 * The fallback half of the same pair a mention uses: the Slack DM is tried
 * first because that is where a linked member already is, and this runs when
 * there is no Slack account to reach. Being added is the one thing that
 * happens to a person in Avalon which they cannot find by looking at what they
 * already have open, so it is worth an inbox.
 */
export async function sendWorkstreamParticipantAddedEmail(
  env: Env,
  input: WorkstreamParticipantAddedEmail,
  request: typeof fetch = fetch,
): Promise<ParticipantEmailDelivery> {
  const actorName = singleLine(input.actorName);
  const workspaceName = singleLine(input.workspaceName);
  const workstreamTitle = singleLine(input.workstreamTitle);
  const recipientName = singleLine(input.recipientName);
  const objective = objectiveExcerpt(input.workstreamObjective);
  // The `rallywithai://` deep link is not linkified by mail clients, and a
  // recipient reading on a phone has no desktop app to hand it to. The
  // canonical HTTPS link is a real link everywhere and ends in the same place.
  const workstreamUrl = workstreamCanonicalUrl(env.PUBLIC_WEB_BASE_URL, input.workstreamId);
  const replyTo = input.workstreamEmailAddress?.trim() || null;
  const subject = `${actorName} added you to ${workstreamTitle}`;
  const text = [
    recipientName ? `Hi ${recipientName},` : "You were added to a work stream in Avalon.",
    "",
    `${actorName} added you to "${workstreamTitle}" in ${workspaceName}.`,
    ...(objective ? ["", objective] : []),
    "",
    `Open in Avalon: ${workstreamUrl}`,
    ...(replyTo ? ["", "Reply to this email to post into the work stream."] : []),
  ].join("\n");

  return sendResendEmail(env, {
    recipientEmail: input.recipientEmail,
    subject,
    html: participantAddedEmailHtml({
      actorName,
      workspaceName,
      workstreamTitle,
      recipientName,
      objective,
      workstreamUrl,
      replyTo,
    }),
    text,
    // Keyed on the participation, not on the person's whole history with the
    // work stream: a re-add after a removal carries a new epoch in `sourceId`
    // and is a genuinely new thing to say.
    idempotencyKey: `avalon-workstream-participant-added/${input.sourceId}/${input.recipientUserId}`,
    category: "workstream_participant_added",
    region: input.region,
    ...(replyTo ? { replyTo } : {}),
    sender: "notification",
    errors: EMAIL_ERRORS,
  }, request);
}

function objectiveExcerpt(value: string): string {
  const normalized = singleLine(value);
  if (normalized.length <= MAX_OBJECTIVE_EXCERPT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_OBJECTIVE_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function participantAddedEmailHtml(input: {
  actorName: string;
  workspaceName: string;
  workstreamTitle: string;
  recipientName: string;
  objective: string;
  workstreamUrl: string;
  replyTo: string | null;
}): string {
  const actorName = escapeHtml(input.actorName);
  const workspaceName = escapeHtml(input.workspaceName);
  const workstreamTitle = escapeHtml(input.workstreamTitle);
  const recipientName = escapeHtml(input.recipientName);
  const objective = escapeHtml(input.objective);
  const workstreamUrl = escapeHtml(input.workstreamUrl);
  const greeting = recipientName ? `Hi ${recipientName},` : "You were added to a work stream in Avalon.";
  const summary = objective
    ? `<tr><td style="padding:18px 20px;background:#20241e;border-left:3px solid #CEDC00;border-radius:8px;font-size:15px;line-height:1.55;color:#e2e5dc">${objective}</td></tr>`
    : "";
  const reply = input.replyTo
    ? `<tr><td style="padding-top:18px;font-size:13px;line-height:1.6;color:#8f948b">Reply to this email to post into the work stream.</td></tr>`
    : "";
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Avalon</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:26px;line-height:1.25;color:#f2f3ec">You were added to a work stream</h1></td></tr>
          <tr><td style="padding-bottom:18px;font-size:15px;line-height:1.6;color:#c9ccc4">${greeting}<br><strong style="color:#f2f3ec">${actorName}</strong> added you to <strong style="color:#f2f3ec">${workstreamTitle}</strong> in ${workspaceName}.</td></tr>
          ${summary}
          <tr><td style="padding-top:28px"><a href="${workstreamUrl}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Open in Avalon</a></td></tr>
          ${reply}
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
