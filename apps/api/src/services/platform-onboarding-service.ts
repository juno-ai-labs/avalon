import { RegionSchema } from "@rally/contracts/regions";
import { configuredRegions, regionConfiguration } from "@rally/contracts/regions";
import { regionalBindings } from "../lib/regional-bindings";
import { AccountOnboardingSchema, PersonalPresentationSchema } from '@rally/contracts';
import { publishWorkspaceSync } from './workspace-realtime-service';
import {
  IanaTimezoneSchema,
  PendingWorkspaceInvitationSchema,
  SessionSchema,
  WorkspaceIdSchema,
  asSpaceId,
  asUserId,
  asWorkspaceId,
  WorkspaceAttentionSchema,
  WorkspaceSchema,
  type Region,
  type WorkspaceId,
  type Session,
  type WorkspaceOnboardingState,
  type Workspace,
} from "@rally/contracts";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { newId, nowIso } from "@rally/db";
import { z } from "zod";
import type { Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { workspaceSlug } from "../lib/workspace-slug";
import { diagnosticErrorCode } from "../observability/logger";
import { sha256 } from "../lib/crypto";
import {
  deriveWorkspacePlacementAffinity,
  fallbackWorkspacePlacementAffinity,
  durableObjectStubForWorkspace,
  isWorkspacePlacementAffinityForRegion,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { BrowserSessionService } from "./browser-session-service";
import { AuthService } from "./auth-service";
import { openGeneralSpaceForNewWorkspace, seatOrganizationMember } from "./space-bootstrap-service";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
  type WorkstreamAuthorityControl,
} from "./workstream-authority";
import { parentRouteStatement, regionalWorkstreamAnchorStatement } from "./workstream-runtime-database";
import { personalSpaceIdFor, type WorkspaceGeneralOpening } from "../durable-objects/workspace-space-protocol";
import { uuidV7 } from "../lib/uuid-v7";
import {
  demoWorkspaceAdmission,
  withheldDemoWorkspaceIds,
} from "./demo-workspace-visibility";
import { acceptInvitationForUser, declineInvitationForUser } from "./workspace-service";
import { claimScopeInvitations } from "./scope-invitation-claims";
import { membershipAttention } from "./workspace-attention-service";
import { settledFailureCode } from "../lib/settled-failure-code";
import {
  PreferenceProjectionSchema,
  applyRegionalPreferenceProjection,
  loadOrCreateCanonicalPreferenceProjection,
} from "../telemetry/preference";

/**
 * One verified sign-in method: `google` and its subject, `email` and its
 * address, or any provider added later. A deployment links a person by these,
 * never by a provider-specific column.
 */
export const loginIdentitySchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
  subject: z.string().min(1).max(320),
});
export type LoginIdentity = z.infer<typeof loginIdentitySchema>;

export const platformIdentitySchema = z.object({
  accountOnboarding: AccountOnboardingSchema.optional(),
  platformUserId: z.string().uuid(),
  loginIdentities: z.array(loginIdentitySchema),
  email: z.string().email().max(254),
  name: z.string().min(1).max(255),
  avatarUrl: HttpUrlSchema.nullable(),
  timezone: IanaTimezoneSchema,
  createdAt: z.string().datetime({ offset: true }),
});

const WorkspacePlacementAffinitySchema = z.enum(["wnam", "enam", "weur", "eeur"]);
const regionalWorkspaceSchema = WorkspaceSchema.safeExtend({
  placementAffinity: WorkspacePlacementAffinitySchema,
});
const regionalPendingInvitationSchema = PendingWorkspaceInvitationSchema.extend({
  placementAffinity: WorkspacePlacementAffinitySchema,
});
type RegionalWorkspace = z.infer<typeof regionalWorkspaceSchema>;

const regionalDiscoverySchema = z.object({
  region: RegionSchema,
  workspaces: z.array(regionalWorkspaceSchema),
  invitations: z.array(regionalPendingInvitationSchema),
});

const regionalAttentionSchema = z.object({
  attention: z.array(z.object({ region: RegionSchema, workspaceId: WorkspaceIdSchema, attention: WorkspaceAttentionSchema })),
  failed: z.array(z.object({ workspaceId: z.string(), code: z.string() })),
});
export type RegionalAttention = z.infer<typeof regionalAttentionSchema>;

const regionalActionBaseSchema = z.object({
  identity: platformIdentitySchema,
  operationId: z.string().uuid(),
  workspaceId: WorkspaceIdSchema,
  placementAffinity: WorkspacePlacementAffinitySchema,
  preference: PreferenceProjectionSchema,
});

