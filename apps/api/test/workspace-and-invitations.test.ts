import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { drainWaitUntil } from './helpers/cloudflare-workers';
import "../../../tests/isolated-region";
import { asWorkspaceId } from "@rally/contracts";
import { asUserId } from "@rally/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env, IdentityAuthContext } from "../src/env";
import { sha256 } from "../src/lib/crypto";
import { AuthService, __authServiceTesting } from "../src/services/auth-service";
import {
  acceptInvitationForUser,
  declineInvitationForUser,
  previewInvitation,
  WorkspaceOnboardingService,
  WorkspaceService,
} from "../src/services/workspace-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestD1Results, createTestEnv } from "./helpers/cloudflare-test";
import { publishWorkspaceSync } from "../src/services/workspace-realtime-service";
import type * as WorkspaceRealtimeService from "../src/services/workspace-realtime-service";

// The control plane is a scripted D1 here; the workspace object behind the sync publish is not.
vi.mock("../src/services/workspace-realtime-service", async (importActual) => ({
  ...await importActual<typeof WorkspaceRealtimeService>(),
  publishWorkspaceSync: vi.fn(async () => 1),
}));

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

type FirstResolver = (statement: RecordedStatement) => unknown | null | undefined;

class StubDatabase {
  readonly batches: RecordedStatement[][] = [];
  readonly runs: RecordedStatement[] = [];
  readonly firsts: RecordedStatement[] = [];

  constructor(
    private readonly resolveFirst: FirstResolver,
    private readonly resolveAll?: (statement: RecordedStatement) => unknown[] | undefined,
    private readonly resolveRun?: (statement: RecordedStatement) => void,
    private readonly resolveBatchRow?: (statement: RecordedStatement) => unknown[] | undefined,
  ) {}

  readonly binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new StubStatement(this, sql)),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const recorded = statements.map((statement) => (statement as unknown as StubStatement).record());
      this.batches.push(recorded);
      return createTestD1Results<T>(recorded.map((statement) => ({
        success: true,
        results: (this.resolveBatchRow?.(statement) ?? []) as T[],
        meta: { changes: 1 },
      })));
    },
  });

  first(statement: RecordedStatement): unknown | null {
    this.firsts.push(statement);
    const value = this.resolveFirst(statement);
    if (value === undefined) throw new Error(`Unexpected first() query: ${statement.sql}`);
    return value;
  }

  all(statement: RecordedStatement): unknown[] {
    const value = this.resolveAll?.(statement);
    if (value === undefined && statement.sql.includes("FROM workspace_relationship_deliveries")) return [];
    if (value === undefined) throw new Error(`Unexpected all() query: ${statement.sql}`);
    return value;
  }

  run(statement: RecordedStatement): void {
    this.resolveRun?.(statement);
  }
}

class StubStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: StubDatabase,
    private readonly rawSql: string,
  ) {}

  bind(...values: unknown[]): StubStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.record()) as T | null;
  }

  async run<T>(): Promise<D1Result<T>> {
    this.database.run(this.record());
    this.database.runs.push(this.record());
    return createTestD1Result<T>({ success: true, results: [], meta: { changes: 1 } });
  }


  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({
      success: true,
      results: this.database.all(this.record()) as T[],
      meta: {},
    });
  }

  record(): RecordedStatement {
    return { sql: this.rawSql.replace(/\s+/gu, " ").trim(), values: this.values };
  }
}

const invitationRow = {
  id: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0",
  workspace_id: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1",
  workspace_name: "Avalon Studio",
  workspace_region: "global" as const,
  email: "invitee@example.com",
  role: "member" as const,
  invited_by_name: "Adam",
  invited_by_email: "adam@example.com",
  expires_at: "2026-08-08T00:00:00.000Z",
  accepted_at: null,
  accepted_by_user_id: null,
  revoked_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
};

const ownerAuth: AuthContext = {
  sessionId: "session-1",
  userId: asUserId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2"),
  workspaceId: asWorkspaceId(invitationRow.workspace_id),
  region: "global",
  role: "owner",
};

