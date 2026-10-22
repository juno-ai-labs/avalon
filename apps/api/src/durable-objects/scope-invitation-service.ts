import { z } from "zod";
import { asUserId } from "@rally/contracts";
import { ListScopeInvitationsSchema, ScopeInvitationsListSchema, CreateScopeInvitationsSchema, ClaimScopeInvitationsSchema, RevokeScopeInvitationSchema,
  WorkspaceRelationshipSchema, type ScopeGrant, type ScopeAccessRequest, type ScopeAccessResult, type ScopeInvitationResult, type ScopeInvitationSummary } from "@rally/contracts/scope-grants";
import { workstreamAddressedUrl } from "@rally/contracts/workstream-links";
import type { Env } from "../env";
import { encryptString, decryptString } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";
import { parseRpcInput } from "../lib/rpc-input";
import { ensureGuestRelationship, type WorkspaceRelationship } from "../services/workspace-relationship-service";
import { sendResendEmail } from "../services/resend";
import { readConversationPreview } from "../services/conversation-preview";
import { PREVIEW_BYTES, PREVIEW_TURNS, PREVIEW_WORDS, scopeInvitationEmailParts } from "../services/scope-invitation-email";
import { ObjectPortError } from "../runtime/object-port";
import { diagnosticErrorCode, logStructuredEvent } from "../observability/logger";
import { ScopeInvitationStorage, ScopeInvitationOperationConflict, type ScopeInvitationRecord } from "./scope-invitation-storage";
import { ScopeGrantStorage } from "./scope-grant-storage";

const SealedSchema = z.strictObject({ ciphertext: z.string(), iv: z.string() });
/** `html` is optional for one reason: an invitation recorded before this email had an HTML part still delivers. */
const DeliverySchema = z.strictObject({ recipientEmail: z.string().email(), text: z.string(), html: z.string().optional() });
const RecipientRelationshipSchema = WorkspaceRelationshipSchema.extend({ email: z.string().email() });
const denied = (reason: Extract<ScopeInvitationResult, { status: "denied" }>["reason"]): ScopeInvitationResult => ({ status: "denied", reason });

/** Validate enablement before any forward-only participant handoff. */
export function scopeInvitationOrigin(env: Env): URL | null {
  let origin: URL;
  try {
    origin = new URL(env.BROWSER_APP_ORIGIN ?? "");
    if (origin.origin !== env.BROWSER_APP_ORIGIN ||
      (origin.protocol !== "https:" && !(env.APP_ENV === "development" && origin.protocol === "http:")) ||
      !env.OAUTH_STATE_ENCRYPTION_KEY) throw new Error("configuration");
  } catch { return null; }
  return origin;
}

/** Product authority stays with the parent that owns the resulting grants. */
export class ScopeInvitationService {
  private readonly invitations: ScopeInvitationStorage;
  constructor(private readonly env: Env, private readonly storage: DurableObjectStorage,
    private readonly parentId: string,
    private readonly resolve: (request: ScopeAccessRequest, relationship: WorkspaceRelationship | null) => ScopeAccessResult,
    private readonly coverageMatches: (request: z.infer<typeof CreateScopeInvitationsSchema>) => boolean,
    private readonly enqueueDirectory: (grant: ScopeGrant, now: number) => void,
    private readonly readRelationship: (workspaceId: string, userId: string) => Promise<WorkspaceRelationship | null>,
    private readonly noteRelationship: (relationship: WorkspaceRelationship) => void) {
    this.invitations = new ScopeInvitationStorage(storage, parentId);
  }

  private canShare(targets: z.infer<typeof CreateScopeInvitationsSchema>["targets"], actor: WorkspaceRelationship | null): boolean {
    if (this.storage.sql.exec("SELECT 1 FROM parent_participant_migrations WHERE parent_id = ? AND phase = 'pending' LIMIT 1",
      this.parentId).toArray().length) return false;
    return actor !== null && targets.every((target) => {
      const access = this.resolve({ target, userId: actor.userId }, actor);
      return access.allowed && access.writable && access.grantIds.length > 0;
    });
  }

