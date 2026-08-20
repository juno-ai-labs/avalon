import { asUserId } from "@avalon/contracts";
import { asWorkspaceId } from "@avalon/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { TerminalWorkstreamService } from "../src/services/terminal/workstream-state";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = asWorkspaceId("61000000-0000-4000-8000-000000000001");
const S = "61000000-0000-4000-8000-000000000002";
const U = asUserId("61000000-0000-4000-8000-000000000003");
const C = "61000000-0000-4000-8000-000000000004";
const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = migratedSqliteDatabase(); databases.push(database);
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
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", TERMINAL_REGION_CAPABILITY: "supported",
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn(async () => undefined) }),
    DAYTONA_API_KEY: "key", DAYTONA_API_URL: "https://app.daytona.io/api", DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "snapshot", TERMINAL_EMERGENCY_DISABLED: "false",
  });
  const auth: AuthContext = { sessionId: "session", userId: U, workspaceId: W, region: "global", role: "member" };
  return { database, env, auth, service: new TerminalWorkstreamService(env, auth) };
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
    const { database, service } = fixture();
    database.prepare(
      `INSERT INTO workstream_terminal_repositories
       (workspace_id, workstream_id, connection_id, repository_id, repository_full_name,
        base_ref, base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 42, 'owner/repo', 'main', ?, ?, 'selected', ?, ?, ?)`,
    ).run(W, S, C, "a".repeat(40), `avalon/${S}`, U, "2026-08-13", "2026-08-13");
    database.prepare(
      `INSERT INTO workstream_sandboxes
       (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_activity_at,
        expire_due_at, final_diff_resource_id, created_at, updated_at)
       VALUES (?, ?, 'stopped', 'state-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, NULL, ?, ?)`,
    ).run(W, S, "2026-08-13T12:00:00.000Z", "2026-09-12T12:00:00.000Z", "2026-08-13T12:00:00.000Z", "2026-08-13T12:00:00.000Z");
    await expect(service.get(S)).resolves.toMatchObject({
      state: "stopped", lastActivityAt: "2026-08-13T12:00:00.000Z", expiresAt: "2026-09-12T12:00:00.000Z",
      localFilesRetained: true,
      repository: { id: 42, fullName: "owner/repo", baseRef: "main", baseSha: "a".repeat(40), headRef: `avalon/${S}` },
    });
  });
});
