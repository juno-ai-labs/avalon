import { z } from "zod";
import { asUserId } from "@rally/contracts";
import { ListScopeInvitationsSchema, ScopeInvitationsListSchema, CreateScopeInvitationsSchema, AcceptScopeInvitationSchema, RevokeScopeInvitationSchema,
  DescribeScopeInvitationSchema, ScopeInvitationDescriptionSchema,
  type ScopeGrant, type ScopeAccessRequest, type ScopeAccessResult, type ScopeInvitationDescription, type ScopeInvitationResult } from "@rally/contracts/scope-grants";
import type { Env } from "../env";
import { encryptString, decryptString, hmacSha256, timingSafeEqualText } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";
import { ensureGuestRelationship, readWorkspaceRelationship, type WorkspaceRelationship } from "../services/workspace-relationship-service";
import { sendResendEmail } from "../services/resend";
import { readConversationPreview } from "../services/conversation-preview";
import { discardScopeInvitationLinks, issueScopeInvitationLink, scopeInvitationLinkUrl } from "../services/scope-invitation-link";
import { PREVIEW_BYTES, PREVIEW_TURNS, PREVIEW_WORDS, scopeInvitationEmailParts } from "../services/scope-invitation-email";
import { ObjectPortError } from "../runtime/object-port";
import { logStructuredEvent } from "../observability/logger";
import { ScopeInvitationStorage, ScopeInvitationOperationConflict, type ScopeInvitationRecord } from "./scope-invitation-storage";
import { ScopeGrantStorage } from "./scope-grant-storage";

const SealedSchema = z.strictObject({ ciphertext: z.string(), iv: z.string() });
/** `html` is optional for one reason: an invitation recorded before this email had an HTML part still delivers. */
const DeliverySchema = z.strictObject({ recipientEmail: z.string().email(), text: z.string(), html: z.string().optional() });
const denied = (reason: Extract<ScopeInvitationResult, { status: "denied" }>["reason"]): ScopeInvitationResult => ({ status: "denied", reason });

/** Validate enablement before any forward-only participant handoff. */
export function scopeInvitationOrigin(env: Env): URL | null {
  let origin: URL;
  try {
    origin = new URL(env.BROWSER_APP_ORIGIN ?? "");
    if (origin.origin !== env.BROWSER_APP_ORIGIN ||
      (origin.protocol !== "https:" && !(env.APP_ENV === "development" && origin.protocol === "http:")) ||
      !env.OAUTH_STATE_ENCRYPTION_KEY || !env.SESSION_SIGNING_KEY) throw new Error("configuration");
  } catch { return null; }
  return origin;
}

/** Product authority stays in the WorkstreamDO that owns the resulting grants. */
export class ScopeInvitationService {
  private readonly invitations: ScopeInvitationStorage;
  constructor(private readonly env: Env, private readonly storage: DurableObjectStorage,
    private readonly resolve: (request: ScopeAccessRequest, relationship: WorkspaceRelationship | null) => ScopeAccessResult,
    private readonly coverageMatches: (request: z.infer<typeof CreateScopeInvitationsSchema>) => boolean,
    private readonly enqueueDirectory: (grant: ScopeGrant, now: number) => void) {
    this.invitations = new ScopeInvitationStorage(storage);
  }

  private canShare(targets: z.infer<typeof CreateScopeInvitationsSchema>["targets"], actor: WorkspaceRelationship | null): boolean {
    if (this.storage.sql.exec("SELECT 1 FROM main_participant_migration WHERE phase = 'pending'").toArray().length ||
      this.storage.sql.exec("SELECT 1 FROM child_participant_migrations WHERE phase = 'pending' LIMIT 1").toArray().length) return false;
    return actor !== null && targets.every((target) => {
      const access = this.resolve({ target, userId: actor.userId }, actor);
      return access.allowed && access.writable && access.grantIds.length > 0;
    });
  }

  private targetsReady(targets: z.infer<typeof CreateScopeInvitationsSchema>["targets"]): boolean {
    if (targets.some((target) => target.kind === "workstream") && this.storage.sql.exec(
      `SELECT 1 FROM conversation_children child LEFT JOIN child_participant_migrations migration
        ON migration.substream_id=child.substream_id
       WHERE child.kind='child' AND child.status='ready' AND child.audience='inherits_workstream'
         AND (migration.phase IS NULL OR migration.phase!='complete') LIMIT 1`,
    ).toArray().length > 0) return false;
    return targets.every((target) => {
      const phase = target.kind === "workstream" || target.substreamId === "0"
        ? this.storage.sql.exec<{ phase: string }>("SELECT phase FROM main_participant_migration WHERE singleton = 1").toArray()[0]?.phase
        : this.storage.sql.exec<{ phase: string }>("SELECT phase FROM child_participant_migrations WHERE substream_id = ?", target.substreamId).toArray()[0]?.phase;
      return phase === "complete";
    });
  }

