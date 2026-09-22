import {
  SidelineCatalogSchema,
  SidelineSendResponseSchema,
  UserIdSchema,
  WorkstreamIdSchema,
  type SidelineCatalog,
  type SidelineSendRequest,
  type SidelineSendResponse,
} from "@rally/contracts";

import { workspaceDOName, workstreamDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import { ConversationService } from "./conversation-service";

const SIDELINE_OPERATOR_EMAIL_DOMAIN = "rallywith.ai";

interface ActiveMember {
  userId: ReturnType<typeof UserIdSchema.parse>;
  name: string;
  avatarUrl: string | null;
  email: string;
  role: AuthContext["role"];
}

function representedAuth(auth: AuthContext, member: ActiveMember): AuthContext {
  return {
    sessionId: `impersonation:${auth.sessionId}`,
    userId: UserIdSchema.parse(member.userId),
    workspaceId: auth.workspaceId,
    region: auth.region,
    role: member.role,
    principal: "impersonation",
    analyticsWorkspaceId: auth.analyticsWorkspaceId ?? null,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The regional adapter for the platform relationship and ordinary message authority. */
export class ImpersonationService {
  constructor(private readonly env: Env, private readonly operator: AuthContext) {}

  private async workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.operator.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.operator.workspaceId),
    );
  }

  private async activeMember(userId: string): Promise<ActiveMember | null> {
    const row = await this.env.DB.prepare(
      `SELECT member.user_id, member.role, user.name, user.avatar_url, user.email
         FROM workspace_members member JOIN users user ON user.id = member.user_id
         JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = ? AND member.user_id = ? AND member.status = 'active'
          AND workspace.region = ? AND workspace.abandoned_at IS NULL`,
    ).bind(this.operator.workspaceId, userId, this.env.AVALON_REGION).first<{
      user_id: string;
      role: AuthContext["role"];
      name: string;
      avatar_url: string | null;
      email: string;
    }>();
    return row ? {
      userId: UserIdSchema.parse(row.user_id),
      role: row.role,
      name: row.name,
      avatarUrl: row.avatar_url,
      email: row.email,
    } : null;
  }

  private async requireOperator(): Promise<ActiveMember> {
    const operator = await this.activeMember(this.operator.userId);
    if (!operator || !operator.email.toLowerCase().endsWith(`@${SIDELINE_OPERATOR_EMAIL_DOMAIN}`)) {
      throw new ApiError(403, "sideline_access_denied", "Sideline access is not available for this account");
    }
    return operator;
  }

  private async relationship(representedUserId: string) {
    return (await (await this.workspace()).authorizeImpersonation({
      workspaceId: this.operator.workspaceId,
      impersonatorUserId: this.operator.userId,
      representedUserId,
    })).relationship;
  }

  async catalog(): Promise<SidelineCatalog> {
    const operator = await this.requireOperator();
    const [{ relationships }, workspace] = await Promise.all([
      (await this.workspace()).listImpersonationRelationships({
        workspaceId: this.operator.workspaceId,
        impersonatorUserId: this.operator.userId,
      }),
      this.env.DB.prepare("SELECT name FROM workspaces WHERE id = ? AND abandoned_at IS NULL")
        .bind(this.operator.workspaceId).first<{ name: string }>(),
    ]);
    if (!workspace) throw new ApiError(403, "workspace_unavailable", "This Organization is unavailable");

    const participant = async (member: ActiveMember, auth: AuthContext) => {
      const directory = new WorkstreamDirectoryService(this.env, auth);
      const workstreams = [];
      let cursor: string | undefined;
      do {
        const page = await directory.list(250, cursor);
        workstreams.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      const destinations = (await Promise.all(workstreams.map(async (workstream) => {
        const root = {
          workstreamId: workstream.id,
          substreamId: "0" as const,
          label: workstream.title,
          workstreamLabel: workstream.title,
        };
        const parent = await durableObjectStubForWorkspace(
          this.env,
          this.env.WORKSTREAM_DOS,
          this.operator.workspaceId,
          workstreamDOName(this.env.AVALON_REGION, this.operator.workspaceId, WorkstreamIdSchema.parse(workstream.id)),
        );
        const children = await parent.listVisiblePrivateChildren({
          workspaceId: this.operator.workspaceId,
          parentId: workstream.id,
          userId: member.userId,
        });
        return [root, ...children.children.map((child) => ({
          workstreamId: workstream.id,
          substreamId: child.substreamId,
          label: child.title,
          workstreamLabel: workstream.title,
        }))];
      }))).flat();
      return { userId: member.userId, name: member.name, avatarUrl: member.avatarUrl, destinations };
    };
    const [operatorParticipant, representedCandidates] = await Promise.all([
      participant(operator, this.operator),
      Promise.all(relationships
        .filter((relationship) => relationship.representedUserId !== operator.userId)
        .map(async (relationship) => {
          const member = await this.activeMember(relationship.representedUserId);
          return member ? participant(member, representedAuth(this.operator, member)) : null;
        })),
    ]);
    const represented = representedCandidates.filter((value): value is NonNullable<typeof value> => value !== null);
    const participants = [operatorParticipant, ...represented];

    return SidelineCatalogSchema.parse({
      workspace: { id: this.operator.workspaceId, name: workspace.name },
      operator: { userId: operator.userId, name: operator.name },
      participants,
    });
  }

  async send(input: SidelineSendRequest, requestReceivedAt?: number): Promise<SidelineSendResponse> {
    if (input.representedUserId === this.operator.userId) {
      await this.requireOperator();
      const conversations = new ConversationService(this.env, this.operator);
      const parent = await conversations.resolveParent(input.workstreamId);
      if (parent.kind !== "workstream") {
        throw new ApiError(404, "destination_not_found", "This destination is no longer available");
      }
      const client = await conversations.writableClient(input.workstreamId, input.substreamId);
      const receipt = await client.createMessage({
        text: input.message,
        clientMessageId: input.idempotencyKey,
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
        telemetryOperationId: input.idempotencyKey,
        ...(requestReceivedAt !== undefined ? { telemetryRequestReceivedAt: requestReceivedAt } : {}),
        telemetryJourney: "message_send",
      });
      return SidelineSendResponseSchema.parse({
        messageId: receipt.turn.turnId,
        createdAt: receipt.turn.createdAt,
      });
    }
    const contentDigest = await sha256Hex(input.message);
    const correlation = await sha256Hex([
      this.operator.workspaceId,
      this.operator.userId,
      input.representedUserId,
      input.workstreamId,
      input.substreamId,
      input.idempotencyKey,
      contentDigest,
    ].join(":"));
    const attemptAuditId = `impersonation:${correlation}:attempt`;
    const resultAuditId = (): string => `impersonation:${correlation}:result:${crypto.randomUUID()}`;
    const auditBase: Record<string, unknown> = {
      operatorUserId: this.operator.userId,
      representedUserId: input.representedUserId,
      destination: { workstreamId: input.workstreamId, substreamId: input.substreamId },
      idempotencyKey: input.idempotencyKey,
      app: input.app,
      contentDigest,
      traceCorrelationId: input.idempotencyKey,
    };
    await this.env.AUDIT_DB.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, workspace_id, actor_type, actor_user_id, workstream_id, action,
          target_type, target_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'impersonation.message.attempt',
               'represented_message', ?, ?, ?, ?)`,
    ).bind(
      attemptAuditId,
      this.operator.workspaceId,
      this.operator.userId,
      null,
      input.representedUserId,
      JSON.stringify({ ...auditBase, decision: "attempted" }),
      input.idempotencyKey,
      new Date().toISOString(),
    ).run();

    try {
      await this.requireOperator();
    } catch (error) {
      await this.recordOutcome(resultAuditId(), auditBase, "sideline_access_denied");
      throw error;
    }
    const represented = await this.activeMember(input.representedUserId);
    if (!represented) {
      await this.recordOutcome(resultAuditId(), auditBase, "represented_member_inactive");
      throw new ApiError(403, "represented_member_inactive", "This participant is no longer available");
    }
    const relationship = await this.relationship(input.representedUserId);
    if (!relationship) {
      await this.recordOutcome(resultAuditId(), auditBase, "impersonation_not_authorized");
      throw new ApiError(403, "impersonation_not_authorized", "You can no longer send as this participant");
    }
    auditBase.relationshipAuthorityBasis = relationship.authorityBasis;

    let validatedWorkstreamId: string | undefined;
    let receipt: Awaited<ReturnType<Awaited<ReturnType<ConversationService["writableClient"]>>["createMessage"]>>;
    try {
      const auth = representedAuth(this.operator, represented);
      const conversations = new ConversationService(this.env, auth);
      const parent = await conversations.resolveParent(input.workstreamId);
      if (parent.kind !== "workstream") {
        throw new ApiError(404, "destination_not_found", "This destination is no longer available");
      }
      validatedWorkstreamId = input.workstreamId;
      const client = await conversations.writableClient(input.workstreamId, input.substreamId);
      receipt = await client.createMessage({
        text: input.message,
        clientMessageId: input.idempotencyKey,
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
        telemetryOperationId: input.idempotencyKey,
        telemetryJourney: "message_send",
      });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "message_admission_failed";
      await this.recordOutcome(resultAuditId(), auditBase, code, undefined, validatedWorkstreamId);
      throw error;
    }
    await this.recordOutcome(resultAuditId(), auditBase, "accepted", receipt.turn.turnId, validatedWorkstreamId);
    return SidelineSendResponseSchema.parse({
      messageId: receipt.turn.turnId,
      createdAt: receipt.turn.createdAt,
    });
  }

  private async recordOutcome(
    auditId: string,
    base: Record<string, unknown>,
    outcome: string,
    messageId?: string,
    workstreamId?: string,
  ): Promise<void> {
    await this.env.AUDIT_DB.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, workspace_id, actor_type, actor_user_id, workstream_id, action,
          target_type, target_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'impersonation.message.result',
               'represented_message', ?, ?, ?, ?)`,
    ).bind(
      auditId,
      this.operator.workspaceId,
      this.operator.userId,
      workstreamId ?? null,
      base.representedUserId,
      JSON.stringify({ ...base, outcome, ...(messageId ? { messageId, turnId: messageId } : {}) }),
      base.idempotencyKey,
      new Date().toISOString(),
    ).run();
  }
}
