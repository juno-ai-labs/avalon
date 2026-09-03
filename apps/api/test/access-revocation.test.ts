import { asUserId, asWorkspaceId } from "@rally/contracts";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workspaceMembershipRoutes } from "../src/routes/workspace-membership";
import { applyAccessRevocation, consumeAccessRevocationQueue } from "../src/queues/access-revocation-consumer";
import {
  AccessRevocationMessageSchema,
  isAccessRevocationQueue,
  revocationClosesSocket,
  type AccessRevocationMessage,
  publishAccessRevocation,
  reapExpiredSessions,
} from "../src/services/access-revocation";
import { AuthService } from "../src/services/auth-service";
import { RegionalOnboardingService } from "../src/services/platform-onboarding-service";
import { acceptInvitationForUser, WorkspaceService } from "../src/services/workspace-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";


const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const OWNER = asUserId("00000000-0000-7000-8000-000000000002");
const MEMBER = asUserId("00000000-0000-7000-8000-000000000003");
const ADMIN = asUserId("00000000-0000-7000-8000-000000000004");
const NOW = "2026-08-22T12:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

interface Published { body: unknown }

/**
 * The workspace object only receives the sidebar invalidation here; the
 * revocation itself travels by queue, which is what these tests read.
 */
function workspaceDurableObjects(): Env["WORKSPACE_DOS"] {
  const stub = { publishSync: async () => 0 };
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return binding;
}

function environment(database: DatabaseSync): { env: Env; sent: Published[] } {
  const sent: Published[] = [];
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    WORKSPACE_DOS: workspaceDurableObjects(),
    ACCESS_REVOCATION_QUEUE: {
      send: async (body: unknown) => { sent.push({ body }); },
      sendBatch: async (messages: Array<{ body: unknown }>) => { sent.push(...messages); },
    },
  });
  return { env, sent };
}

function seed(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  for (const [id, email] of [[OWNER, "owner"], [MEMBER, "member"], [ADMIN, "admin"]] as const) {
    database.prepare(
      `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
       VALUES (?, ?, ?, 'Test Person', ?, ?)`,
    ).run(id, `google-${id}`, `${email}@example.test`, NOW, NOW);
  }
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Test', 'test', 'global', ?, ?, ?)`,
  ).run(WORKSPACE, OWNER, NOW, NOW);
  for (const [id, role] of [[OWNER, "owner"], [MEMBER, "member"], [ADMIN, "admin"]] as const) {
    database.prepare(
      `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'active', ?)`,
    ).run(WORKSPACE, id, role, NOW);
  }
  return database;
}

function auth(userId: string, role: AuthContext["role"]): AuthContext {
  return {
    userId: asUserId(userId),
    workspaceId: WORKSPACE,
    sessionId: "session-a",
    region: "global" as const,
    role,
    analyticsWorkspaceId: null,
  };
}

