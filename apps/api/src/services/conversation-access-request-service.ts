import { z } from "zod";
import { asUserId, asWorkspaceId, type ConversationAccessDecisionResult, type ConversationAccessPreview, type Region } from "@rally/contracts";

import type { StoredAccessRequest } from "../durable-objects/conversation-access-request-storage";
import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { decryptString, encryptString } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { ConversationService } from "./conversation-service";
import { escapeHtml, sendResendEmail, singleLine } from "./resend";
import { canonicalWorkstreamUrl } from "./workstream-link-service";
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

/** Names the stored request and who may approve it; the row holds the rest. */
const ApprovalSchema = z.strictObject({
  workspaceId: z.string().min(1),
  requestId: z.string().min(1),
  approverUserId: z.string().min(1),
});
type Approval = z.infer<typeof ApprovalSchema>;

interface Subject {
  kind: "channel" | "breakout";
  title: string;
  appearance: ConversationAccessPreview["appearance"];
  markId: string;
  createdByUserId: string | null;
  requestPending: boolean;
}

export type ApprovalOutcome =
  | { status: "approved"; requesterName: string; title: string; kind: "channel" | "breakout" }
  | { status: "invalid" }
  | { status: "refused"; code: string; message: string };

/**
 * A member who holds a link to a Channel or Breakout they are not in: what
 * they may see of it, and the request that asks its creator to let them in.
 *
 * A request is a row in the Organization object, listed to its approver in
 * the app and emailed to them with a sealed link naming it. Approving either
 * way runs the ordinary add as the approver, so every rule an add already
 * enforces (the approver still a member, still able to share, the requester
 * still a member) is enforced again at the click, and then settles the row.
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
      requestPending: subject.requestPending,
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
      `SELECT user.id AS id, user.email AS email, user.name AS name, member.role AS role, workspace.name AS workspace_name
         FROM users user
         JOIN workspace_members member ON member.user_id = user.id AND member.workspace_id = ?
          AND member.status = 'active' AND member.access_class = 'member'
         JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE user.id IN (?, ?)`,
    ).bind(this.auth.workspaceId, approverUserId, this.auth.userId)
      .all<{ id: string; email: string; name: string | null; role: AuthContext["role"]; workspace_name: string }>();
    const approver = people.results?.find((row) => row.id === approverUserId);
    const requester = people.results?.find((row) => row.id === this.auth.userId);
    // A creator who left the conversation but not the Organization could
    // never approve: every add they ran would be refused. They are asked the
    // same question the socket ticket asks, as themselves.
    if (!approver || !await canOpen(this.env, approverAuth(this.env, this.auth.workspaceId, approverUserId, approver.role), parentId, substreamId)) {
      throw new ApiError(409, "access_request_no_approver", "Nobody can approve this request. Ask someone in it to add you.");
    }
    const requesterName = singleLine(requester?.name || requester?.email || "Someone");
    const workspace = await workspaceStub(this.env, this.auth.workspaceId);
    const recorded = await workspace.recordConversationAccessRequest({
      workspaceId: this.auth.workspaceId, parentId, substreamId,
      requesterUserId: this.auth.userId, requesterName, approverUserId,
    });
    // Asking again while a request is pending reuses it. The approver already
    // has the row, and has the email unless sending it failed, in which case
    // this press sends it again under the same idempotency key.
    if (recorded.request.emailed) return;
    const approveUrl = await approvalUrl(this.env, {
      workspaceId: this.auth.workspaceId, requestId: recorded.request.id, approverUserId,
    });
    await sendAccessRequestEmail(this.env, {
      approverEmail: approver.email,
      requesterName,
      requesterEmail: requester?.email ?? "",
      workspaceName: singleLine(approver.workspace_name),
      title: singleLine(subject.title),
      kind: subject.kind,
      approveUrl,
      idempotencyKey: `rally-conversation-access-request/${recorded.request.id}`,
      region: this.env.AVALON_REGION,
    });
    await workspace.markConversationAccessRequestEmailed({ workspaceId: this.auth.workspaceId, id: recorded.request.id });
    // Mail is never sent outside production; the link is what a developer
    // needs to try the approval locally. Never logged where it is a credential.
    if (this.env.APP_ENV === "development") {
      logInfo(this.env, "conversation_access_request_dev_link", { approveUrl });
    }
  }

  /**
   * Approve or decline from the app, as the signed-in approver. Only the
   * request's approver may; anyone else is told it does not exist.
   */
  async decide(requestId: string, decision: "approve" | "decline"): Promise<ConversationAccessDecisionResult> {
    if (this.auth.role === null) throw new ApiError(404, "access_request_not_found", "Access request not found");
    const workspace = await workspaceStub(this.env, this.auth.workspaceId);
    const request = await workspace.conversationAccessRequest({ workspaceId: this.auth.workspaceId, id: requestId });
    if (!request || request.approverUserId !== this.auth.userId) {
      throw new ApiError(404, "access_request_not_found", "Access request not found");
    }
    if (request.status !== "pending") return { status: "settled" };
    // Settled before the grant, so only the decision that wins may grant: an
    // approve and a decline sent together from two places can never leave
    // somebody added under a request that reads declined.
    const resolved = await workspace.resolveConversationAccessRequest({
      workspaceId: this.auth.workspaceId, id: requestId, status: decision === "approve" ? "approved" : "declined",
    });
    if (!resolved) return { status: "settled" };
    if (decision === "approve") {
      try {
        await grant(this.env, this.auth, resolved);
      } catch (error) {
        await workspace.reopenConversationAccessRequest({ workspaceId: this.auth.workspaceId, id: requestId });
        throw error;
      }
    }
    await tellRequester(this.env, this.auth.workspaceId, resolved);
    return { status: resolved.status as "approved" | "declined" };
  }

  /** Whether this person may open it already: the same decision the socket ticket asks. */
  private admitted(parentId: string, substreamId: string): Promise<boolean> {
    return canOpen(this.env, this.auth, parentId, substreamId);
  }

  /** Organization members only: a guest is told nothing they do not take part in (`docs/listing-rules.md`). */
  private async subject(parentId: string, substreamId: string): Promise<Subject> {
    if (this.auth.role === null) throw new ApiError(404, "conversation_not_found", "Conversation not found");
    const subject = await (await workspaceStub(this.env, this.auth.workspaceId))
      .accessRequestSubject({ workspaceId: this.auth.workspaceId, parentId, substreamId, requesterUserId: this.auth.userId });
    if (!subject) throw new ApiError(404, "conversation_not_found", "Conversation not found");
    return subject;
  }
}