function environment(database: StubDatabase, overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    DB: database.binding,
    APP_ENV: "test",
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
    SESSION_SIGNING_KEY: "test-session-signing-key-with-enough-entropy",
    RESEND_FROM_EMAIL: "Avalon <invites@with-avalon.com>",
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace preferences", () => {
  const workspaceRow = {
    id: invitationRow.workspace_id,
    name: invitationRow.workspace_name,
    slug: "avalon-studio",
    region: "global",
    timezone: "America/Los_Angeles",
    role: "owner",
    created_at: "2026-08-01T00:00:00.000Z",
  };

  it("returns and updates the workspace timezone", async () => {
    const database = new StubDatabase(({ sql }) =>
      sql.includes("FROM workspaces w JOIN workspace_members") ? workspaceRow : undefined
    );
    const service = new WorkspaceService(environment(database), ownerAuth);

    await expect(service.getWorkspace()).resolves.toMatchObject({ timezone: "America/Los_Angeles" });
    await expect(service.updateWorkspace({ timezone: "Europe/London" }))
      .resolves.toMatchObject({ timezone: "America/Los_Angeles" });

    const update = database.runs.find((statement) => statement.sql.startsWith("UPDATE workspaces"));
    expect(update?.values.slice(0, 2)).toEqual([null, "Europe/London"]);
  });

  it("keeps workspace preferences admin-only", async () => {
    const database = new StubDatabase(() => undefined);
    const service = new WorkspaceService(environment(database), { ...ownerAuth, role: "member" });

    await expect(service.updateWorkspace({ timezone: "Europe/London" }))
      .rejects.toMatchObject({ status: 403 });
    expect(database.runs).toHaveLength(0);
  });
});