describe("removing a member", () => {
  it("deletes the membership and publishes the revocation", async () => {
    const database = seed();
    const { env, sent } = environment(database);
    await new WorkspaceService(env, auth(OWNER, "owner")).removeMember(MEMBER);

    const remaining = database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).get(WORKSPACE, MEMBER) as { count: number };
    expect(remaining.count).toBe(0);

    const revocations = sent
      .map((message) => AccessRevocationMessageSchema.safeParse(message.body))
      .flatMap((parsed) => parsed.success ? [parsed.data] : []);
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      reason: "workspace_membership_removed",
      workspaceId: WORKSPACE,
      userId: MEMBER,
      // No session: every window they hold is inadmissible now.
      sessionId: null,
      target: { scope: "workspace" },
    });
  });

  it("keeps an owner when two owners remove each other at the same time", async () => {
    const database = seed();
    const { env, sent } = environment(database);
    // A second owner, so each of them passes every check the other does.
    database.prepare(
      `UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?`,
    ).run(WORKSPACE, ADMIN);

    // Both read the other's owner row before either delete runs — which is what
    // the guards cannot see, and what an unconditional delete would let through
    // on both sides, leaving a workspace with no owner at all.
    const outcomes = await Promise.allSettled([
      new WorkspaceService(env, auth(OWNER, "owner")).removeMember(ADMIN),
      new WorkspaceService(env, auth(ADMIN, "owner")).removeMember(OWNER),
    ]);

    const owners = database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members
        WHERE workspace_id = ? AND role = 'owner' AND status = 'active'`,
    ).get(WORKSPACE) as { count: number };
    expect(owners.count).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    // The refused one announces nothing: it did not cause a revocation.
    expect(sent).toHaveLength(1);
  });

  it("refuses an admin whose target was promoted after the check", async () => {
    const database = seed();
    const { env, sent } = environment(database);
    const service = new WorkspaceService(env, auth(ADMIN, "admin"));
    // The role is read in an earlier round trip than the delete. Promote the
    // target in between, exactly as a concurrent request would: an admin may
    // remove a member but never an owner, and a delete that asserts only the
    // caller's standing would take one anyway.
    const promote = () => database.prepare(
      `UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?`,
    ).run(WORKSPACE, MEMBER);
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("DELETE FROM workspace_members")) promote();
      return prepare(sql);
    });

    await expect(service.removeMember(MEMBER)).rejects.toThrow(/membership changed/i);
    const remaining = database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).get(WORKSPACE, MEMBER) as { count: number };
    expect(remaining.count).toBe(1);
    expect(sent).toEqual([]);
  });

  it("refuses a member, a self-removal, and an admin reaching for an owner", async () => {
    const database = seed();
    const { env, sent } = environment(database);
    await expect(new WorkspaceService(env, auth(MEMBER, "member")).removeMember(OWNER))
      .rejects.toThrow(/owner or admin/i);
    await expect(new WorkspaceService(env, auth(OWNER, "owner")).removeMember(OWNER))
      .rejects.toThrow(/yourself/i);
    // An admin outranks a member but not an owner. With self-removal refused
    // too, an active owner is always left behind, which is why nothing counts
    // owners here.
    await expect(new WorkspaceService(env, auth(ADMIN, "admin")).removeMember(OWNER))
      .rejects.toThrow(/owner can remove an owner/i);

    const remaining = database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?`,
    ).get(WORKSPACE) as { count: number };
    expect(remaining.count).toBe(3);
    // A refusal writes nothing, so nothing is announced either.
    expect(sent).toEqual([]);
  });
});

