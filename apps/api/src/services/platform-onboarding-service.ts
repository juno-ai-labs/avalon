import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import {
  IanaTimezoneSchema,
  PendingWorkspaceInvitationSchema,
  SessionSchema,
  WorkspaceIdSchema,
  asWorkspaceId,
  WorkspaceSchema,
  type Region,
  type WorkspaceId,
  type Session,
  type WorkspaceOnboardingState,
} from "@rally/contracts";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { OffsetDateTimeSchema, RequiredUnknownSchema } from "@rally/contracts/schema-runtime";
import { newId, nowIso } from "@rally/db";
import { z } from "zod/v3";
import type { Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { sha256 } from "../lib/crypto";
import {
  deriveWorkspacePlacementAffinity,
  durableObjectStubForWorkspace,
  isWorkspacePlacementAffinityForRegion,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { AuthService } from "./auth-service";
import { acceptInvitationForUser, declineInvitationForUser } from "./workspace-service";
import {
  PreferenceProjectionSchema,
  applyRegionalPreferenceProjection,
  loadOrCreateCanonicalPreferenceProjection,
} from "../telemetry/preference";

export const platformIdentitySchema = z.object({
  platformUserId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  googleSubject: z.string().min(1).max(255),
  email: z.string().email().max(254),
  name: z.string().min(1).max(255),
  avatarUrl: HttpUrlSchema.nullable(),
  timezone: IanaTimezoneSchema,
  createdAt: OffsetDateTimeSchema,
});

const WorkspacePlacementAffinitySchema = z.enum(["wnam", "enam", "weur", "eeur"]);
const regionalWorkspaceSchema = WorkspaceSchema.extend({
  placementAffinity: WorkspacePlacementAffinitySchema,
});
const regionalPendingInvitationSchema = PendingWorkspaceInvitationSchema.extend({
  placementAffinity: WorkspacePlacementAffinitySchema,
});
type RegionalWorkspace = z.infer<typeof regionalWorkspaceSchema>;

const regionalDiscoverySchema = z.object({
  region: z.enum(["global", "eu"]),
  workspaces: z.array(regionalWorkspaceSchema),
  invitations: z.array(regionalPendingInvitationSchema),
});

const regionalActionBaseSchema = z.object({
  identity: platformIdentitySchema,
  operationId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  workspaceId: WorkspaceIdSchema,
  placementAffinity: WorkspacePlacementAffinitySchema,
  preference: PreferenceProjectionSchema,
});

export const regionalActivateSchema = regionalActionBaseSchema;
export const regionalCreateSchema = regionalActionBaseSchema.extend({
  name: z.string().trim().min(2).max(120),
});
export const regionalAcceptSchema = regionalActionBaseSchema.extend({
  invitationId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
});
export const regionalDeclineSchema = z.object({
  identity: platformIdentitySchema,
  invitationId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
});

export type PlatformIdentity = z.infer<typeof platformIdentitySchema>;
export type RegionalDiscovery = z.infer<typeof regionalDiscoverySchema>;
export type RegionalActivateInput = z.infer<typeof regionalActivateSchema>;
export type RegionalCreateInput = z.infer<typeof regionalCreateSchema>;
export type RegionalAcceptInput = z.infer<typeof regionalAcceptSchema>;
export type RegionalDeclineInput = z.infer<typeof regionalDeclineSchema>;

const regionalRpcBusinessStatusSchema = z.union([
  z.literal(400),
  z.literal(401),
  z.literal(403),
  z.literal(404),
  z.literal(409),
  z.literal(413),
  z.literal(422),
  z.literal(426),
  z.literal(429),
]);
const regionalRpcBusinessErrorSchema = z.object({
  status: regionalRpcBusinessStatusSchema,
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(1_000),
});
const regionalRpcEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: RequiredUnknownSchema }),
  z.object({ ok: z.literal(false), error: regionalRpcBusinessErrorSchema }),
]);

export type RegionalRpcBusinessError = z.infer<typeof regionalRpcBusinessErrorSchema>;
export type RegionalRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RegionalRpcBusinessError };

function isRegionalBusinessApiError(
  error: unknown,
): error is ApiError & { status: RegionalRpcBusinessError["status"] } {
  return error instanceof ApiError && (
    error.status === 400
    || error.status === 401
    || error.status === 403
    || error.status === 404
    || error.status === 409
    || error.status === 413
    || error.status === 422
    || error.status === 426
    || error.status === 429
  );
}

export async function serializeRegionalRpcResult<T>(
  operation: () => Promise<T>,
): Promise<RegionalRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (isRegionalBusinessApiError(error)) {
      return {
        ok: false,
        error: { status: error.status, code: error.code, message: error.message },
      };
    }
    throw error;
  }
}

/** Named WorkerEntrypoint RPC surface. It is intentionally not an HTTP route. */
export interface RegionalIdentityBridgeBinding {
  discover(identity: PlatformIdentity): Promise<RegionalDiscovery>;
  activate(input: RegionalActivateInput): Promise<Session>;
  create(input: RegionalCreateInput): Promise<Session>;
  accept(input: RegionalAcceptInput): Promise<Session>;
  decline(input: RegionalDeclineInput): Promise<{ ok: true }>;
}

/** Raw Cloudflare RPC surface. Business failures are data, never thrown errors. */
export interface RegionalIdentityBridgeRpcBinding {
  discover(identity: PlatformIdentity): Promise<RegionalRpcResult<RegionalDiscovery>>;
  activate(input: RegionalActivateInput): Promise<RegionalRpcResult<Session>>;
  create(input: RegionalCreateInput): Promise<RegionalRpcResult<Session>>;
  accept(input: RegionalAcceptInput): Promise<RegionalRpcResult<Session>>;
  decline(input: RegionalDeclineInput): Promise<RegionalRpcResult<{ ok: true }>>;
}

