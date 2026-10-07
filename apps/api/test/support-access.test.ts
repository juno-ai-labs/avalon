import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SessionSchema } from "@rally/contracts";
import { createApp } from "../src/app";
import { AuthService } from "../src/services/auth-service";
import { BrowserSessionService } from "../src/services/browser-session-service";
import { SUPPORT_ORGANIZATION_ID } from "../src/services/support-access";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedObservabilityFixture, sqliteD1 } from "./helpers/sqlite-d1";

// Rally access (`docs/impersonation.md`) against the checked-in migrations:
// the grant, the staff check, and the support session every request re-checks.

const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
const STAFF = "01a11778-0000-7000-8000-0000000000a1";
const ADMIN = "01a11778-0000-7000-8000-0000000000a2";
const BOB = "01a11778-0000-7000-8000-0000000000a3";
const GUEST = "01a11778-0000-7000-8000-0000000000a4";
const OUTSIDER = "01a11778-0000-7000-8000-0000000000a5";
const CUSTOMER = "01a11778-0000-7000-8000-0000000000c1";

let db: DatabaseSync;
let revoked: unknown[];

function bindings() {
  return createTestEnv({ DB: sqliteD1(db), APP_ENV: "development", RALLY_DEV_AUTH: "false", AVALON_REGION: "global",
    ALLOWED_ORIGINS: origin, PUBLIC_API_BASE_URL: apiOrigin, LOG_LEVEL: "error",
    SESSION_SIGNING_KEY: "support-test-signing-key", OAUTH_STATE_ENCRYPTION_KEY: "support-test-encryption-key",
    BROWSER_APP_ORIGIN: origin,
    ACCESS_REVOCATION_QUEUE: {
      send: async (body: unknown) => { revoked.push(body); },
      sendBatch: async (messages: Array<{ body: unknown }>) => { revoked.push(...messages.map((message) => message.body)); },
    } });
}

function call(path: string, token: string, method = "GET", body?: unknown) {
  return createApp().request(`${apiOrigin}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin,
    ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings());
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

function person(id: string, name: string) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, `${name.toLowerCase().replace(/\s+/gu, ".")}@example.test`, name, now, now);
}

function organization(id: string, people: Array<[string, "owner" | "admin" | "member" | null]>) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,'global',?,?,?)`).run(id, `Organization ${id.slice(-2)}`, id, people[0]![0], now, now);
  for (const [userId, role] of people) {
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,?,?,'active',?)")
      .run(id, userId, role === null ? "guest" : "member", role, now);
  }
}

beforeEach(() => {
  db = migratedObservabilityFixture();
  revoked = [];
  for (const [id, name] of [[STAFF, "Sam Staff"], [ADMIN, "Ada Admin"], [BOB, "Bob Smith"], [GUEST, "Gus Guest"], [OUTSIDER, "Olive Outsider"]] as const) {
    person(id, name);
  }
  organization(SUPPORT_ORGANIZATION_ID, [[STAFF, "owner"], [OUTSIDER, null]]);
  organization(CUSTOMER, [[ADMIN, "owner"], [BOB, "member"], [GUEST, null]]);
});
afterEach(() => { db.close(); });

async function identity(userId: string): Promise<string> {
  return (await new AuthService(bindings()).createIdentitySession(userId)).accessToken;
}

async function member(userId: string, workspaceId: string) {
  return new AuthService(bindings()).createRegionalSession(userId, workspaceId);
}

async function grant(): Promise<string> {
  const response = await call("/workspace/support-access", (await member(ADMIN, CUSTOMER)).accessToken, "PUT");
  expect(response.status).toBe(200);
  return ((await response.json()) as { expiresAt: string }).expiresAt;
}

async function startAsBob() {
  const response = await call("/auth/support/session", await identity(STAFF), "POST", { workspaceId: CUSTOMER, userId: BOB });
  expect(response.status).toBe(200);
  return SessionSchema.parse(await response.json());
}

it("lists a granting Organization's members, then guests, to Rally staff only", async () => {
  const before = await call("/auth/support/workspaces", await identity(STAFF));
  expect(await before.json()).toEqual({ workspaces: [] });
  const expiresAt = await grant();
  const after = await call("/auth/support/workspaces", await identity(STAFF));
  expect(await after.json()).toEqual({ workspaces: [{ id: CUSTOMER, name: "Organization c1", region: "global", expiresAt }] });
  const people = await call(`/auth/support/workspaces/${CUSTOMER}/people`, await identity(STAFF));
  expect(((await people.json()) as { people: Array<{ name: string; accessClass: string }> }).people
    .map((entry) => `${entry.name}:${entry.accessClass}`)).toEqual(["Ada Admin:member", "Bob Smith:member", "Gus Guest:guest"]);
  // A guest of Juno Labs is not staff, and neither is somebody outside it.
  for (const outsider of [OUTSIDER, ADMIN]) {
    const refused = await call("/auth/support/workspaces", await identity(outsider));
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("support_access_staff_required");
  }
});