describe("workspace invitation lifecycle", () => {
  it("does not consume an invitation when the signed-in email is wrong", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("WHERE i.token_hash = ?")) return invitationRow;
      if (sql === "SELECT id, email, name FROM users WHERE id = ?") {
        return { id: ownerAuth.userId, email: "wrong@example.com", name: "Wrong User" };
      }
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      return undefined;
    });

    await expect(new WorkspaceService(environment(database), ownerAuth).acceptInvitation("a".repeat(32)))
      .rejects.toMatchObject({ status: 403, code: "invitation_email_mismatch" });
    expect(database.batches).toHaveLength(0);
  });

  it("atomically activates membership and consumes a valid invitation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      if (sql.includes("FROM workspace_members") && sql.includes("workspace_id != ?")) return null;
      return undefined;
    });
    const env = environment(database);
    const user = { id: ownerAuth.userId, email: invitationRow.email };

    await expect(acceptInvitationForUser(env, invitationRow.id, user))
      .resolves.toBe(invitationRow.workspace_id);
    // The new member's search decisions are projected for them by name.
    expect(publishWorkspaceSync).toHaveBeenCalledWith(env, invitationRow.workspace_id, ["member_directory"], { memberUserIds: [user.id] });
    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]).toHaveLength(2);
    expect(database.batches[0]![0]!.sql).toContain("UPDATE workspace_invitations SET accepted_at = ?, accepted_by_user_id = ?");
    expect(database.batches[0]![1]!.sql).toContain("INSERT INTO workspace_members");
    expect(database.batches[0]![1]!.sql).toContain("WHERE i.id = ? AND i.accepted_at = ? AND i.accepted_by_user_id = ?");
    expect(database.batches[0]![1]!.values).toEqual([
      user.id,
      "2026-08-01T01:00:00.000Z",
      invitationRow.id,
      "2026-08-01T01:00:00.000Z",
      user.id,
    ]);
  });

  it("accepts an invitation while another workspace membership remains active", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      return undefined;
    });

    await expect(acceptInvitationForUser(
      environment(database),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email },
    )).resolves.toBe(invitationRow.workspace_id);
    expect(database.batches).toHaveLength(1);
  });

  it.each([false, true])("emails the original inviter once after acceptance, including a failed dispatch read (%s)", async (dispatchReadFails) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      if (sql.includes("FROM workspace_members") && sql.includes("workspace_id != ?")) return null;
      return undefined;
    }, ({ sql }) => {
      if (dispatchReadFails && sql.includes("FROM workspace_relationship_deliveries")) throw new Error("D1 read unavailable");
      return undefined;
    });
    const resend = vi.fn(async () => new Response(JSON.stringify({ id: "accepted-email-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", resend);

    await expect(acceptInvitationForUser(
      environment(database, { APP_ENV: "production", RESEND_API_KEY: "re_test_send_only" }),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email, name: "Invitee <Team>" },
    )).resolves.toBe(invitationRow.workspace_id);

    expect(resend).toHaveBeenCalledTimes(1);
    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      "idempotency-key": `avalon-workspace-invitation/${invitationRow.id}/accepted`,
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      to: [invitationRow.invited_by_email],
      subject: "Invitee <Team> accepted your invitation to Avalon Studio",
      tags: [
        { name: "category", value: "workspace_invitation_accepted" },
        { name: "region", value: "global" },
      ],
    });
    expect(String(body.html)).toContain("Invitee &lt;Team&gt;");
    expect(String(body.html)).not.toContain("Invitee <Team>");
    // The roster the email is about lives on the Members page.
    expect(String(body.text)).toContain(encodeURIComponent(`rallywithai://workspace/global/${invitationRow.workspace_id}/settings/members`));
  });

  it.each([false, true])("does not resend an acceptance notification on replay, including a failed dispatch read (%s)", async (dispatchReadFails) => {
    const accepted = {
      ...invitationRow,
      accepted_at: "2026-08-01T01:00:00.000Z",
      accepted_by_user_id: ownerAuth.userId,
    };
    const database = new StubDatabase(({ sql }) => sql.includes("WHERE i.id = ?") ? accepted : undefined, ({ sql }) => {
      if (dispatchReadFails && sql.includes("FROM workspace_relationship_deliveries")) throw new Error("D1 read unavailable");
      return undefined;
    });
    const resend = vi.fn();
    vi.stubGlobal("fetch", resend);

    await expect(acceptInvitationForUser(
      environment(database, { APP_ENV: "production", RESEND_API_KEY: "re_test_send_only" }),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email, name: "Invitee" },
    )).resolves.toBe(invitationRow.workspace_id);
    expect(resend).not.toHaveBeenCalled();
    expect(database.batches).toHaveLength(0);
  });

  it("keeps acceptance successful when its notification email fails", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      if (sql.includes("FROM workspace_members") && sql.includes("workspace_id != ?")) return null;
      return undefined;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider unavailable", { status: 503 })));

    await expect(acceptInvitationForUser(
      environment(database, { APP_ENV: "production", RESEND_API_KEY: "re_test_send_only" }),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email, name: "Invitee" },
    )).resolves.toBe(invitationRow.workspace_id);
    expect(database.batches).toHaveLength(1);
  });

  it("emails the original inviter once after an invitation is declined", async () => {
    const database = new StubDatabase(({ sql }) => sql.includes("WHERE i.id = ?") ? invitationRow : undefined);
    const resend = vi.fn(async () => new Response(JSON.stringify({ id: "declined-email-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", resend);

    await expect(declineInvitationForUser(
      environment(database, { APP_ENV: "production", RESEND_API_KEY: "re_test_send_only" }),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email, name: "Invitee" },
    )).resolves.toBeUndefined();

    expect(resend).toHaveBeenCalledTimes(1);
    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      "idempotency-key": `avalon-workspace-invitation/${invitationRow.id}/declined`,
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      to: [invitationRow.invited_by_email],
      subject: "Invitee declined your invitation to Avalon Studio",
      tags: [
        { name: "category", value: "workspace_invitation_declined" },
        { name: "region", value: "global" },
      ],
    });
  });

  it("keeps decline successful when its notification email fails", async () => {
    const database = new StubDatabase(({ sql }) => sql.includes("WHERE i.id = ?") ? invitationRow : undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider unavailable", { status: 503 })));

    await expect(declineInvitationForUser(
      environment(database, { APP_ENV: "production", RESEND_API_KEY: "re_test_send_only" }),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email, name: "Invitee" },
    )).resolves.toBeUndefined();
    expect(database.runs.filter(({ sql }) => sql.startsWith('UPDATE workspace_invitations'))).toHaveLength(1);
  });

  it("does not send a decline notification for invalid terminal invitations or administrator revocation", async () => {
    const revoked = { ...invitationRow, revoked_at: "2026-08-01T01:00:00.000Z" };
    const declinedDatabase = new StubDatabase(({ sql }) => sql.includes("WHERE i.id = ?") ? revoked : undefined);
    const resend = vi.fn();
    vi.stubGlobal("fetch", resend);

    await expect(declineInvitationForUser(
      environment(declinedDatabase, { APP_ENV: "production", RESEND_API_KEY: "re_test_send_only" }),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email, name: "Invitee" },
    )).rejects.toMatchObject({ status: 404, code: "invitation_invalid" });

    const revokeDatabase = new StubDatabase(({ sql }) => sql.includes('WHERE i.id = ?') ? null : undefined);
    await expect(new WorkspaceService(
      environment(revokeDatabase, { APP_ENV: "production", RESEND_API_KEY: "re_test_send_only" }),
      ownerAuth,
    ).revokeInvitation(invitationRow.id)).resolves.toBeUndefined();
    expect(resend).not.toHaveBeenCalled();
  });

  it("revokes an invitation's download grant when an administrator revokes the invitation", async () => {
    const database = new StubDatabase(({ sql }) => sql.includes("WHERE i.id = ?") ? invitationRow : undefined);

    await new WorkspaceService(environment(database), ownerAuth).revokeInvitation(invitationRow.id);

    const grantRevoke = database.runs.find(({ sql }) => sql.includes("UPDATE download_grants SET revoked_at"));
    expect(grantRevoke?.sql).toContain("source = 'workspace_invitation'");
    expect(grantRevoke?.values[1]).toBe(invitationRow.id);
  });

  it("reissues duplicate pending invitations, revoking the superseded one's download grant", async () => {
    const supersededId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79ff";
    const database = new StubDatabase(
      ({ sql }) => {
        if (sql.includes("SELECT 1 AS present")) return null;
        if (sql.includes("WHERE i.id = ?")) return invitationRow;
        return undefined;
      },
      undefined,
      undefined,
      ({ sql }) => (sql.includes("UPDATE workspace_invitations SET revoked_at") ? [{ id: supersededId }] : undefined),
    );

    const result = await new WorkspaceService(environment(database), ownerAuth)
      .createInvitation(invitationRow.email.toUpperCase(), "member");

    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]![0]!.sql).toContain("SET revoked_at = ?");
    expect(database.batches[0]![0]!.sql).toContain("RETURNING id");
    expect(database.batches[0]![1]!.values[2]).toBe(invitationRow.email);
    // The superseded invitation's own download grant must not outlive it.
    const grantRevoke = database.runs.find(({ sql }) => sql.includes("UPDATE download_grants SET revoked_at"));
    expect(grantRevoke?.sql).toContain("source = 'workspace_invitation'");
    expect(grantRevoke?.values[1]).toBe(supersededId);
    const inviteUrl = new URL(result.inviteUrl);
    expect(inviteUrl.origin).toBe("https://with-avalon.com");
    expect(inviteUrl.pathname).toBe("/invite/");
    expect(inviteUrl.search).toBe("");
    const fragment = new URLSearchParams(inviteUrl.hash.slice(1));
    expect(fragment.get("region")).toBe("global");
    expect(fragment.get("token")?.length).toBeGreaterThanOrEqual(40);
    expect(result.emailDelivery).toBe("skipped");
  });

  it("sends a branded Resend email without persisting the bearer invitation token", async () => {
    const row = {
      ...invitationRow,
      workspace_name: "Research <script>alert(1)</script>",
      invited_by_name: "Adam & Team",
    };
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("SELECT 1 AS present")) return null;
      if (sql.includes("WHERE i.id = ?")) return row;
      return undefined;
    });
    const resend = vi.fn(async () => new Response(JSON.stringify({ id: "resend-email-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", resend);

    const result = await new WorkspaceService(environment(database, {
      APP_ENV: "production",
      RESEND_API_KEY: "re_test_send_only",
    }), ownerAuth).createInvitation(" INVITEE@EXAMPLE.COM ", "member");

    expect(result.emailDelivery).toBe("sent");
    expect(resend).toHaveBeenCalledTimes(1);
    const [url, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_test_send_only",
      "content-type": "application/json",
      "idempotency-key": `avalon-workspace-invitation/${invitationRow.id}`,
      "user-agent": "avalon-worker/0.1",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "Avalon <invites@with-avalon.com>",
      to: [invitationRow.email],
    });
    expect(String(body.text)).toContain(result.inviteUrl);
    expect(String(body.html)).toContain("Research &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(String(body.html)).toContain("Adam &amp; Team");
    expect(String(body.html)).not.toContain("<script>alert(1)</script>");
    const token = new URLSearchParams(new URL(result.inviteUrl).hash.slice(1)).get("token");
    expect(token).toBeTruthy();
    expect(JSON.stringify(database.batches)).not.toContain(token!);

    // A recipient with no Rally install yet must not be stuck on the accept
    // page with only a desktop deep link: the email also carries a download
    // grant from the same shared issuer Ace uses, timed to the invitation's
    // own expiry rather than single-use.
    const downloadUrlMatch = String(body.text).match(/https:\/\/with-avalon\.com\/download\/#token=([a-f0-9]{64})/);
    expect(downloadUrlMatch).toBeTruthy();
    expect(String(body.html)).toContain("Download it for macOS");
    const downloadToken = downloadUrlMatch![1]!;
    expect(downloadToken).not.toBe(token);
    expect(JSON.stringify(database.runs)).not.toContain(downloadToken);
  });

  it("does not issue a download link for an enterprise workspace invitation, since redemption is Global-only", async () => {
    const enterpriseRow = { ...invitationRow, workspace_region: "enterprise" as const };
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("SELECT 1 AS present")) return null;
      if (sql.includes("WHERE i.id = ?")) return enterpriseRow;
      return undefined;
    });
    const resend = vi.fn(async () => new Response(JSON.stringify({ id: "resend-email-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", resend);

    // A session's own region always matches its workspace's (middleware/auth.ts
    // rejects a mismatch), so an enterprise invitation is only ever created by the enterprise
    // Worker: pair the region override with the enterprise row for a realistic case.
    await new WorkspaceService(environment(database, {
      APP_ENV: "production",
      RESEND_API_KEY: "re_test_send_only",
      AVALON_REGION: "enterprise",
    }), ownerAuth).createInvitation(invitationRow.email, "member");

    expect(database.runs.some((run) => run.sql.includes("INSERT INTO download_grants"))).toBe(false);
    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(String(body.text)).not.toContain("/download/");
    expect(String(body.html)).not.toContain("Download it for macOS");
  });

  it("revokes a newly persisted invitation and its download grant when Resend rejects delivery", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("SELECT 1 AS present")) return null;
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      // The revoke targets the exact grant issued for this invitation; the
      // stub proves the call was made rather than swallowing it via `.catch`.
      if (sql.includes("UPDATE download_grants SET revoked_at")) return { id: "revoked-grant-id" };
      return undefined;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "domain not verified" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })));

    await expect(new WorkspaceService(environment(database, {
      APP_ENV: "production",
      RESEND_API_KEY: "re_test_send_only",
    }), ownerAuth).createInvitation(invitationRow.email, "member"))
      .rejects.toMatchObject({ status: 502, code: "invitation_email_failed" });
    const revocation = database.runs.find(({ sql }) => sql.includes("UPDATE workspace_invitations SET revoked_at = ?"));
    expect(revocation?.values.slice(1)).toEqual([invitationRow.id, ownerAuth.workspaceId]);
    const grantInsert = database.runs.find(({ sql }) => sql.includes("INSERT INTO download_grants"));
    const grantRevoke = database.firsts.find(({ sql }) => sql.includes("UPDATE download_grants SET revoked_at"));
    expect(grantInsert).toBeTruthy();
    expect(grantRevoke?.values[1]).toBe(grantInsert!.values[0]);
  });

  it("revokes a newly persisted invitation when issuing its download grant fails", async () => {
    const database = new StubDatabase(
      ({ sql }) => {
        if (sql.includes("SELECT 1 AS present")) return null;
        if (sql.includes("WHERE i.id = ?")) return invitationRow;
        return undefined;
      },
      undefined,
      ({ sql }) => {
        // A D1 failure while writing the grant (a partial migration, a
        // transient error) must not leave the just-persisted invitation
        // orphaned: the exact lockout this feature exists to prevent.
        if (sql.includes("INSERT INTO download_grants")) throw new Error("D1 unavailable");
      },
    );
    const resend = vi.fn();
    vi.stubGlobal("fetch", resend);

    await expect(new WorkspaceService(environment(database, {
      APP_ENV: "production",
      RESEND_API_KEY: "re_test_send_only",
    }), ownerAuth).createInvitation(invitationRow.email, "member"))
      .rejects.toThrow("D1 unavailable");
    expect(resend).not.toHaveBeenCalled();
    const revocation = database.runs.find(({ sql }) => sql.includes("UPDATE workspace_invitations SET revoked_at = ?"));
    expect(revocation?.values.slice(1)).toEqual([invitationRow.id, ownerAuth.workspaceId]);
  });

  it("lets any administrator invite another administrator, and no ordinary member invite at all", async () => {
    // The owner-only gate this used to assert was the other half of the
    // single-administrator problem: an administrator could not grow the set
    // they were part of. It is gone, and what remains is the admin gate —
    // proved by an administrator reaching the roster check behind it.
    const seated = new StubDatabase(({ sql }) =>
      sql.includes("SELECT 1 AS present FROM workspace_members") ? { present: 1 } : undefined);
    const admin = { ...ownerAuth, role: "admin" as const };
    await expect(new WorkspaceService(environment(seated), admin)
      .createInvitation("admin@example.com", "admin"))
      .rejects.toMatchObject({ status: 409, code: "already_workspace_member" });

    const refused = new StubDatabase(() => undefined);
    await expect(new WorkspaceService(environment(refused), { ...ownerAuth, role: "member" })
      .createInvitation("admin@example.com", "admin"))
      .rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
    expect(refused.batches).toHaveLength(0);
  });

  it("rejects expired previews without exposing workspace details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
    const database = new StubDatabase(({ sql }) => sql.includes("WHERE i.token_hash = ?") ? invitationRow : undefined);
    await expect(previewInvitation(environment(database), "b".repeat(32)))
      .rejects.toMatchObject({ status: 404, code: "invitation_invalid" });
  });
});