/** Converts the serialized RPC envelope back into the local service contract. */
export class RegionalIdentityBridgeClient implements RegionalIdentityBridgeBinding {
  constructor(private readonly rpc: RegionalIdentityBridgeRpcBinding) {}

  discover(identity: PlatformIdentity): Promise<RegionalDiscovery> {
    return this.call(this.rpc.discover(identity), regionalDiscoverySchema);
  }

  activate(input: RegionalActivateInput): Promise<Session> {
    return this.call(this.rpc.activate(input), SessionSchema);
  }

  create(input: RegionalCreateInput): Promise<Session> {
    return this.call(this.rpc.create(input), SessionSchema);
  }

  accept(input: RegionalAcceptInput): Promise<Session> {
    return this.call(this.rpc.accept(input), SessionSchema);
  }

  decline(input: RegionalDeclineInput): Promise<{ ok: true }> {
    return this.call(this.rpc.decline(input), z.object({ ok: z.literal(true) }));
  }

  private async call<T>(pending: Promise<unknown>, valueSchema: z.ZodType<T>): Promise<T> {
    // A thrown RPC exception or malformed response intentionally escapes as an
    // unknown error. The coordinator must treat its side-effect outcome as
    // ambiguous and keep the workspace reservation fail-closed.
    const envelope = regionalRpcEnvelopeSchema.parse(await pending);
    if (!envelope.ok) {
      throw new ApiError(envelope.error.status, envelope.error.code, envelope.error.message);
    }
    return valueSchema.parse(envelope.value);
  }
}

interface RegionalUserRow {
  id: string;
  platform_user_id: string | null;
  google_subject: string;
  email: string;
}

interface InvitationDiscoveryRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_region: Region;
  email: string;
  role: "admin" | "member";
  invited_by_name: string;
  expires_at: string;
  placement_affinity: WorkspacePlacementAffinity;
}

interface OperationRow {
  platform_user_id: string;
  action: "activate" | "accept" | "create";
  workspace_id: string;
  invitation_id: string | null;
}

function mapWorkspace(row: Record<string, unknown>): z.infer<typeof regionalWorkspaceSchema> {
  return regionalWorkspaceSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    region: row.region,
    role: row.role,
    timezone: row.timezone,
    createdAt: row.created_at,
    placementAffinity: row.placement_affinity,
  });
}

function mapPendingInvitation(
  row: InvitationDiscoveryRow,
): z.infer<typeof regionalPendingInvitationSchema> {
  return regionalPendingInvitationSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    region: row.workspace_region,
    email: row.email,
    role: row.role,
    invitedByName: row.invited_by_name,
    expiresAt: row.expires_at,
    placementAffinity: row.placement_affinity,
  });
}

function sameDestination(
  value: { region: Region; workspaceId: string },
  region: Region,
  workspaceId: string,
): boolean {
  return value.region === region && value.workspaceId === workspaceId;
}

/** Regional data-plane operations called either directly for Global or by RPC for EU. */
export class RegionalOnboardingService implements RegionalIdentityBridgeBinding {
  constructor(private readonly env: Env) {}

  async discover(rawIdentity: PlatformIdentity): Promise<RegionalDiscovery> {
    const identity = platformIdentitySchema.parse(rawIdentity);
    const user = await this.ensureRegionalUser(identity);
    const [workspaceResult, invitationResult] = await Promise.all([
      this.env.DB.prepare(
        `SELECT w.id, w.name, w.slug, w.region, w.timezone, w.created_at,
           w.placement_affinity, m.role
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? AND m.status = 'active' AND w.region = ?
           AND w.abandoned_at IS NULL
         ORDER BY m.joined_at, w.created_at, w.id`,
      ).bind(user.id, this.env.AVALON_REGION).all<Record<string, unknown>>(),
      this.env.DB.prepare(
        `SELECT i.id, i.workspace_id, w.name AS workspace_name,
           w.region AS workspace_region, w.placement_affinity, i.email, i.role,
           inviter.name AS invited_by_name, i.expires_at
         FROM workspace_invitations i
         JOIN workspaces w ON w.id = i.workspace_id
         JOIN users inviter ON inviter.id = i.invited_by_user_id
         WHERE i.email = ? COLLATE NOCASE
           AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
           AND w.region = ? AND w.abandoned_at IS NULL
         ORDER BY i.created_at DESC LIMIT 100`,
      ).bind(identity.email, nowIso(), this.env.AVALON_REGION).all<InvitationDiscoveryRow>(),
    ]);
    return regionalDiscoverySchema.parse({
      region: this.env.AVALON_REGION,
      workspaces: (workspaceResult.results ?? []).map(mapWorkspace),
      invitations: (invitationResult.results ?? []).map(mapPendingInvitation),
    });
  }

  async activate(rawInput: RegionalActivateInput): Promise<Session> {
    const input = regionalActivateSchema.parse(rawInput);
    this.requireCompatiblePlacementAffinity(input.placementAffinity);
    const user = await this.ensureRegionalUser(input.identity);
    await applyRegionalPreferenceProjection(this.env, user.id, input.preference);
    await this.requirePlacementAffinity(input.workspaceId, input.placementAffinity);
    await this.requireMembership(user.id, input.workspaceId);
    await this.initializeWorkspaceObject(input.workspaceId, input.placementAffinity);
    // Activation is a read/verify plus fresh session issue. It intentionally
    // does not claim the action journal because the binding's operation may
    // have originally been a create or invitation acceptance.
    return new AuthService(this.env).createRegionalSession(user.id, input.workspaceId);
  }

