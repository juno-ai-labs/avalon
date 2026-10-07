import { z } from "zod";
import { asUserId, asWorkspaceId, type ConversationAccessPreview, type Region } from "@rally/contracts";
import { newId } from "@rally/db";

import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { decryptString, encryptString } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo } from "../observability/logger";
import { ConversationService } from "./conversation-service";
import { escapeHtml, sendResendEmail, singleLine } from "./resend";
import { SubstreamCreationService } from "./substream-creation-service";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";
import { WorkstreamService } from "./workstream-service";

/**
 * Binds a sealed approval to this one use, so no other value sealed under the
 * same key (an OAuth state, a scope invitation) opens as an approval.
 */
const APPROVAL_PURPOSE = "rally-conversation-access-approval-v1";

const EMAIL_ERRORS = {
  unavailable: { code: "access_request_email_unavailable", message: "Access request email is temporarily unavailable" },
  failed: { code: "access_request_email_failed", message: "The access request email could not be sent" },
};

const ApprovalSchema = z.strictObject({
  workspaceId: z.string().min(1),
  parentId: z.string().min(1),
  substreamId: z.string().min(1),
  requesterUserId: z.string().min(1),
  approverUserId: z.string().min(1),
  operationId: z.string().min(1),
});
type Approval = z.infer<typeof ApprovalSchema>;

interface Subject {
  kind: "channel" | "breakout";
  title: string;
  appearance: ConversationAccessPreview["appearance"];
  markId: string;
  createdByUserId: string | null;
}

export type ApprovalOutcome =
  | { status: "approved"; requesterName: string; title: string; kind: "channel" | "breakout" }
  | { status: "invalid" }
  | { status: "refused"; code: string; message: string };

/**
 * A member who holds a link to a Channel or Breakout they are not in: what
 * they may see of it, and the email that asks its creator to let them in.
 *
 * The approval is a sealed value, not a stored row. It names who asked, who
 * may approve, and what for; opening it runs the ordinary add as the approver,
 * so every rule an add already enforces (the approver still a member, still
 * able to share, the requester still a member) is enforced again at the click.
 * `docs/channel-access-requests.md` owns why.
 */
export class ConversationAccessRequestService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async preview(parentId: string, substreamId: string): Promise<ConversationAccessPreview> {
    const subject = await this.subject(parentId, substreamId);
    return {
      kind: subject.kind,
      title: subject.title,
      appearance: subject.appearance,
      markId: subject.markId,
      access: await this.admitted(parentId, substreamId) ? "open" : "requestable",
    };
  }

  async request(parentId: string, substreamId: string): Promise<void> {
    const subject = await this.subject(parentId, substreamId);
    if (await this.admitted(parentId, substreamId)) {
      throw new ApiError(409, "access_request_already_open", "You can already open this.");
    }
    const approverUserId = subject.createdByUserId;
    if (!approverUserId || approverUserId === this.auth.userId) {
      throw new ApiError(409, "access_request_no_approver", "Nobody can approve this request. Ask someone in it to add you.");
    }
    const people = await workspaceRegionalDatabase(this.env).prepare(
      `SELECT user.id AS id, user.email AS email, user.name AS name, workspace.name AS workspace_name
         FROM users user
         JOIN workspace_members member ON member.user_id = user.id AND member.workspace_id = ?
          AND member.status = 'active' AND member.access_class = 'member'
         JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE user.id IN (?, ?)`,
    ).bind(this.auth.workspaceId, approverUserId, this.auth.userId)
      .all<{ id: string; email: string; name: string | null; workspace_name: string }>();
    const approver = people.results?.find((row) => row.id === approverUserId);
    const requester = people.results?.find((row) => row.id === this.auth.userId);
    if (!approver) {
      throw new ApiError(409, "access_request_no_approver", "Nobody can approve this request. Ask someone in it to add you.");
    }
    const approval: Approval = {
      workspaceId: this.auth.workspaceId,
      parentId,
      substreamId,
      requesterUserId: this.auth.userId,
      approverUserId,
      operationId: newId(),
    };
    const approveUrl = await approvalUrl(this.env, approval);
    const requesterName = singleLine(requester?.name || requester?.email || "Someone");
    await sendAccessRequestEmail(this.env, {
      approverEmail: approver.email,
      requesterName,
      requesterEmail: requester?.email ?? "",
      workspaceName: singleLine(approver.workspace_name),
      title: singleLine(subject.title),
      kind: subject.kind,
      approveUrl,
      idempotencyKey: `rally-conversation-access-request/${approval.operationId}`,
      region: this.env.AVALON_REGION,
    });
    // Mail is never sent outside production; the link is what a developer
    // needs to try the approval locally. Never logged where it is a credential.
    if (this.env.APP_ENV === "development") {
      logInfo(this.env, "conversation_access_request_dev_link", { approveUrl });
    }
  }

  /** Whether this person may open it already: the same decision the socket ticket asks. */
  private async admitted(parentId: string, substreamId: string): Promise<boolean> {
    try {
      await new ConversationService(this.env, this.auth).authorizeViewer(parentId, substreamId);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "conversation_not_found") return false;
      throw error;
    }
  }

  /** Organization members only: a guest is told nothing they do not take part in (`docs/listing-rules.md`). */
  private async subject(parentId: string, substreamId: string): Promise<Subject> {
    if (this.auth.role === null) throw new ApiError(404, "conversation_not_found", "Conversation not found");
    const workspaceId = asWorkspaceId(this.auth.workspaceId);
    const workspace = await durableObjectStubForWorkspace(
      this.env, this.env.WORKSPACE_DOS, workspaceId, workspaceDOName(this.env.AVALON_REGION, workspaceId),
    );
    const subject = await workspace.accessRequestSubject({ workspaceId, parentId, substreamId });
    if (!subject) throw new ApiError(404, "conversation_not_found", "Conversation not found");
    return subject;
  }
}

