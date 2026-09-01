import { asUserId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSchema, type Region, type Session, type Workspace } from "@rally/contracts";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Env, IdentityAuthContext } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import {
  D1PlatformBindingStore,
  D1PlatformOperationStore,
  PlatformOnboardingService,
  serializeRegionalRpcResult,
  type PlatformBindingRow,
  type PlatformBindingStore,
  type PlatformOperationRow,
  type PlatformOperationStore,
  type PlatformIdentity,
  type RegionalAcceptInput,
  type RegionalActivateInput,
  type RegionalCreateInput,
  type RegionalDeclineInput,
  type RegionalDiscovery,
  type RegionalIdentityBridgeBinding,
  type RegionalIdentityBridgeRpcBinding,
  type RegionalRpcResult,
} from "../src/services/platform-onboarding-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const platformUserId = asUserId("00000000-0000-7000-8000-000000000001");
const euWorkspaceId = "00000000-0000-7000-8000-000000000002";
const globalWorkspaceId = "00000000-0000-7000-8000-000000000003";
const invitationId = "00000000-0000-7000-8000-000000000004";
const operationId = "00000000-0000-7000-8000-000000000005";
const createdWorkspaceId = "00000000-0000-7000-8000-000000000006";
const freshActivationId = "00000000-0000-7000-8000-000000000007";
const retryOperationId = "00000000-0000-7000-8000-000000000008";
const preferenceSubjectHandle = "00000000-0000-7000-8000-000000000009";
const at = "2026-08-01T12:00:00.000Z";

function placementAffinity(region: Region): "wnam" | "weur" {
  return region === "eu" ? "weur" : "wnam";
}

const auth: IdentityAuthContext = {
  sessionId: "bootstrap-session",
  userId: platformUserId,
  workspaceId: null,
  region: "global",
  role: null,
};

const identity: PlatformIdentity = {
  platformUserId,
  googleSubject: "google-subject-1",
  email: "member@example.com",
  name: "Member",
  avatarUrl: null,
  timezone: "America/Los_Angeles",
  createdAt: at,
};

function workspace(
  region: Region,
  id: string,
): Workspace & { placementAffinity: "wnam" | "weur" } {
  return {
    id,
    name: region === "eu" ? "Europe Research" : "Global Research",
    slug: region === "eu" ? "europe-research" : "global-research",
    region,
    role: "member",
    timezone: region === "eu" ? "Europe/London" : "America/Los_Angeles",
    createdAt: at,
    placementAffinity: placementAffinity(region),
  };
}

function session(region: Region, workspaceId: string): Session {
  return {
    accessToken: `access-token-${region}-longer-than-twenty-characters`,
    refreshToken: `refresh-token-${region}-longer-than-twenty-characters`,
    expiresAt: "2026-08-01T12:15:00.000Z",
    apiBaseUrl: region === "eu" ? "https://eu.api.with-avalon.com" : "https://api.with-avalon.com",
    user: {
      id: platformUserId,
      email: identity.email,
      name: identity.name,
      avatarUrl: null,
      timezone: "America/Los_Angeles",
      createdAt: at,
    },
    workspace: WorkspaceSchema.parse(workspace(region, workspaceId)),
  };
}

function invitation(region: Region = "eu") {
  return {
    id: invitationId,
    workspaceId: euWorkspaceId,
    workspaceName: "Europe Research",
    region,
    email: identity.email,
    role: "member" as const,
    invitedByName: "Owner",
    expiresAt: "2026-08-08T12:00:00.000Z",
    placementAffinity: placementAffinity(region),
  };
}

class IdentityDatabase {
  readonly statements: Array<{ sql: string; values: unknown[] }> = [];