export const regionalActivateSchema = regionalActionBaseSchema;
export const regionalCreateSchema = regionalActionBaseSchema.extend({
  name: z.string().trim().min(2).max(120),
});
export const regionalAcceptSchema = regionalActionBaseSchema.extend({
  invitationId: z.string().uuid(),
});
export const regionalDeclineSchema = z.object({
  identity: platformIdentitySchema,
  invitationId: z.string().uuid(),
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
  z.object({ ok: z.literal(true), value: z.unknown() }),
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

/** A browser cookie credential a deployment minted for itself, and when it expires. */
export const browserRegistrationSchema = z.object({ credential: z.string().min(1), expiresAt: z.string().datetime() });
export type BrowserRegistration = z.infer<typeof browserRegistrationSchema>;

/** Named WorkerEntrypoint RPC surface. It is intentionally not an HTTP route. */
export interface RegionalIdentityBridgeBinding {
  discover(identity: PlatformIdentity): Promise<RegionalDiscovery>;
  attention(identity: PlatformIdentity): Promise<RegionalAttention>;
  activate(input: RegionalActivateInput): Promise<Session>;
  activateBrowser(input: RegionalActivateInput): Promise<BrowserRegistration>;
  create(input: RegionalCreateInput): Promise<Session>;
  accept(input: RegionalAcceptInput): Promise<Session>;
  decline(input: RegionalDeclineInput): Promise<{ ok: true }>;
}

/** Raw Cloudflare RPC surface. Business failures are data, never thrown errors. */
export interface RegionalIdentityBridgeRpcBinding {
  discover(identity: PlatformIdentity): Promise<RegionalRpcResult<RegionalDiscovery>>;
  attention(identity: PlatformIdentity): Promise<RegionalRpcResult<RegionalAttention>>;
  activate(input: RegionalActivateInput): Promise<RegionalRpcResult<Session>>;
  activateBrowser(input: RegionalActivateInput): Promise<RegionalRpcResult<BrowserRegistration>>;
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

  attention(identity: PlatformIdentity): Promise<RegionalAttention> {
    return this.call(this.rpc.attention(identity), regionalAttentionSchema);
  }

  activate(input: RegionalActivateInput): Promise<Session> {
    return this.call(this.rpc.activate(input), SessionSchema);
  }

  activateBrowser(input: RegionalActivateInput): Promise<BrowserRegistration> {
    return this.call(this.rpc.activateBrowser(input), browserRegistrationSchema);
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
  google_subject: string | null;
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
    ...(row.access_class === "guest" ? { accessClass: "guest" } : {}),
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

/** Regional data-plane operations called either directly for Global or by RPC for regional. */
export class RegionalOnboardingService implements RegionalIdentityBridgeBinding {
  constructor(private readonly env: Env) {}

  async discover(rawIdentity: PlatformIdentity): Promise<RegionalDiscovery> {
    const identity = platformIdentitySchema.parse(rawIdentity);
    const user = await this.ensureRegionalUser(identity);
    // Before listing, so a joined Organization is listed. The identity's address
    // is Global's verified one, which this deployment may not have recorded.
    await claimScopeInvitations(this.env, user.id, identity.email);
    const [workspaceResult, invitationResult] = await Promise.all([
      this.env.DB.prepare(
        `SELECT w.id, w.name, w.slug, w.region, w.timezone, w.created_at,
           w.placement_affinity, m.role, m.access_class
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? AND m.status = 'active' AND w.region = ?
           AND w.abandoned_at IS NULL
         ORDER BY m.access_class = 'guest', m.joined_at, w.created_at, w.id`,
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
    // Memberships before guest relationships: a device with nothing selected
    // opens the first one, and that should be the person's own Organization
    // rather than one they were shared into earlier.
    const memberships = (workspaceResult.results ?? []).map(mapWorkspace);
    // Two workspaces a member holds but is not offered: the demo template, and a
    // demo still being prepared. Both are withheld from the list rather than
    // from the membership — the template's operator still maintains it, and a
    // candidate becomes ordinary the moment it is published.
    const withheld = await withheldDemoWorkspaceIds(
      this.env.DB,
      memberships.map((workspace) => workspace.id),
    );
    return regionalDiscoverySchema.parse({
      region: this.env.AVALON_REGION,
      workspaces: memberships.filter((workspace) => !withheld.has(workspace.id)),
      invitations: (invitationResult.results ?? []).map(mapPendingInvitation),
    });
  }

  /**
   * Attention for each organization the identity is a member of here, for a
   * browser that holds no workspace credential to ask each one itself.
   */
  async attention(rawIdentity: PlatformIdentity): Promise<RegionalAttention> {
    // A read, so it never writes: `discover`, which the list ran first, is what
    // links or refreshes the regional user. Not linked yet means no membership here.
    const identity = platformIdentitySchema.parse(rawIdentity);
    const user = await this.env.DB.prepare("SELECT id FROM users WHERE platform_user_id = ?")
      .bind(identity.platformUserId).first<{ id: string }>();
    if (!user) return { attention: [], failed: [] };
    const workspaces = await new AuthService(this.env).listRegionalWorkspaces(user.id);
    return membershipAttention(this.env, user.id, workspaces);
  }

  async activate(rawInput: RegionalActivateInput): Promise<Session> {
    const input = regionalActivateSchema.parse(rawInput);
    const user = await this.admit(input);
    return new AuthService(this.env).createRegionalSession(user.id, input.workspaceId);
  }

  /**
   * The browser's activation: the same admission as `activate`, ending in a
   * browser cookie credential for this deployment rather than a bearer session.
   * The credential goes back to Global over the bridge and on to the browser as
   * a host-only cookie; see the full browser client PRD's `design.md`.
   */
  async activateBrowser(rawInput: RegionalActivateInput): Promise<BrowserRegistration> {
    const input = regionalActivateSchema.parse(rawInput);
    const user = await this.admit(input);
    const browser = new BrowserSessionService(this.env);
    const registration = await browser.register(await new AuthService(this.env).createIdentitySession(user.id));
    await browser.select(registration.credential, input.workspaceId);
    return { credential: registration.credential, expiresAt: registration.expiresAt };
  }

  private async admit(input: RegionalActivateInput): Promise<RegionalUserRow> {
    this.requireCompatiblePlacementAffinity(input.placementAffinity);
    const user = await this.ensureRegionalUser(input.identity);
    await applyRegionalPreferenceProjection(this.env, user.id, input.preference);
    await this.requirePlacementAffinity(input.workspaceId, input.placementAffinity);
    await this.requireMembership(user.id, input.workspaceId);
    // Preparation is a real admission state, not a rendering detail: activating
    // a candidate before it is published shows a half-seeded sidebar and lets
    // somebody open a room the pack has not finished writing. The template is
    // deliberately still activatable — the filter above is a discovery filter,
    // not its security gate, and an operator maintains it by opening it.
    if (await demoWorkspaceAdmission(this.env.DB, input.workspaceId) === "preparing") {
      throw new ApiError(409, "demo_workspace_preparing", "This demo is still being prepared");
    }
    await this.initializeWorkspaceObject(input.workspaceId, input.placementAffinity);
    // Activation is a read/verify plus fresh session issue. It intentionally
    // does not claim the action journal because the binding's operation may
    // have originally been a create or invitation acceptance.
    return user;
  }

  async create(rawInput: RegionalCreateInput): Promise<Session> {
    const input = regionalCreateSchema.parse(rawInput);
    this.requireCompatiblePlacementAffinity(input.placementAffinity);
    const user = await this.ensureRegionalUser(input.identity);
    const [, replay, authority] = await Promise.all([
      applyRegionalPreferenceProjection(this.env, user.id, input.preference),
      this.loadOperation(input.operationId),
      readWorkstreamAuthorityControl(this.env),
    ]);
    if (replay) {
      this.assertOperation(replay, input, "create", null);
      await this.requireMembership(user.id, input.workspaceId);
      await this.requirePlacementAffinity(input.workspaceId, input.placementAffinity);
      await this.initializeWorkspaceObject(input.workspaceId, input.placementAffinity);
      return new AuthService(this.env).createRegionalSession(user.id, input.workspaceId);
    }

    const session = await new AuthService(this.env).prepareWorkspaceSession(user.id, input.workspaceId);
    const results = await this.createOwnedWorkspace(user.id, input, authority, session.statements);
    return session.issue(results);
  }

  /**
   * Create a workspace for a member who already exists in this region, with no
   * session minted for them.
   *
   * The demo preparation's path: the presenter is a regional user, and a demo
   * workspace is created *for* them — as its owner, through the same rows,
   * journal, placement check and object initialization as `create` — without
   * anybody signing in. A session here would be a login credential minted on
   * somebody's behalf by an operator, which is not something preparation may
   * do. Idempotent through the journal exactly as `create` is: a replay of the
   * same operation returns to the same workspace. Engineering MCP shares this
   * entryway, optionally committing initial members with the owner and seating
   * them through the ordinary membership bootstrap.
   */
  async createWorkspaceForMember(input: {
    operationId: string;
    workspaceId: WorkspaceId;
    name: string;
    userId: string;
    /** Initial members, committed alongside the owner through ordinary onboarding. */
    memberUserIds?: readonly string[];
  }): Promise<void> {
    const user = await this.env.DB.prepare(
      "SELECT id, platform_user_id, google_subject, email FROM users WHERE id = ?",
    ).bind(input.userId).first<RegionalUserRow>();
    if (!user?.platform_user_id) {
      throw new ApiError(404, "regional_user_not_found", "The member is not known in this region");
    }
    const members = [...new Set(input.memberUserIds ?? [])].filter((id) => id !== user.id);
    if (members.length) {
      const known = await this.env.DB.batch(members.map((id) => this.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id)));
      if (known.some((result) => result.results.length === 0)) {
        throw new ApiError(404, "regional_user_not_found", "An initial member is not known in this region");
      }
    }
    const placementAffinity = fallbackWorkspacePlacementAffinity(this.env.AVALON_REGION);
    const reference: OperationReference & { name: string; placementAffinity: WorkspacePlacementAffinity } = {
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      identity: { platformUserId: user.platform_user_id },
      name: input.name,
      placementAffinity,
    };
    const [replay, authority] = await Promise.all([
      this.loadOperation(input.operationId),
      readWorkstreamAuthorityControl(this.env),
    ]);
    if (replay) {
      this.assertOperation(replay, reference, "create", null);
      await this.requireMembership(user.id, input.workspaceId);
      await this.requirePlacementAffinity(input.workspaceId, placementAffinity);
      await this.initializeWorkspaceObject(input.workspaceId, placementAffinity);
      for (const id of members) {
        await this.requireMembership(id, input.workspaceId);
        await seatOrganizationMember(this.env, input.workspaceId, id);
      }
      return;
    }
    await this.createOwnedWorkspace(user.id, reference, authority, members.map((id) => this.env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'member', 'active', ?)`,
    ).bind(input.workspaceId, id, nowIso())));
    for (const id of members) await seatOrganizationMember(this.env, input.workspaceId, id);
  }

  /**
   * The rows, the journal entry, General's anchor and the object, for both
   * creators above. One D1 batch writes the workspace, its owner, the journal
   * entry and General's anchor and route; `trailing` statements (initial
   * members or the creator's session) go last, after the owner, and their
   * results are returned. The batch is all or nothing and the workspace insert
   * has no conflict clause, so a committed batch is the proof of the rows: no
   * read-back follows. One object call then initializes the Organization and
   * opens General in it. An authority that does not accept new work (closed,
   * or mid-migration with a positive generation) gets no anchor here, and
   * General is left to the slower path, which asks again.
   */
  private async createOwnedWorkspace(
    userId: string,
    input: OperationReference & { name: string; placementAffinity: WorkspacePlacementAffinity },
    authority: WorkstreamAuthorityControl,
    trailing: D1PreparedStatement[],
  ): Promise<D1Result[]> {
    const at = nowIso();
    const slug = workspaceSlug(input.name, input.workspaceId);
    // Minted here, or derived from the Organization this call creates, and
    // never seen outside it, so no Channel create can have claimed either and
    // the claim read `claimParentAnchor` makes is not needed.
    const general = acceptsNewWorkstreamWork(authority) && authority.generation >= 1
      ? {
        creatorUserId: asUserId(userId),
        spaceId: asSpaceId(uuidV7()),
        // The creator's Personal Channel, anchored in this batch too so the
        // object makes it in the same call. Derived, so the relationship
        // change that follows names the same one rather than a second.
        personalSpaceId: await personalSpaceIdFor(input.workspaceId, userId),
        authorityGeneration: authority.generation,
      }
      : undefined;
    const results = await this.env.DB.batch([
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
        "America/Los_Angeles",
        input.placementAffinity,
        userId,
        at,
        at,
      ),
      this.env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         SELECT ?, ?, 'owner', 'active', ?
         WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND region = ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = 'active'`,
      ).bind(input.workspaceId, userId, at, input.workspaceId, this.env.AVALON_REGION),
      this.operationStatement(input, "create", null, at),
      ...(general ? [general.spaceId, general.personalSpaceId].flatMap((parentId) => [
        regionalWorkstreamAnchorStatement(this.env, input.workspaceId, parentId),
        parentRouteStatement(this.env, {
          workspaceId: input.workspaceId, parentId, generation: general.authorityGeneration, at,
        }),
      ]) : []),
      ...trailing,
    ]);
    await this.initializeWorkspaceObject(asWorkspaceId(input.workspaceId), input.placementAffinity, general);
    return trailing.length === 0 ? [] : results.slice(-trailing.length);
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
    const resolved = await this.resolveRegionalUser(identity);
    const { user } = resolved;
    if (!resolved.profileApplied) {
      const onboarding = this.onboardingStatements(user.id, identity);
      if (onboarding.length > 0) await this.publishOnboardingChange(await this.env.DB.batch(onboarding));
    }
    return user;
  }

  /**
   * The account onboarding profile Global sends, written to this deployment's
   * user, and the memberships to tell when it changed anything. Empty in
   * Global, which owns the profile. `publishOnboardingChange` takes these
   * statements' results.
   */
  private onboardingStatements(userId: string, identity: PlatformIdentity): D1PreparedStatement[] {
    const profile = identity.accountOnboarding;
    if (!profile || this.env.AVALON_REGION === 'global') return [];
    return [
      this.env.DB.prepare(
        `UPDATE users SET onboarding_eligible = ?, onboarding_introduced = ?,
          name = COALESCE(?, name), presentation_json = ?, onboarding_revision = ?
         WHERE id = ? AND onboarding_revision <= ?
           AND (onboarding_revision < ? OR onboarding_eligible != ? OR onboarding_introduced != ? OR presentation_json IS NOT ?)`,
      ).bind(profile.eligible ? 1 : 0, profile.introduced ? 1 : 0,
        profile.presentation?.displayName ?? null, profile.presentation ? JSON.stringify(profile.presentation) : null,
        profile.revision, userId, profile.revision, profile.revision, profile.eligible ? 1 : 0, profile.introduced ? 1 : 0, profile.presentation ? JSON.stringify(profile.presentation) : null),
      this.env.DB.prepare(
        "SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = 'active'",
      ).bind(userId),
    ];
  }

  private async publishOnboardingChange(results: readonly D1Result[]): Promise<void> {
    if (!results[0]?.meta.changes) return;
    const memberships = (results[1]?.results ?? []) as Array<{ workspace_id: string }>;
    await Promise.all(memberships.map((row) =>
      publishWorkspaceSync(this.env, row.workspace_id, ['workspace_profile', 'member_directory'])));
  }

  /**
   * The regional user for this identity. A known user's profile, sign-in
   * methods and onboarding profile are refreshed in one batch, after one
   * parallel pair of reads, which is the path every create, accept and
   * activation of a returning account takes (`profileApplied`).
   */
  private async resolveRegionalUser(identity: PlatformIdentity): Promise<{ user: RegionalUserRow; profileApplied: boolean }> {
    const [known, owners] = await Promise.all([
      this.env.DB.prepare(
        "SELECT id, platform_user_id, google_subject, email FROM users WHERE platform_user_id = ?",
      ).bind(identity.platformUserId).first<RegionalUserRow>(),
      this.loginIdentityOwners(identity),
    ]);
    if (known) {
      if (owners.some((owner) => owner.id !== known.id)) {
        throw new ApiError(409, "regional_identity_conflict", "The regional identity link does not match this account");
      }
      const profile = this.syncRegionalProfileStatement(known.id, identity);
      const logins = this.loginIdentityStatements(known.id, identity);
      const onboarding = this.onboardingStatements(known.id, identity);
      let results: D1Result[];
      try {
        results = await this.env.DB.batch([profile, ...logins, ...onboarding]);
      } catch (error) {
        throw this.profileConflict(error);
      }
      if (onboarding.length > 0) await this.publishOnboardingChange(results.slice(1 + logins.length));
      return { user: { ...known, email: identity.email }, profileApplied: true };
    }
    return { user: await this.linkOrCreateRegionalUser(identity, owners), profileApplied: false };
  }

  private async linkOrCreateRegionalUser(identity: PlatformIdentity, owners: RegionalUserRow[]): Promise<RegionalUserRow> {
    if (owners.length > 1) {
      throw new ApiError(409, "regional_identity_conflict", "This account's sign-in methods belong to different regional identities");
    }
    const user: RegionalUserRow | null = owners[0] ?? null;
    if (user) {
      if (user.platform_user_id && user.platform_user_id !== identity.platformUserId) {
        throw new ApiError(409, "regional_identity_conflict", "The regional identity is already linked to another account");
      }
      const result = await this.env.DB.prepare(
        `UPDATE users SET platform_user_id = ?, email = ?, name = COALESCE(json_extract(presentation_json, '$.displayName'), ?), avatar_url = ?, updated_at = ?
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
      await this.recordLoginIdentities(user.id, identity);
      return { ...user, platform_user_id: identity.platformUserId, email: identity.email };
    }

    // Nothing to link a new regional user by; refuse rather than mint one that
    // no later sign-in could ever be matched to.
    if (identity.loginIdentities.length === 0) {
      throw new ApiError(409, "login_identity_required", "This account has no sign-in method to link in this deployment");
    }
    const id = newId();
    const at = nowIso();
    const googleSubject = identity.loginIdentities.find((entry) => entry.provider === "google")?.subject ?? null;
    try {
      await this.env.DB.prepare(
        `INSERT INTO users
         (id, google_subject, email, name, avatar_url, timezone, created_at, updated_at, platform_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        googleSubject,
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
      if (!raced) {
        throw new ApiError(409, "regional_identity_conflict", "The regional identity could not be linked safely");
      }
      await this.requireLoginIdentitiesFree(raced.id, identity);
      return raced;
    }
    await this.recordLoginIdentities(id, identity);
    return {
      id,
      platform_user_id: identity.platformUserId,
      google_subject: googleSubject,
      email: identity.email,
    };
  }

  /**
   * The regional users these sign-in methods already belong to. `users.google_subject`
   * is read too: regional users this bridge created before it recorded login
   * identities carry their Google subject only there.
   */
  private async loginIdentityOwners(identity: PlatformIdentity): Promise<RegionalUserRow[]> {
    if (identity.loginIdentities.length === 0) return [];
    const pairs = identity.loginIdentities.map(() => "(provider = ? AND subject = ?)").join(" OR ");
    const google = identity.loginIdentities.filter((entry) => entry.provider === "google").map((entry) => entry.subject);
    const legacy = google.length > 0 ? ` OR google_subject IN (${google.map(() => "?").join(",")})` : "";
    const rows = await this.env.DB.prepare(
      `SELECT id, platform_user_id, google_subject, email FROM users
       WHERE id IN (SELECT user_id FROM user_login_identities WHERE ${pairs})${legacy}`,
    ).bind(...identity.loginIdentities.flatMap((entry) => [entry.provider, entry.subject]), ...google)
      .all<RegionalUserRow>();
    return rows.results ?? [];
  }

  private async requireLoginIdentitiesFree(userId: string, identity: PlatformIdentity): Promise<void> {
    if ((await this.loginIdentityOwners(identity)).some((owner) => owner.id !== userId)) {
      throw new ApiError(409, "regional_identity_conflict", "The regional identity link does not match this account");
    }
  }

  /**
   * Global verified each of these; the deployment keeps them so a later sign-in
   * links to the same user. An email address Global no longer sends is dropped,
   * as Global drops it when the mailbox changes: a kept old address would block
   * its next owner here with a conflict.
   */
  private async recordLoginIdentities(userId: string, identity: PlatformIdentity): Promise<void> {
    await this.env.DB.batch(this.loginIdentityStatements(userId, identity));
  }

  private loginIdentityStatements(userId: string, identity: PlatformIdentity): D1PreparedStatement[] {
    const at = nowIso();
    const emails = identity.loginIdentities.filter((entry) => entry.provider === "email").map((entry) => entry.subject);
    return [
      this.env.DB.prepare(
        `DELETE FROM user_login_identities WHERE provider = 'email' AND user_id = ?
         AND subject NOT IN (SELECT value FROM json_each(?))`,
      ).bind(userId, JSON.stringify(emails)),
      ...identity.loginIdentities.map((entry) => this.env.DB.prepare(
        `INSERT INTO user_login_identities (provider, subject, user_id, verified_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider, subject) DO NOTHING`,
      ).bind(entry.provider, entry.subject, userId, at)),
    ];
  }

  private syncRegionalProfileStatement(userId: string, identity: PlatformIdentity): D1PreparedStatement {
    return this.env.DB.prepare(
      "UPDATE users SET email = ?, name = COALESCE(json_extract(presentation_json, '$.displayName'), ?), avatar_url = ?, updated_at = ? WHERE id = ?",
    ).bind(identity.email, identity.name, identity.avatarUrl, nowIso(), userId);
  }

  /**
   * A refused profile refresh. The verified email is the one column there that
   * another regional user can already hold, so a uniqueness refusal is that
   * conflict; anything else is the database failing and keeps its own error.
   */
  private profileConflict(error: unknown): unknown {
    if (error instanceof Error && /UNIQUE constraint failed/iu.test(error.message)) {
      return new ApiError(409, "regional_identity_conflict", "The verified account profile conflicts with a regional identity");
    }
    return error;
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

  /**
   * Initialize the Organization's object before the session this call is about
   * to issue, with General open in it. Every Channel belongs to a Space, so an
   * Organization without General is one whose sidebar cannot be drawn, and
   * the client shows the opening card until it can. The object answers that in
   * the same call, for an Organization already open or for a new one whose
   * General anchor `general` names; anything else takes the slower path that
   * makes General and closes the cutover itself.
   */
  private async initializeWorkspaceObject(
    workspaceId: WorkspaceId,
    placementAffinity: WorkspacePlacementAffinity,
    general?: WorkspaceGeneralOpening,
  ): Promise<void> {
    const workspaceObject = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(this.env.AVALON_REGION, workspaceId),
      placementAffinity,
    );
    const opened = await workspaceObject.initializeWorkspace(workspaceId, placementAffinity, general);
    if (opened?.spacesReady === true) return;
    await openGeneralSpaceForNewWorkspace(this.env, workspaceId);
  }

  private async loadOperation(operationId: string): Promise<OperationRow | null> {
    return this.env.DB.prepare(
      `SELECT platform_user_id, action, workspace_id, invitation_id
       FROM regional_onboarding_operations WHERE operation_id = ?`,
    ).bind(operationId).first<OperationRow>();
  }

  private assertOperation(
    row: OperationRow,
    input: OperationReference,
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
    input: OperationReference,
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

/**
 * What the onboarding journal keys an action on: the person, the operation,
 * and the workspace. Every regional action input carries these; the demo
 * preparation's create carries only these, because it has no platform identity
 * payload to hand over — the presenter is already a regional user.
 */
interface OperationReference {
  operationId: string;
  workspaceId: string;
  identity: { platformUserId: string };
}

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
    const result = await this.listStatement(platformUserId).all<PlatformBindingRow>();
    return result.results ?? [];
  }

  private listStatement(platformUserId: string): D1PreparedStatement {
    return this.db.prepare(
      `SELECT platform_user_id, region, workspace_id, placement_affinity, status,
              operation_id, pending_expires_at
       FROM platform_workspace_bindings
       WHERE platform_user_id = ?
       ORDER BY created_at, region, workspace_id`,
    ).bind(platformUserId);
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
    // outcomes are never reclaimed automatically because the old regional action
    // could still commit after an apparent timeout.
    const expiresAt = new Date(this.now().getTime() + 2 * 60_000).toISOString();
    // One round trip: the reactivation, the insert, and the read of what won.
    const results = await this.db.batch([
      this.db.prepare(
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
      ),
      this.db.prepare(
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
      ),
      this.listStatement(platformUserId),
    ]);
    const rows = (results[2]?.results ?? []) as PlatformBindingRow[];
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
    return this.getStatement(operationId).first<PlatformOperationRow>();
  }

  private getStatement(operationId: string): D1PreparedStatement {
    return this.db.prepare(
      `SELECT operation_id, platform_user_id, action, request_fingerprint, region,
              workspace_id, placement_affinity, invitation_id, status
       FROM platform_workspace_operations WHERE operation_id = ?`,
    ).bind(operationId);
  }

  async begin(row: PlatformOperationRow): Promise<PlatformOperationRow> {
    const at = this.now().toISOString();
    // The insert and the read of whichever row won, in one round trip.
    const results = await this.db.batch([this.db.prepare(
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
    ), this.getStatement(row.operation_id)]);
    const stored = results[1]?.results?.[0] as PlatformOperationRow | undefined;
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
    this.gateways = Object.fromEntries(configuredRegions.map((region) => {
      const injected = dependencies.gateways?.[region];
      if (injected) return [region, injected];
      if (region === env.AVALON_REGION) return [region, new RegionalOnboardingService(env)];
      const bridge = regionalBindings(env, region).identity;
      if (!bridge) throw new ApiError(503, "regional_onboarding_unavailable", "A regional onboarding service is unavailable");
      return [region, new RegionalIdentityBridgeClient(bridge)];
    }));
    this.bindings = dependencies.bindings ?? new D1PlatformBindingStore(env.DB);
    this.operations = dependencies.operations ?? new D1PlatformOperationStore(env.DB);
    this.createId = dependencies.newId ?? newId;
  }

  /**
   * `guests` is whether the asking client opens a guest relationship
   * (`clientOpensGuestWorkspaces`). Bindings reconcile against every
   * relationship either way, so two devices on different builds agree on them;
   * only the answer leaves guests out.
   */
  async state(options: { guests?: boolean } = {}): Promise<WorkspaceOnboardingState> {
    const identity = await this.loadPlatformIdentity();
    const discovery = await this.discover(identity);
    const workspaces = (await this.reconcileWorkspaceBindings(identity.platformUserId, discovery))
      .filter((workspace) => options.guests || workspace.accessClass !== "guest");
    return {
      // Compatibility for desktop builds released before plural discovery.
      workspace: workspaces[0] ?? null,
      workspaces,
      invitations: discovery.flatMap((item) => item.invitations),
    };
  }

  async activate(region: Region, workspaceId: string, options: { guests?: boolean } = {}): Promise<Session> {
    const identity = await this.loadPlatformIdentity();
    const discovery = await this.discover(identity);
    const workspace = discovery.flatMap((item) => item.workspaces)
      .find((item) => item.region === region && item.id === workspaceId
        && (options.guests || item.accessClass !== "guest"));
    if (!workspace) throw new ApiError(403, "workspace_access_denied", "Workspace access is unavailable");
    await this.reconcileWorkspaceBindings(identity.platformUserId, discovery);
    return this.issueExistingSession(
      identity,
      region,
      workspaceId,
      workspace.placementAffinity,
    );
  }

  /**
   * Memberships in every other deployment, for the browser's list on Global.
   * A deployment links a person by their sign-in methods, so an account with
   * none has nothing elsewhere. Each deployment is asked on its own: one that
   * fails is named in `failed` and the others still answer. Nothing is
   * reconciled; the desktop's binding bookkeeping is not the browser's to change.
   */
  async otherDeploymentWorkspaces(): Promise<{ workspaces: Workspace[]; failed: Array<{ region: Region; code: string }> }> {
    const identity = await this.loadPlatformIdentity();
    if (identity.loginIdentities.length === 0) return { workspaces: [], failed: [] };
    const regions = configuredRegions.filter((region) => region !== this.env.AVALON_REGION);
    const settled = await Promise.allSettled(regions.map(async (region) => this.gateway(region).discover(identity)));
    return {
      workspaces: settled.flatMap((result) => result.status === "fulfilled" ? result.value.workspaces : []),
      failed: settled.flatMap((result, index) => result.status === "rejected"
        ? [{ region: regions[index]!, code: settledFailureCode(result.reason, "regional_discovery") }]
        : []),
    };
  }

  /** Attention in every other deployment, beside `otherDeploymentWorkspaces`; one down deployment hides only its own. */
  async otherDeploymentAttention(): Promise<{ attention: RegionalAttention["attention"]; failed: Array<{ region: Region; workspaceId?: string; code: string }> }> {
    const identity = await this.loadPlatformIdentity();
    if (identity.loginIdentities.length === 0) return { attention: [], failed: [] };
    const regions = configuredRegions.filter((region) => region !== this.env.AVALON_REGION);
    const settled = await Promise.allSettled(regions.map(async (region) => this.gateway(region).attention(identity)));
    return {
      attention: settled.flatMap((result) => result.status === "fulfilled" ? result.value.attention : []),
      failed: settled.flatMap((result, index) => result.status === "rejected"
        ? [{ region: regions[index]!, code: settledFailureCode(result.reason, "regional_attention") }]
        : result.value.failed.map((item) => ({ region: regions[index]!, workspaceId: item.workspaceId, code: item.code }))),
    };
  }

  /**
   * Activates a workspace for a browser and returns that deployment's cookie
   * credential. Admission asks only the target deployment, so an unrelated one
   * being down cannot block it.
   */
  async activateBrowser(region: Region, workspaceId: string): Promise<BrowserRegistration> {
    const identity = await this.loadPlatformIdentity();
    let discovery: RegionalDiscovery;
    try { discovery = await this.gateway(region).discover(identity); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "regional_onboarding_unavailable", "A regional onboarding service is unavailable");
    }
    const workspace = discovery.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new ApiError(403, "workspace_access_denied", "Workspace access is unavailable");
    return this.gateway(region).activateBrowser({
      identity,
      operationId: this.createId(),
      workspaceId: asWorkspaceId(workspaceId),
      placementAffinity: workspace.placementAffinity,
      preference: await loadOrCreateCanonicalPreferenceProjection(this.env, identity.platformUserId),
    });
  }

  async createWorkspace(
    name: string,
    region: Region,
    requestLocation?: unknown,
    requestedOperationId?: string,
  ): Promise<Session> {
    // The preference is read here, beside the identity, rather than beside
    // the reservation: a read that fails after the reservation commits would
    // leave a pending binding nothing releases.
    const [identity, requestFingerprint, requested, preference] = await Promise.all([
      this.loadPlatformIdentity(),
      sha256(JSON.stringify(["create", region, name])),
      requestedOperationId ? this.operations.get(requestedOperationId) : null,
      this.canonicalPreference(),
    ]);
    let operationId: string;
    let existing = requested;
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
    const session = await this.completeRegionalAction(
      identity,
      region,
      workspaceId,
      placementAffinity,
      operationId,
      (regionalOperationId, preference) => this.gateway(region).create({
        identity,
        operationId: regionalOperationId,
        workspaceId: asWorkspaceId(workspaceId),
        name,
        placementAffinity,
        preference,
      }),
      preference,
      () => this.makeFirstCreatorEligible(identity.platformUserId, region, workspaceId),
    );
    return session;
  }

  /**
   * Someone whose first organization this is sets it up as its creator, as a
   * new Mac account does. An email sign-in starts ineligible, since most arrive
   * as guests, and a guest relationship here does not exempt them. Runs only
   * once the organization exists, so a failed create changes nothing. An
   * active binding in another deployment keeps the exemption: the binding
   * does not say member or guest, and an established member must not be sent
   * through setup again.
   */
  private async makeFirstCreatorEligible(platformUserId: string, region: Region, workspaceId: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE users SET onboarding_eligible = 1 WHERE id = ? AND onboarding_eligible = 0
         AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE user_id = users.id AND workspace_id <> ?
           AND access_class = 'member' AND status = 'active')
         AND NOT EXISTS (SELECT 1 FROM platform_workspace_bindings WHERE platform_user_id = ? AND region <> ?
           AND status = 'active' AND NOT (region = ? AND workspace_id = ?))`,
    ).bind(this.auth.userId, workspaceId, platformUserId, this.env.AVALON_REGION, region, workspaceId).run();
  }

  async acceptInvitation(
    invitationId: string,
    region: Region,
    requestedOperationId?: string,
  ): Promise<Session> {
    const [identity, requestFingerprint, preference] = await Promise.all([
      this.loadPlatformIdentity(),
      sha256(JSON.stringify(["accept", region, invitationId])),
      this.canonicalPreference(),
    ]);
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
      (regionalOperationId, preference) => this.gateway(region).accept({
        identity,
        operationId: regionalOperationId,
        workspaceId: asWorkspaceId(operation.workspace_id),
        invitationId,
        placementAffinity: operation.placement_affinity,
        preference,
      }),
      preference,
    );
  }

  async declineInvitation(invitationId: string, region: Region): Promise<void> {
    const identity = await this.loadPlatformIdentity();
    await this.gateway(region).decline({ identity, invitationId });
  }

  private requireGlobalControlPlane(): void {
    if (this.env.AVALON_REGION !== "global" || this.auth.region !== "global") {
      throw new ApiError(409, "global_identity_required", "Sign in through the Rally platform before choosing a workspace");
    }
  }

  /** The session names the canonical user, so its preference needs no identity read first. */
  private canonicalPreference(): Promise<z.infer<typeof PreferenceProjectionSchema>> {
    return loadOrCreateCanonicalPreferenceProjection(this.env, this.auth.userId);
  }

  private async loadPlatformIdentity(): Promise<PlatformIdentity> {
    // The session names the user, so the sign-in methods are read beside the row.
    const [row, identities] = await Promise.all([this.env.DB.prepare(
      `SELECT id, google_subject, email, name, avatar_url, timezone, created_at, platform_user_id, onboarding_eligible, onboarding_introduced, onboarding_revision, presentation_json
       FROM users WHERE id = ?`,
    ).bind(this.auth.userId).first<{
      id: string;
      google_subject: string | null;
      email: string;
      name: string;
      avatar_url: string | null;
      timezone: string;
      created_at: string;
      platform_user_id: string | null;
      onboarding_eligible: number;
      onboarding_introduced: number;
      onboarding_revision: number;
      presentation_json: string | null;
    }>(), this.env.DB.prepare(
      "SELECT provider, subject FROM user_login_identities WHERE user_id = ? ORDER BY provider, subject",
    ).bind(this.auth.userId).all<LoginIdentity>()]);
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
    const loginIdentities = identities.results ?? [];
    // A Google account created before login identities were recorded has its
    // subject only on the user row.
    if (row.google_subject && !loginIdentities.some((entry) => entry.provider === "google" && entry.subject === row.google_subject)) {
      loginIdentities.push({ provider: "google", subject: row.google_subject });
    }
    return platformIdentitySchema.parse({
      accountOnboarding: { eligible: row.onboarding_eligible === 1, introduced: row.onboarding_introduced === 1, revision: row.onboarding_revision, presentation: row.presentation_json ? PersonalPresentationSchema.parse(JSON.parse(row.presentation_json)) : null },
      platformUserId: row.id,
      loginIdentities,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      timezone: row.timezone,
      createdAt: row.created_at,
    });
  }

  private gateway(region: Region): RegionalIdentityBridgeBinding {
    const gateway = this.gateways[region];
    if (!gateway) throw new ApiError(503, "regional_onboarding_unavailable", "The region is unavailable");
    return gateway;
  }

  private async discover(identity: PlatformIdentity): Promise<RegionalDiscovery[]> {
    try {
      return await Promise.all(Object.values(this.gateways).map((gateway) => gateway.discover(identity)));
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
    // Memberships before guest relationships across every deployment, not only
    // within one: a device with nothing selected opens the first, and that
    // should be the person's own Organization. The sort is stable, so each
    // group keeps the deployment and discovery order it came in.
    const ordered = [...unique.values()].sort((left, right) =>
      Number(left.accessClass === "guest") - Number(right.accessClass === "guest"));
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
    preference: z.infer<typeof PreferenceProjectionSchema>,
    /** Runs beside the binding's activation once the regional action has committed. */
    committed?: () => Promise<void>,
  ): Promise<Session> {
    const reservation = await this.bindings.reserve(
      identity.platformUserId, region, workspaceId, placementAffinity, operationId,
    );
    if (!sameDestination({ region: reservation.region, workspaceId: reservation.workspace_id }, region, workspaceId)) {
      throw new ApiError(409, "workspace_binding_conflict", "The workspace route conflicts with this Rally account");
    }
    if (reservation.placement_affinity !== placementAffinity) {
      throw new ApiError(409, "workspace_binding_conflict", "The workspace placement route conflicts with its binding");
    }
    if (reservation.status === "active") {
      // A replay of an action that committed: `committed` may not have run, or
      // may have failed, the first time, and it is idempotent.
      const [session] = await Promise.all([
        this.issueExistingSession(identity, region, workspaceId, placementAffinity),
        committed?.(),
      ]);
      return session;
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
    // Independent writes: nothing reads an operation's status, and `committed`
    // excludes this destination from what it reads.
    await Promise.all([
      this.bindings.activate(identity.platformUserId, operationId),
      this.operations.complete(identity.platformUserId, operationId),
      committed?.(),
    ]);
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
    const session = await this.gateway(region).activate({
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
      const discovery = await this.gateway(region).discover(identity);
      const membership = discovery.workspaces.find((item) => item.id === workspaceId && item.region === region);
      if (membership?.placementAffinity === placementAffinity) {
        return this.gateway(region).activate({
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
    // The log names what went wrong; the caller still learns only that it is unconfirmed.
    throw new ApiError(503, "regional_onboarding_unavailable", "The regional onboarding action could not be confirmed",
      undefined, diagnosticErrorCode(originalError, "regional_action_failed"));
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
    const configuration = regionConfiguration(region);
    return this.env.APP_ENV === "development" || this.env.APP_ENV === "test"
      ? configuration.localApiUrl : configuration.apiUrl;
  }
}

export const __platformOnboardingTesting = {
  platformIdentitySchema,
  regionalDiscoverySchema,
};
