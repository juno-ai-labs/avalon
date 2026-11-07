import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import { resolveConnectorActorIdentity } from "../src/services/connector-actor-identity";
import { hostedParentStub } from "./helpers/hosted-parent";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000001317");
const owner = "00000000-0000-7000-8000-000000001318";
const other = "00000000-0000-7000-8000-000000001319";
const resource = "https://mcp.apollo.io/mcp";
const workspace = () => hostedParentStub(env, workspaceId);

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: owner, sessionId: "identity-test-session" });
  await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')")
    .bind(workspaceId, other).run();
  await workspace().initializeWorkspace(workspaceId, "wnam");
});

async function addConnection(id: string, provider: string, user: string, account: string, config: Record<string, unknown>) {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
       granted_scopes_json, model_plugin_id, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, 'personal', ?, ?, ?, '[]', ?, 'healthy', ?, 'now', 'now')`,
    id, workspaceId, provider, user, account, provider, `plugin_${id}`, JSON.stringify(config));
  });
}

describe("verified connector identity", () => {
  it("does not resolve a resource URL as a person even when only one Apollo owner is connected", async () => {
    await addConnection("apollo_one", "apollo", owner, resource, { providerTenantId: resource, providerUserId: null });
    expect(await resolveConnectorActorIdentity(env, workspaceId, {
      provider: "apollo", providerAccountId: resource, providerUserId: resource, displayName: "Connected actor", avatarUrl: null,
    })).toBeNull();
    await addConnection("github_legacy", "github", owner, "github-user", {});
    expect(await resolveConnectorActorIdentity(env, workspaceId, {
      provider: "github", providerAccountId: "github-user", providerUserId: "github-user", displayName: "Connected actor", avatarUrl: null,
    })).toMatchObject({ userId: owner, verification: "personal_connection" });
  });
});