/**
 * Add the requester as the approver would by hand, through the same add the
 * app runs, so an approval can never grant more than the approver could.
 * Already in counts as done.
 */
async function grant(env: Env, auth: AuthContext, request: StoredAccessRequest): Promise<void> {
  try {
    if (request.substreamId === "0") {
      await new WorkstreamService(env, auth).addParticipant(request.parentId, request.requesterUserId);
    } else {
      await new SubstreamCreationService(env, auth).changeParticipant(request.parentId, request.substreamId, {
        userId: request.requesterUserId, operationId: request.id,
      }, true);
    }
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "participant_inherited_access") throw error;
  }
}

/**
 * Approve from the email's link, acting as the approver.
 *
 * Nobody is signed in here: the approver clicked a link in their own inbox.
 * The approver is re-read as a current member and acts under the `connector`
 * principal, which the objects verify against current membership rather than
 * a login session, the same authority the Space default delivery uses. The
 * link settles the stored request, so a request already settled is never
 * granted again: an old email cannot re-add somebody removed since, and a
 * declined request stays declined.
 */
export async function approveConversationAccess(env: Env, token: string): Promise<ApprovalOutcome> {
  const approval = await openApproval(env, token);
  if (!approval) return { status: "invalid" };
  const workspaceId = asWorkspaceId(approval.workspaceId);
  const workspace = await workspaceStub(env, workspaceId);
  const request = await workspace.conversationAccessRequest({ workspaceId, id: approval.requestId });
  if (!request || request.approverUserId !== approval.approverUserId) return { status: "invalid" };
  const db = workspaceRegionalDatabase(env);
  const subject = await workspace.accessRequestSubject({
    workspaceId, parentId: request.parentId, substreamId: request.substreamId,
  });
  if (!subject) return { status: "refused", code: "conversation_not_found", message: "This has been archived or no longer exists." };
  const named = async (): Promise<ApprovalOutcome> => {
    const requester = await db.prepare(`SELECT name, email FROM users WHERE id = ?`)
      .bind(request.requesterUserId).first<{ name: string | null; email: string }>();
    return {
      status: "approved",
      requesterName: singleLine(requester?.name || requester?.email || "They"),
      title: singleLine(subject.title),
      kind: subject.kind,
    };
  };
  if (request.status === "approved") return named();
  if (request.status === "declined") {
    return { status: "refused", code: "access_request_declined", message: "You declined this request in Rally." };
  }
  const approver = await db.prepare(
    `SELECT role FROM workspace_members
      WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND access_class = 'member'`,
  ).bind(workspaceId, request.approverUserId).first<{ role: AuthContext["role"] }>();
  if (!approver) {
    return { status: "refused", code: "access_request_approver_inactive", message: "You are no longer a member of this organization." };
  }
  const auth = approverAuth(env, workspaceId, request.approverUserId, approver.role);
  // Claimed before the grant, as `decide` does: a decline that lands first
  // wins, and this link then grants nothing.
  const claimed = await workspace.resolveConversationAccessRequest({ workspaceId, id: request.id, status: "approved" });
  if (!claimed) {
    const now = await workspace.conversationAccessRequest({ workspaceId, id: request.id });
    return now?.status === "approved"
      ? named()
      : { status: "refused", code: "access_request_declined", message: "You declined this request in Rally." };
  }
  try {
    await grant(env, auth, claimed);
  } catch (error) {
    await workspace.reopenConversationAccessRequest({ workspaceId, id: request.id });
    if (!(error instanceof ApiError)) throw error;
    return { status: "refused", code: error.code, message: error.message };
  }
  await tellRequester(env, workspaceId, claimed);
  return named();
}

