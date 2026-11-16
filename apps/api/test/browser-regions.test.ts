import "../../../tests/isolated-region";
import { asUserId } from "@rally/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { BrowserWorkspaceAttentionSchema } from "@rally/contracts/browser-session";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { BrowserSessionService, BrowserWorkspacesSchema } from "../src/services/browser-session-service";
import { AuthService } from "../src/services/auth-service";
import { PlatformOnboardingService, RegionalOnboardingService, serializeRegionalRpcResult, type RegionalIdentityBridgeRpcBinding } from "../src/services/platform-onboarding-service";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// Two real deployments, each with its own migrated database, joined by the
// identity bridge as service-binding RPC would join them. The workspace object
// is the one double: activation initializes it, and this test is about the
// session ledgers and the cookie, not the object.
const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
const signingKey = "browser-regions-signing-key";
const globalUserId = "00000000-0000-7000-8000-00000000a001";
const enterpriseUserId = "00000000-0000-7000-8000-00000000e001";
const enterpriseWorkspaceId = "00000000-0000-7000-8000-00000000e002";
const strangerWorkspaceId = "00000000-0000-7000-8000-00000000e003";
const at = "2026-10-03T00:00:00.000Z";
let globalDb: DatabaseSync;
let enterpriseDb: DatabaseSync;

function workspaceObjects(): Env["WORKSPACE_DOS"] {
  // Attention answers only for the person's regional id, so a read made under
  // any other id comes back empty.
  const stub = {
    initializeWorkspace: async () => undefined,
    attention: async ({ userId }: { userId: string }) => ({
      waitingForYou: 0, waitingReason: null, hasUnreadActivity: userId === enterpriseUserId,
      readerAttentionCount: userId === enterpriseUserId ? 3 : 0,
    }),
  };
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return binding;
}
const common = { APP_ENV: "development", RALLY_DEV_AUTH: "false", ALLOWED_ORIGINS: origin, PUBLIC_API_BASE_URL: apiOrigin,
  LOG_LEVEL: "error", SESSION_SIGNING_KEY: signingKey, BROWSER_APP_ORIGIN: origin } as const;
function enterprise(): Env {
  return createTestEnv({ ...common, DB: sqliteD1(enterpriseDb), AVALON_REGION: "enterprise", WORKSPACE_DOS: workspaceObjects(),
    PUBLIC_API_BASE_URL: "https://enterprise.api.with-avalon.com" });
}
/** What the service binding carries: the bridge entrypoint's own envelope, against the enterprise deployment. */
function bridge(): RegionalIdentityBridgeRpcBinding {
  const service = () => new RegionalOnboardingService(enterprise());
  return {
    discover: (identity) => serializeRegionalRpcResult(() => service().discover(identity)),
    attention: (identity) => serializeRegionalRpcResult(() => service().attention(identity)),
    activate: (input) => serializeRegionalRpcResult(() => service().activate(input)),
    activateBrowser: (input) => serializeRegionalRpcResult(() => service().activateBrowser(input)),
    create: (input) => serializeRegionalRpcResult(() => service().create(input)),
    accept: (input) => serializeRegionalRpcResult(() => service().accept(input)),
    decline: (input) => serializeRegionalRpcResult(() => service().decline(input)),
  };
}
function global(): Env {
  return createTestEnv({ ...common, DB: sqliteD1(globalDb), AVALON_REGION: "global", REGION_ENTERPRISE_IDENTITY_BRIDGE: bridge() });
}
async function signedIn(): Promise<string> {
  const registration = await new BrowserSessionService(global()).register(await new AuthService(global()).createIdentitySession(globalUserId));
  return `__Host-rally-browser-global=${registration.credential}`;
}
function request(path: string, cookie: string, body?: unknown) {
  return createApp().request(`${apiOrigin}/browser/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { origin, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, global());
}

beforeEach(() => {
  globalDb = migratedSqliteDatabase();
  enterpriseDb = migratedSqliteDatabase();
  globalDb.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at, platform_user_id)
    VALUES (?, 'google-person', 'person@example.test', 'Person', ?, ?, ?)`).run(globalUserId, at, at, globalUserId);
  // Enterprise knows the same person under its own id, linked to the platform identity.
  enterpriseDb.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at, platform_user_id)
    VALUES (?, 'google-person', 'person@example.test', 'Person', ?, ?, ?)`).run(enterpriseUserId, at, at, globalUserId);
  for (const id of [enterpriseWorkspaceId, strangerWorkspaceId]) {
    enterpriseDb.prepare(`INSERT INTO workspaces (id, name, slug, region, placement_affinity, created_by_user_id, created_at, updated_at)
      VALUES (?, 'Enterprise', ?, 'enterprise', 'weur', ?, ?, ?)`).run(id, id, enterpriseUserId, at, at);
  }
  enterpriseDb.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (?, ?, 'member', 'active', ?)`).run(enterpriseWorkspaceId, enterpriseUserId, at);
});
afterEach(() => { globalDb.close(); enterpriseDb.close(); });

