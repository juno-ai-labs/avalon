import type { Region } from "@rally/contracts";

import type { Env } from "../env";
import { escapeHtml, sendResendEmail, singleLine } from "./resend";
import { conversationCanonicalUrl } from "./conversation-link-service";

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
  workspaceId: string;
  workstreamId: string;
  substreamId?: string;
  workstreamTitle: string;
  workstreamObjective: string;
  /** The work stream has no settled name yet; do not print the placeholder. */
  titleIsProvisional: boolean;
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
  const workstreamUrl = await conversationCanonicalUrl(env, {
    region: input.region, workspaceId: input.workspaceId, parentId: input.workstreamId,
  });
  // A Thread or Breakout has no link now that no surface opens one; an email
  // that could only point at nothing is not sent.
  if (!workstreamUrl) return "skipped";
  const replyTo = input.workstreamEmailAddress?.trim() || null;
  // A work stream created from the composer has no name yet — its title is the
  // opening message's first line, cut at 180 characters, and the naming pass
  // runs after this notification is enqueued. Quoting it names the room by a
  // sentence fragment and then prints the same words again as the objective, so
  // the unnamed case says what actually happened instead: somebody started
  // something and put you in it. The opening line still appears, once, below.
  const subject = input.titleIsProvisional
    ? `${actorName} started a thread with you`
    : `${actorName} added you to ${workstreamTitle}`;
  const opening = input.titleIsProvisional
    ? `${actorName} started a thread in ${workspaceName} and added you to it.`
    : `${actorName} added you to "${workstreamTitle}" in ${workspaceName}.`;
  const text = [
    recipientName ? `Hi ${firstName(recipientName)},` : "You were added to a thread in Rally.",
    "",
    opening,
    ...(objective ? ["", objective] : []),
    "",
    `Open in Rally: ${workstreamUrl}`,
    ...(replyTo ? ["", "Reply to this email to post into the thread."] : []),
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
      titleIsProvisional: input.titleIsProvisional,
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

/** "Dana Okafor" is how a record reads; "Dana" is how a person is greeted. */
function firstName(value: string): string {
  return value.split(" ")[0] || value;
}

function participantAddedEmailHtml(input: {
  actorName: string;
  workspaceName: string;
  workstreamTitle: string;
  recipientName: string;
  objective: string;
  workstreamUrl: string;
  replyTo: string | null;
  titleIsProvisional: boolean;
}): string {
  const actorName = escapeHtml(input.actorName);
  const workspaceName = escapeHtml(input.workspaceName);
  const workstreamTitle = escapeHtml(input.workstreamTitle);
  const recipientName = escapeHtml(input.recipientName);
  const objective = escapeHtml(input.objective);
  const workstreamUrl = escapeHtml(input.workstreamUrl);
  // The heading already says it when there is no name to greet, so the fallback
  // is dropped rather than printed two lines under itself.
  const greeting = recipientName ? `Hi ${escapeHtml(firstName(input.recipientName))},<br>` : "";
  const heading = input.titleIsProvisional
    ? "You're in a new thread"
    : "You were added to a thread";
  const opening = input.titleIsProvisional
    ? `<strong style="color:#f2f3ec">${actorName}</strong> started a thread in ${workspaceName} and added you to it.`
    : `<strong style="color:#f2f3ec">${actorName}</strong> added you to <strong style="color:#f2f3ec">${workstreamTitle}</strong> in ${workspaceName}.`;
  const summary = objective
    ? `<tr><td style="padding:18px 20px;background:#20241e;border-left:3px solid #CEDC00;border-radius:8px;font-size:15px;line-height:1.55;color:#e2e5dc">${objective}</td></tr>`
    : "";
  const reply = input.replyTo
    ? `<tr><td style="padding-top:18px;font-size:13px;line-height:1.6;color:#8f948b">Reply to this email to post into the thread.</td></tr>`
    : "";
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Rally</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:26px;line-height:1.25;color:#f2f3ec">${heading}</h1></td></tr>
          <tr><td style="padding-bottom:18px;font-size:15px;line-height:1.6;color:#c9ccc4">${greeting}${opening}</td></tr>
          ${summary}
          <tr><td style="padding-top:28px"><a href="${workstreamUrl}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Open in Rally</a></td></tr>
          ${reply}
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