describe("organization setup intent", () => {
  it.each(["avalon://auth/complete", undefined])("persists identity-only OAuth state for return URI %s", async returnUri => {
    const database = migratedSqliteDatabase();
    try {
      const env = environment(new StubDatabase(() => undefined), { DB: sqliteD1(database), LOG_LEVEL: 'error', APP_ENV: 'development' });
      const authorize = await new AuthService(env).beginIdentity({
        ...(returnUri ? { returnUri } : {}), desktopAttemptId: "a".repeat(43), desktopCodeChallenge: "c".repeat(43),
      });
      const google = new URL(authorize);
      expect(google.hostname).toBe("accounts.google.com");
      expect(google.searchParams.get("scope")).toBe("openid email profile");
      const state = database.prepare(`SELECT purpose,workspace_id,workspace_name,invitation_id,desktop_attempt_id,desktop_code_challenge
        FROM oauth_states WHERE id=?`).get(google.searchParams.get('state'));
      expect(state).toEqual({ purpose:'identity',workspace_id:null,workspace_name:null,invitation_id:null,
        desktop_attempt_id:'a'.repeat(43),desktop_code_challenge:'c'.repeat(43) });
    } finally { await drainWaitUntil(); database.close(); }
  });
});

describe("identity-first workspace onboarding", () => {
  const identityAuth: IdentityAuthContext = {
    sessionId: "session-unbound",
    userId: ownerAuth.userId,
    workspaceId: null,
    region: "global",
    role: null,
  };

  it("lists only pending invitations for the signed-in identity", async () => {
    const database = new StubDatabase(
      () => undefined,
      ({ sql, values }) => {
        expect(sql).toContain("i.email = invitee.email COLLATE NOCASE");
        expect(sql).toContain("i.accepted_at IS NULL");
        expect(values[0]).toBe(identityAuth.userId);
        return [invitationRow];
      },
    );

    await expect(new WorkspaceOnboardingService(environment(database), identityAuth).state())
      .resolves.toEqual({
        invitations: [{
          id: invitationRow.id,
          workspaceId: invitationRow.workspace_id,
          workspaceName: invitationRow.workspace_name,
          region: "global",
          email: invitationRow.email,
          role: "member",
          invitedByName: "Adam",
          expiresAt: invitationRow.expires_at,
        }],
      });
  });

  it("creates and binds a workspace only after authenticated setup", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("FROM workspace_members") && sql.includes("LIMIT 1")) return null;
      return undefined;
    });

    await new WorkspaceOnboardingService(environment(database), identityAuth).createWorkspace(" Acme Research ");

    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]?.[0]?.sql).toContain("INSERT INTO workspaces");
    expect(database.batches[0]?.[0]?.values[1]).toBe("Acme Research");
    expect(database.batches[0]?.[1]?.sql).toContain("'owner', 'active'");
    expect(database.batches[0]?.[2]?.sql).toContain("UPDATE sessions SET workspace_id = ?");
  });

  it("accepts a matching invitation and binds all unbound regional sessions", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql === "SELECT id, email, name FROM users WHERE id = ?") {
        return { id: identityAuth.userId, email: invitationRow.email, name: "Invitee" };
      }
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      if (sql.includes("FROM workspace_members") && sql.includes("workspace_id != ?")) return null;
      return undefined;
    });

    await new WorkspaceOnboardingService(environment(database), identityAuth)
      .acceptInvitation(invitationRow.id);

    expect(database.batches).toHaveLength(1);
    expect(database.runs.at(-1)?.sql).toContain("UPDATE sessions SET workspace_id = ?");
    expect(database.runs.at(-1)?.values[0]).toBe(invitationRow.workspace_id);
  });

  it("declines a matching invitation without creating membership", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql === "SELECT id, email, name FROM users WHERE id = ?") {
        return { id: identityAuth.userId, email: invitationRow.email, name: "Invitee" };
      }
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      return undefined;
    });

    await new WorkspaceOnboardingService(environment(database), identityAuth)
      .declineInvitation(invitationRow.id);

    expect(database.batches).toHaveLength(0);
    expect(database.runs).toHaveLength(2);
    expect(database.runs[0]?.sql).toContain("UPDATE workspace_invitations SET revoked_at = ?");
    expect(database.runs[0]?.values[2]).toBe(invitationRow.email);
    // A declined invitation must not leave its download link usable for the
    // remainder of its 7-day window.
    expect(database.runs[1]?.sql).toContain("UPDATE download_grants SET revoked_at");
    expect(database.runs[1]?.sql).toContain("source = 'workspace_invitation'");
    expect(database.runs[1]?.values[1]).toBe(invitationRow.id);
  });
});