  private targetsReady(targets: z.infer<typeof CreateScopeInvitationsSchema>["targets"]): boolean {
    if (targets.some((target) => target.kind === "workstream") && this.storage.sql.exec(
      `SELECT 1 FROM parent_children child LEFT JOIN parent_participant_migrations migration
        ON migration.parent_id=child.parent_id AND migration.substream_id=child.substream_id
       WHERE child.parent_id=? AND child.kind='child' AND child.status='ready' AND child.audience='inherits_workstream'
         AND (migration.phase IS NULL OR migration.phase!='complete') LIMIT 1`,
      this.parentId,
    ).toArray().length > 0) return false;
    return targets.every((target) => {
      const substreamId = target.kind === "workstream" ? "0" : target.substreamId;
      const phase = this.storage.sql.exec<{ phase: string }>(
        "SELECT phase FROM parent_participant_migrations WHERE parent_id = ? AND substream_id = ?",
        this.parentId, substreamId,
      ).toArray()[0]?.phase;
      return phase === "complete";
    });
  }

  async list(input: z.infer<typeof ListScopeInvitationsSchema>) {
    const request = ListScopeInvitationsSchema.parse(input);
    const actor = await this.readRelationship(request.target.workspaceId, request.actorUserId);
    if (!this.canShare([request.target], actor)) return ScopeInvitationsListSchema.parse({ status: "denied", reason: "sharing_required" });
    const invitations = this.invitations.summaries().filter((invitation) =>
      invitation.targets.some((target) => target.kind === request.target.kind
        && target.workspaceId === request.target.workspaceId && target.parentId === request.target.parentId
        && (target.kind === "workstream" || (request.target.kind === "conversation" && target.substreamId === request.target.substreamId)))
      && this.canShare(invitation.targets, actor));
    return ScopeInvitationsListSchema.parse({ status: "ready", invitations });
  }

  async create(input: z.infer<typeof CreateScopeInvitationsSchema>): Promise<ScopeInvitationResult> {
    const request = CreateScopeInvitationsSchema.parse(input);
    const origin = scopeInvitationOrigin(this.env);
    if (!origin) return denied("configuration_required");
    // One read for every recipient of this operation: they are offered the same
    // scope, so they are told the same thing about it.
    const [introduction, offered] = await Promise.all([this.introduction(request), this.offered(request.targets)]);
    const emails = [...new Set(request.emails)];
    const link = this.destination(origin, request.targets);
    const prepared = await Promise.all(emails.map(async (email) => {
      const id = uuidV7();
      const delivery = { recipientEmail: email, ...scopeInvitationEmailParts({
        ...introduction, ...offered, recipientEmail: email, link }) };
      return { id, email, grantOperationIds: request.targets.map(() => uuidV7()),
        deliveryEncrypted: JSON.stringify(await encryptString(JSON.stringify(delivery), this.env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)) };
    }));
    const actor = await this.readRelationship(request.workspaceId, request.actorUserId);
    const result = this.record(request, actor, prepared);
    if (result.status !== "created") return result;
    // Only once the share is recorded, so a refused caller writes no rows. If
    // this fails the request fails, and the sharer's retry replays the same
    // operation to this line. A cleanup racing it is re-checked there.
    const waiting = this.waiting();
    const recipients = await this.prepareRecipients(request.workspaceId, emails.filter((email) => waiting.has(email)));
    // An existing account holds the share now. Committed already, so a failure
    // here leaves it pending for their next sign-in.
    await this.claimForKnownRecipients(request.workspaceId, recipients).catch((error: unknown) => {
      logStructuredEvent(this.env, "warn", "scope_invitation_claim_failed", {
        workspace_id: request.workspaceId, workstream_id: this.parentId,
        error: diagnosticErrorCode(error, "scope_invitation_claim_failed"),
      });
    });
    return { status: "created", invitations: this.invitations.operation(request) ?? result.invitations };
  }

  /** Main for a Channel share, the conversation itself for a single conversation. */
  private destination(origin: URL, targets: z.infer<typeof CreateScopeInvitationsSchema>["targets"]): string {
    const target = targets[0]!;
    return workstreamAddressedUrl(origin.origin, { region: this.env.AVALON_REGION, workspaceId: target.workspaceId,
      workstreamId: target.parentId,
      ...(target.kind === "conversation" && target.substreamId !== "0" ? { substreamId: target.substreamId } : {}) });
  }

