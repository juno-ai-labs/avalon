import type { Region } from "@rally/contracts/regions";
import { addWorkspaceTarget } from "@rally/contracts";
import type { Env } from "../env";
import { escapeHtml, sendEmail, singleLine } from "./email";

const EMAIL_ERRORS = {
  unavailable: { code: "invitation_email_unavailable", message: "Invitation email is temporarily unavailable" },
  failed: { code: "invitation_email_failed", message: "The invitation email could not be sent" },
};

export interface WorkspaceInvitationResolutionEmail {
  id: string;
  outcome: "accepted" | "declined";
  recipientEmail: string;
  workspaceName: string;
  workspaceId: string;
  inviteeEmail: string;
  inviteeName?: string;
  role: "admin" | "member";
  region: Region;
}

export type InvitationEmailDelivery = "sent" | "skipped";

/** Someone added to an Organization, who is a member as of this email: nothing to accept. */
export interface WorkspaceMemberAddedEmail {
  workspaceId: string;
  userId: string;
  /** When this adding happened: someone removed and added again is told again. */
  addedAt: string;
  recipientEmail: string;
  workspaceName: string;
  inviterName: string;
  role: "owner" | "admin" | "member";
  region: Region;
  openUrl: string;
}

/**
 * Tell a person they were added to an Organization. They are a member when
 * this is sent; the link only opens Rally, where signing in with this address
 * reaches the account the adding made for them.
 */
export async function sendWorkspaceMemberAddedEmail(
  env: Env,
  added: WorkspaceMemberAddedEmail,
  send?: (message: EmailMessageBuilder) => Promise<EmailSendResult>,
): Promise<InvitationEmailDelivery> {
  const roleLabel = added.role === "owner" ? "an owner" : added.role === "admin" ? "an administrator" : "a member";
  const subject = `${singleLine(added.inviterName)} added you to ${singleLine(added.workspaceName)} on Rally`;
  const text = [
    `${added.inviterName} added you to ${added.workspaceName} as ${roleLabel}.`,
    "",
    `Open Rally and sign in with ${added.recipientEmail}: ${added.openUrl}`,
    "",
    "If you were not expecting this, you can leave the Organization from Settings in Rally.",
  ].join("\n");
  const workspaceName = escapeHtml(added.workspaceName);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
  </head>
  <body style="margin:0;background:#ffffff;color:#141414;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;table-layout:fixed;overflow-wrap:anywhere;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:28px">
          <tr><td><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:10px;vertical-align:middle"><img src="https://rallywith.ai/brand/rally-mark-email.png" width="32" height="32" alt="" style="display:block;border:0"></td><td style="font-size:18px;font-weight:700;color:#141414;vertical-align:middle">Rally</td></tr></table></td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:28px;line-height:1.2;color:#141414">You're in ${workspaceName}</h1></td></tr>
          <tr><td style="font-size:16px;line-height:1.6;color:#3d3d3d">${escapeHtml(added.inviterName)} added you to <strong style="color:#141414">${workspaceName}</strong> as ${escapeHtml(roleLabel)}.</td></tr>
          <tr><td style="padding:28px 0"><a href="${escapeHtml(added.openUrl)}" style="display:inline-block;background:#070707;color:#fcfcfc;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:8px">Open Rally</a></td></tr>
          <tr><td style="font-size:13px;line-height:1.6;color:#696969">Sign in with ${escapeHtml(added.recipientEmail)}.</td></tr>
          <tr><td style="padding-top:24px;font-size:12px;line-height:1.5;color:#696969;border-top:1px solid #e5e5e5">If you were not expecting this, you can leave the Organization from Settings in Rally.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return sendEmail(env, {
    recipientEmail: added.recipientEmail,
    subject,
    html,
    text,
    idempotencyKey: `avalon-workspace-member-added/${added.workspaceId}/${added.userId}/${added.addedAt}`,
    category: "workspace_invitation",
    region: added.region,
    sender: "transactional",
    errors: EMAIL_ERRORS,
  }, send);
}