describe("single-platform identity bootstrap", () => {
  it("never embeds an existing Global workspace in the Google desktop ticket", () => {
    expect(__authServiceTesting.identityBootstrapWorkspaceId()).toBeNull();
  });
});

describe("desktop login ticket PKCE binding", () => {
  const identity = {
    user_id: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2",
    email: "member@example.com",
    user_name: "Member",
    avatar_url: null,
    user_timezone: "America/Los_Angeles",
    user_created_at: "2026-08-01T00:00:00.000Z",
    workspace_id: invitationRow.workspace_id,
    workspace_name: invitationRow.workspace_name,
    workspace_slug: "avalon-studio",
    workspace_region: "global" as const,
    workspace_timezone: "America/Los_Angeles",
    workspace_created_at: "2026-08-01T00:00:00.000Z",
    role: "member" as const,
  };

  it("requires the matching attempt and verifier and consumes a ticket only once", async () => {
    const verifier = "v".repeat(64);
    const challenge = await sha256(verifier);
    let claimed = false;
    const database = new StubDatabase(({ sql, values }) => {
      if (sql.startsWith("UPDATE desktop_login_tickets")) {
        if (claimed || values[3] !== "a".repeat(43)) return null;
        claimed = true;
        return {
          user_id: identity.user_id,
          workspace_id: identity.workspace_id,
          desktop_code_challenge: challenge,
        };
      }
      if (sql.startsWith("SELECT u.id AS user_id")) return identity;
      return undefined;
    });
    const service = new AuthService(environment(database));
    const request = {
      ticket: "ticket-value-longer-than-twenty-characters",
      region: "global" as const,
      attemptId: "a".repeat(43),
      codeVerifier: verifier,
    };

    await expect(service.exchangeDesktopTicket(request)).resolves.toMatchObject({
      user: { email: identity.email },
      workspace: { id: identity.workspace_id, region: "global" },
    });
    await expect(service.exchangeDesktopTicket(request))
      .rejects.toMatchObject({ status: 401, code: "invalid_login_ticket" });
  });

  it("seeds the account timezone from the signing-in machine but never over a chosen one", async () => {
    const verifier = "v".repeat(64);
    const challenge = await sha256(verifier);
    const database = new StubDatabase(({ sql }) => {
      if (sql.startsWith("UPDATE desktop_login_tickets")) {
        return {
          user_id: identity.user_id,
          workspace_id: identity.workspace_id,
          desktop_code_challenge: challenge,
        };
      }
      if (sql.startsWith("SELECT u.id AS user_id")) return identity;
      return undefined;
    });
    const service = new AuthService(environment(database));
    const request = {
      ticket: "ticket-value-longer-than-twenty-characters",
      region: "global" as const,
      attemptId: "a".repeat(43),
      codeVerifier: verifier,
    };

    await service.exchangeDesktopTicket({ ...request, timezone: "America/New_York" });
    const seeded = database.runs.find((statement) => statement.sql.startsWith("UPDATE users SET timezone"));
    // Guarded, so an account whose owner picked a zone in settings keeps it
    // when they next sign in from a machine somewhere else.
    expect(seeded!.sql).toContain("timezone_source = 'client'");
    expect(seeded!.values[0]).toBe("America/New_York");

    // A client that sends no zone knows nothing about where this person is; it
    // used to be answered with Pacific, which is a guess written over an answer.
    await service.exchangeDesktopTicket(request);
    expect(database.runs.filter((statement) =>
      statement.sql.startsWith("UPDATE users SET timezone"))).toHaveLength(1);
  });

  it("burns a correctly targeted ticket when the verifier proof is wrong", async () => {
    const challenge = await sha256("v".repeat(64));
    let claims = 0;
    const database = new StubDatabase(({ sql }) => {
      if (sql.startsWith("UPDATE desktop_login_tickets")) {
        claims += 1;
        return claims === 1
          ? {
              user_id: identity.user_id,
              workspace_id: identity.workspace_id,
              desktop_code_challenge: challenge,
            }
          : null;
      }
      return undefined;
    });
    const service = new AuthService(environment(database));

    const request = {
      ticket: "ticket-value-longer-than-twenty-characters",
      region: "global" as const,
      attemptId: "a".repeat(43),
      codeVerifier: "x".repeat(64),
    };
    await expect(service.exchangeDesktopTicket(request))
      .rejects.toMatchObject({ status: 401, code: "invalid_login_ticket" });
    await expect(service.exchangeDesktopTicket({ ...request, codeVerifier: "v".repeat(64) }))
      .rejects.toMatchObject({ status: 401, code: "invalid_login_ticket" });
    expect(claims).toBe(2);
  });
});