/**
 * Grant what a sealed approval asks for, acting as the approver.
 *
 * Nobody is signed in here: the approver clicked a link in their own inbox.
 * The approver is re-read as a current member and acts under the `connector`
 * principal, which the objects verify against current membership rather than
 * a login session, the same authority the Space default delivery uses.
 */
export async function approveConversationAccess(env: Env, token: string): Promise<ApprovalOutcome> {
  const approval = await openApproval(env, token);
  if (!approval) return { status: "invalid" };
  const workspaceId = asWorkspaceId(approval.workspaceId);
  const db = workspaceRegionalDatabase(env);
  const approver = await db.prepare(
    `SELECT role FROM workspace_members
      WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND access_class = 'member'`,
  ).bind(workspaceId, approval.approverUserId).first<{ role: AuthContext["role"] }>();
  if (!approver) {
    return { status: "refused", code: "access_request_approver_inactive", message: "You are no longer a member of this organization." };
  }
  const auth: AuthContext = {
    sessionId: `conversation-access-approval:${approval.operationId}`,
    userId: asUserId(approval.approverUserId),
    workspaceId,
    region: env.AVALON_REGION,
    role: approver.role,
    analyticsWorkspaceId: null,
    principal: "connector",
  };
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
  const subject = await workspace.accessRequestSubject({
    workspaceId, parentId: approval.parentId, substreamId: approval.substreamId,
  });
  if (!subject) return { status: "refused", code: "conversation_not_found", message: "This has been archived or no longer exists." };
  try {
    if (approval.substreamId === "0") {
      await new WorkstreamService(env, auth).addParticipant(approval.parentId, approval.requesterUserId);
    } else {
      await new SubstreamCreationService(env, auth).changeParticipant(approval.parentId, approval.substreamId, {
        userId: approval.requesterUserId, operationId: approval.operationId,
      }, true);
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // Already in: the request is satisfied, which is what the approver wanted.
    if (error.code !== "participant_inherited_access") {
      return { status: "refused", code: error.code, message: error.message };
    }
  }
  const requester = await db.prepare(`SELECT name, email FROM users WHERE id = ?`)
    .bind(approval.requesterUserId).first<{ name: string | null; email: string }>();
  return {
    status: "approved",
    requesterName: singleLine(requester?.name || requester?.email || "They"),
    title: singleLine(subject.title),
    kind: subject.kind,
  };
}

export async function approvalUrl(env: Env, approval: Approval): Promise<string> {
  const sealed = await encryptString(JSON.stringify(approval), env.OAUTH_STATE_ENCRYPTION_KEY, APPROVAL_PURPOSE);
  const url = new URL("/conversation-access/approve", env.PUBLIC_API_BASE_URL);
  url.searchParams.set("token", `${sealed.iv}.${sealed.ciphertext}`);
  return url.toString();
}

export async function openApproval(env: Env, token: string): Promise<Approval | null> {
  const separator = token.indexOf(".");
  if (separator < 1) return null;
  try {
    const plaintext = await decryptString(token.slice(separator + 1), token.slice(0, separator), env.OAUTH_STATE_ENCRYPTION_KEY, APPROVAL_PURPOSE);
    const parsed = ApprovalSchema.safeParse(JSON.parse(plaintext));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function sendAccessRequestEmail(env: Env, input: {
  approverEmail: string;
  requesterName: string;
  requesterEmail: string;
  workspaceName: string;
  title: string;
  kind: "channel" | "breakout";
  approveUrl: string;
  idempotencyKey: string;
  region: Region;
}): Promise<void> {
  const noun = input.kind === "breakout" ? "breakout" : "channel";
  const who = input.requesterEmail && input.requesterEmail !== input.requesterName
    ? `${input.requesterName} (${input.requesterEmail})` : input.requesterName;
  const subject = `${input.requesterName} asked to join ${input.title}`;
  const text = [
    `${who} asked to join the ${noun} "${input.title}" in ${input.workspaceName}.`,
    "",
    `Approve access: ${input.approveUrl}`,
    "",
    "If you don't know why they asked, ignore this email and nothing changes.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Rally</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:26px;line-height:1.25;color:#f2f3ec">Access request</h1></td></tr>
          <tr><td style="padding-bottom:18px;font-size:15px;line-height:1.6;color:#c9ccc4"><strong style="color:#f2f3ec">${escapeHtml(who)}</strong> asked to join the ${noun} <strong style="color:#f2f3ec">${escapeHtml(input.title)}</strong> in ${escapeHtml(input.workspaceName)}.</td></tr>
          <tr><td style="padding-top:12px"><a href="${escapeHtml(input.approveUrl)}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Approve access</a></td></tr>
          <tr><td style="padding-top:18px;font-size:13px;line-height:1.6;color:#8f948b">If you don't know why they asked, ignore this email and nothing changes.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  await sendResendEmail(env, {
    recipientEmail: input.approverEmail,
    subject,
    html,
    text,
    idempotencyKey: input.idempotencyKey,
    category: "conversation_access_request",
    region: input.region,
    sender: "notification",
    errors: EMAIL_ERRORS,
  });
}