  readonly binding = createTestD1Database({
    prepare: (sql: string) => {
      const record = { sql: sql.replace(/\s+/gu, " ").trim(), values: [] as unknown[] };
      this.statements.push(record);
      const statement = {
        bind: (...values: unknown[]) => {
          record.values = values;
          return statement;
        },
        first: async <T>() => {
          if (record.sql.includes("FROM users WHERE id = ?") && record.sql.includes("google_subject")) {
            return {
              id: platformUserId,
              google_subject: identity.googleSubject,
              email: identity.email,
              name: identity.name,
              avatar_url: null,
              timezone: identity.timezone,
              created_at: at,
              platform_user_id: platformUserId,
            } as T;
          }
          if (record.sql === "SELECT platform_user_id FROM users WHERE id = ?") {
            return { platform_user_id: platformUserId } as T;
          }
          if (record.sql.includes("SELECT preference_subject_handle, product_analytics_enabled")) {
            return {
              preference_subject_handle: preferenceSubjectHandle,
              product_analytics_enabled: 0,
              product_analytics_preference_version: 3,
            } as T;
          }
          if (record.sql.startsWith("UPDATE sessions SET revoked_at = ? WHERE id = ?")) {
            // Ending the bootstrap session now reads back the row it revoked,
            // so the revocation can be announced. See docs/access-revocation.md.
            return { id: String(record.values[1]), user_id: platformUserId, workspace_id: null } as T;
          }
          throw new Error(`Unexpected first query: ${record.sql}`);
        },
        all: async <T>() => createTestD1Result<T>(({ success: true, results: [], meta: { changes: 0 } })),
        run: async <T>() => createTestD1Result<T>(({ success: true, results: [], meta: { changes: 1 } })),
      };
      return createTestD1PreparedStatement(statement);
    },
  });
}

class MemoryBindingStore implements PlatformBindingStore {
  readonly rows: PlatformBindingRow[];

  constructor(
    row: PlatformBindingRow | null = null,
    private readonly now: () => Date = () => new Date(at),
  ) {
    this.rows = row ? [{ ...row }] : [];
  }

  get row(): PlatformBindingRow | null {
    return this.rows[0] ? { ...this.rows[0] } : null;
  }

  async list(platformId: string): Promise<PlatformBindingRow[]> {
    return this.rows.filter((row) => row.platform_user_id === platformId).map((row) => ({ ...row }));
  }

  async reconcile(
    platformId: string,
    destinations: readonly {
      region: Region;
      workspaceId: string;
      placementAffinity: "wnam" | "enam" | "weur" | "eeur";
      operationId: string;
    }[],
  ): Promise<PlatformBindingRow[]> {
    const keys = new Set(destinations.map((item) => `${item.region}:${item.workspaceId}`));
    for (const destination of destinations) {
      const existing = this.rows.find((row) => row.platform_user_id === platformId
        && row.region === destination.region && row.workspace_id === destination.workspaceId);
      if (existing) {
        if (existing.placement_affinity !== destination.placementAffinity) throw new Error("binding conflict");
        existing.status = "active";
        existing.pending_expires_at = null;
      } else {
        this.rows.push({
          platform_user_id: platformId,
          region: destination.region,
          workspace_id: destination.workspaceId,
          placement_affinity: destination.placementAffinity,
          status: "active",
          operation_id: destination.operationId,
          pending_expires_at: null,
        });
      }
    }
    for (const row of this.rows) {
      if (row.platform_user_id !== platformId || row.status === "pending") continue;
      if (!keys.has(`${row.region}:${row.workspace_id}`)) row.status = "inactive";
    }
    return this.list(platformId);
  }

  async reserve(
    platformId: string,
    region: Region,
    workspaceId: string,
    affinity: "wnam" | "enam" | "weur" | "eeur",
    nextOperationId: string,
  ): Promise<PlatformBindingRow> {
    const exact = this.rows.find((row) => row.platform_user_id === platformId
      && row.region === region && row.workspace_id === workspaceId);
    if (exact?.status === "inactive" && !this.rows.some((row) => (
      row.platform_user_id === platformId && row.status === "pending"
    ))) {
      exact.status = "pending";
      exact.operation_id = nextOperationId;
      exact.pending_expires_at = new Date(this.now().getTime() + 2 * 60_000).toISOString();
    }
    if (exact) return { ...exact };
    const pending = this.rows.find((row) => row.platform_user_id === platformId && row.status === "pending");
    if (!pending) {
      const row: PlatformBindingRow = {
        platform_user_id: platformId,
        region,
        workspace_id: workspaceId,
        placement_affinity: affinity,
        status: "pending",
        operation_id: nextOperationId,
        pending_expires_at: new Date(this.now().getTime() + 2 * 60_000).toISOString(),
      };
      this.rows.push(row);
      return { ...row };
    }
    return { ...pending };
  }

