import { DatabaseSync } from "node:sqlite";

import type { Env } from "../../src/env";
import type { WorkspaceDO } from "../../src/durable-objects/workspace-do";
import { createTestEnv } from "./cloudflare-test";
import { sqliteD1 } from "./sqlite-d1";
import { testSubstreamAgentsBinding } from "./durable-authority";
import {
  CONNECTION_WORKSPACE_OBJECT_METHODS,
  createTestWorkspaceDO,
  workspaceObjectRpcs,
} from "./workspace-object-rpcs";

/**
 * A real WorkspaceDO holding one connection, for a connector test.
 *
 * These suites used to build a fake `D1Database` that answered by matching
 * substrings of the SQL — `sql.includes("RETURNING id")` deciding whether a
 * lease settle won. That was workable while the service wrote the statements,
 * and it is not workable now: the lease is a typed method whose semantics live
 * in the object, so a fixture reimplementing them would be asserting on its own
 * reimplementation. It also hid drift — the fake answered a settle whether or
 * not the row was still leased, which is the exact fence the real method has.
 *
 * The regional database is deliberately empty. Nothing in the credential paths
 * reads a regional table, so a schema here would only be inviting one to.
 */
export function connectionObjectFixture(input: {
  workspaceId: string;
  connectionId: string;
  connectorType?: string;
  scope?: "personal" | "workspace";
  ownerUserId?: string | null;
  status?: "healthy" | "needs_reconnect" | "error" | "disabled";
  credentials?: { ciphertext: string; iv: string; keyVersion?: number } | null;
  providerAccountId?: string | null;
  configJson?: string;
  grantedScopesJson?: string;
  env?: Partial<Env>;
  register?: (database: DatabaseSync) => void;
}): { env: Env; instance: WorkspaceDO; objectDatabase: DatabaseSync; regionalDatabase: DatabaseSync } {
  const regionalDatabase = new DatabaseSync(":memory:");
  input.register?.(regionalDatabase);
  const { instance, objectDatabase } = createTestWorkspaceDO({
    workspaceId: input.workspaceId,
    regionalDatabase,
    ...(input.register ? { register: input.register } : {}),
  });
  const at = "2026-01-01T00:00:00.000Z";
  objectDatabase.prepare(
    `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
        display_name, encrypted_credentials, credential_iv, credential_key_version,
        granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
        model_plugin_id)
     VALUES (?, ?, ?, ?, ?, ?, 'Fixture connection', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(
    input.connectionId,
    input.workspaceId,
    input.connectorType ?? "google",
    input.scope ?? "workspace",
    input.scope === "personal" ? (input.ownerUserId ?? "fixture-user") : null,
    input.providerAccountId ?? null,
    input.credentials?.ciphertext ?? null,
    input.credentials?.iv ?? null,
    input.credentials ? (input.credentials.keyVersion ?? 1) : null,
    input.grantedScopesJson ?? "[]",
    input.status ?? "healthy",
    input.configJson ?? "{}",
    at,
    at,
    `plugin_${input.connectorType ?? "google"}_fixture`,
  );
  const env = createTestEnv({
    DB: sqliteD1(regionalDatabase),
    AVALON_REGION: "global",
    WORKSPACE_DOS: testSubstreamAgentsBinding(regionalDatabase, {
      extra: workspaceObjectRpcs(instance, CONNECTION_WORKSPACE_OBJECT_METHODS),
    }),
    ...input.env,
  });
  return { env, instance, objectDatabase, regionalDatabase };
}

/** The stored envelope, for a test asserting on what a rotation wrote. */
export function storedConnectionEnvelope(
  objectDatabase: DatabaseSync,
  connectionId: string,
): { encrypted_credentials: string | null; credential_iv: string | null; credential_key_version: number | null } {
  return objectDatabase.prepare(
    `SELECT encrypted_credentials, credential_iv, credential_key_version
       FROM connector_connections WHERE id = ?`,
  ).get(connectionId) as never;
}

/** The lease a connection currently holds, if any. */
export function storedConnectionLease(
  objectDatabase: DatabaseSync,
  connectionId: string,
): { credential_refresh_lease_id: string | null } {
  return objectDatabase.prepare(
    `SELECT credential_refresh_lease_id FROM connector_connections WHERE id = ?`,
  ).get(connectionId) as never;
}

/** The connection's health and the diagnosis attached to it. */
export function storedConnectionStatus(
  objectDatabase: DatabaseSync,
  connectionId: string,
): { status: string; error_json: string | null } {
  return objectDatabase.prepare(
    `SELECT status, error_json FROM connector_connections WHERE id = ?`,
  ).get(connectionId) as never;
}
