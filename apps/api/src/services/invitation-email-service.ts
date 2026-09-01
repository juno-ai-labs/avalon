import { addWorkspaceTarget } from "@rally/contracts";
import type { Env } from "../env";
import { escapeHtml, sendResendEmail, singleLine } from "./resend";

const EMAIL_ERRORS = {
  unavailable: { code: "invitation_email_unavailable", message: "Invitation email is temporarily unavailable" },
  failed: { code: "invitation_email_failed", message: "The invitation email could not be sent" },
};

export interface WorkspaceInvitationEmail {
  id: string;
  recipientEmail: string;
  workspaceName: string;
  inviterName: string;
  role: "admin" | "member";
  region: "global" | "eu";
  expiresAt: string;
  inviteUrl: string;
}

export interface WorkspaceInvitationResolutionEmail {
  id: string;
  outcome: "accepted" | "declined";
  recipientEmail: string;
  workspaceName: string;
  workspaceId: string;
  inviteeEmail: string;
  inviteeName?: string;
  role: "admin" | "member";
  region: "global" | "eu";
}

export type InvitationEmailDelivery = "sent" | "skipped";

export async function sendWorkspaceInvitationEmail(
  env: Env,
  invitation: WorkspaceInvitationEmail,
  request: typeof fetch = fetch,
): Promise<InvitationEmailDelivery> {
  const roleLabel = invitation.role === "admin" ? "an administrator" : "a member";
  const regionLabel = invitation.region === "eu" ? "European Union" : "Global";
  const expiration = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(invitation.expiresAt));
  const subject = `${singleLine(invitation.inviterName)} invited you to ${singleLine(invitation.workspaceName)} on Avalon`;
  const text = [
    `${invitation.inviterName} invited you to join ${invitation.workspaceName} as ${roleLabel}.`,
    "",
    `Accept the invitation: ${invitation.inviteUrl}`,
    "",
    `This one-time invitation expires ${expiration}.`,
    `Workspace data region: ${regionLabel}.`,
    "",
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");
  const html = invitationEmailHtml({
    ...invitation,
    roleLabel,
    regionLabel,
    expiration,
  });

  return sendResendEmail(env, {
    recipientEmail: invitation.recipientEmail,
    subject,
    html,
    text,
    idempotencyKey: `avalon-workspace-invitation/${invitation.id}`,
    category: "workspace_invitation",
    region: invitation.region,
    sender: "transactional",
    errors: EMAIL_ERRORS,
  }, request);
}

export async function sendWorkspaceInvitationResolutionEmail(
  env: Env,
  invitation: WorkspaceInvitationResolutionEmail,
  request: typeof fetch = fetch,
): Promise<InvitationEmailDelivery> {
  const actor = singleLine(invitation.inviteeName?.trim() || invitation.inviteeEmail);
  const workspaceName = singleLine(invitation.workspaceName);
  const verb = invitation.outcome === "accepted" ? "accepted" : "declined";
  const roleLabel = invitation.role === "admin" ? "an administrator" : "a member";
  const regionLabel = invitation.region === "eu" ? "European Union" : "Global";
  const desktopTarget = addWorkspaceTarget(new URL("rallywithai://settings/workspace"), {
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
    `Workspace data region: ${regionLabel}.`,
    "",
    `Open Rally: ${desktopUrl.toString()}`,
  ].join("\n");
  const html = invitationResolutionEmailHtml({
    ...invitation,
    actor,
    roleLabel,
    regionLabel,
    verb,
    desktopUrl: desktopUrl.toString(),
  });

  return sendResendEmail(env, {
    recipientEmail: invitation.recipientEmail,
    subject,
    html,
    text,
    idempotencyKey: `avalon-workspace-invitation/${invitation.id}/${invitation.outcome}`,
    category: `workspace_invitation_${invitation.outcome}`,
    region: invitation.region,
    sender: "transactional",
    errors: EMAIL_ERRORS,
  }, request);
}


function invitationEmailHtml(input: WorkspaceInvitationEmail & {
  roleLabel: string;
  regionLabel: string;
  expiration: string;
}): string {
  const workspaceName = escapeHtml(input.workspaceName);
  const inviterName = escapeHtml(input.inviterName);
  const inviteUrl = escapeHtml(input.inviteUrl);
  const roleLabel = escapeHtml(input.roleLabel);
  const regionLabel = escapeHtml(input.regionLabel);
  const expiration = escapeHtml(input.expiration);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Avalon</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:28px;line-height:1.2;color:#f2f3ec">Join ${workspaceName}</h1></td></tr>
          <tr><td style="font-size:16px;line-height:1.6;color:#c9ccc4">${inviterName} invited you to join <strong style="color:#f2f3ec">${workspaceName}</strong> as ${roleLabel}.</td></tr>
          <tr><td style="padding:28px 0"><a href="${inviteUrl}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Accept invitation</a></td></tr>
          <tr><td style="font-size:13px;line-height:1.6;color:#8f948b">This one-time invitation expires ${expiration}.<br>Workspace data region: ${regionLabel}.</td></tr>
          <tr><td style="padding-top:24px;font-size:12px;line-height:1.5;color:#73786f;border-top:1px solid #2b2f29">If you were not expecting this invitation, you can ignore this email.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function invitationResolutionEmailHtml(input: WorkspaceInvitationResolutionEmail & {
  actor: string;
  roleLabel: string;
  regionLabel: string;
  verb: "accepted" | "declined";
  desktopUrl: string;
}): string {
  const actor = escapeHtml(input.actor);
  const inviteeEmail = escapeHtml(input.inviteeEmail);
  const workspaceName = escapeHtml(input.workspaceName);
  const roleLabel = escapeHtml(input.roleLabel);
  const regionLabel = escapeHtml(input.regionLabel);
  const outcome = input.outcome === "accepted" ? "Invitation accepted" : "Invitation declined";
  const desktopUrl = escapeHtml(input.desktopUrl);
  const accent = input.outcome === "accepted" ? "#CEDC00" : "#47C7FC";
  const actorDescription = input.actor.toLowerCase() === input.inviteeEmail.toLowerCase()
    ? actor
    : `${actor} <span style="color:#8f948b">(${inviteeEmail})</span>`;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${accent}">Avalon</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:28px;line-height:1.2;color:#f2f3ec">${outcome}</h1></td></tr>
          <tr><td style="font-size:16px;line-height:1.6;color:#c9ccc4">${actorDescription} ${input.verb} your invitation to join <strong style="color:#f2f3ec">${workspaceName}</strong>.</td></tr>
          <tr><td style="padding-top:24px;font-size:13px;line-height:1.6;color:#8f948b;border-top:1px solid #2b2f29">They were invited as ${roleLabel}.<br>Workspace data region: ${regionLabel}.</td></tr>
          <tr><td style="padding-top:28px"><a href="${desktopUrl}" style="display:inline-block;background:${accent};color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Open Avalon</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
