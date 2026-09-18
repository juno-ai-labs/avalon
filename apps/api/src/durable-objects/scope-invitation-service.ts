import { z } from "zod";
import { asUserId } from "@rally/contracts";
import { ListScopeInvitationsSchema, ScopeInvitationsListSchema, CreateScopeInvitationsSchema, AcceptScopeInvitationSchema, RevokeScopeInvitationSchema,
  type ScopeAccessRequest, type ScopeAccessResult, type ScopeInvitationResult } from "@rally/contracts/scope-grants";
import type { Env } from "../env";
import { encryptString, decryptString, randomToken, hmacSha256, timingSafeEqualText } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";
import { ensureGuestRelationship, readWorkspaceRelationship, type WorkspaceRelationship } from "../services/workspace-relationship-service";
import { sendResendEmail } from "../services/resend";
import { ScopeInvitationStorage, ScopeInvitationOperationConflict, type ScopeInvitationRecord } from "./scope-invitation-storage";
import { ScopeGrantStorage } from "./scope-grant-storage";

const SealedSchema = z.strictObject({ ciphertext: z.string(), iv: z.string() });
const DeliverySchema = z.strictObject({ recipientEmail: z.string().email(), text: z.string() });
const denied = (reason: Extract<ScopeInvitationResult, { status: "denied" }>["reason"]): ScopeInvitationResult => ({ status: "denied", reason });

/** Product authority stays in the WorkstreamDO that owns the resulting grants. */
export class ScopeInvitationService {
  private readonly invitations: ScopeInvitationStorage;
  constructor(private readonly env: Env, private readonly storage: DurableObjectStorage,
    private readonly resolve: (request: ScopeAccessRequest, relationship: WorkspaceRelationship | null) => ScopeAccessResult,
    private readonly coverageMatches: (request: z.infer<typeof CreateScopeInvitationsSchema>) => boolean) {
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
    let origin: URL;
    try {
      origin = new URL(this.env.BROWSER_APP_ORIGIN ?? "");
      if (origin.origin !== this.env.BROWSER_APP_ORIGIN ||
        (origin.protocol !== "https:" && !(this.env.APP_ENV === "development" && origin.protocol === "http:")) ||
        !this.env.OAUTH_STATE_ENCRYPTION_KEY || !this.env.SESSION_SIGNING_KEY) throw new Error("configuration");
    } catch { return denied("configuration_required"); }
    const prepared = await Promise.all([...new Set(request.emails)].map(async (email) => {
      const id = uuidV7(), token = randomToken();
      const link = new URL("/invite", origin);
      link.hash = new URLSearchParams({ region: this.env.AVALON_REGION, workspace: request.workspaceId,
        workstream: request.parentId, invitation: id, token }).toString();
      const delivery = { recipientEmail: email, text: `You have been invited to collaborate in Rally.\n\nSign in with ${email} and accept:\n${link}\n\nThis invitation does not grant access until you sign in and accept it.` };
      return { id, email, grantOperationIds: request.targets.map(() => uuidV7()),
        tokenHash: await this.tokenHash(id, token),
        deliveryEncrypted: JSON.stringify(await encryptString(JSON.stringify(delivery), this.env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)) };
    }));
    const actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId);
    // All external awaits precede local sharing checks and the transaction.
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
    if (!this.targetsReady(initial.summary.targets)) return denied("migration_pending");
    const actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, initial.actorUserId);
    if (actor?.incarnation !== initial.actorIncarnation || !this.canShare(initial.summary.targets, actor)) return denied("sharing_required");
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
      const grants = new ScopeGrantStorage(this.storage, request);
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

  async revoke(input: z.infer<typeof RevokeScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    const request = RevokeScopeInvitationSchema.parse(input);
    const actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId);
    const current = this.invitations.read(request.invitationId);
    if (!current) return denied("invitation_unavailable");
    if (!this.canShare(current.summary.targets, actor)) return denied("sharing_required");
    const invitation = this.invitations.revoke(request.invitationId, request.expectedRevision);
    return invitation ? { status: "revoked", invitation } : denied("revision_conflict");
  }

  async deliver(id: string): Promise<void> {
    const current = this.invitations.read(id);
    if (!current || current.deliveredAt !== null || !this.usable(current) || current.summary.status !== "pending") return;
    const sealed = SealedSchema.parse(JSON.parse(current.deliveryEncrypted));
    const delivery = DeliverySchema.parse(JSON.parse(await decryptString(sealed.ciphertext, sealed.iv,
      this.env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)));
    await sendResendEmail(this.env, { ...delivery, subject: "An invitation to collaborate in Rally",
      idempotencyKey: `scope-invitation:${id}`, category: "scope_invitation", region: this.env.AVALON_REGION,
      sender: "transactional", errors: {
        unavailable: { code: "scope_invitation_delivery_unavailable", message: "Invitation email is not configured" },
        failed: { code: "scope_invitation_delivery_failed", message: "Invitation email could not be delivered" },
      } });
    this.invitations.acknowledgeDelivery(id);
  }

  private usable(record: ScopeInvitationRecord): boolean {
    return record.summary.status !== "revoked" &&
      (record.summary.status === "accepted" || record.summary.expiresAt === null || record.summary.expiresAt > Date.now());
  }

  private tokenHash(id: string, token: string): Promise<string> {
    return hmacSha256(this.env.SESSION_SIGNING_KEY, JSON.stringify(["scope-invitation", id, token]));
  }
}