it("lists another deployment's workspace from Global and hands the browser that deployment's own cookie", async () => {
  const cookie = await signedIn();
  const listed = BrowserWorkspacesSchema.parse(await (await request("workspaces", cookie)).json());
  expect(listed.workspaces.map((workspace) => [workspace.region, workspace.id])).toEqual([["enterprise", enterpriseWorkspaceId]]);

  const activated = await request("workspace/activate", cookie, { region: "enterprise", workspaceId: enterpriseWorkspaceId });
  expect(activated.status).toBe(204);
  const setCookie = activated.headers.getSetCookie().find((value) => value.startsWith("__Host-rally-browser-enterprise="))!;
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(setCookie).toContain(attribute);
  expect(await activated.text()).toBe("");

  // The credential is enterprise's own: it resolves there, to enterprise's user and workspace.
  const credential = decodeURIComponent(setCookie.split(";")[0]!.slice(setCookie.indexOf("=") + 1));
  const auth = await new BrowserSessionService(enterprise()).read(credential, enterpriseWorkspaceId);
  expect(auth).toMatchObject({ userId: enterpriseUserId, workspaceId: enterpriseWorkspaceId, region: "enterprise" });
  // And means nothing to Global.
  await expect(new BrowserSessionService(global()).read(credential)).rejects.toMatchObject({ status: 401 });
});

it("reads another deployment's attention from Global under that deployment's own id for the person", async () => {
  const response = await request("workspaces/attention", await signedIn());
  expect(response.status).toBe(200);
  const { attention } = BrowserWorkspaceAttentionSchema.parse(await response.json());
  expect(attention.map((item) => [item.region, item.workspaceId, item.attention.readerAttentionCount]))
    .toEqual([["enterprise", enterpriseWorkspaceId, 3]]);
});

it("reads attention without linking a person another deployment has not linked yet", async () => {
  const strangerId = "00000000-0000-7000-8000-00000000a002";
  globalDb.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at, platform_user_id)
    VALUES (?, 'google-stranger', 'stranger@example.test', 'Stranger', ?, ?, ?)`).run(strangerId, at, at, strangerId);
  const registration = await new BrowserSessionService(global()).register(await new AuthService(global()).createIdentitySession(strangerId));
  const response = await request("workspaces/attention", `__Host-rally-browser-global=${registration.credential}`);
  expect(BrowserWorkspaceAttentionSchema.parse(await response.json()).attention).toEqual([]);
  // Linking is discovery's job; a badge read writes nothing.
  expect(enterpriseDb.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
});

it("refuses a workspace the identity is not a member of, and mints nothing there", async () => {
  const cookie = await signedIn();
  const refused = await request("workspace/activate", cookie, { region: "enterprise", workspaceId: strangerWorkspaceId });
  expect(refused.status).toBe(403);
  expect(refused.headers.getSetCookie().some((value) => value.includes("rally-browser-enterprise"))).toBe(false);
  expect(enterpriseDb.prepare("SELECT COUNT(*) AS n FROM browser_sessions").get()).toEqual({ n: 0 });
});

it("needs the Global cookie to activate anywhere", async () => {
  const response = await request("workspace/activate", "__Host-rally-browser-global=forged", { region: "enterprise", workspaceId: enterpriseWorkspaceId });
  expect(response.status).toBe(401);
  expect(enterpriseDb.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
});

// The Mac app's path over the same two deployments: platform discovery and a
// bearer activation, for a relationship that is a guest's rather than a member's.
it("lists and activates another deployment's guest relationship for the Mac app", async () => {
  enterpriseDb.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at, access_class)
    VALUES (?, ?, NULL, 'active', ?, 'guest')`).run(strangerWorkspaceId, enterpriseUserId, "2026-10-02T00:00:00.000Z");
  // And one in Global, the deployment listed first.
  const globalGuestWorkspaceId = "00000000-0000-7000-8000-00000000a002";
  globalDb.prepare(`INSERT INTO workspaces (id, name, slug, region, placement_affinity, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Partner', 'partner', 'global', 'wnam', ?, ?, ?)`).run(globalGuestWorkspaceId, globalUserId, at, at);
  globalDb.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at, access_class)
    VALUES (?, ?, NULL, 'active', ?, 'guest')`).run(globalGuestWorkspaceId, globalUserId, "2026-10-01T00:00:00.000Z");
  const auth = { sessionId: "identity-session", userId: asUserId(globalUserId), workspaceId: null, region: "global" as const, role: null };
  const platform = new PlatformOnboardingService(global(), auth);

  // Both guest relationships follow the membership, though each was joined
  // first and one is in the deployment listed first: a device with nothing
  // selected opens the first workspace, and that is the person's own.
  const state = await platform.state({ guests: true });
  expect(state.workspaces.map((workspace) => [workspace.id, workspace.role, workspace.accessClass])).toEqual([
    [enterpriseWorkspaceId, "member", undefined],
    [globalGuestWorkspaceId, null, "guest"],
    [strangerWorkspaceId, null, "guest"],
  ]);
  // A build that has not declared the guest contract is offered neither.
  expect((await platform.state()).workspaces.map((workspace) => workspace.id)).toEqual([enterpriseWorkspaceId]);
  await expect(platform.activate("enterprise", strangerWorkspaceId)).rejects.toMatchObject({ status: 403 });
  const session = await platform.activate("enterprise", strangerWorkspaceId, { guests: true });
  expect(session.workspace).toMatchObject({ id: strangerWorkspaceId, region: "enterprise", role: null, accessClass: "guest" });
  expect(enterpriseDb.prepare("SELECT user_id, workspace_id FROM sessions WHERE workspace_id = ?").all(strangerWorkspaceId))
    .toEqual([{ user_id: enterpriseUserId, workspace_id: strangerWorkspaceId }]);
});