describe("pending invitees for the people pickers", () => {
  function seeded() {
    const database = migratedSqliteDatabase();
    const at = "2026-08-01T00:00:00.000Z";
    const workspaceId = invitationRow.workspace_id;
    const owner = ownerAuth.userId;
    const guestId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79e1";
    database.prepare(`INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?,?,?,?,?),(?,?,?,?,?)`)
      .run(owner, "owner@example.com", "Owner", at, at, guestId, "guest@example.com", "Guest", at, at);
    database.prepare(`INSERT INTO workspaces (id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(workspaceId, "Avalon Studio", "avalon-studio", "global", owner, at, at);
    database.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,access_class,status,joined_at) VALUES (?,?,?,?,?,?),(?,?,?,?,?,?)`)
      .run(workspaceId, owner, "owner", "member", "active", at, workspaceId, guestId, null, "guest", "active", at);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const invite = database.prepare(`INSERT INTO workspace_invitations
      (id,workspace_id,email,invited_by_user_id,token_hash,role,expires_at,accepted_at,revoked_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    invite.run("018f3f4e-7b5a-7cc1-9a6f-2aa0324b7a01", workspaceId, "Pending@Example.com", owner, "h1", "member", future, null, null, at);
    invite.run("018f3f4e-7b5a-7cc1-9a6f-2aa0324b7a02", workspaceId, "accepted@example.com", owner, "h2", "member", future, at, null, at);
    invite.run("018f3f4e-7b5a-7cc1-9a6f-2aa0324b7a03", workspaceId, "revoked@example.com", owner, "h3", "member", future, null, at, at);
    invite.run("018f3f4e-7b5a-7cc1-9a6f-2aa0324b7a04", workspaceId, "expired@example.com", owner, "h4", "member", past, null, null, at);
    // Shared a Channel before accepting: a guest membership already names them.
    invite.run("018f3f4e-7b5a-7cc1-9a6f-2aa0324b7a05", workspaceId, "guest@example.com", owner, "h5", "member", future, null, null, at);
    return database;
  }

  it("lists only addresses still waiting to accept, for an ordinary member", async () => {
    const database = seeded();
    try {
      const env = environment(new StubDatabase(() => undefined), { DB: sqliteD1(database) });
      await expect(new WorkspaceService(env, { ...ownerAuth, role: "member" }).listInvitees())
        .resolves.toEqual([{ email: "pending@example.com", invitedAt: "2026-08-01T00:00:00.000Z" }]);
    } finally { database.close(); }
  });
});