export async function sendWorkspaceInvitationResolutionEmail(
  env: Env,
  invitation: WorkspaceInvitationResolutionEmail,
  send?: (message: EmailMessageBuilder) => Promise<EmailSendResult>,
): Promise<InvitationEmailDelivery> {
  const actor = singleLine(invitation.inviteeName?.trim() || invitation.inviteeEmail);
  const workspaceName = singleLine(invitation.workspaceName);
  const verb = invitation.outcome === "accepted" ? "accepted" : "declined";
  const roleLabel = invitation.role === "admin" ? "an administrator" : "a member";
  const desktopTarget = addWorkspaceTarget(new URL("rallywithai://settings/members"), {
    region: invitation.region,
    workspaceId: invitation.workspaceId,
  });
  const desktopUrl = new URL("/open", env.PUBLIC_WEB_BASE_URL);
  desktopUrl.hash = new URLSearchParams({ target: desktopTarget.toString() }).toString();
  const subject = `${actor} ${verb} your invitation to ${workspaceName}`;
  const actorWithEmail = actor.toLowerCase() === invitation.inviteeEmail.toLowerCase()
    ? actor
    : `${actor} (${invitation.inviteeEmail})`;
  const text = [
    `${actorWithEmail} ${verb} your invitation to join ${workspaceName}.`,
    "",
    `They were invited as ${roleLabel}.`,
    "",
    `Open Rally: ${desktopUrl.toString()}`,
  ].join("\n");
  const html = invitationResolutionEmailHtml({
    ...invitation,
    actor,
    roleLabel,
    verb,
    desktopUrl: desktopUrl.toString(),
  });

  return sendEmail(env, {
    recipientEmail: invitation.recipientEmail,
    subject,
    html,
    text,
    idempotencyKey: `avalon-workspace-invitation/${invitation.id}/${invitation.outcome}`,
    category: `workspace_invitation_${invitation.outcome}`,
    region: invitation.region,
    sender: "transactional",
    errors: EMAIL_ERRORS,
  }, send);
}


function invitationResolutionEmailHtml(input: WorkspaceInvitationResolutionEmail & {
  actor: string;
  roleLabel: string;
  verb: "accepted" | "declined";
  desktopUrl: string;
}): string {
  const actor = escapeHtml(input.actor);
  const inviteeEmail = escapeHtml(input.inviteeEmail);
  const workspaceName = escapeHtml(input.workspaceName);
  const roleLabel = escapeHtml(input.roleLabel);
  const outcome = input.outcome === "accepted" ? "Invitation accepted" : "Invitation declined";
  const desktopUrl = escapeHtml(input.desktopUrl);
  const actorDescription = input.actor.toLowerCase() === input.inviteeEmail.toLowerCase()
    ? actor
    : `${actor} <span style="color:#696969">(${inviteeEmail})</span>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
  </head>
  <body style="margin:0;background:#ffffff;color:#141414;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;table-layout:fixed;overflow-wrap:anywhere;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:28px">
          <tr><td><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:10px;vertical-align:middle"><img src="https://rallywith.ai/brand/rally-mark-email.png" width="32" height="32" alt="" style="display:block;border:0"></td><td style="font-size:18px;font-weight:700;color:#141414;vertical-align:middle">Rally</td></tr></table></td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:28px;line-height:1.2;color:#141414">${outcome}</h1></td></tr>
          <tr><td style="font-size:16px;line-height:1.6;color:#3d3d3d">${actorDescription} ${input.verb} your invitation to join <strong style="color:#141414">${workspaceName}</strong>.</td></tr>
          <tr><td style="padding-top:24px;font-size:13px;line-height:1.6;color:#696969;border-top:1px solid #e5e5e5">They were invited as ${roleLabel}.</td></tr>
          <tr><td style="padding-top:28px"><a href="${desktopUrl}" style="display:inline-block;background:#070707;color:#fcfcfc;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:8px">Open Rally</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