  async list(input: z.infer<typeof ListScopeInvitationsSchema>) {
    const request = ListScopeInvitationsSchema.parse(input);
    const actor = await readWorkspaceRelationship(this.env.DB, request.target.workspaceId, request.actorUserId);
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
    const minted = await Promise.all([...new Set(request.emails)].map(async (email) => {
      const id = uuidV7();
      // Before the sharing checks and the transaction below, with every other
      // external await. A denied or replayed creation therefore leaves a row
      // addressing an invitation that never existed: inert, since opening it
      // reaches an owner that has no such invitation to offer.
      //
      // The token this returns is the invitation's acceptance secret as well as
      // the link's: the owner keeps its HMAC and the row keeps its digest, so
      // neither store holds anything a holder could present.
      const token = await issueScopeInvitationLink(this.env,
        { workspaceId: request.workspaceId, parentId: request.parentId, invitationId: id }, request.expiresAt);
      const link = scopeInvitationLinkUrl(origin, token);
      const delivery = { recipientEmail: email, ...scopeInvitationEmailParts({
        ...introduction, ...offered, recipientEmail: email, link: link.toString() }) };
      return { token, record: { id, email, grantOperationIds: request.targets.map(() => uuidV7()),
        tokenHash: await this.tokenHash(id, token),
        deliveryEncrypted: JSON.stringify(await encryptString(JSON.stringify(delivery), this.env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)) } };
    }));
    const actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId);
    // All external awaits precede local sharing checks and the transaction.
    const outcome = this.record(request, actor, minted.map((invitation) => invitation.record));
    // A denial, a replay and a conflict each leave rows addressing invitations
    // that were never recorded. They are inert, but a row with no expiry is
    // swept by nothing and reachable only by the token in hand right here, so
    // the path that orphans them is the only one that can take them back.
    if (!outcome.committed) await this.discard(request, minted.map((invitation) => invitation.token));
    return outcome.result;
  }

  /**
   * The local half of a creation: sharing, replay and coverage, then the
   * transaction. Split out so its caller can tell a creation that recorded the
   * links it minted from one that did not, which is not something the result
   * says — a replayed operation reports the invitations of the first attempt.
   */
  private record(request: z.infer<typeof CreateScopeInvitationsSchema>, actor: WorkspaceRelationship | null,
    prepared: Parameters<ScopeInvitationStorage["create"]>[2]): { result: ScopeInvitationResult; committed: boolean } {
    const not = (result: ScopeInvitationResult) => ({ result, committed: false });
    if (!actor || !this.canShare(request.targets, actor)) return not(denied("sharing_required"));
    if (!this.targetsReady(request.targets)) return not(denied("migration_pending"));
    try {
      const existing = this.invitations.operation(request);
      if (existing) return not({ status: "created", invitations: existing });
    } catch (error) {
      if (error instanceof ScopeInvitationOperationConflict) return not(denied("operation_conflict"));
      throw error;
    }
    if (request.completeWorkstream && !this.coverageMatches(request)) return not(denied("scope_changed"));
    if (request.expiresAt !== null && request.expiresAt <= Date.now()) return not(denied("invitation_unavailable"));
    return { result: { status: "created", invitations: this.invitations.create(request, actor.incarnation, prepared) },
      committed: true };
  }

  /** Reclaiming a link is housekeeping: a creation that was already denied is not failed over it. */
  private async discard(request: z.infer<typeof CreateScopeInvitationsSchema>, tokens: string[]): Promise<void> {
    try {
      await discardScopeInvitationLinks(this.env, tokens);
    } catch (error) {
      logStructuredEvent(this.env, "warn", "scope_invitation_link_discard_failed", {
        workspace_id: request.workspaceId, workstream_id: request.parentId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async accept(input: z.infer<typeof AcceptScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    const request = AcceptScopeInvitationSchema.parse(input);
    const initial = this.invitations.read(request.invitationId);
    if (!initial || !await timingSafeEqualText(initial.tokenHash, await this.tokenHash(request.invitationId, request.token))) {
      return denied("invitation_unavailable");
    }
    const verified = await this.env.DB.prepare("SELECT 1 AS present FROM user_verified_emails WHERE user_id = ? AND email = ?")
      .bind(request.userId, initial.summary.email).first();
    if (!verified) return denied("verified_email_required");
    if (!this.usable(initial)) return denied("invitation_unavailable");
    const blocked = await this.unofferable(initial);
    if (blocked) return denied(blocked);
    // Cross-authority saga: an interruption may leave a relationship without a
    // share. That grants no conversation access and a retry resumes this step.
    if (initial.summary.status === "accepted" && initial.summary.acceptedByUserId !== request.userId) return denied("invitation_unavailable");
    const recipient = initial.summary.status === "accepted"
      ? await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.userId)
      : await ensureGuestRelationship(this.env.DB, request.workspaceId, request.userId);
    if (recipient?.status !== "active") return denied("relationship_required");
    const currentActor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, initial.actorUserId);
    if (currentActor?.incarnation !== initial.actorIncarnation) return denied("sharing_required");
    return this.storage.transactionSync(() => {
      const current = this.invitations.read(request.invitationId);
      if (!current || !this.usable(current)) return denied("invitation_unavailable");
      if (current.summary.status === "accepted") {
        return current.summary.acceptedByUserId === request.userId && current.acceptedIncarnation === recipient.incarnation
          ? { status: "accepted", invitation: current.summary } : denied("invitation_unavailable");
      }
      if (!this.canShare(current.summary.targets, currentActor)) return denied("sharing_required");
      const grants = new ScopeGrantStorage(this.storage, request, this.enqueueDirectory);
      for (const [index, target] of current.summary.targets.entries()) {
        const operationId = current.grantOperationIds[index];
        if (!operationId) throw new Error("scope_invitation_grant_operation_missing");
        const result = grants.mutateCurrent({ operationId, target, userId: request.userId,
          actorUserId: asUserId(current.actorUserId), active: true }, recipient.incarnation);
        if (result.status !== "committed") throw new Error("scope_invitation_grant_not_committed");
      }
      return { status: "accepted", invitation: this.invitations.accept(request.invitationId, request.userId, recipient.incarnation) };
    });
  }

  /**
   * The invited mailbox, for a recipient who is not signed in yet and whose
   * link no longer spells out who it was addressed to. The secret is checked
   * first: an invitation id alone releases nothing.
   *
   * Expiry is checked here rather than through {@link usable}, which admits an
   * accepted invitation whatever its deadline so that acceptance stays
   * replayable for the person who already holds the grant. Replaying an
   * acceptance is idempotence; releasing a mailbox is a disclosure, and a
   * deadline that has passed ends it.
   *
   * Everything else acceptance would refuse it for is checked through the same
   * {@link offerable} predicate acceptance uses. A preview that outlives
   * acceptance's conditions is a mailbox oracle: it would keep naming who an
   * invitation was for after the sharer lost the share it rests on, which is
   * not something the holder could have found out by accepting.
   */
  async describe(input: z.infer<typeof DescribeScopeInvitationSchema>): Promise<ScopeInvitationDescription> {
    const request = DescribeScopeInvitationSchema.parse(input);
    const current = this.invitations.read(request.invitationId);
    const presented = await this.tokenHash(request.invitationId, request.token);
    const expired = current !== null && current.summary.expiresAt !== null && current.summary.expiresAt <= Date.now();
    if (!current || !timingSafeEqualText(current.tokenHash, presented) || expired || !this.usable(current)
      || await this.unofferable(current) !== null) {
      return ScopeInvitationDescriptionSchema.parse({ status: "denied", reason: "invitation_unavailable" });
    }
    return ScopeInvitationDescriptionSchema.parse({ status: "ready", email: current.summary.email });
  }

  async revoke(input: z.infer<typeof RevokeScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    const request = RevokeScopeInvitationSchema.parse(input);
    const actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId);
    const current = this.invitations.read(request.invitationId);
    if (!current) return denied("invitation_unavailable");
    if (!this.canShare(current.summary.targets, actor)) return denied("sharing_required");
    const invitation = this.invitations.revoke(request.invitationId, request.expectedRevision);
    return invitation ? { status: "revoked", invitation } : denied("revision_conflict");
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
   * The first target, because that is the destination acceptance navigates to:
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
        ? this.storage.sql.exec<{ title: string | null }>("SELECT title FROM workstream_metadata WHERE id = 1").toArray()[0]?.title ?? null
        : this.storage.sql.exec<{ title: string | null }>("SELECT title FROM conversation_children WHERE substream_id = ?", substreamId)
          .toArray()[0]?.title ?? null;
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
    if (!current || current.deliveredAt !== null || !this.usable(current) || current.summary.status !== "pending") return;
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
   * What still stops this invitation from being offered, or null: its targets
   * have finished their participant migration, and the sharer still holds the
   * share they offered, in the membership incarnation they offered it from.
   *
   * One predicate for both the preview and acceptance, because a preview that
   * outlives acceptance's conditions is a mailbox oracle. It returns the reason
   * rather than a boolean so acceptance can keep answering `migration_pending`
   * and `sharing_required` separately; the preview collapses every reason into
   * the one sentence it is allowed to say. Acceptance still re-reads the actor
   * inside its own flow and commits under that read — this is the gate they
   * share, not the whole of either.
   */
  private async unofferable(record: ScopeInvitationRecord): Promise<"migration_pending" | "sharing_required" | null> {
    if (!this.targetsReady(record.summary.targets)) return "migration_pending";
    const target = record.summary.targets[0];
    if (!target) return "sharing_required";
    const actor = await readWorkspaceRelationship(this.env.DB, target.workspaceId, record.actorUserId);
    return actor?.incarnation === record.actorIncarnation && this.canShare(record.summary.targets, actor)
      ? null : "sharing_required";
  }

  private usable(record: ScopeInvitationRecord): boolean {
    return record.summary.status !== "revoked" &&
      (record.summary.status === "accepted" || record.summary.expiresAt === null || record.summary.expiresAt > Date.now());
  }

  private tokenHash(id: string, token: string): Promise<string> {
    return hmacSha256(this.env.SESSION_SIGNING_KEY, JSON.stringify(["scope-invitation", id, token]));
  }
}
