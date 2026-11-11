import type { PushNotificationData } from "@rally/contracts/push-notifications";

import type { Env } from "../env";
import { escapeHtml, sendEmail, singleLine, type EmailDelivery } from "./email";
import type { Notice } from "./notification-notice";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

/**
 * The quoted excerpt's length, carried from the mention and participant
 * emails this template replaced (`MAX_MESSAGE_EXCERPT_LENGTH` and
 * `MAX_OBJECTIVE_EXCERPT_LENGTH` in the deleted `apps/api/src/services/mention-email-service.ts`;
 * `git log --diff-filter=D -- <that path>` finds the last revision that held it),
 * not set again here.
 */
const EXCERPT_CHARACTERS = 320;

const EMAIL_ERRORS = {
  unavailable: { code: "notification_email_unavailable", message: "Notification email is temporarily unavailable" },
  failed: { code: "notification_email_failed", message: "The notification email could not be sent" },
};

/**
 * The Settings row each kind is chosen under, named in the footer so the
 * reader knows which switch sends it. A kind with no row (the Thread-era
 * ones) is never allowed on any channel, so it never reaches here.
 */
const SETTING_LABEL: Partial<Record<PushNotificationData["kind"], string>> = {
  mention: "Mentions",
  new_message: "New messages",
  participant_added: "Being added",
  access_granted: "Being added",
  run_finished: "Sidekick runs",
  needs_input: "Sidekick runs",
  artifact_updated: "Pinned Canvas updates",
  access_request: "Access requests",
  access_denied: "Access requests",
  source_request: "Source requests",
  source_approved: "Source requests",
  source_declined: "Source requests",
};

/** Who the email goes to, read now: an inactive member is sent nothing. */
interface Recipient { email: string; name: string; workspaceName: string }

async function recipient(env: Env, notice: Notice): Promise<Recipient | null> {
  const row = await workspaceRegionalDatabase(env).prepare(
    `SELECT person.email AS email, person.name AS name, workspace.name AS workspace_name
       FROM users person JOIN workspace_members member ON member.user_id = person.id AND member.workspace_id = ? AND member.status = 'active'
       JOIN workspaces workspace ON workspace.id = member.workspace_id
      WHERE person.id = ?`,
  ).bind(notice.workspaceId, notice.recipientUserId).first<{ email: string; name: string | null; workspace_name: string }>();
  return row ? { email: row.email, name: row.name ?? "", workspaceName: row.workspace_name } : null;
}

export type NoticeEmailOutcome = { outcome: EmailDelivery } | { outcome: "skipped"; reason: string };

/**
 * The email sink: one template for every kind, its subject the notice's own
 * title (which is per kind), its body the notice's text as a quote, and one
 * button to the notice's link. A notice that carries its own actions (a
 * Sidekick source request's Approve and Decline) gets a button for each in
 * that one's place, and a line saying that opening one answers. Sent through
 * the shared Cloudflare sender, with the intent as its delivery reference.
 */
export async function sendNoticeEmail(env: Env, notice: Notice, send?: (message: EmailMessageBuilder) => Promise<EmailSendResult>): Promise<NoticeEmailOutcome> {
  const to = await recipient(env, notice);
  if (!to) return { outcome: "skipped", reason: "recipient_inactive_or_identity_missing" };
  const title = singleLine(notice.title);
  // What a notice's own actions answer is quoted whole: a person agrees to all of a source's
  // condition, and a cut would have them approve a clause they never saw.
  const excerpt = notice.actions?.length ? singleLine(notice.body) : excerptOf(notice.body);
  const name = singleLine(to.name).split(" ")[0] ?? "";
  const workspaceName = singleLine(to.workspaceName);
  const setting = SETTING_LABEL[notice.kind] ?? "Notifications";
  // "You get", not "you chose": a source request goes by email until the person says otherwise.
  const footer = `You get email for ${setting} in ${workspaceName}. Change it in Rally under Settings, Notifications.`;
  const actions = notice.actions?.length ? notice.actions : null;
  const buttons = actions ?? [{ label: "Open in Rally", url: notice.url }];
  const text = [
    name ? `Hi ${name},` : "Hi,",
    "",
    `${title}.`,
    ...(excerpt ? ["", `"${excerpt}"`] : []),
    "",
    ...buttons.map((button) => `${button.label}: ${button.url}`),
    ...(actions ? ["", ACTIONS_NOTE] : []),
    "",
    footer,
  ].join("\n");
  const outcome = await sendEmail(env, {
    recipientEmail: to.email,
    subject: title,
    html: noticeHtml({ greeting: name ? `Hi ${name},` : "Hi,", title, excerpt, buttons, answers: actions !== null, note: actions ? ACTIONS_NOTE : "", footer }),
    text,
    idempotencyKey: `rally-notice/${notice.workspaceId}/${notice.intentId}`,
    category: `notification_${notice.kind}`,
    region: env.AVALON_REGION,
    sender: "notification",
    durableDelivery: "retry",
    errors: EMAIL_ERRORS,
  }, send);
  return { outcome };
}

/** Under a notice's own actions: each link records the answer when it is opened, with no second step. */
const ACTIONS_NOTE = "Opening a button records your answer. You can also answer in Rally, under Activity.";

function excerptOf(body: string): string {
  const normalized = singleLine(body);
  if (normalized.length <= EXCERPT_CHARACTERS) return normalized;
  return `${normalized.slice(0, EXCERPT_CHARACTERS - 1).trimEnd()}…`;
}

/** A notice's one link is filled. Two answers are drawn alike, so neither reads as the one to press. */
function buttonHtml(button: { label: string; url: string }, filled: boolean): string {
  const style = filled
    ? "background:#CCFF00;color:#11140f;border:1px solid #CCFF00"
    : "background:#181b17;color:#f2f3ec;border:1px solid #5a6054";
  return `<a href="${escapeHtml(button.url)}" style="display:inline-block;${style};text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px;margin:0 10px 10px 0">${escapeHtml(button.label)}</a>`;
}

function noticeHtml(input: { greeting: string; title: string; excerpt: string; buttons: { label: string; url: string }[]; answers: boolean; note: string; footer: string }): string {
  const quote = input.excerpt
    ? `<tr><td style="padding:18px 20px;background:#20241e;border-left:3px solid #CCFF00;border-radius:8px;font-size:15px;line-height:1.55;color:#e2e5dc">${escapeHtml(input.excerpt)}</td></tr>`
    : "";
  const note = input.note
    ? `<tr><td style="padding-top:8px;font-size:13px;line-height:1.6;color:#c9ccc4">${escapeHtml(input.note)}</td></tr>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <!-- At phone width the card's 36px padding left a column of about 260px; a
         client that honours this rule narrows it, and one that strips it keeps the wide layout. -->
    <style>
      @media (max-width: 480px) {
        .rally-notice-outer { padding: 16px 8px !important; }
        .rally-notice-card { padding: 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table class="rally-notice-outer" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table class="rally-notice-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CCFF00">Rally</td></tr>
          <tr><td style="padding-top:18px;font-size:15px;line-height:1.6;color:#c9ccc4">${escapeHtml(input.greeting)}</td></tr>
          <tr><td><h1 style="margin:8px 0 18px;font-size:22px;line-height:1.3;color:#f2f3ec">${escapeHtml(input.title)}</h1></td></tr>
          ${quote}
          <tr><td style="padding-top:28px">${input.buttons.map((button) => buttonHtml(button, !input.answers)).join("")}</td></tr>
          ${note}
          <tr><td style="padding-top:28px;font-size:12px;line-height:1.6;color:#8f948b">${escapeHtml(input.footer)}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