  async activate(platformId: string, nextOperationId: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.platform_user_id === platformId
      && candidate.operation_id === nextOperationId);
    if (!row) {
      throw new Error("binding conflict");
    }
    row.status = "active";
    row.pending_expires_at = null;
  }

  async release(platformId: string, nextOperationId: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.platform_user_id === platformId
      && row.operation_id === nextOperationId && row.status === "pending");
    if (index >= 0) this.rows.splice(index, 1);
  }
}

class MemoryOperationStore implements PlatformOperationStore {
  readonly rows = new Map<string, PlatformOperationRow>();

  async get(operationId: string): Promise<PlatformOperationRow | null> {
    const row = this.rows.get(operationId);
    return row ? { ...row } : null;
  }

  async begin(row: PlatformOperationRow): Promise<PlatformOperationRow> {
    const existing = this.rows.get(row.operation_id);
    if (!existing) this.rows.set(row.operation_id, { ...row });
    return { ...(existing ?? row) };
  }

  async complete(platformId: string, operationId: string): Promise<void> {
    const row = this.rows.get(operationId);
    if (!row || row.platform_user_id !== platformId) throw new Error("operation conflict");
    row.status = "complete";
  }
}

class FakeRegionalGateway implements RegionalIdentityBridgeBinding {
  discovery: RegionalDiscovery;
  readonly activate = vi.fn<(input: RegionalActivateInput) => Promise<Session>>();
  readonly create = vi.fn<(input: RegionalCreateInput) => Promise<Session>>();
  readonly accept = vi.fn<(input: RegionalAcceptInput) => Promise<Session>>();
  readonly decline = vi.fn<(input: RegionalDeclineInput) => Promise<{ ok: true }>>();

  constructor(region: Region, discovery?: Partial<RegionalDiscovery>) {
    this.discovery = { region, workspaces: [], invitations: [], ...discovery };
    this.activate.mockImplementation(async (input) => session(region, input.workspaceId));
    this.create.mockImplementation(async (input) => session(region, input.workspaceId));
    this.accept.mockImplementation(async (input) => session(region, input.workspaceId));
    this.decline.mockResolvedValue({ ok: true });
  }

  async discover(): Promise<RegionalDiscovery> {
    return structuredClone(this.discovery);
  }
}

class FakeRawRegionalBridge implements RegionalIdentityBridgeRpcBinding {
  readonly discover = vi.fn<(identity: PlatformIdentity) => Promise<RegionalRpcResult<RegionalDiscovery>>>();
  readonly activate = vi.fn<(input: RegionalActivateInput) => Promise<RegionalRpcResult<Session>>>();
  readonly create = vi.fn<(input: RegionalCreateInput) => Promise<RegionalRpcResult<Session>>>();
  readonly accept = vi.fn<(input: RegionalAcceptInput) => Promise<RegionalRpcResult<Session>>>();
  readonly decline = vi.fn<
    (input: RegionalDeclineInput) => Promise<RegionalRpcResult<{ ok: true }>>
  >();

  constructor(discovery: RegionalDiscovery) {
    this.discover.mockResolvedValue({ ok: true, value: discovery });
    this.activate.mockImplementation(async (input) => ({
      ok: true,
      value: session("eu", input.workspaceId),
    }));
    this.create.mockImplementation(async (input) => ({
      ok: true,
      value: session("eu", input.workspaceId),
    }));
    this.accept.mockImplementation(async (input) => ({
      ok: true,
      value: session("eu", input.workspaceId),
    }));
    this.decline.mockResolvedValue({ ok: true, value: { ok: true } });
  }
}

function environment(database: IdentityDatabase, eu?: RegionalIdentityBridgeRpcBinding): Env {
  return createTestEnv({
    DB: database.binding,
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    EU_PUBLIC_API_BASE_URL: "https://eu.api.with-avalon.com",
    EU_IDENTITY_BRIDGE: eu,
    SESSION_SIGNING_KEY: "global-session-signing-key-with-enough-entropy",
  });
}

