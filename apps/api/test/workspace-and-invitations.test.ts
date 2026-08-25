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

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

type FirstResolver = (statement: RecordedStatement) => unknown | null | undefined;

class StubDatabase {
  readonly batches: RecordedStatement[][] = [];
  readonly runs: RecordedStatement[] = [];

  constructor(
    private readonly resolveFirst: FirstResolver,
    private readonly resolveAll?: (statement: RecordedStatement) => unknown[] | undefined,
  ) {}

  readonly binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new StubStatement(this, sql)),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const recorded = statements.map((statement) => (statement as unknown as StubStatement).record());
      this.batches.push(recorded);
      return createTestD1Results<T>(recorded.map(() => ({
        success: true,
        results: [],
        meta: { changes: 1 },
      })));
    },
  });

  first(statement: RecordedStatement): unknown | null {
    const value = this.resolveFirst(statement);
    if (value === undefined) throw new Error(`Unexpected first() query: ${statement.sql}`);
    return value;
  }

  all(statement: RecordedStatement): unknown[] {
    const value = this.resolveAll?.(statement);
    if (value === undefined) throw new Error(`Unexpected all() query: ${statement.sql}`);
    return value;
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
    expect(update?.values[0]).toBe("Europe/London");
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

  it("rejects another active workspace before changing invitation state", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      if (sql.includes("FROM workspace_members") && sql.includes("workspace_id != ?")) {
        return { workspace_id: "another-workspace" };
      }
      return undefined;
    });

    await expect(acceptInvitationForUser(
      environment(database),
      invitationRow.id,
      { id: ownerAuth.userId, email: invitationRow.email },
    )).rejects.toMatchObject({ status: 409, code: "workspace_membership_conflict" });
    expect(database.batches).toHaveLength(0);
  });

  it("emails the original inviter once after an invitation is accepted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      if (sql.includes("FROM workspace_members") && sql.includes("workspace_id != ?")) return null;
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
  });

  it("does not resend an acceptance notification when the same user replays acceptance", async () => {
    const accepted = {
      ...invitationRow,
      accepted_at: "2026-08-01T01:00:00.000Z",
      accepted_by_user_id: ownerAuth.userId,
    };
    const database = new StubDatabase(({ sql }) => sql.includes("WHERE i.id = ?") ? accepted : undefined);
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

  it("reissues duplicate pending invitations and returns a fragment-protected web link", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("SELECT 1 AS present")) return null;
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
      return undefined;
    });

    const result = await new WorkspaceService(environment(database), ownerAuth)
      .createInvitation(invitationRow.email.toUpperCase(), "member");

    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]![0]!.sql).toContain("SET revoked_at = ?");
    expect(database.batches[0]![1]!.values[2]).toBe(invitationRow.email);
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
  });

  it("revokes a newly persisted invitation when Resend rejects delivery", async () => {
    const database = new StubDatabase(({ sql }) => {
      if (sql.includes("SELECT 1 AS present")) return null;
      if (sql.includes("WHERE i.id = ?")) return invitationRow;
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
  });

  it("limits administrator invitations to workspace owners", async () => {
    const database = new StubDatabase(() => undefined);
    const admin = { ...ownerAuth, role: "admin" as const };
    await expect(new WorkspaceService(environment(database), admin)
      .createInvitation("admin@example.com", "admin"))
      .rejects.toMatchObject({ status: 403, code: "workspace_owner_required" });
    expect(database.batches).toHaveLength(0);
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
  it("keeps workspace and invitation setup out of the identity OAuth state", async () => {
    const database = new StubDatabase(() => undefined);
    const authorize = await new AuthService(environment(database)).beginIdentity({
      returnUri: "avalon://auth/complete",
      desktopAttemptId: "a".repeat(43),
      desktopCodeChallenge: "c".repeat(43),
    });

    expect(database.runs).toHaveLength(1);
    const stateInsert = database.runs[0]!;
    expect(stateInsert.sql).toContain("workspace_name, invitation_id");
    expect(stateInsert.values[1]).toBe("global");
    expect(stateInsert.values[3]).toBeNull();
    expect(stateInsert.values[4]).toBeNull();
    expect(stateInsert.values[5]).toBeNull();
    const google = new URL(authorize);
    expect(google.hostname).toBe("accounts.google.com");
    expect(google.searchParams.get("scope")).toBe("openid email profile");
  });

  it("allows identity-only sign-in before organization selection", async () => {
    const database = new StubDatabase(() => undefined);
    await expect(new AuthService(environment(database)).beginIdentity({
      desktopAttemptId: "a".repeat(43),
      desktopCodeChallenge: "c".repeat(43),
    })).resolves.toContain("accounts.google.com");
    expect(database.runs).toHaveLength(1);
    expect(database.runs[0]!.values[4]).toBeNull();
    expect(database.runs[0]!.values[5]).toBeNull();
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
    expect(database.runs).toHaveLength(1);
    expect(database.runs[0]?.sql).toContain("UPDATE workspace_invitations SET revoked_at = ?");
    expect(database.runs[0]?.values[2]).toBe(invitationRow.email);
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