  async create(rawInput: RegionalCreateInput): Promise<Session> {
    const input = regionalCreateSchema.parse(rawInput);
    this.requireCompatiblePlacementAffinity(input.placementAffinity);
    const user = await this.ensureRegionalUser(input.identity);
    await applyRegionalPreferenceProjection(this.env, user.id, input.preference);
    const replay = await this.loadOperation(input.operationId);
    if (replay) {
      this.assertOperation(replay, input, "create", null);
      await this.requireMembership(user.id, input.workspaceId);
      await this.requirePlacementAffinity(input.workspaceId, input.placementAffinity);
      await this.initializeWorkspaceObject(input.workspaceId, input.placementAffinity);
      return new AuthService(this.env).createRegionalSession(user.id, input.workspaceId);
    }

    const at = nowIso();
    const slugBase = input.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40) || "workspace";
    const slug = `${slugBase}-${input.workspaceId.slice(0, 8)}`;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO workspaces
         (id, name, slug, region, timezone, placement_affinity,
          created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.workspaceId,
        input.name,
        slug,
        this.env.AVALON_REGION,
        this.env.AVALON_REGION === "eu" ? "Europe/London" : "America/Los_Angeles",
        input.placementAffinity,
        user.id,
        at,
        at,
      ),
      this.env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         SELECT ?, ?, 'owner', 'active', ?
         WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND region = ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = 'active'`,
      ).bind(input.workspaceId, user.id, at, input.workspaceId, this.env.AVALON_REGION),
      this.operationStatement(input, "create", null, at),
    ]);
    await this.requireMembership(user.id, input.workspaceId);
    await this.requirePlacementAffinity(input.workspaceId, input.placementAffinity);
    await this.initializeWorkspaceObject(input.workspaceId, input.placementAffinity);
    return new AuthService(this.env).createRegionalSession(user.id, input.workspaceId);
  }

  async accept(rawInput: RegionalAcceptInput): Promise<Session> {
    const input = regionalAcceptSchema.parse(rawInput);
    this.requireCompatiblePlacementAffinity(input.placementAffinity);
    const user = await this.ensureRegionalUser(input.identity);
    await applyRegionalPreferenceProjection(this.env, user.id, input.preference);
    await this.requirePlacementAffinity(input.workspaceId, input.placementAffinity);
    const replay = await this.loadOperation(input.operationId);
    if (replay) {
      this.assertOperation(replay, input, "accept", input.invitationId);
      await this.requireMembership(user.id, input.workspaceId);
      return new AuthService(this.env).createRegionalSession(user.id, input.workspaceId);
    }

    const acceptedWorkspaceId = await acceptInvitationForUser(this.env, input.invitationId, {
      id: user.id,
      email: input.identity.email,
      name: input.identity.name,
    });
    if (acceptedWorkspaceId !== input.workspaceId) {
      throw new ApiError(409, "invitation_workspace_mismatch", "The invitation changed while it was being accepted");
    }
    await this.recordOperation(input, "accept", input.invitationId);
    return new AuthService(this.env).createRegionalSession(user.id, input.workspaceId);
  }

  async decline(rawInput: RegionalDeclineInput): Promise<{ ok: true }> {
    const input = regionalDeclineSchema.parse(rawInput);
    const user = await this.ensureRegionalUser(input.identity);
    await declineInvitationForUser(this.env, input.invitationId, {
      id: user.id,
      email: input.identity.email,
      name: input.identity.name,
    });
    return { ok: true };
  }

  private async ensureRegionalUser(identity: PlatformIdentity): Promise<RegionalUserRow> {
    let user = await this.env.DB.prepare(
      "SELECT id, platform_user_id, google_subject, email FROM users WHERE platform_user_id = ?",
    ).bind(identity.platformUserId).first<RegionalUserRow>();
    if (user) {
      if (user.google_subject !== identity.googleSubject) {
        throw new ApiError(409, "regional_identity_conflict", "The regional identity link does not match this account");
      }
      await this.syncRegionalProfile(user.id, identity);
      return { ...user, email: identity.email };
    }

    user = await this.env.DB.prepare(
      "SELECT id, platform_user_id, google_subject, email FROM users WHERE google_subject = ?",
    ).bind(identity.googleSubject).first<RegionalUserRow>();
    if (user) {
      if (user.platform_user_id && user.platform_user_id !== identity.platformUserId) {
        throw new ApiError(409, "regional_identity_conflict", "The regional identity is already linked to another account");
      }
      const result = await this.env.DB.prepare(
        `UPDATE users SET platform_user_id = ?, email = ?, name = ?, avatar_url = ?, updated_at = ?
         WHERE id = ? AND (platform_user_id IS NULL OR platform_user_id = ?)`,
      ).bind(
        identity.platformUserId,
        identity.email,
        identity.name,
        identity.avatarUrl,
        nowIso(),
        user.id,
        identity.platformUserId,
      ).run();
      if (Number(result.meta.changes ?? 0) !== 1) {
        throw new ApiError(409, "regional_identity_conflict", "The regional identity could not be linked safely");
      }
      return { ...user, platform_user_id: identity.platformUserId, email: identity.email };
    }

    const id = newId();
    const at = nowIso();
    try {
      await this.env.DB.prepare(
        `INSERT INTO users
         (id, google_subject, email, name, avatar_url, timezone, created_at, updated_at, platform_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        identity.googleSubject,
        identity.email,
        identity.name,
        identity.avatarUrl,
        identity.timezone,
        at,
        at,
        identity.platformUserId,
      ).run();
    } catch {
      const raced = await this.env.DB.prepare(
        "SELECT id, platform_user_id, google_subject, email FROM users WHERE platform_user_id = ?",
      ).bind(identity.platformUserId).first<RegionalUserRow>();
      if (!raced || raced.google_subject !== identity.googleSubject) {
        throw new ApiError(409, "regional_identity_conflict", "The regional identity could not be linked safely");
      }
      return raced;
    }
    return {
      id,
      platform_user_id: identity.platformUserId,
      google_subject: identity.googleSubject,
      email: identity.email,
    };
  }

  private async syncRegionalProfile(userId: string, identity: PlatformIdentity): Promise<void> {
    try {
      await this.env.DB.prepare(
        "UPDATE users SET email = ?, name = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
      ).bind(identity.email, identity.name, identity.avatarUrl, nowIso(), userId).run();
    } catch {
      throw new ApiError(409, "regional_identity_conflict", "The verified account profile conflicts with a regional identity");
    }
  }

  private async requireMembership(userId: string, workspaceId: string): Promise<void> {
    const membership = await this.env.DB.prepare(
      `SELECT 1 AS present FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND m.workspace_id = ? AND m.status = 'active'
         AND w.region = ? AND w.abandoned_at IS NULL`,
    ).bind(userId, workspaceId, this.env.AVALON_REGION).first<{ present: number }>();
    if (!membership) throw new ApiError(403, "workspace_access_denied", "Workspace access is unavailable");
  }

  private async requirePlacementAffinity(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<void> {
    const workspace = await this.env.DB.prepare(
      "SELECT region, placement_affinity FROM workspaces WHERE id = ? AND region = ?",
    ).bind(workspaceId, this.env.AVALON_REGION).first<{
      region: Region;
      placement_affinity: string;
    }>();
    if (
      !workspace
      || workspace.placement_affinity !== placementAffinity
      || !isWorkspacePlacementAffinityForRegion(workspace.region, placementAffinity)
    ) {
      throw new ApiError(
        409,
        "workspace_placement_affinity_conflict",
        "The workspace placement route does not match its regional authority",
      );
    }
  }

  private requireCompatiblePlacementAffinity(
    placementAffinity: WorkspacePlacementAffinity,
  ): void {
    if (!isWorkspacePlacementAffinityForRegion(this.env.AVALON_REGION, placementAffinity)) {
      throw new ApiError(
        400,
        "workspace_placement_affinity_invalid",
        "The workspace placement route is invalid for this regional service",
      );
    }
  }

  private async initializeWorkspaceObject(
    workspaceId: WorkspaceId,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<void> {
    const workspaceObject = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(this.env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    await workspaceObject.initializeWorkspace(workspaceId, placementAffinity);
  }

  private async loadOperation(operationId: string): Promise<OperationRow | null> {
    return this.env.DB.prepare(
      `SELECT platform_user_id, action, workspace_id, invitation_id
       FROM regional_onboarding_operations WHERE operation_id = ?`,
    ).bind(operationId).first<OperationRow>();
  }

  private assertOperation(
    row: OperationRow,
    input: RegionalActionInput,
    action: OperationRow["action"],
    invitationId: string | null,
  ): void {
    if (
      row.platform_user_id !== input.identity.platformUserId
      || row.action !== action
      || row.workspace_id !== input.workspaceId
      || row.invitation_id !== invitationId
    ) {
      throw new ApiError(409, "onboarding_operation_conflict", "The onboarding operation was already used for another action");
    }
  }

  private operationStatement(
    input: RegionalActionInput,
    action: OperationRow["action"],
    invitationId: string | null,
    at = nowIso(),
  ): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO regional_onboarding_operations
       (operation_id, platform_user_id, action, workspace_id, invitation_id, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
    ).bind(
      input.operationId,
      input.identity.platformUserId,
      action,
      input.workspaceId,
      invitationId,
      at,
      at,
    );
  }

  private async recordOperation(
    input: RegionalActionInput,
    action: OperationRow["action"],
    invitationId: string | null,
  ): Promise<void> {
    await this.operationStatement(input, action, invitationId).run();
    const stored = await this.loadOperation(input.operationId);
    if (!stored) throw new ApiError(500, "onboarding_operation_failed", "The onboarding operation could not be recorded");
    this.assertOperation(stored, input, action, invitationId);
  }
}

type RegionalActionInput = RegionalActivateInput | RegionalCreateInput | RegionalAcceptInput;

export interface PlatformBindingRow {
  platform_user_id: string;
  region: Region;
  workspace_id: string;
  placement_affinity: WorkspacePlacementAffinity;
  status: "pending" | "active" | "inactive";
  operation_id: string;
  pending_expires_at: string | null;
}

export interface PlatformBindingStore {
  list(platformUserId: string): Promise<PlatformBindingRow[]>;
  reconcile(
    platformUserId: string,
    destinations: readonly {
      region: Region;
      workspaceId: string;
      placementAffinity: WorkspacePlacementAffinity;
      operationId: string;
    }[],
  ): Promise<PlatformBindingRow[]>;
  reserve(
    platformUserId: string,
    region: Region,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
    operationId: string,
  ): Promise<PlatformBindingRow>;
  activate(platformUserId: string, operationId: string): Promise<void>;
  release(platformUserId: string, operationId: string): Promise<void>;
}

export class D1PlatformBindingStore implements PlatformBindingStore {
  constructor(private readonly db: D1Database, private readonly now: () => Date = () => new Date()) {}

  async list(platformUserId: string): Promise<PlatformBindingRow[]> {
    const result = await this.db.prepare(
      `SELECT platform_user_id, region, workspace_id, placement_affinity, status,
              operation_id, pending_expires_at
       FROM platform_workspace_bindings
       WHERE platform_user_id = ?
       ORDER BY created_at, region, workspace_id`,
    ).bind(platformUserId).all<PlatformBindingRow>();
    return result.results ?? [];
  }

  async reconcile(
    platformUserId: string,
    destinations: readonly {
      region: Region;
      workspaceId: string;
      placementAffinity: WorkspacePlacementAffinity;
      operationId: string;
    }[],
  ): Promise<PlatformBindingRow[]> {
    const current = await this.list(platformUserId);
    const destinationKeys = new Set(destinations.map((item) => `${item.region}:${item.workspaceId}`));
    const statements: D1PreparedStatement[] = [];
    const at = this.now().toISOString();

    for (const destination of destinations) {
      if (!isWorkspacePlacementAffinityForRegion(destination.region, destination.placementAffinity)) {
        throw new ApiError(409, "workspace_binding_conflict", "The workspace placement route conflicts with its binding");
      }
      const existing = current.find((row) => sameDestination(
        { region: row.region, workspaceId: row.workspace_id },
        destination.region,
        destination.workspaceId,
      ));
      if (existing && existing.placement_affinity !== destination.placementAffinity) {
        throw new ApiError(409, "workspace_binding_conflict", "The workspace placement route conflicts with its binding");
      }
      if (existing) {
        if (existing.status !== "active") {
          statements.push(this.db.prepare(
            `UPDATE platform_workspace_bindings
             SET status = 'active', pending_expires_at = NULL, updated_at = ?
             WHERE platform_user_id = ? AND region = ? AND workspace_id = ?`,
          ).bind(at, platformUserId, destination.region, destination.workspaceId));
        }
      } else {
        statements.push(this.db.prepare(
          `INSERT INTO platform_workspace_bindings
           (platform_user_id, region, workspace_id, placement_affinity, status,
            operation_id, pending_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)`,
        ).bind(
          platformUserId,
          destination.region,
          destination.workspaceId,
          destination.placementAffinity,
          destination.operationId,
          at,
          at,
        ));
      }
    }

    for (const row of current) {
      if (row.status === "pending") continue;
      if (destinationKeys.has(`${row.region}:${row.workspace_id}`)) continue;
      if (row.status !== "inactive") {
        statements.push(this.db.prepare(
          `UPDATE platform_workspace_bindings SET status = 'inactive', updated_at = ?
           WHERE platform_user_id = ? AND region = ? AND workspace_id = ?
             AND status IN ('active', 'inactive')`,
        ).bind(at, platformUserId, row.region, row.workspace_id));
      }
    }

    if (statements.length > 0) await this.db.batch(statements);
    return this.list(platformUserId);
  }

  async reserve(
    platformUserId: string,
    region: Region,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
    operationId: string,
  ): Promise<PlatformBindingRow> {
    if (!isWorkspacePlacementAffinityForRegion(region, placementAffinity)) {
      throw new ApiError(400, "workspace_placement_affinity_invalid", "The workspace placement route is invalid");
    }
    const at = this.now().toISOString();
    // Diagnostic deadline for operators and observability only. Unknown RPC
    // outcomes are never reclaimed automatically because the old EU action
    // could still commit after an apparent timeout.
    const expiresAt = new Date(this.now().getTime() + 2 * 60_000).toISOString();
    await this.db.prepare(
      `UPDATE platform_workspace_bindings
       SET status = 'pending', operation_id = ?, pending_expires_at = ?, updated_at = ?
       WHERE platform_user_id = ? AND region = ? AND workspace_id = ? AND status = 'inactive'
         AND NOT EXISTS (
           SELECT 1 FROM platform_workspace_bindings
           WHERE platform_user_id = ? AND status = 'pending'
         )`,
    ).bind(
      operationId,
      expiresAt,
      at,
      platformUserId,
      region,
      workspaceId,
      platformUserId,
    ).run();
    await this.db.prepare(
      `INSERT OR IGNORE INTO platform_workspace_bindings
       (platform_user_id, region, workspace_id, placement_affinity, status, operation_id,
        pending_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
       `,
    ).bind(
      platformUserId,
      region,
      workspaceId,
      placementAffinity,
      operationId,
      expiresAt,
      at,
      at,
    ).run();
    const rows = await this.list(platformUserId);
    const exact = rows.find((row) => sameDestination(
      { region: row.region, workspaceId: row.workspace_id },
      region,
      workspaceId,
    ));
    const row = exact ?? rows.find((candidate) => candidate.status === "pending");
    if (!row) throw new ApiError(503, "workspace_binding_unavailable", "The workspace selection could not be reserved");
    return row;
  }

  async activate(platformUserId: string, operationId: string): Promise<void> {
    const result = await this.db.prepare(
      `UPDATE platform_workspace_bindings
       SET status = 'active', pending_expires_at = NULL, updated_at = ?
       WHERE platform_user_id = ? AND operation_id = ? AND status = 'pending'`,
    ).bind(this.now().toISOString(), platformUserId, operationId).run();
    if (Number(result.meta.changes ?? 0) === 1) return;
    const row = (await this.list(platformUserId)).find((candidate) => candidate.operation_id === operationId);
    if (!row || row.status !== "active" || row.operation_id !== operationId) {
      throw new ApiError(409, "workspace_binding_conflict", "The workspace route conflicts with this Rally account");
    }
  }

  async release(platformUserId: string, operationId: string): Promise<void> {
    await this.db.prepare(
      `DELETE FROM platform_workspace_bindings
       WHERE platform_user_id = ? AND operation_id = ? AND status = 'pending'`,
    ).bind(platformUserId, operationId).run();
  }

}

export interface PlatformOperationRow {
  operation_id: string;
  platform_user_id: string;
  action: "create" | "accept";
  request_fingerprint: string;
  region: Region;
  workspace_id: string;
  placement_affinity: WorkspacePlacementAffinity;
  invitation_id: string | null;
  status: "pending" | "complete";
}

export interface PlatformOperationStore {
  get(operationId: string): Promise<PlatformOperationRow | null>;
  begin(row: PlatformOperationRow): Promise<PlatformOperationRow>;
  complete(platformUserId: string, operationId: string): Promise<void>;
}

export class D1PlatformOperationStore implements PlatformOperationStore {
  constructor(private readonly db: D1Database, private readonly now: () => Date = () => new Date()) {}

  get(operationId: string): Promise<PlatformOperationRow | null> {
    return this.db.prepare(
      `SELECT operation_id, platform_user_id, action, request_fingerprint, region,
              workspace_id, placement_affinity, invitation_id, status
       FROM platform_workspace_operations WHERE operation_id = ?`,
    ).bind(operationId).first<PlatformOperationRow>();
  }

  async begin(row: PlatformOperationRow): Promise<PlatformOperationRow> {
    const at = this.now().toISOString();
    await this.db.prepare(
      `INSERT OR IGNORE INTO platform_workspace_operations
       (operation_id, platform_user_id, action, request_fingerprint, region,
        workspace_id, placement_affinity, invitation_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      row.operation_id,
      row.platform_user_id,
      row.action,
      row.request_fingerprint,
      row.region,
      row.workspace_id,
      row.placement_affinity,
      row.invitation_id,
      at,
      at,
    ).run();
    const stored = await this.get(row.operation_id);
    if (!stored) throw new ApiError(503, "workspace_operation_unavailable", "Workspace setup could not be reserved");
    return stored;
  }

  async complete(platformUserId: string, operationId: string): Promise<void> {
    const result = await this.db.prepare(
      `UPDATE platform_workspace_operations SET status = 'complete', updated_at = ?
       WHERE operation_id = ? AND platform_user_id = ?`,
    ).bind(this.now().toISOString(), operationId, platformUserId).run();
    if (Number(result.meta.changes ?? 0) === 1) return;
    const stored = await this.get(operationId);
    if (!stored || stored.platform_user_id !== platformUserId || stored.status !== "complete") {
      throw new ApiError(409, "onboarding_operation_conflict", "The onboarding operation could not be completed");
    }
  }
}

export interface PlatformOnboardingDependencies {
  gateways?: Partial<Record<Region, RegionalIdentityBridgeBinding>>;
  bindings?: PlatformBindingStore;
  operations?: PlatformOperationStore;
  newId?: () => string;
}

/** Global-only identity/control-plane coordinator. */
export class PlatformOnboardingService {
  private readonly gateways: Record<Region, RegionalIdentityBridgeBinding>;
  private readonly bindings: PlatformBindingStore;
  private readonly operations: PlatformOperationStore;
  private readonly createId: () => string;

  constructor(
    private readonly env: Env,
    private readonly auth: IdentityAuthContext,
    dependencies: PlatformOnboardingDependencies = {},
  ) {
    this.requireGlobalControlPlane();
    const euRpc = env.EU_IDENTITY_BRIDGE;
    const eu = dependencies.gateways?.eu ?? (euRpc ? new RegionalIdentityBridgeClient(euRpc) : undefined);
    if (!eu) {
      throw new ApiError(503, "regional_onboarding_unavailable", "The European Union onboarding service is unavailable");
    }
    this.gateways = {
      global: dependencies.gateways?.global ?? new RegionalOnboardingService(env),
      eu,
    };
    this.bindings = dependencies.bindings ?? new D1PlatformBindingStore(env.DB);
    this.operations = dependencies.operations ?? new D1PlatformOperationStore(env.DB);
    this.createId = dependencies.newId ?? newId;
  }

  async state(): Promise<WorkspaceOnboardingState> {
    const identity = await this.loadPlatformIdentity();
    const discovery = await this.discover(identity);
    const workspaces = await this.reconcileWorkspaceBindings(identity.platformUserId, discovery);
    return {
      // Compatibility for desktop builds released before plural discovery.
      workspace: workspaces[0] ?? null,
      workspaces,
      invitations: discovery.flatMap((item) => item.invitations),
    };
  }

  async activate(region: Region, workspaceId: string): Promise<Session> {
    const identity = await this.loadPlatformIdentity();
    const discovery = await this.discover(identity);
    const workspace = discovery.flatMap((item) => item.workspaces)
      .find((item) => item.region === region && item.id === workspaceId);
    if (!workspace) throw new ApiError(403, "workspace_access_denied", "Workspace access is unavailable");
    await this.reconcileWorkspaceBindings(identity.platformUserId, discovery);
    return this.issueExistingSession(
      identity,
      region,
      workspaceId,
      workspace.placementAffinity,
    );
  }

  async createWorkspace(
    name: string,
    region: Region,
    requestLocation?: unknown,
    requestedOperationId?: string,
  ): Promise<Session> {
    const identity = await this.loadPlatformIdentity();
    const requestFingerprint = await sha256(JSON.stringify(["create", region, name]));
    let operationId: string;
    let existing = requestedOperationId ? await this.operations.get(requestedOperationId) : null;
    let workspaceId: string;
    let placementAffinity: WorkspacePlacementAffinity;
    if (existing) {
      operationId = existing.operation_id;
      this.assertPlatformOperation(existing, identity.platformUserId, "create", requestFingerprint, region, null);
      workspaceId = existing.workspace_id;
      placementAffinity = existing.placement_affinity;
    } else {
      workspaceId = this.createId();
      operationId = requestedOperationId ?? this.createId();
      placementAffinity = deriveWorkspacePlacementAffinity(region, requestLocation).affinity;
      existing = await this.operations.begin({
        operation_id: operationId,
        platform_user_id: identity.platformUserId,
        action: "create",
        request_fingerprint: requestFingerprint,
        region,
        workspace_id: workspaceId,
        placement_affinity: placementAffinity,
        invitation_id: null,
        status: "pending",
      });
      this.assertPlatformOperation(existing, identity.platformUserId, "create", requestFingerprint, region, null);
      workspaceId = existing.workspace_id;
      placementAffinity = existing.placement_affinity;
    }
    return this.completeRegionalAction(
      identity,
      region,
      workspaceId,
      placementAffinity,
      operationId,
      (regionalOperationId, preference) => this.gateways[region].create({
        identity,
        operationId: regionalOperationId,
        workspaceId: asWorkspaceId(workspaceId),
        name,
        placementAffinity,
        preference,
      }),
    );
  }

  async acceptInvitation(
    invitationId: string,
    region: Region,
    requestedOperationId?: string,
  ): Promise<Session> {
    const identity = await this.loadPlatformIdentity();
    const requestFingerprint = await sha256(JSON.stringify(["accept", region, invitationId]));
    const operationId = requestedOperationId ?? this.createId();
    let operation = await this.operations.get(operationId);
    if (operation) {
      this.assertPlatformOperation(
        operation,
        identity.platformUserId,
        "accept",
        requestFingerprint,
        region,
        invitationId,
      );
    } else {
      const discovery = await this.discover(identity);
      const invitation = discovery.flatMap((item) => item.invitations)
        .find((item) => item.id === invitationId && item.region === region);
      if (!invitation) {
        throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
      }
      // Leaving is regional authority and deliberately does not synchronously
      // mutate the Global route. Reconcile the discovery that proved this is a
      // new acceptance before reserving, so a stale `active` route cannot turn
      // a valid re-invitation into an activation of membership that no longer
      // exists.
      await this.reconcileWorkspaceBindings(identity.platformUserId, discovery);
      operation = await this.operations.begin({
        operation_id: operationId,
        platform_user_id: identity.platformUserId,
        action: "accept",
        request_fingerprint: requestFingerprint,
        region,
        workspace_id: invitation.workspaceId,
        placement_affinity: invitation.placementAffinity,
        invitation_id: invitationId,
        status: "pending",
      });
      this.assertPlatformOperation(
        operation,
        identity.platformUserId,
        "accept",
        requestFingerprint,
        region,
        invitationId,
      );
    }
    return this.completeRegionalAction(
      identity,
      region,
      operation.workspace_id,
      operation.placement_affinity,
      operationId,
      (regionalOperationId, preference) => this.gateways[region].accept({
        identity,
        operationId: regionalOperationId,
        workspaceId: asWorkspaceId(operation.workspace_id),
        invitationId,
        placementAffinity: operation.placement_affinity,
        preference,
      }),
    );
  }

  async declineInvitation(invitationId: string, region: Region): Promise<void> {
    const identity = await this.loadPlatformIdentity();
    await this.gateways[region].decline({ identity, invitationId });
  }

  private requireGlobalControlPlane(): void {
    if (this.env.AVALON_REGION !== "global" || this.auth.region !== "global") {
      throw new ApiError(409, "global_identity_required", "Sign in through the Rally platform before choosing a workspace");
    }
  }

  private async loadPlatformIdentity(): Promise<PlatformIdentity> {
    const row = await this.env.DB.prepare(
      `SELECT id, google_subject, email, name, avatar_url, timezone, created_at, platform_user_id
       FROM users WHERE id = ?`,
    ).bind(this.auth.userId).first<{
      id: string;
      google_subject: string;
      email: string;
      name: string;
      avatar_url: string | null;
      timezone: string;
      created_at: string;
      platform_user_id: string | null;
    }>();
    if (!row) throw new ApiError(401, "identity_not_found", "The signed-in user no longer exists");
    if (row.platform_user_id && row.platform_user_id !== row.id) {
      throw new ApiError(409, "platform_identity_conflict", "The Global identity record is not canonical");
    }
    if (!row.platform_user_id) {
      const result = await this.env.DB.prepare(
        "UPDATE users SET platform_user_id = ?, updated_at = ? WHERE id = ? AND platform_user_id IS NULL",
      ).bind(row.id, nowIso(), row.id).run();
      if (Number(result.meta.changes ?? 0) !== 1) {
        const winner = await this.env.DB.prepare("SELECT platform_user_id FROM users WHERE id = ?")
          .bind(row.id).first<{ platform_user_id: string | null }>();
        if (winner?.platform_user_id !== row.id) {
          throw new ApiError(409, "platform_identity_conflict", "The Global identity could not be linked safely");
        }
      }
    }
    return platformIdentitySchema.parse({
      platformUserId: row.id,
      googleSubject: row.google_subject,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      timezone: row.timezone,
      createdAt: row.created_at,
    });
  }

  private async discover(identity: PlatformIdentity): Promise<RegionalDiscovery[]> {
    try {
      return await Promise.all([
        this.gateways.global.discover(identity),
        this.gateways.eu.discover(identity),
      ]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "regional_onboarding_unavailable", "A regional onboarding service is unavailable");
    }
  }

  private async reconcileWorkspaceBindings(
    platformUserId: string,
    discovery: RegionalDiscovery[],
  ): Promise<RegionalWorkspace[]> {
    const workspaces = discovery.flatMap((item) => item.workspaces);
    const unique = new Map(workspaces.map((workspace) => [`${workspace.region}:${workspace.id}`, workspace]));
    const ordered = [...unique.values()];
    const current = await this.bindings.list(platformUserId);
    await this.bindings.reconcile(platformUserId, ordered.map((workspace) => ({
      region: workspace.region,
      workspaceId: workspace.id,
      placementAffinity: workspace.placementAffinity,
      operationId: current.find((binding) => sameDestination(
        { region: binding.region, workspaceId: binding.workspace_id },
        workspace.region,
        workspace.id,
      ))?.operation_id ?? this.createId(),
    })));
    return ordered;
  }

  private async completeRegionalAction(
    identity: PlatformIdentity,
    region: Region,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
    operationId: string,
    action: (
      operationId: string,
      preference: z.infer<typeof PreferenceProjectionSchema>,
    ) => Promise<Session>,
  ): Promise<Session> {
    const preference = await loadOrCreateCanonicalPreferenceProjection(
      this.env,
      identity.platformUserId,
    );
    const reservation = await this.bindings.reserve(
      identity.platformUserId,
      region,
      workspaceId,
      placementAffinity,
      operationId,
    );
    if (!sameDestination({ region: reservation.region, workspaceId: reservation.workspace_id }, region, workspaceId)) {
      throw new ApiError(409, "workspace_binding_conflict", "The workspace route conflicts with this Rally account");
    }
    if (reservation.placement_affinity !== placementAffinity) {
      throw new ApiError(409, "workspace_binding_conflict", "The workspace placement route conflicts with its binding");
    }
    if (reservation.status === "active") {
      return this.issueExistingSession(identity, region, workspaceId, placementAffinity);
    }
    if (reservation.operation_id !== operationId) {
      throw new ApiError(409, "workspace_setup_in_progress", "Workspace setup is already in progress");
    }

    let session: Session;
    try {
      session = await action(operationId, preference);
    } catch (error) {
      // Only a validated RPC business-error envelope becomes ApiError here.
      // It proves the regional action was rejected, so the reservation is safe
      // to release. Thrown RPC/runtime errors have unknown side-effect outcome.
      if (error instanceof ApiError && error.status < 500) {
        await this.bindings.release(identity.platformUserId, operationId);
        throw error;
      }
      session = await this.recoverAmbiguousAction(
        identity,
        region,
        workspaceId,
        placementAffinity,
        operationId,
        preference,
        error,
      );
    }
    this.assertRegionalSession(session, region, workspaceId);
    await this.bindings.activate(identity.platformUserId, operationId);
    await this.operations.complete(identity.platformUserId, operationId);
    return session;
  }

  private async issueExistingSession(
    identity: PlatformIdentity,
    region: Region,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<Session> {
    const preference = await loadOrCreateCanonicalPreferenceProjection(
      this.env,
      identity.platformUserId,
    );
    const operationId = this.createId();
    const session = await this.gateways[region].activate({
      identity,
      operationId,
      workspaceId: asWorkspaceId(workspaceId),
      placementAffinity,
      preference,
    });
    this.assertRegionalSession(session, region, workspaceId);
    return session;
  }

  private assertPlatformOperation(
    operation: PlatformOperationRow,
    platformUserId: string,
    action: PlatformOperationRow["action"],
    requestFingerprint: string,
    region: Region,
    invitationId: string | null,
  ): void {
    if (
      operation.platform_user_id !== platformUserId
      || operation.action !== action
      || operation.request_fingerprint !== requestFingerprint
      || operation.region !== region
      || operation.invitation_id !== invitationId
    ) {
      throw new ApiError(409, "onboarding_operation_conflict", "The onboarding operation was already used for another action");
    }
  }

  private async recoverAmbiguousAction(
    identity: PlatformIdentity,
    region: Region,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
    operationId: string,
    preference: z.infer<typeof PreferenceProjectionSchema>,
    originalError: unknown,
  ): Promise<Session> {
    try {
      const discovery = await this.gateways[region].discover(identity);
      const membership = discovery.workspaces.find((item) => item.id === workspaceId && item.region === region);
      if (membership?.placementAffinity === placementAffinity) {
        return this.gateways[region].activate({
          identity,
          operationId,
          workspaceId: asWorkspaceId(workspaceId),
          placementAffinity,
          preference,
        });
      }
      // A thrown RPC/runtime error can race a regional commit. Never release
      // the reservation merely because an immediate read did not yet observe
      // membership; later discovery or manual reconciliation must resolve it.
    } catch {
      // Keep the pending reservation when the outcome cannot be proven.
      // A later discovery reconciles it if the regional membership committed.
    }
    if (originalError instanceof ApiError) throw originalError;
    throw new ApiError(503, "regional_onboarding_unavailable", "The regional onboarding action could not be confirmed");
  }

  private assertRegionalSession(session: Session, region: Region, workspaceId: string): void {
    if (
      !session.workspace
      || session.workspace.region !== region
      || session.workspace.id !== workspaceId
      || session.apiBaseUrl.replace(/\/$/u, "") !== this.apiBaseForRegion(region)
    ) {
      throw new ApiError(502, "regional_session_mismatch", "The regional service returned a mismatched session");
    }
  }

  private apiBaseForRegion(region: Region): string {
    if (region === "global") return this.env.PUBLIC_API_BASE_URL.replace(/\/$/u, "");
    const configured = this.env.EU_PUBLIC_API_BASE_URL?.replace(/\/$/u, "");
    if (!configured) throw new ApiError(503, "regional_onboarding_unavailable", "The European Union API endpoint is not configured");
    return configured;
  }
}

export const __platformOnboardingTesting = {
  platformIdentitySchema,
  regionalDiscoverySchema,
};