describe("leaving a workspace", () => {
  it("deletes the caller's membership and publishes the ordinary membership revocation", async () => {
    const database = seed();
    const { env, sent } = environment(database);

    await expect(new WorkspaceService(env, auth(MEMBER, "member")).leaveWorkspace("left"))
      .resolves.toEqual({ outcome: "left" });

    expect(database.prepare(
      "SELECT 1 AS present FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(WORKSPACE, MEMBER)).toBeUndefined();
    expect(sent.map((message) => AccessRevocationMessageSchema.parse(message.body))).toEqual([
      expect.objectContaining({
        reason: "workspace_membership_removed",
        workspaceId: WORKSPACE,
        userId: MEMBER,
        sessionId: null,
      }),
    ]);
  });

  it("refuses the sole owner while other active members remain", async () => {
    const database = seed();
    const { env, sent } = environment(database);

    await expect(new WorkspaceService(env, auth(OWNER, "owner")).leaveWorkspace("left"))
      .rejects.toMatchObject({ status: 409, code: "sole_workspace_owner" });

    expect(database.prepare(
      "SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(WORKSPACE, OWNER)).toEqual({ status: "active" });
    expect(sent).toEqual([]);
  });

  it("abandons the workspace, suspends its final member, and revokes pending invitations atomically", async () => {
    const database = seed();
    database.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id != ?",
    ).run(WORKSPACE, OWNER);
    database.prepare(
      `INSERT INTO workspace_invitations
       (id, workspace_id, email, invited_by_user_id, token_hash, role, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'member', ?, ?)`,
    ).run(
      "00000000-0000-7000-8000-000000000099",
      WORKSPACE,
      "invited@example.test",
      OWNER,
      "token-hash",
      "2099-01-01T00:00:00.000Z",
      NOW,
    );
    const { env, sent } = environment(database);

    await expect(new WorkspaceService(env, auth(OWNER, "owner")).leaveWorkspace("abandoned"))
      .resolves.toEqual({ outcome: "abandoned" });

    expect(database.prepare("SELECT abandoned_at FROM workspaces WHERE id = ?").get(WORKSPACE))
      .toEqual({ abandoned_at: expect.any(String) });
    expect(database.prepare(
      "SELECT role, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(WORKSPACE, OWNER)).toEqual({ role: "owner", status: "suspended" });
    expect(database.prepare(
      "SELECT revoked_at FROM workspace_invitations WHERE workspace_id = ?",
    ).get(WORKSPACE)).toEqual({ revoked_at: expect.any(String) });
    expect(sent.map((message) => AccessRevocationMessageSchema.parse(message.body))).toEqual([
      expect.objectContaining({ userId: OWNER, workspaceId: WORKSPACE, sessionId: null }),
    ]);
  });

  it("never leaves an accepted member active inside an abandoned workspace", async () => {
    const database = seed();
    database.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id != ?",
    ).run(WORKSPACE, OWNER);
    database.prepare(
      `INSERT INTO workspace_invitations
       (id, workspace_id, email, invited_by_user_id, token_hash, role, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'member', ?, ?)`,
    ).run(
      "00000000-0000-7000-8000-000000000098",
      WORKSPACE,
      "member@example.test",
      OWNER,
      "race-token-hash",
      "2099-01-01T00:00:00.000Z",
      NOW,
    );
    const { env } = environment(database);

    const [departure, acceptance] = await Promise.allSettled([
      new WorkspaceService(env, auth(OWNER, "owner")).leaveWorkspace("abandoned"),
      acceptInvitationForUser(env, "00000000-0000-7000-8000-000000000098", {
        id: MEMBER,
        email: "member@example.test",
      }),
    ]);

    const lifecycle = database.prepare(
      `SELECT w.abandoned_at,
              (SELECT COUNT(*) FROM workspace_members m
               WHERE m.workspace_id = w.id AND m.status = 'active') AS active_members
       FROM workspaces w WHERE w.id = ?`,
    ).get(WORKSPACE) as { abandoned_at: string | null; active_members: number };
    expect([departure, acceptance].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    if (lifecycle.abandoned_at === null) {
      expect(departure).toMatchObject({
        status: "rejected",
        reason: { status: 409, code: "membership_changed" },
      });
      expect(acceptance.status).toBe("fulfilled");
      expect(lifecycle.active_members).toBe(2);
    } else {
      expect(departure).toEqual({ status: "fulfilled", value: { outcome: "abandoned" } });
      expect(acceptance.status).toBe("rejected");
      expect(lifecycle.active_members).toBe(0);
    }
  });

  it("does not close a workspace after an ordinary-leave confirmation becomes stale", async () => {
    const database = seed();
    database.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id != ?",
    ).run(WORKSPACE, OWNER);
    const { env, sent } = environment(database);

    await expect(new WorkspaceService(env, auth(OWNER, "owner")).leaveWorkspace("left"))
      .rejects.toMatchObject({ status: 409, code: "membership_changed" });

    expect(database.prepare("SELECT abandoned_at FROM workspaces WHERE id = ?").get(WORKSPACE))
      .toEqual({ abandoned_at: null });
    expect(sent).toEqual([]);
  });

  it("does not turn a close-workspace confirmation into an ordinary leave", async () => {
    const database = seed();
    const { env, sent } = environment(database);

    await expect(new WorkspaceService(env, auth(MEMBER, "member")).leaveWorkspace("abandoned"))
      .rejects.toMatchObject({ status: 409, code: "membership_changed" });

    expect(database.prepare(
      "SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(WORKSPACE, MEMBER)).toEqual({ status: "active" });
    expect(sent).toEqual([]);
  });

  it("refuses invitation acceptance and fresh session issue for an abandoned workspace", async () => {
    const database = seed();
    database.prepare("UPDATE workspaces SET abandoned_at = ? WHERE id = ?").run(NOW, WORKSPACE);
    database.prepare(
      `INSERT INTO workspace_invitations
       (id, workspace_id, email, invited_by_user_id, token_hash, role, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'member', ?, ?)`,
    ).run(
      "00000000-0000-7000-8000-000000000097",
      WORKSPACE,
      "member@example.test",
      OWNER,
      "abandoned-token-hash",
      "2099-01-01T00:00:00.000Z",
      NOW,
    );
    const { env } = environment(database);

    await expect(acceptInvitationForUser(env, "00000000-0000-7000-8000-000000000097", {
      id: MEMBER,
      email: "member@example.test",
    })).rejects.toMatchObject({ status: 404, code: "invitation_invalid" });
    await expect(new AuthService(env).createRegionalSession(OWNER, WORKSPACE))
      .rejects.toMatchObject({ status: 403, code: "workspace_access_denied" });
  });

  it("omits abandoned memberships and invitations from regional discovery", async () => {
    const database = seed();
    database.prepare("UPDATE workspaces SET abandoned_at = ? WHERE id = ?").run(NOW, WORKSPACE);
    database.prepare(
      `INSERT INTO workspace_invitations
       (id, workspace_id, email, invited_by_user_id, token_hash, role, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'member', ?, ?)`,
    ).run(
      "00000000-0000-7000-8000-000000000096",
      WORKSPACE,
      "member@example.test",
      OWNER,
      "discovery-token-hash",
      "2099-01-01T00:00:00.000Z",
      NOW,
    );
    const { env } = environment(database);

    await expect(new RegionalOnboardingService(env).discover({
      platformUserId: MEMBER,
      googleSubject: `google-${MEMBER}`,
      email: "member@example.test",
      name: "Member",
      avatarUrl: null,
      timezone: "UTC",
      createdAt: NOW,
    })).resolves.toMatchObject({ workspaces: [], invitations: [] });
  });
});

describe("reaping expired sessions", () => {
  function insertSession(
    database: DatabaseSync,
    id: string,
    expiresAt: string,
    revokedAt: string | null = null,
  ): void {
    database.prepare(
      `INSERT INTO sessions(id, user_id, workspace_id, region, refresh_token_hash,
                            created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, 'global', ?, ?, ?, ?)`,
    ).run(id, MEMBER, WORKSPACE, `hash-${id}`, NOW, expiresAt, revokedAt);
  }

  it("revokes what expired, publishes it once, and leaves live sessions alone", async () => {
    const database = seed();
    insertSession(database, "expired", "2020-01-01T00:00:00.000Z");
    insertSession(database, "live", "2099-01-01T00:00:00.000Z");
    const { env, sent } = environment(database);

    expect(await reapExpiredSessions(env)).toBe(1);
    const revocations = sent
      .map((message) => AccessRevocationMessageSchema.safeParse(message.body))
      .flatMap((parsed) => parsed.success ? [parsed.data] : []);
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      reason: "session_expired",
      sessionId: "expired",
      userId: MEMBER,
    });

    const live = database.prepare(`SELECT revoked_at FROM sessions WHERE id = 'live'`)
      .get() as { revoked_at: string | null };
    expect(live.revoked_at).toBeNull();

    // Marking the row is what makes the sweep exactly-once: a second run finds
    // nothing and publishes nothing, so a five-minute cron does not re-announce
    // the same expiry forever.
    expect(await reapExpiredSessions(env)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("does not overwrite a revocation that landed while the sweep was running", async () => {
    const database = seed();
    insertSession(database, "expired", "2020-01-01T00:00:00.000Z");
    const { env, sent } = environment(database);
    // A logout lands between the sweep's select and its mark. Marking by id
    // alone would overwrite that row's `revoked_at` with the sweep's later
    // timestamp, moving the recorded moment the session actually ended.
    const loggedOutAt = "2021-06-06T06:06:06.000Z";
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("UPDATE sessions SET revoked_at")) {
        database.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = 'expired' AND revoked_at IS NULL`)
          .run(loggedOutAt);
      }
      return prepare(sql);
    });

    await reapExpiredSessions(env);
    expect(sent).toHaveLength(1);
    const row = database.prepare(`SELECT revoked_at FROM sessions WHERE id = 'expired'`)
      .get() as { revoked_at: string };
    expect(row.revoked_at).toBe(loggedOutAt);
  });

  it("leaves a session unmarked when its announcement did not go out", async () => {
    const database = seed();
    insertSession(database, "expired", "2020-01-01T00:00:00.000Z");
    let offline = true;
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      ACCESS_REVOCATION_QUEUE: {
        send: async () => { if (offline) throw new Error("queue offline"); },
      },
    });

    // Marking first would be tidier and would lose this expiry permanently: the
    // row would never be selected again, and nothing else re-checks an open
    // socket, so that person keeps receiving until they reconnect.
    expect(await reapExpiredSessions(env)).toBe(0);
    const afterFailure = database.prepare(`SELECT revoked_at FROM sessions WHERE id = 'expired'`)
      .get() as { revoked_at: string | null };
    expect(afterFailure.revoked_at).toBeNull();

    offline = false;
    expect(await reapExpiredSessions(env)).toBe(1);
    const afterSuccess = database.prepare(`SELECT revoked_at FROM sessions WHERE id = 'expired'`)
      .get() as { revoked_at: string | null };
    expect(afterSuccess.revoked_at).not.toBeNull();
  });
});

describe("publishing a revocation", () => {
  it("does not fail its caller when the queue is unavailable", async () => {
    const database = seed();
    const env = createTestEnv({
      DB: sqliteD1(database),
      ACCESS_REVOCATION_QUEUE: { send: async () => { throw new Error("queue offline"); } },
    });
    // The fact is already written when this runs; failing the request would
    // tell the operator the removal did not happen when it did. It reports the
    // failure in its return value instead, for the one caller that can retry.
    await expect(publishAccessRevocation(env, {
      reason: "workspace_membership_removed",
      workspaceId: WORKSPACE,
      userId: MEMBER,
      sessionId: null,
    })).resolves.toBe(false);
  });
});

describe("the membership route", () => {
  function app(userId: string = OWNER, role: AuthContext["role"] = "owner"): Hono<HonoAppEnv> {
    const routes = new Hono<HonoAppEnv>();
    routes.use("*", async (context, next) => {
      context.set("auth", auth(userId, role));
      await next();
    });
    routes.route("/workspaces", workspaceMembershipRoutes);
    routes.onError(errorHandler);
    return routes;
  }

  it("removes the named member from the workspace it is signed in to", async () => {
    const database = seed();
    const { env, sent } = environment(database);
    const response = await app().request(
      `/workspaces/${WORKSPACE}/membership/member/${MEMBER}`,
      { method: "DELETE" },
      env,
    );
    expect(response.status).toBe(204);
    const remaining = database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).get(WORKSPACE, MEMBER) as { count: number };
    expect(remaining.count).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("refuses a path that names a workspace the caller is not signed in to", async () => {
    const database = seed();
    const { env, sent } = environment(database);
    // Every other protected route reads the workspace from the session. This
    // one takes it from the path, so a mismatch has to be refused before the
    // service sees it, or the parameter becomes a way into someone else's
    // workspace.
    const response = await app().request(
      `/workspaces/00000000-0000-7000-8000-0000000000ff/membership/member/${MEMBER}`,
      { method: "DELETE" },
      env,
    );
    expect(response.status).toBe(403);
    const remaining = database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).get(WORKSPACE, MEMBER) as { count: number };
    expect(remaining.count).toBe(1);
    expect(sent).toEqual([]);
  });

  it("lets the signed-in member leave their own workspace", async () => {
    const database = seed();
    const { env, sent } = environment(database);
    const response = await app(MEMBER, "member").request(
      `/workspaces/${WORKSPACE}/membership?expectedOutcome=left`,
      { method: "DELETE" },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: "left" });
    expect(sent).toHaveLength(1);
  });
});

describe("carrying one revocation to the objects", () => {
  interface Visit { name: string; revocation: unknown }

  function fanOut(options: {
    workstreamIds?: string[];
    automationIds?: string[];
    substreamIds?: string[];
    failAt?: boolean;
  } = {}) {
    const visits: Visit[] = [];
    const sent: Published[] = [];
    /**
     * One double serves all four namespaces: the consumer only ever calls
     * `revokeSocketAccess`, and what each object answers with is the whole
     * difference between the hops.
     */
    const namespace = (answer: () => unknown): DurableObjectNamespace => {
      const binding: DurableObjectNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: (id: DurableObjectId) => ({
          revokeSocketAccess: async (revocation: unknown) => {
            visits.push({ name: id.toString(), revocation });
            if (options.failAt) throw new Error("object unreachable");
            return answer();
          },
        }),
        jurisdiction: (): DurableObjectNamespace => binding,
      });
      return binding;
    };
    const database = seed();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: namespace(() => ({
        workstreamIds: options.workstreamIds ?? [],
        automationIds: options.automationIds ?? [],
      })),
      WORKSTREAM_DOS: namespace(() => ({
        substreamIds: options.substreamIds ?? [],
      })),
      SUBSTREAM_AGENTS: namespace(() => undefined),
      AUTOMATION_DOS: namespace(() => undefined),
      ACCESS_REVOCATION_QUEUE: {
        send: async (body: unknown) => { sent.push({ body }); },
        sendBatch: async (messages: Array<{ body: unknown }>) => { sent.push(...messages); },
      },
    });
    return { env, visits, sent };
  }

  const WORKSTREAM = "00000000-0000-7000-8000-0000000000a1";
  const SUBSTREAM = "00000000-0000-7000-8000-0000000000c1";

  function message(target: AccessRevocationMessage["target"]): AccessRevocationMessage {
    return AccessRevocationMessageSchema.parse({
      kind: "access_revoked",
      reason: "workspace_membership_removed",
      workspaceId: WORKSPACE,
      userId: MEMBER,
      sessionId: null,
      target,
      occurredAt: NOW,
    });
  }

  function targetsOf(sent: Published[]): unknown[] {
    return sent.map((published) => AccessRevocationMessageSchema.parse(published.body).target);
  }

  it("tells the workspace, then publishes a message for each work stream it names", async () => {
    const { env, visits, sent } = fanOut({ workstreamIds: [WORKSTREAM] });
    await applyAccessRevocation(env, message({ scope: "workspace" }));

    expect(visits).toHaveLength(1);
    // The object is told who lost access, not how the revocation was addressed.
    expect(visits[0]?.revocation).toEqual({
      reason: "workspace_membership_removed",
      workspaceId: WORKSPACE,
      userId: MEMBER,
      sessionId: null,
    });
    expect(targetsOf(sent)).toEqual([{ scope: "workstream", workstreamId: WORKSTREAM }]);
  });

  it("publishes a message for every automation the workspace names", async () => {
    const AUTOMATION = "00000000-0000-7000-8000-0000000000d1";
    const { env, sent } = fanOut({ workstreamIds: [WORKSTREAM], automationIds: [AUTOMATION] });
    await applyAccessRevocation(env, message({ scope: "workspace" }));

    // An automation holds its own socket room, so a member who lost workspace
    // access keeps reading a draft transcript until this hop reaches it.
    expect(targetsOf(sent)).toEqual([
      { scope: "workstream", workstreamId: WORKSTREAM },
      { scope: "automation", automationId: AUTOMATION },
    ]);
  });

  it("stops at an automation", async () => {
    const AUTOMATION = "00000000-0000-7000-8000-0000000000d1";
    const { env, visits, sent } = fanOut();
    await applyAccessRevocation(env, message({ scope: "automation", automationId: AUTOMATION }));

    expect(visits).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("publishes a message for every substream a work stream names", async () => {
    const { env, sent } = fanOut({ substreamIds: ["0", SUBSTREAM] });
    await applyAccessRevocation(env, message({ scope: "workstream", workstreamId: WORKSTREAM }));

    expect(targetsOf(sent)).toEqual([
      { scope: "substream", workstreamId: WORKSTREAM, substreamId: "0" },
      { scope: "substream", workstreamId: WORKSTREAM, substreamId: SUBSTREAM },
    ]);
  });

  it("stops at a leaf", async () => {
    const { env, visits, sent } = fanOut();
    await applyAccessRevocation(env, message({
      scope: "substream", workstreamId: WORKSTREAM, substreamId: SUBSTREAM,
    }));
    expect(visits).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("retries a hop that failed and acknowledges one it cannot read", async () => {
    const { env } = fanOut({ failAt: true });
    const acked: string[] = [];
    const retried: string[] = [];
    const queued = (id: string, body: unknown) => ({
      id,
      timestamp: new Date(NOW),
      body,
      attempts: 1,
      ack: () => { acked.push(id); },
      retry: () => { retried.push(id); },
    }) satisfies Message<unknown>;
    await consumeAccessRevocationQueue({
      queue: "avalon-global-access-revocations",
      messages: [
        queued("unreadable", { kind: "something_else" }),
        queued("hop", message({ scope: "workspace" })),
      ],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } satisfies MessageBatch<unknown>, env);

    // Nothing will ever make a malformed message readable, so it is dropped
    // rather than retried until the dead-letter queue takes it.
    expect(acked).toEqual(["unreadable"]);
    expect(retried).toEqual(["hop"]);
  });
});

describe("recognizing this protocol's queue", () => {
  it("accepts each region's queue and refuses the ones beside it", () => {
    expect([
      "avalon-global-access-revocations",
      "avalon-eu-access-revocations",
      "avalon-do-runtime-test-access-revocations",
    ].every(isAccessRevocationQueue)).toBe(true);

    // The dead-letter queue is the one that matters: it carries the batches
    // this consumer already failed, so routing it back here would retry the
    // undeliverable forever. `avalon-global-activities` stands for every other
    // queue the same Worker handler serves.
    expect([
      "avalon-global-access-revocations-dead-letter",
      "avalon-eu-access-revocations-dead-letter",
      "avalon-global-activities",
      "avalon-migration-reports",
    ].some(isAccessRevocationQueue)).toBe(false);
  });
});

describe("deciding whether one socket belongs to a revocation", () => {
  const membershipGone = { reason: "workspace_membership_removed", workspaceId: WORKSPACE, userId: MEMBER, sessionId: null } as const;
  const sessionGone = { reason: "session_revoked", workspaceId: WORKSPACE, userId: MEMBER, sessionId: "session-a" } as const;

  it("never touches somebody else's socket", () => {
    expect(revocationClosesSocket(membershipGone, { userId: OWNER, sessionId: "session-a" })).toBe(false);
    expect(revocationClosesSocket(sessionGone, { userId: OWNER, sessionId: "session-a" })).toBe(false);
  });

  it("closes every window when the membership itself is gone", () => {
    expect(revocationClosesSocket(membershipGone, { userId: MEMBER, sessionId: "session-a" })).toBe(true);
    expect(revocationClosesSocket(membershipGone, { userId: MEMBER, sessionId: "session-b" })).toBe(true);
    expect(revocationClosesSocket(membershipGone, { userId: MEMBER })).toBe(true);
  });

  it("closes only the named session, and any socket that cannot disprove it", () => {
    expect(revocationClosesSocket(sessionGone, { userId: MEMBER, sessionId: "session-a" })).toBe(true);
    // One window signing out must not sign the person out of the others.
    expect(revocationClosesSocket(sessionGone, { userId: MEMBER, sessionId: "session-b" })).toBe(false);
    // Only SubstreamAgent's schema makes the field optional, which is exactly
    // why this rule is shared: written out per role it diverged once already,
    // and `undefined !== "<id>"` exempted the transcript feed from every logout.
    expect(revocationClosesSocket(sessionGone, { userId: MEMBER })).toBe(true);
  });
});
