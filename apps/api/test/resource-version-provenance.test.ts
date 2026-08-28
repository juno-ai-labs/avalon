/**
 * Who moved a resource's pointers, and why, as the swap sites record it.
 *
 * The capture itself is a WorkspaceDO trigger, so these run against the
 * object's own schema from its ledger rather than a hand-written fixture: a
 * test over invented tables would prove the service wrote provenance columns
 * and nothing about whether capture carried them into history.
 */
import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { AuthContext } from "../src/env";
import { sha256Hex } from "../src/lib/crypto";
import { ResourceService } from "../src/services/resource-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { workspaceObjectSqliteDatabase } from "./helpers/workspace-object-tables";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-0000000000c1");
const userId = asUserId("00000000-0000-7000-8000-0000000000c2");
const connectionId = "00000000-0000-7000-8000-0000000000c3";
const resourceId = "00000000-0000-7000-8000-0000000000c4";
const draftId = "00000000-0000-7000-8000-0000000000c5";

const auth: AuthContext = {
  sessionId: "session-1",
  userId,
  workspaceId,
  region: "global",
  role: "owner",
};

const open: DatabaseSync[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

function fixture(): DatabaseSync {
  const database = workspaceObjectSqliteDatabase(workspaceId);
  open.push(database);
  return database;
}

function environmentFor(database: DatabaseSync, stored = new Map<string, string>()) {
  return createTestEnv({
    AVALON_REGION: "global",
    MAX_ATTACHMENT_BYTES: "25000000",
    DB: sqliteD1(database),
    PAYLOADS: {
      async put(key: string, value: string) { stored.set(key, value); },
      async delete(key: string) { stored.delete(key); },
    },
  });
}

function seedConnectorResource(database: DatabaseSync, contentSha256 = "1".repeat(64)): void {
  database.exec(`
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, display_name, status,
       model_plugin_id, created_at, updated_at)
    VALUES ('${connectionId}', '${workspaceId}', 'granola', 'workspace', 'Granola',
            'healthy', 'granola-plugin', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z');
    INSERT INTO resources
      (id, workspace_id, connection_id, resource_type, provider, provider_resource_id, title,
       content_ref, content_sha256, model_content_ref, model_mime_type, model_content_sha256,
       model_content_status, metadata_json, attachment_status, created_at, updated_at,
       revision_author_kind, revision_author_connection_id, revision_cause)
    VALUES ('${resourceId}', '${workspaceId}', '${connectionId}', 'meeting', 'granola',
            'granola-1', 'Kickoff', 'r2/original-1', '${contentSha256}', 'r2/model-1',
            'text/markdown', '${"a".repeat(64)}', 'ready', '{}', 'attached',
            '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
            'connector', '${connectionId}', 'created');
  `);
}

function versions(database: DatabaseSync): Array<Record<string, unknown>> {
  return database.prepare(
    `SELECT version, author_kind, author_run_id, author_user_id, author_connection_id,
            cause, storage_kind, content_ref
       FROM resource_versions ORDER BY version`,
  ).all() as Array<Record<string, unknown>>;
}

function hydrationRegistry(value: unknown): NonNullable<ConstructorParameters<typeof ResourceService>[2]> {
  return { get() { return { hydrateResource: async () => value }; } } as never;
}

describe("resource version provenance", () => {
  it("attributes an uploaded draft's first version to the member who uploaded it", async () => {
    const database = fixture();
    const service = new ResourceService(environmentFor(database), auth);

    await service.upload(new File(["hello"], "notes.txt", { type: "text/plain" }), undefined, draftId);

    expect(versions(database)).toMatchObject([
      { version: 1, author_kind: "member", author_user_id: userId, author_run_id: null,
        author_connection_id: null, cause: "created", storage_kind: "object" },
    ]);
  });

  it("attributes a connector re-fetch to the connection that served it", async () => {
    const database = fixture();
    seedConnectorResource(database);
    const service = new ResourceService(
      environmentFor(database),
      auth,
      hydrationRegistry({ revision: 2 }),
    );

    await service.hydrate(resourceId);

    const captured = versions(database);
    expect(captured).toMatchObject([
      { version: 1, author_kind: "connector", author_connection_id: connectionId, cause: "created" },
      { version: 2, author_kind: "connector", author_connection_id: connectionId, cause: "refetched" },
    ]);
    // The superseded pointer is still named by history, which is what stops
    // the sweeper collecting the bytes participants read before the re-fetch.
    expect(captured[0]?.content_ref).toBe("r2/original-1");
    expect(captured[1]?.content_ref).not.toBe("r2/original-1");
    await expect(service.versions(resourceId)).resolves.toMatchObject([
      { version: 2, author: { kind: "connector", connectionId }, cause: "refetched", storageKind: "object" },
      { version: 1, author: { kind: "connector", connectionId }, cause: "created", storageKind: "object" },
    ]);
  });

  it("reports history that predates provenance as unattributed rather than guessing", async () => {
    const database = fixture();
    seedConnectorResource(database);
    // What an object upgraded through the provenance migration holds: rows
    // recording which pointers a state had, and nothing about who moved them.
    database.exec("UPDATE resource_versions SET author_kind = NULL, author_connection_id = NULL, cause = NULL");
    const service = new ResourceService(environmentFor(database), auth);

    await expect(service.versions(resourceId)).resolves.toMatchObject([
      { version: 1, author: null, cause: null, storageKind: "object" },
    ]);
  });

  it("attributes a re-fetch that resolved to the same bytes to the same connection", async () => {
    const database = fixture();
    // Seeded already holding the bytes the connector is about to return, so
    // the service takes its unchanged-content branch. A re-observation is
    // still a new state of the resource, and it is still the connector's.
    seedConnectorResource(database, await sha256Hex(JSON.stringify({ revision: 2 })));
    const service = new ResourceService(
      environmentFor(database),
      auth,
      hydrationRegistry({ revision: 2 }),
    );

    await service.hydrate(resourceId);

    expect(versions(database)).toMatchObject([
      { version: 1, cause: "created" },
      { version: 2, author_kind: "connector", author_connection_id: connectionId, cause: "refetched" },
    ]);
  });
});