it("opens a session as the chosen person that names the staff member and expires with the grant", async () => {
  const expiresAt = await grant();
  const session = await startAsBob();
  expect(session.user.id).toBe(BOB);
  expect(session.workspace?.id).toBe(CUSTOMER);
  expect(session.impersonator).toEqual({ id: STAFF, email: "sam.staff@example.test", name: "Sam Staff", avatarUrl: null });
  const workspace = await call("/workspace", session.accessToken);
  expect(workspace.status).toBe(200);
  expect(((await workspace.json()) as { role: string }).role).toBe("member");
  // Renewal keeps the staff member on the session and never passes the grant.
  const renewed = await call("/auth/refresh", session.accessToken, "POST", { refreshToken: session.refreshToken });
  expect(renewed.status).toBe(200);
  expect(SessionSchema.parse(await renewed.json()).impersonator?.id).toBe(STAFF);
  expect(db.prepare("SELECT expires_at FROM sessions WHERE impersonator_user_id = ?").get(STAFF)).toEqual({ expires_at: expiresAt });
});

it("refuses a session in an Organization that has not granted access", async () => {
  const response = await call("/auth/support/session", await identity(STAFF), "POST", { workspaceId: CUSTOMER, userId: BOB });
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe("support_access_not_granted");
});

it("lets only a person in the Organization, as an administrator, grant access", async () => {
  const asMember = await call("/workspace/support-access", (await member(BOB, CUSTOMER)).accessToken, "PUT");
  expect(asMember.status).toBe(403);
  await grant();
  db.prepare("UPDATE workspace_members SET role = 'admin' WHERE user_id = ?").run(BOB);
  const support = await startAsBob();
  const extended = await call("/workspace/support-access", support.accessToken, "PUT");
  expect(extended.status).toBe(403);
  expect(await errorCode(extended)).toBe("support_access_grant_requires_member");
});

it("ends every support session when the Organization revokes access, and closes its sockets", async () => {
  await grant();
  const session = await startAsBob();
  const revoke = await call("/workspace/support-access", (await member(ADMIN, CUSTOMER)).accessToken, "DELETE");
  expect(await revoke.json()).toEqual({ available: true, expiresAt: null });
  const after = await call("/workspace", session.accessToken);
  expect(after.status).toBe(401);
  expect(revoked).toEqual([expect.objectContaining({ reason: "session_revoked", userId: BOB, workspaceId: CUSTOMER })]);
});

it("ends a support session on the next request once the grant has run out", async () => {
  await grant();
  const session = await startAsBob();
  db.prepare("UPDATE support_access_grants SET granted_at = '2026-01-01T00:00:00.000Z', expires_at = '2026-01-02T00:00:00.000Z'").run();
  expect((await call("/workspace", session.accessToken)).status).toBe(401);
  expect((await call("/auth/refresh", session.accessToken, "POST", { refreshToken: session.refreshToken })).status).toBe(401);
});

it("ends a support session on the next request once its staff member leaves Juno Labs", async () => {
  await grant();
  const session = await startAsBob();
  db.prepare("UPDATE workspace_members SET access_class = 'guest', role = NULL WHERE workspace_id = ? AND user_id = ?")
    .run(SUPPORT_ORGANIZATION_ID, STAFF);
  const after = await call("/workspace", session.accessToken);
  expect(after.status).toBe(401);
  expect(await errorCode(after)).toBe("session_revoked");
});

it("gives a browser the support session in the Organization's slot and takes it back", async () => {
  await grant();
  const service = new BrowserSessionService(bindings());
  const { credential } = await service.register(await new AuthService(bindings()).createIdentitySession(STAFF));
  const opened = await service.selectSupport(credential, { workspaceId: CUSTOMER, userId: BOB });
  expect(opened.user.id).toBe(BOB);
  expect(opened.impersonator?.id).toBe(STAFF);
  expect((await service.read(credential, CUSTOMER)).impersonatorUserId).toBe(STAFF);
  await service.endSupport(credential, CUSTOMER);
  await expect(service.read(credential, CUSTOMER)).rejects.toMatchObject({ status: 401 });
  expect(db.prepare("SELECT COUNT(*) AS live FROM sessions WHERE impersonator_user_id = ? AND revoked_at IS NULL").get(STAFF))
    .toEqual({ live: 0 });
});
