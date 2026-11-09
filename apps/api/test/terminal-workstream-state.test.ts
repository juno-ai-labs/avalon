import { asUserId } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { TerminalWorkstreamService } from "../src/services/terminal/workstream-state";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  seedWorkstreamObjectParticipant,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const W = asWorkspaceId("61000000-0000-4000-8000-000000000001");
const S = "61000000-0000-4000-8000-000000000002";
const U = asUserId("61000000-0000-4000-8000-000000000003");
const C = "61000000-0000-4000-8000-000000000004";
const databases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = preRetirementProductSqliteDatabase(); databases.push(database);
  // Terminal state is served from the work stream's object once the authority
  // is open; the D1 sandbox and repository copies were dropped.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'terminal-state', 'state@example.com', 'State', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'State', 'terminal-state', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'member', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'State', 'State', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${S}', '${U}', '${U}', 'creator', '2026-08-13');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, model_plugin_id, status, created_at, updated_at)
    VALUES ('${C}', '${W}', 'github', 'workspace', NULL, '1234', 'GitHub',
            '[]', 'plugin_github', 'healthy', '2026-08-13', '2026-08-13');
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  workstreamObjectRun(objectStore, "UPDATE workstream SET parent_kind = 'canvas' WHERE id = 1");
  seedWorkstreamObjectParticipant(objectStore, { userId: U, participationReason: "creator" });
  const objectStores = new Map<string, DatabaseSync>([[S, objectStore]]);
  // Visibility is the hosting parent's answer: the fixture conversation is a
  // Canvas's, and its creator-participant reads it.
  const resolveHostedParent = vi.fn(async () => ({
    kind: "canvas",
    authority: { exists: true, authorityGeneration: 1, archived: false },
    viewer: { authorized: true, archived: false },
  }));
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", TERMINAL_REGION_CAPABILITY: "supported",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: { resolveHostedParent },
    }),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn(async () => undefined) }),
    DAYTONA_API_KEY: "key", DAYTONA_API_URL: "https://app.daytona.io/api", DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "snapshot", TERMINAL_EMERGENCY_DISABLED: "false",
  });
  const auth: AuthContext = { sessionId: "session", userId: U, workspaceId: W, region: "global", role: "member" };
  return { database, objectStore, env, auth, resolveHostedParent, service: new TerminalWorkstreamService(env, auth) };
}

describe("Terminal work-stream state", () => {
  it("projects absent state without allocating Daytona or a participant repository gate", async () => {
    const { service } = fixture();
    await expect(service.get(S)).resolves.toMatchObject({
      availability: "supported", state: "absent", repository: null,
      lastActivityAt: null, expiresAt: null,
    });
  });

  it("returns model-selected repository and lifecycle retention state", async () => {
    const { objectStore, service } = fixture();
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_repository
       (id, connection_id, repository_id, repository_full_name,
        base_ref, base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
       VALUES (1, ?, 42, 'owner/repo', 'main', ?, ?, 'selected', ?, ?, ?)`,
      C, "a".repeat(40), `avalon/${S}`, U,
      Date.parse("2026-08-13T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
    );
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_workspace
       (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_command_at,
        expire_due_at, final_diff_resource_id, created_at, updated_at)
       VALUES (1, 'daytona', 'stopped', 'state-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, NULL, ?, ?)`,
      Date.parse("2026-08-13T12:00:00.000Z"),
      Date.parse("2026-09-12T12:00:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
    );
    await expect(service.get(S)).resolves.toMatchObject({
      state: "stopped", lastActivityAt: "2026-08-13T12:00:00.000Z", expiresAt: "2026-09-12T12:00:00.000Z",
      localFilesRetained: true,
      repository: { id: 42, fullName: "owner/repo", baseRef: "main", baseSha: "a".repeat(40), headRef: `avalon/${S}` },
    });
  });

  it("starts fresh using the participant authority without repeating directory visibility", async () => {
    const { resolveHostedParent, service } = fixture();

    await expect(service.startFresh(S)).resolves.toMatchObject({
      availability: "supported",
      state: "absent",
      repository: null,
    });

    expect(resolveHostedParent).not.toHaveBeenCalled();
  });
});