  private async noteRecipients(workspaceId: string, emails: string[]): Promise<void> {
    const at = new Date().toISOString();
    await this.env.DB.batch(emails.map((email) => this.env.DB.prepare(
      "INSERT OR IGNORE INTO scope_share_recipients (email, workspace_id, parent_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(email, workspaceId, this.parentId, at)));
  }

  /** One primary round trip for lookup durability, verified identities and their relationships. */
  private async prepareRecipients(workspaceId: string, emails: string[]): Promise<Array<{ email: string; relationship: WorkspaceRelationship }>> {
    if (!emails.length) return [];
    const addresses = JSON.stringify(emails);
    const at = new Date().toISOString();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`INSERT OR IGNORE INTO scope_share_recipients (email, workspace_id, parent_id, created_at)
        SELECT value, ?, ?, ? FROM json_each(?)`).bind(workspaceId, this.parentId, at, addresses),
      this.env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, access_class, status, joined_at)
        SELECT DISTINCT ?, user_id, NULL, 'guest', 'active', ? FROM user_verified_emails
        WHERE email IN (SELECT value FROM json_each(?))
        ON CONFLICT(workspace_id, user_id) DO NOTHING`).bind(workspaceId, at, addresses),
      this.env.DB.prepare(`SELECT verified.email, members.workspace_id AS workspaceId, members.user_id AS userId,
        members.access_class AS accessClass, members.role, members.status, members.incarnation, members.revision
        FROM user_verified_emails verified JOIN workspace_members members ON members.user_id = verified.user_id
        JOIN workspaces workspace ON workspace.id = members.workspace_id
        WHERE members.workspace_id = ? AND workspace.abandoned_at IS NULL
          AND verified.email IN (SELECT value FROM json_each(?))`).bind(workspaceId, addresses),
    ]);
    return parseRpcInput(z.array(RecipientRelationshipSchema), results[2]!.results, "scope_invitation_recipients")
      .map(({ email, ...relationship }) => ({ email, relationship }));
  }

  private async claimForKnownRecipients(workspaceId: z.infer<typeof CreateScopeInvitationsSchema>["workspaceId"],
    recipients: Array<{ email: string; relationship: WorkspaceRelationship }>): Promise<void> {
    for (const { email, relationship } of recipients) {
      // Prefer any newer event learned while D1 was in flight. A suspended or
      // replaced relationship must never be overwritten by this batch's read.
      this.noteRelationship(relationship);
      await this.claim({ workspaceId, parentId: this.parentId, userId: asUserId(relationship.userId), emails: [email] },
        { membershipIncarnation: relationship.incarnation });
    }
  }

  /** The local half of a creation: sharing, replay and coverage, then the transaction. */
  private record(request: z.infer<typeof CreateScopeInvitationsSchema>, actor: WorkspaceRelationship | null,
    prepared: Parameters<ScopeInvitationStorage["create"]>[2]): ScopeInvitationResult {
    if (!actor || !this.canShare(request.targets, actor)) return denied("sharing_required");
    if (!this.targetsReady(request.targets)) return denied("migration_pending");
    try {
      const existing = this.invitations.operation(request);
      if (existing) return { status: "created", invitations: existing };
    } catch (error) {
      if (error instanceof ScopeInvitationOperationConflict) return denied("operation_conflict");
      throw error;
    }
    if (request.completeWorkstream && !this.coverageMatches(request)) return denied("scope_changed");
    if (request.expiresAt !== null && request.expiresAt <= Date.now()) return denied("invitation_unavailable");
    return { status: "created", invitations: this.invitations.create(request, actor.incarnation, prepared) };
  }

  /**
   * Turns every share pending for these verified addresses into grants for
   * `userId`, and returns the ones it did. A share that cannot be claimed yet
   * (its sharer lost the share, a migration is still running) stays pending
   * for the next sign-in; one that never can (revoked, expired) is skipped.
   */
  async claim(input: z.infer<typeof ClaimScopeInvitationsSchema>, prepared?: { membershipIncarnation: string }): Promise<ScopeInvitationSummary[]> {
    const request = ClaimScopeInvitationsSchema.parse(input);
    const emails = new Set(request.emails);
    const claimed: ScopeInvitationSummary[] = [];
    for (const summary of this.invitations.summaries()) {
      if (summary.status !== "pending" || !emails.has(summary.email)) continue;
      const result = await this.claimOne(summary.id, request.workspaceId, request.userId, prepared?.membershipIncarnation);
      if (result.status === "accepted") claimed.push(result.invitation);
      // A share left pending says why, or it looks the same as one nobody tried.
      else logStructuredEvent(this.env, "warn", "scope_invitation_claim_refused", {
        workspace_id: request.workspaceId, workstream_id: this.parentId, reason: result.reason,
      });
    }
    // Creation's delivery alarm (or a later sign-in) cleans these harmless
    // lookup rows. The guest already holds the grants; cleanup cannot delay it.
    if (!prepared) await this.forgetSettled(request.workspaceId, [...emails]);
    return claimed;
  }

  private async claimOne(invitationId: string, workspaceId: string, userId: string,
    preparedIncarnation?: string)
    : Promise<{ status: "accepted"; invitation: ScopeInvitationSummary } | Extract<ScopeInvitationResult, { status: "denied" }>> {
    const initial = this.invitations.read(invitationId);
    if (!initial || initial.summary.status !== "pending" || !this.usable(initial)) return { status: "denied", reason: "invitation_unavailable" };
    // A sharer whose membership was replaced can never authorize this share
    // again (rejoining restores nothing), so retire it rather than leave it
    // pending: its lookup row then clears instead of costing every sign-in.
    const sharer = await this.readRelationship(workspaceId, initial.actorUserId);
    if (sharer?.incarnation !== initial.actorIncarnation) {
      this.invitations.revoke(invitationId, initial.summary.revision);
      return { status: "denied", reason: "sharing_required" };
    }
    const blocked = await this.unofferable(initial);
    if (blocked) return { status: "denied", reason: blocked };
    // Cross-authority saga: an interruption may leave a relationship without a
    // share. That grants no conversation access and the next claim resumes it.
    const recipient = preparedIncarnation !== undefined ? await this.readRelationship(workspaceId, userId)
      : await ensureGuestRelationship(this.env.DB, workspaceId, userId);
    // This request just wrote the relationship to D1, so its checks below and
    // the viewer checks right after it read that, not the table's older answer.
    if (recipient) this.noteRelationship(recipient);
    if (recipient?.status !== "active") return { status: "denied", reason: "relationship_required" };
    // Live rows in different incarnations cannot be ordered without the
    // membership event. Leave the share pending instead of binding its receipt
    // to the cached old membership (or replacing a newer one with this read).
    if (preparedIncarnation !== undefined && recipient.incarnation !== preparedIncarnation) {
      return { status: "denied", reason: "relationship_required" };
    }
    const currentActor = await this.readRelationship(workspaceId, initial.actorUserId);
    if (currentActor?.incarnation !== initial.actorIncarnation) return { status: "denied", reason: "sharing_required" };
    return this.storage.transactionSync(() => {
      const current = this.invitations.read(invitationId);
      if (!current || current.summary.status !== "pending" || !this.usable(current)) return { status: "denied" as const, reason: "invitation_unavailable" as const };
      if (!this.canShare(current.summary.targets, currentActor)) return { status: "denied" as const, reason: "sharing_required" as const };
      const grants = new ScopeGrantStorage(this.storage, { workspaceId, parentId: this.parentId }, this.enqueueDirectory);
      for (const [index, target] of current.summary.targets.entries()) {
        const operationId = current.grantOperationIds[index];
        if (!operationId) throw new Error("scope_invitation_grant_operation_missing");
        const result = grants.mutateCurrent({ operationId, target, userId: asUserId(userId),
          actorUserId: asUserId(current.actorUserId), active: true }, recipient.incarnation);
        if (result.status !== "committed") throw new Error("scope_invitation_grant_not_committed");
      }
      return { status: "accepted" as const, invitation: this.invitations.claim(invitationId, userId, recipient.incarnation) };
    });
  }

  /** Writes lookup rows for every address with a share here still waiting to be claimed. */
  async indexPending(workspaceId: string): Promise<void> {
    const emails = [...this.waiting()];
    if (emails.length > 0) await this.noteRecipients(workspaceId, emails);
  }

  /**
   * Drops the lookup rows for addresses with nothing left to claim here. One
   * still pending keeps its row, so the next sign-in tries it again.
   */
  private async forgetSettled(workspaceId: string, emails: string[]): Promise<void> {
    // Housekeeping after a committed claim or revocation: a failure leaves a
    // harmless row for a later claim to remove, never a failed operation.
    try { await this.forgetSettledRows(workspaceId, emails); } catch (error) {
      logStructuredEvent(this.env, "warn", "scope_share_recipient_cleanup_failed", {
        workspace_id: workspaceId, workstream_id: this.parentId,
        error: diagnosticErrorCode(error, "scope_share_recipient_cleanup_failed"),
      });
    }
  }

  private async forgetSettledRows(workspaceId: string, emails: string[]): Promise<void> {
    const settled = emails.filter((email) => !this.waiting().has(email));
    if (settled.length === 0) return;
    await this.env.DB.batch(settled.map((email) => this.env.DB.prepare(
      "DELETE FROM scope_share_recipients WHERE email = ? AND workspace_id = ? AND parent_id = ?",
    ).bind(email, workspaceId, this.parentId)));
    // A share for one of these addresses recorded while the delete was in
    // flight needs its row back.
    const revived = settled.filter((email) => this.waiting().has(email));
    if (revived.length > 0) await this.noteRecipients(workspaceId, revived);
  }

  /** Addresses with a share here that a sign-in could still claim. */
  private waiting(): Set<string> {
    return new Set(this.invitations.summaries()
      .filter((summary) => summary.status === "pending" && (summary.expiresAt === null || summary.expiresAt > Date.now()))
      .map((summary) => summary.email));
  }

  async revoke(input: z.infer<typeof RevokeScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    const request = RevokeScopeInvitationSchema.parse(input);
    const actor = await this.readRelationship(request.workspaceId, request.actorUserId);
    const current = this.invitations.read(request.invitationId);
    if (!current) return denied("invitation_unavailable");
    if (!this.canShare(current.summary.targets, actor)) return denied("sharing_required");
    const invitation = this.invitations.revoke(request.invitationId, request.expectedRevision);
    if (!invitation) return denied("revision_conflict");
    await this.forgetSettled(request.workspaceId, [invitation.email]);
    return { status: "revoked", invitation };
  }

  /**
   * Who is asking, and into what. Both are shown to someone who has not signed
   * in, so neither is an identifier, and neither can fail an invitation: the
   * email has a sentence for every name it did not get.
   */
  private async introduction(request: z.infer<typeof CreateScopeInvitationsSchema>) {
    try {
      const [inviter, workspace] = await Promise.all([
        this.env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(request.actorUserId).first<{ name: string | null }>(),
        this.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(request.workspaceId).first<{ name: string | null }>(),
      ]);
      return { inviterName: inviter?.name ?? null, workspaceName: workspace?.name ?? null };
    } catch (error) {
      this.previewFailed("scope_invitation_introduction_failed", request.workspaceId, request.parentId, null, error);
      return { inviterName: null, workspaceName: null };
    }
  }

  private previewFailed(event: string, workspaceId: string, parentId: string, substreamId: string | null, error: unknown): void {
    logStructuredEvent(this.env, "warn", event, {
      workspace_id: workspaceId, workstream_id: parentId, substream_id: substreamId,
      error_name: error instanceof Error ? error.name : "UnknownError",
      // Every port failure is one class, so the name alone cannot tell an
      // unprovisioned object from a misrouted stub from a drifted protocol.
      // Nothing rendered here can fail an invitation, which makes this log the
      // only evidence that the preview stopped rendering at all.
      error_code: error instanceof ObjectPortError ? error.code : null,
    });
  }

  /**
   * The conversation this invitation opens onto, and the end of what has been
   * said in it.
   *
   * The first target, because that is where the emailed link opens:
   * a work-stream offer opens Main, and a conversation offer opens that
   * conversation. Never a second conversation and never the parent of a
   * child-only share — the preview is bounded by the scope, exactly as the
   * grants are.
   *
   * A preview is cosmetic and its transcript lives in another object, so a read
   * that fails sends the invitation without it. An invitation is not a title,
   * and must not fail because one could not be rendered.
   */
  private async offered(targets: z.infer<typeof CreateScopeInvitationsSchema>["targets"]) {
    const target = targets[0];
    if (!target) return { conversationTitle: null, preview: null };
    const substreamId = target.kind === "workstream" ? "0" : target.substreamId;
    let conversationTitle: string | null = null;
    try {
      // Inside the guard with the transcript read: a local read that fails is
      // still only a title, and an invitation must not fail for want of one.
      conversationTitle = substreamId === "0"
        ? this.storage.sql.exec<{ title: string | null }>("SELECT title FROM channels WHERE workstream_id = ?", this.parentId)
          .toArray()[0]?.title ?? null
        : this.storage.sql.exec<{ title: string | null }>(
          "SELECT title FROM parent_children WHERE parent_id = ? AND substream_id = ?", this.parentId, substreamId,
        ).toArray()[0]?.title ?? null;
      return { conversationTitle, preview: await readConversationPreview(this.env, {
        workspaceId: target.workspaceId, parentId: target.parentId, substreamId,
        turns: PREVIEW_TURNS, words: PREVIEW_WORDS, bytes: PREVIEW_BYTES,
      }) };
    } catch (error) {
      this.previewFailed("scope_invitation_preview_failed", target.workspaceId, target.parentId, substreamId, error);
      return { conversationTitle, preview: null };
    }
  }

  async deliver(id: string): Promise<void> {
    const current = this.invitations.read(id);
    if (current) await this.forgetSettled(current.summary.targets[0]!.workspaceId, [current.summary.email]);
    // A share claimed the moment it was made, by someone who already has an
    // account, still owes them the email: it is how they hear of it.
    if (!current || current.deliveredAt !== null || !this.usable(current)) return;
    const sealed = SealedSchema.parse(JSON.parse(current.deliveryEncrypted));
    const delivery = DeliverySchema.parse(JSON.parse(await decryptString(sealed.ciphertext, sealed.iv,
      this.env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)));
    await sendResendEmail(this.env, { recipientEmail: delivery.recipientEmail, text: delivery.text,
      // Absent rather than undefined: an invitation composed before this email
      // had an HTML part delivers as the text it was composed as.
      ...(delivery.html ? { html: delivery.html } : {}),
      subject: "An invitation to collaborate in Rally",
      idempotencyKey: `scope-invitation:${id}`, category: "scope_invitation", region: this.env.AVALON_REGION,
      sender: "transactional", errors: {
        unavailable: { code: "scope_invitation_delivery_unavailable", message: "Invitation email is not configured" },
        failed: { code: "scope_invitation_delivery_failed", message: "Invitation email could not be delivered" },
      } });
    this.invitations.acknowledgeDelivery(id);
  }

  /**
   * What still stops this share from being claimed, or null: its targets have
   * finished their participant migration, and the sharer still holds the share
   * they offered, in the membership incarnation they offered it from. Claiming
   * re-reads the actor and commits under that read; this is the early gate.
   */
  private async unofferable(record: ScopeInvitationRecord): Promise<"migration_pending" | "sharing_required" | null> {
    if (!this.targetsReady(record.summary.targets)) return "migration_pending";
    const target = record.summary.targets[0];
    if (!target) return "sharing_required";
    const actor = await this.readRelationship(target.workspaceId, record.actorUserId);
    return actor?.incarnation === record.actorIncarnation && this.canShare(record.summary.targets, actor)
      ? null : "sharing_required";
  }

  private usable(record: ScopeInvitationRecord): boolean {
    return record.summary.status !== "revoked" &&
      (record.summary.status === "accepted" || record.summary.expiresAt === null || record.summary.expiresAt > Date.now());
  }
}