/** The socket ticket's question: may this person open this conversation? */
async function canOpen(env: Env, auth: AuthContext, parentId: string, substreamId: string): Promise<boolean> {
  try {
    await new ConversationService(env, auth).authorizeViewer(parentId, substreamId);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "conversation_not_found") return false;
    throw error;
  }
}

/**
 * The approver, with nobody signed in as them: under the `connector`
 * principal, which the objects verify against current membership rather than
 * a login session (`IdentityAuthContext.principal` in `env.ts`). The caller has
 * just read them as an active member.
 */
function approverAuth(env: Env, workspaceId: string, userId: string, role: AuthContext["role"]): AuthContext {
  return {
    sessionId: `conversation-access-approval:${userId}`,
    userId: asUserId(userId),
    workspaceId: asWorkspaceId(workspaceId),
    region: env.AVALON_REGION,
    role,
    analyticsWorkspaceId: null,
    principal: "connector",
  };
}

async function workspaceStub(env: Env, id: string) {
  const workspaceId = asWorkspaceId(id);
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
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

const DECISION_EMAIL_ERRORS = {
  unavailable: { code: "access_decision_email_unavailable", message: "Access decision email is temporarily unavailable" },
  failed: { code: "access_decision_email_failed", message: "The access decision email could not be sent" },
};

/**
 * Email the person who asked, once their request is settled either way. Sent
 * only by the call that settled it, so it goes once. The access already
 * changed, so a mail failure is logged and does not undo or fail the decision.
 */
async function tellRequester(env: Env, id: string, request: StoredAccessRequest): Promise<void> {
  try {
    const workspaceId = asWorkspaceId(id);
    const workspace = await workspaceStub(env, workspaceId);
    const subject = await workspace.accessRequestSubject({
      workspaceId, parentId: request.parentId, substreamId: request.substreamId,
    });
    const people = await workspaceRegionalDatabase(env).prepare(
      `SELECT id, email, name FROM users WHERE id IN (?, ?)`,
    ).bind(request.requesterUserId, request.approverUserId).all<{ id: string; email: string; name: string | null }>();
    const requester = people.results?.find((row) => row.id === request.requesterUserId);
    const approver = people.results?.find((row) => row.id === request.approverUserId);
    if (!requester || !subject) return;
    const approved = request.status === "approved";
    const noun = subject.kind === "breakout" ? "breakout" : "channel";
    const title = singleLine(subject.title);
    const approverName = singleLine(approver?.name || approver?.email || "The creator");
    const openUrl = approved ? await canonicalWorkstreamUrl(env, {
      region: env.AVALON_REGION, workspaceId, workstreamId: request.parentId,
      ...(request.substreamId !== "0" ? { substreamId: request.substreamId } : {}),
    }) : null;
    const heading = approved ? "Access approved" : "Access declined";
    const line = approved
      ? `${approverName} approved your request to join the ${noun} "${title}".`
      : `${approverName} declined your request to join the ${noun} "${title}".`;
    const text = [line, ...(openUrl ? ["", `Open in Rally: ${openUrl}`] : [])].join("\n");
    const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Rally</td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:26px;line-height:1.25;color:#f2f3ec">${heading}</h1></td></tr>
          <tr><td style="padding-bottom:18px;font-size:15px;line-height:1.6;color:#c9ccc4">${escapeHtml(line)}</td></tr>
          ${openUrl ? `<tr><td style="padding-top:12px"><a href="${escapeHtml(openUrl)}" style="display:inline-block;background:#CEDC00;color:#11140f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Open in Rally</a></td></tr>` : ""}
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
    // Mail is never sent outside production; this says locally that it would have been.
    if (env.APP_ENV === "development") {
      logInfo(env, "conversation_access_decision_dev_email", { requestId: request.id, status: request.status });
    }
    await sendResendEmail(env, {
      recipientEmail: requester.email,
      subject: approved ? `You can now open ${title}` : `Your request to join ${title} was declined`,
      html,
      text,
      idempotencyKey: `rally-conversation-access-decision/${request.id}`,
      category: "conversation_access_decision",
      region: env.AVALON_REGION,
      sender: "notification",
      errors: DECISION_EMAIL_ERRORS,
    });
  } catch (error) {
    logWarn(env, "conversation_access_decision_email_failed", {
      requestId: request.id, errorCode: diagnosticErrorCode(error, "access_decision_email_failed"),
    });
  }
}