function service(input: {
  global?: FakeRegionalGateway;
  eu?: FakeRegionalGateway;
  bindings?: MemoryBindingStore;
  operations?: MemoryOperationStore;
  ids?: string[];
} = {}) {
  const database = new IdentityDatabase();
  const global = input.global ?? new FakeRegionalGateway("global");
  const eu = input.eu ?? new FakeRegionalGateway("eu");
  const bindings = input.bindings ?? new MemoryBindingStore();
  const operations = input.operations ?? new MemoryOperationStore();
  const ids = [...(input.ids ?? [operationId])];
  return {
    database,
    global,
    eu,
    bindings,
    operations,
    value: new PlatformOnboardingService(environment(database), auth, {
      gateways: { global, eu },
      bindings,
      operations,
      newId: () => ids.shift() ?? operationId,
    }),
  };
}

describe("single-platform regional onboarding", () => {
  it("replays reservations idempotently in the migrated D1 stores", async () => {
    const database = migratedSqliteDatabase();
    try {
      const d1 = sqliteD1(database);
      const now = () => new Date(at);
      const bindings = new D1PlatformBindingStore(d1, now);
      const operations = new D1PlatformOperationStore(d1, now);
      const operation: PlatformOperationRow = {
        operation_id: operationId,
        platform_user_id: platformUserId,
        action: "create",
        request_fingerprint: "sha256:same-request",
        region: "eu",
        workspace_id: createdWorkspaceId,
        placement_affinity: "weur",
        invitation_id: null,
        status: "pending",
      };

      const [firstOperation, replayedOperation] = await Promise.all([
        operations.begin(operation),
        operations.begin(operation),
      ]);
      expect(replayedOperation).toEqual(firstOperation);
      const [firstBinding, replayedBinding] = await Promise.all([
        bindings.reserve(platformUserId, "eu", createdWorkspaceId, "weur", operationId),
        bindings.reserve(platformUserId, "eu", createdWorkspaceId, "weur", operationId),
      ]);
      expect(replayedBinding).toEqual(firstBinding);

      await Promise.all([
        operations.complete(platformUserId, operationId),
        operations.complete(platformUserId, operationId),
        bindings.activate(platformUserId, operationId),
        bindings.activate(platformUserId, operationId),
      ]);
      expect(await operations.get(operationId)).toMatchObject({ status: "complete" });
      expect(await bindings.list(platformUserId)).toEqual([
        expect.objectContaining({
          operation_id: operationId,
          status: "active",
          workspace_id: createdWorkspaceId,
        }),
      ]);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM platform_workspace_operations WHERE operation_id = ?`,
      ).get(operationId)).toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM platform_workspace_bindings WHERE platform_user_id = ?`,
      ).get(platformUserId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("serializes only expected regional business errors across the RPC boundary", async () => {
    await expect(serializeRegionalRpcResult(async () => {
      throw new ApiError(409, "expected_conflict", "Expected conflict");
    })).resolves.toEqual({
      ok: false,
      error: { status: 409, code: "expected_conflict", message: "Expected conflict" },
    });

    const runtimeFailure = new Error("regional runtime failed after an unknown outcome");
    await expect(serializeRegionalRpcResult(async () => {
      throw runtimeFailure;
    })).rejects.toBe(runtimeFailure);
    await expect(serializeRegionalRpcResult(async () => {
      throw new ApiError(503, "regional_database_unavailable", "Regional database unavailable");
    })).rejects.toMatchObject({ status: 503, code: "regional_database_unavailable" });
  });

  it("aggregates an EU invitation after the one Global identity login", async () => {
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    await expect(service({ eu }).value.state()).resolves.toEqual({
      workspace: null,
      workspaces: [],
      invitations: [invitation()],
    });
  });

  it("accepts an EU invitation, activates the binding, and retains the account session", async () => {
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    const subject = service({ eu, ids: [operationId] });

    await expect(subject.value.acceptInvitation(invitationId, "eu")).resolves.toEqual(session("eu", euWorkspaceId));
    expect(eu.accept).toHaveBeenCalledWith(expect.objectContaining({
      identity,
      operationId,
      workspaceId: euWorkspaceId,
      invitationId,
      preference: {
        preferenceSubjectHandle,
        enabled: false,
        version: 3,
      },
    }));
    expect(subject.bindings.row).toMatchObject({ region: "eu", workspace_id: euWorkspaceId, status: "active" });
    expect(subject.database.statements.some((item) => item.sql.startsWith("UPDATE sessions SET revoked_at"))).toBe(false);
  });

  it("declines an EU invitation without creating a workspace binding or session", async () => {
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    const subject = service({ eu });

    await expect(subject.value.declineInvitation(invitationId, "eu")).resolves.toBeUndefined();
    expect(eu.decline).toHaveBeenCalledWith({ identity, invitationId });
    expect(subject.bindings.row).toBeNull();
    expect(subject.database.statements.some((item) => item.sql.startsWith("UPDATE sessions SET revoked_at"))).toBe(false);
  });

  it("creates an EU workspace with a control-plane-generated stable ID", async () => {
    const subject = service({ ids: [createdWorkspaceId, operationId] });

    await expect(subject.value.createWorkspace("Europe Lab", "eu"))
      .resolves.toEqual(session("eu", createdWorkspaceId));
    expect(subject.eu.create).toHaveBeenCalledWith(expect.objectContaining({
      identity,
      operationId,
      workspaceId: createdWorkspaceId,
      name: "Europe Lab",
      placementAffinity: "weur",
    }));
    expect(subject.bindings.row).toMatchObject({
      region: "eu",
      workspace_id: createdWorkspaceId,
      placement_affinity: "weur",
      status: "active",
    });
  });

  it("persists an eastern request affinity through the Global reservation and regional create RPC", async () => {
    const subject = service({ ids: [createdWorkspaceId, operationId] });

    await expect(subject.value.createWorkspace("Eastern Europe Lab", "eu", { longitude: "30.5234" }))
      .resolves.toEqual(session("eu", createdWorkspaceId));
    expect(subject.eu.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: createdWorkspaceId,
      placementAffinity: "eeur",
    }));
    expect(subject.bindings.row).toMatchObject({
      region: "eu",
      workspace_id: createdWorkspaceId,
      placement_affinity: "eeur",
      status: "active",
    });
  });

  it("discovers then activates an existing EU membership without another Google login", async () => {
    const eu = new FakeRegionalGateway("eu", { workspaces: [workspace("eu", euWorkspaceId)] });
    const subject = service({ eu, ids: [operationId] });

    await expect(subject.value.state()).resolves.toEqual({
      workspace: workspace("eu", euWorkspaceId),
      workspaces: [workspace("eu", euWorkspaceId)],
      invitations: [],
    });
    expect(subject.bindings.row).toMatchObject({ region: "eu", workspace_id: euWorkspaceId, status: "active" });
    await expect(subject.value.activate("eu", euWorkspaceId)).resolves.toEqual(session("eu", euWorkspaceId));
    expect(eu.activate).toHaveBeenCalled();
  });

  it("reconciles a regional membership alongside the account's existing active binding", async () => {
    const eu = new FakeRegionalGateway("eu", { workspaces: [workspace("eu", euWorkspaceId)] });
    const bindings = new MemoryBindingStore({
      platform_user_id: platformUserId,
      region: "global",
      workspace_id: globalWorkspaceId,
      placement_affinity: "wnam",
      status: "active",
      operation_id: operationId,
      pending_expires_at: null,
    });
    await expect(service({ eu, bindings }).value.state()).resolves.toEqual({
      workspace: workspace("eu", euWorkspaceId),
      workspaces: [workspace("eu", euWorkspaceId)],
      invitations: [],
    });
    expect(bindings.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: globalWorkspaceId, status: "inactive" }),
      expect.objectContaining({ workspace_id: euWorkspaceId, status: "active" }),
    ]));
  });

  it("returns simultaneous existing Global and EU memberships in stable discovery order", async () => {
    const global = new FakeRegionalGateway("global", { workspaces: [workspace("global", globalWorkspaceId)] });
    const eu = new FakeRegionalGateway("eu", { workspaces: [workspace("eu", euWorkspaceId)] });
    await expect(service({ global, eu }).value.state()).resolves.toEqual({
      workspace: workspace("global", globalWorkspaceId),
      workspaces: [workspace("global", globalWorkspaceId), workspace("eu", euWorkspaceId)],
      invitations: [],
    });
  });

  it("does not overtake another in-flight reservation for the same account", async () => {
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    const bindings = new MemoryBindingStore({
      platform_user_id: platformUserId,
      region: "eu",
      workspace_id: euWorkspaceId,
      placement_affinity: "weur",
      status: "pending",
      operation_id: "00000000-0000-7000-8000-000000000099",
      pending_expires_at: "2026-08-01T12:02:00.000Z",
    });
    await expect(service({ eu, bindings, ids: [operationId] }).value.acceptInvitation(invitationId, "eu"))
      .rejects.toMatchObject({ status: 409, code: "workspace_setup_in_progress" });
    expect(eu.accept).not.toHaveBeenCalled();
  });

  it("releases a reservation after an explicit EU business-error envelope so retry can succeed", async () => {
    const database = new IdentityDatabase();
    const bindings = new MemoryBindingStore();
    const global = new FakeRegionalGateway("global");
    const eu = new FakeRawRegionalBridge({
      region: "eu",
      workspaces: [],
      invitations: [invitation()],
    });
    eu.accept.mockResolvedValueOnce({
      ok: false,
      error: {
        status: 409,
        code: "invitation_raced",
        message: "The invitation changed while the request was processed",
      },
    });
    const ids = [operationId, retryOperationId];
    const subject = new PlatformOnboardingService(environment(database, eu), auth, {
      gateways: { global },
      bindings,
      operations: new MemoryOperationStore(),
      newId: () => ids.shift() ?? retryOperationId,
    });

    await expect(subject.acceptInvitation(invitationId, "eu"))
      .rejects.toMatchObject({ status: 409, code: "invitation_raced" });
    expect(bindings.row).toBeNull();

    await expect(subject.acceptInvitation(invitationId, "eu"))
      .resolves.toEqual(session("eu", euWorkspaceId));
    expect(eu.accept).toHaveBeenLastCalledWith(expect.objectContaining({
      operationId: retryOperationId,
      workspaceId: euWorkspaceId,
    }));
    expect(bindings.row).toMatchObject({ status: "active", operation_id: retryOperationId });
  });

  it("never reuses an ambiguous EU reservation based on elapsed time or for a second workspace", async () => {
    let now = new Date(at);
    const database = new IdentityDatabase();
    const bindings = new MemoryBindingStore(null, () => now);
    const global = new FakeRegionalGateway("global");
    const eu = new FakeRawRegionalBridge({ region: "eu", workspaces: [], invitations: [invitation()] });
    eu.accept.mockRejectedValueOnce(new Error("RPC response lost before a regional commit"));
    const ids = [operationId, freshActivationId, createdWorkspaceId, retryOperationId];
    const subject = new PlatformOnboardingService(environment(database, eu), auth, {
      gateways: { global },
      bindings,
      operations: new MemoryOperationStore(),
      newId: () => ids.shift() ?? retryOperationId,
    });

    await expect(subject.acceptInvitation(invitationId, "eu"))
      .rejects.toMatchObject({ status: 503, code: "regional_onboarding_unavailable" });
    expect(bindings.row).toMatchObject({ status: "pending", operation_id: operationId });

    now = new Date("2026-08-01T13:00:00.000Z");
    await expect(subject.acceptInvitation(invitationId, "eu"))
      .rejects.toMatchObject({ status: 409, code: "workspace_setup_in_progress" });
    expect(eu.accept).toHaveBeenCalledTimes(1);

    await expect(subject.createWorkspace("Another Organization", "global"))
      .rejects.toMatchObject({ status: 409, code: "workspace_binding_conflict" });
    expect(global.create).not.toHaveBeenCalled();
    expect(bindings.row).toMatchObject({
      status: "pending",
      operation_id: operationId,
      region: "eu",
      workspace_id: euWorkspaceId,
    });
  });

  it("activates a fail-closed reservation when later discovery observes the delayed EU commit", async () => {
    const database = new IdentityDatabase();
    const bindings = new MemoryBindingStore();
    const global = new FakeRegionalGateway("global");
    const eu = new FakeRawRegionalBridge({ region: "eu", workspaces: [], invitations: [invitation()] });
    eu.accept.mockRejectedValueOnce(new Error("RPC response lost before discovery observed the commit"));
    const ids = [operationId, retryOperationId, freshActivationId];
    const subject = new PlatformOnboardingService(environment(database, eu), auth, {
      gateways: { global },
      bindings,
      operations: new MemoryOperationStore(),
      newId: () => ids.shift() ?? freshActivationId,
    });

    await expect(subject.acceptInvitation(invitationId, "eu"))
      .rejects.toMatchObject({ status: 503, code: "regional_onboarding_unavailable" });
    expect(bindings.row).toMatchObject({ status: "pending", operation_id: operationId });

    eu.discover.mockResolvedValue({
      ok: true,
      value: { region: "eu", workspaces: [workspace("eu", euWorkspaceId)], invitations: [] },
    });
    await expect(subject.state()).resolves.toEqual({
      workspace: workspace("eu", euWorkspaceId),
      workspaces: [workspace("eu", euWorkspaceId)],
      invitations: [],
    });
    expect(bindings.row).toMatchObject({ status: "active", operation_id: operationId });

    await expect(subject.activate("eu", euWorkspaceId)).resolves.toEqual(session("eu", euWorkspaceId));
    expect(eu.activate).toHaveBeenCalledWith(expect.objectContaining({
      operationId: retryOperationId,
      workspaceId: euWorkspaceId,
    }));
  });

  it("recovers an ambiguous invite response by discovering the committed EU membership", async () => {
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    eu.accept.mockImplementationOnce(async () => {
      eu.discovery = { region: "eu", workspaces: [workspace("eu", euWorkspaceId)], invitations: [] };
      throw new Error("RPC response lost");
    });
    const subject = service({ eu, ids: [operationId] });

    await expect(subject.value.acceptInvitation(invitationId, "eu")).resolves.toEqual(session("eu", euWorkspaceId));
    expect(eu.activate).toHaveBeenCalledWith(expect.objectContaining({ operationId, workspaceId: euWorkspaceId }));
    expect(subject.bindings.row?.status).toBe("active");
  });

  it.each(["create", "accept"])(
    "recovers a lost %s response on the next login with a fresh activation operation",
    async () => {
      const eu = new FakeRegionalGateway("eu", { workspaces: [workspace("eu", euWorkspaceId)] });
      const bindings = new MemoryBindingStore({
        platform_user_id: platformUserId,
        region: "eu",
        workspace_id: euWorkspaceId,
        placement_affinity: "weur",
        status: "active",
        operation_id: operationId,
        pending_expires_at: null,
      });
      const subject = service({ eu, bindings, ids: [freshActivationId] });

      await expect(subject.value.state()).resolves.toMatchObject({ workspace: { id: euWorkspaceId } });
      await expect(subject.value.activate("eu", euWorkspaceId)).resolves.toEqual(session("eu", euWorkspaceId));
      expect(eu.activate).toHaveBeenCalledWith(expect.objectContaining({
        operationId: freshActivationId,
        workspaceId: euWorkspaceId,
      }));
      expect(subject.database.statements.some((item) => item.sql.startsWith("UPDATE sessions SET revoked_at"))).toBe(false);
    },
  );

  it("replays a create request with the same client operation without duplicating the workspace", async () => {
    const subject = service({ ids: [createdWorkspaceId, freshActivationId] });

    await expect(subject.value.createWorkspace("Europe Lab", "eu", undefined, operationId))
      .resolves.toEqual(session("eu", createdWorkspaceId));
    await expect(subject.value.createWorkspace("Europe Lab", "eu", undefined, operationId))
      .resolves.toEqual(session("eu", createdWorkspaceId));

    expect(subject.eu.create).toHaveBeenCalledTimes(1);
    expect(subject.eu.activate).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: createdWorkspaceId,
    }));
    expect(subject.bindings.rows.filter((row) => row.workspace_id === createdWorkspaceId)).toHaveLength(1);
  });

  it("rejects reusing a client operation for different create input", async () => {
    const subject = service({ ids: [createdWorkspaceId] });

    await subject.value.createWorkspace("Europe Lab", "eu", undefined, operationId);
    await expect(subject.value.createWorkspace("Different Lab", "eu", undefined, operationId))
      .rejects.toMatchObject({ status: 409, code: "onboarding_operation_conflict" });
    expect(subject.eu.create).toHaveBeenCalledTimes(1);
  });

  it("creates another workspace while an existing membership remains active", async () => {
    const bindings = new MemoryBindingStore({
      platform_user_id: platformUserId,
      region: "global",
      workspace_id: globalWorkspaceId,
      placement_affinity: "wnam",
      status: "active",
      operation_id: retryOperationId,
      pending_expires_at: null,
    });
    const subject = service({ bindings, ids: [createdWorkspaceId] });

    await expect(subject.value.createWorkspace("Europe Lab", "eu", undefined, operationId))
      .resolves.toEqual(session("eu", createdWorkspaceId));
    expect(subject.bindings.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: globalWorkspaceId, status: "active" }),
      expect.objectContaining({ workspace_id: createdWorkspaceId, status: "active" }),
    ]));
  });

  it("accepts another workspace invitation while an existing membership remains active", async () => {
    const bindings = new MemoryBindingStore({
      platform_user_id: platformUserId,
      region: "global",
      workspace_id: globalWorkspaceId,
      placement_affinity: "wnam",
      status: "active",
      operation_id: retryOperationId,
      pending_expires_at: null,
    });
    const global = new FakeRegionalGateway("global", {
      workspaces: [workspace("global", globalWorkspaceId)],
    });
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    const subject = service({ bindings, global, eu });

    await expect(subject.value.acceptInvitation(invitationId, "eu", operationId))
      .resolves.toEqual(session("eu", euWorkspaceId));
    expect(subject.bindings.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: globalWorkspaceId, status: "active" }),
      expect.objectContaining({ workspace_id: euWorkspaceId, status: "active" }),
    ]));
  });

  it("reactivates an inactive route when membership is accepted again", async () => {
    const bindings = new MemoryBindingStore({
      platform_user_id: platformUserId,
      region: "eu",
      workspace_id: euWorkspaceId,
      placement_affinity: "weur",
      status: "inactive",
      operation_id: retryOperationId,
      pending_expires_at: null,
    });
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    const subject = service({ bindings, eu });

    await expect(subject.value.acceptInvitation(invitationId, "eu", operationId))
      .resolves.toEqual(session("eu", euWorkspaceId));
    expect(subject.bindings.row).toMatchObject({
      workspace_id: euWorkspaceId,
      status: "active",
      operation_id: operationId,
    });
  });

  it("reconciles a stale active route before accepting a new invitation to that workspace", async () => {
    const bindings = new MemoryBindingStore({
      platform_user_id: platformUserId,
      region: "eu",
      workspace_id: euWorkspaceId,
      placement_affinity: "weur",
      status: "active",
      operation_id: retryOperationId,
      pending_expires_at: null,
    });
    const eu = new FakeRegionalGateway("eu", { invitations: [invitation()] });
    eu.activate.mockRejectedValue(new ApiError(403, "workspace_access_denied", "Workspace access is unavailable"));
    const subject = service({ bindings, eu });

    await expect(subject.value.acceptInvitation(invitationId, "eu", operationId))
      .resolves.toEqual(session("eu", euWorkspaceId));

    expect(eu.accept).toHaveBeenCalledWith(expect.objectContaining({
      invitationId,
      operationId,
      workspaceId: euWorkspaceId,
    }));
    expect(eu.activate).not.toHaveBeenCalled();
  });

  it("fails closed when the named EU bridge binding is unavailable", () => {
    const database = new IdentityDatabase();
    expect(() => new PlatformOnboardingService(environment(database), auth, {
      gateways: { global: new FakeRegionalGateway("global") },
      bindings: new MemoryBindingStore(),
    })).toThrowError(expect.objectContaining({ status: 503, code: "regional_onboarding_unavailable" }));
  });
});

describe("platform identity migration", () => {
  it("rejects both nulling and relinking an established platform identity", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE workspace_invitations (
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT
      );
    `);
    const migration = readFileSync(
      new URL("../../../packages/db/migrations/0012_platform_identity_control_plane.sql", import.meta.url),
      "utf8",
    );
    database.exec(migration);
    database.prepare("INSERT INTO users (id, platform_user_id) VALUES (?, ?)")
      .run(platformUserId, platformUserId);

    expect(() => database.prepare("UPDATE users SET platform_user_id = NULL WHERE id = ?").run(platformUserId))
      .toThrow(/platform_user_id_immutable/u);
    expect(() => database.prepare("UPDATE users SET platform_user_id = ? WHERE id = ?")
      .run(globalWorkspaceId, platformUserId)).toThrow(/platform_user_id_immutable/u);
    expect(database.prepare("SELECT platform_user_id FROM users WHERE id = ?").get(platformUserId))
      .toEqual({ platform_user_id: platformUserId });
    database.close();
  });
});
