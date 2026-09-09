/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Copying the template's connections, and the one write that must not happen.
 *
 * `connector_connections` lives in each WorkspaceDO's own SQLite, so this runs
 * on real workerd against two real objects: a single `env.DB` cannot see both
 * sides of the copy, and a Node double over one database would hide that.
 *
 * The envelope's additional authenticated data is the connection ID, so a copy
 * has to be a re-encryption rather than a row copy — and that part fails loudly
 * if you get it wrong. The part that fails *silently* is which decrypt helper
 * does it. `decryptVersionedConnectorCredentials` re-encrypts under the active
 * key and writes the result back to the row it read whenever the stored version
 * is stale, so preparing a demo from a template one rotation behind would
 * rewrite the template — a write into the single workspace this feature exists
 * to leave alone. It is invisible unless the test puts the template a rotation
 * behind on purpose, which the second test does.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { copyTemplateConnections } from "../src/services/demo-connection-copy";
import { decryptVersionedCredentialValue } from "../src/services/connector-credential-envelope";
import { encryptString } from "../src/lib/crypto";
import { workspaceDOName } from "../src/durable-objects/names";
import { workspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";

const TEST_ENV: Env = env;

const ACTIVE_KEY = "active-connector-credentials-key-for-tests";
const PREVIOUS_KEY = "previous-connector-credentials-key-for-tests";
const NOW = "2026-09-05T12:00:00.000Z";

let sequence = 0;
function freshPair() {
  sequence += 1;
  const suffix = (0xf100 + sequence * 2).toString(16).padStart(4, "0");
  const next = (0xf101 + sequence * 2).toString(16).padStart(4, "0");
  return {
    templateId: asWorkspaceId(`00000000-0000-7000-8000-00000000${suffix}`),
    demoId: asWorkspaceId(`00000000-0000-7000-8000-00000000${next}`),
    connectionId: `00000000-0000-7000-8000-0000000b${suffix}`,
  };
}

/**
 * The real bindings with three credential settings overridden.
 *
 * Spread rather than cast: every binding the copier reaches for is the one
 * workerd bound, so a binding that changes shape fails here rather than being
 * hidden behind an assertion.
 */
function envWithKeys(keyVersion: string): Env {
  return {
    ...TEST_ENV,
    CONNECTOR_CREDENTIALS_KEY: ACTIVE_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: keyVersion,
    CONNECTOR_CREDENTIALS_KEYS_JSON: JSON.stringify({ "1": PREVIOUS_KEY }),
  };
}

/**
 * A workspace object refuses product SQL until it knows which workspace it is.
 * In production that identity arrives with the first projection; here it is
 * written directly, because what this file is testing is the copy rather than
 * how a workspace comes to exist.
 */
async function claimWorkspaceIdentity(workspaceId: string): Promise<void> {
  const stub = TEST_ENV.WORKSPACE_DOS.get(
    TEST_ENV.WORKSPACE_DOS.idFromName(workspaceDOName(TEST_ENV.AVALON_REGION, workspaceId as never)),
  ) as DurableObjectStub<WorkspaceDO>;
  await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
    state.storage.sql.exec(
      `INSERT INTO workspace_identity
         (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, ?, 'wnam', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      workspaceId,
      TEST_ENV.AVALON_REGION,
      Date.now(),
      Date.now(),
    );
    void instance;
  });
}

async function seedTemplateConnection(
  db: D1Database,
  workspaceId: string,
  connectionId: string,
  storedKeyVersion: number,
  owner: { scope: "workspace" | "personal"; ownerUserId: string | null; modelPluginId?: string; connectorType?: string } = {
    scope: "workspace",
    ownerUserId: null,
  },
): Promise<void> {
  const secret = storedKeyVersion === 1 ? PREVIOUS_KEY : ACTIVE_KEY;
  const sealed = await encryptString(
    JSON.stringify({ refreshToken: "demo-refresh-token" }),
    secret,
    connectionId,
  );
  await db.prepare(
    `INSERT INTO connector_connections (
       id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       granted_scopes_json, status, cursor_json, config_json, model_plugin_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'alex-demo@example.com',
               'Google', ?, ?, ?, '["drive.read"]', 'healthy', '{}', '{}', ?, ?, ?)`,
  ).bind(
    connectionId,
    workspaceId,
    owner.connectorType ?? "google",
    owner.scope,
    owner.ownerUserId,
    sealed.ciphertext,
    sealed.iv,
    storedKeyVersion,
    owner.modelPluginId ?? "google",
    NOW,
    NOW,
  ).run();
}

async function connectionRow(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  return db.prepare(
    `SELECT id, scope, owner_user_id, provider_account_id, granted_scopes_json,
            encrypted_credentials, credential_iv, credential_key_version, updated_at
       FROM connector_connections WHERE id = ?`,
  ).bind(id).first();
}

describe("demo connection copying", () => {
  it("produces a working workspace-scoped copy under its own identity", async () => {
    const { templateId, demoId, connectionId } = freshPair();
    const keyed = envWithKeys("2");
    await claimWorkspaceIdentity(templateId);
    await claimWorkspaceIdentity(demoId);
    const sourceDb = workspaceRuntimeDatabase(keyed, templateId);
    const destinationDb = workspaceRuntimeDatabase(keyed, demoId);
    await seedTemplateConnection(sourceDb, templateId, connectionId, 2);

    const copied = await copyTemplateConnections(keyed, {
      sourceWorkspaceId: templateId,
      destinationWorkspaceId: demoId,
      sourceDb,
      destinationDb,
      now: NOW,
    });

    expect(copied.copied).toHaveLength(1);
    expect(copied.copied[0]?.carriesCredentials).toBe(true);
    expect(copied.copied[0]?.destinationConnectionId).not.toBe(connectionId);

    const destination = await connectionRow(destinationDb, copied.copied[0]!.destinationConnectionId);
    // Workspace-scoped with no owner, so the presenter — who owns none of the
    // cast's connections — can use it. A personal copy would be invisible to them.
    expect(destination?.scope).toBe("workspace");
    expect(destination?.owner_user_id).toBeNull();
    // The same upstream account and the same granted capabilities, never wider.
    expect(destination?.provider_account_id).toBe("alex-demo@example.com");
    expect(destination?.granted_scopes_json).toBe('["drive.read"]');

    const source = await connectionRow(sourceDb, connectionId);
    // A different envelope, not the same bytes in a new row.
    expect(destination?.encrypted_credentials).not.toBe(source?.encrypted_credentials);
    expect(destination?.credential_iv).not.toBe(source?.credential_iv);

    // And it actually opens — under the destination's own id, which is what
    // makes the copy usable rather than merely present.
    const plaintext = await decryptVersionedCredentialValue(
      keyed,
      {
        encrypted_credentials: destination?.encrypted_credentials as string,
        credential_iv: destination?.credential_iv as string,
        credential_key_version: destination?.credential_key_version as number,
      },
      destination?.id as string,
    );
    expect(JSON.parse(plaintext)).toEqual({ refreshToken: "demo-refresh-token" });
  });

  it("leaves the template byte-identical when its key version is stale", async () => {
    const { templateId, demoId, connectionId } = freshPair();
    const keyed = envWithKeys("2");
    await claimWorkspaceIdentity(templateId);
    await claimWorkspaceIdentity(demoId);
    const sourceDb = workspaceRuntimeDatabase(keyed, templateId);
    const destinationDb = workspaceRuntimeDatabase(keyed, demoId);
    // One rotation behind. This is the only state in which the writing helper
    // and the non-writing one behave differently, so it is the only state that
    // can catch the wrong one.
    await seedTemplateConnection(sourceDb, templateId, connectionId, 1);

    const before = await connectionRow(sourceDb, connectionId);
    const copied = await copyTemplateConnections(keyed, {
      sourceWorkspaceId: templateId,
      destinationWorkspaceId: demoId,
      sourceDb,
      destinationDb,
      now: NOW,
    });
    const after = await connectionRow(sourceDb, connectionId);

    expect(copied.copied[0]?.carriesCredentials).toBe(true);
    // Every column, not just the ciphertext: the writing helper moves the IV,
    // the key version and `updated_at` too.
    expect(after).toEqual(before);
  });

  it("leaves a personal template connection behind rather than sharing it", async () => {
    const { templateId, demoId, connectionId } = freshPair();
    const personalId = `${connectionId.slice(0, -1)}e`;
    const keyed = envWithKeys("2");
    await claimWorkspaceIdentity(templateId);
    await claimWorkspaceIdentity(demoId);
    const sourceDb = workspaceRuntimeDatabase(keyed, templateId);
    const destinationDb = workspaceRuntimeDatabase(keyed, demoId);
    await seedTemplateConnection(sourceDb, templateId, connectionId, 2);
    // One person's own Google account, connected to the template for their own
    // use. The demo's copies are workspace-scoped so the presenter can use
    // them, and rewriting this one that way would hand their refresh token to
    // everybody in the demo workspace.
    await seedTemplateConnection(sourceDb, templateId, personalId, 2, {
      scope: "personal",
      ownerUserId: "00000000-0000-7000-8000-0000000000a7",
      modelPluginId: "slack",
    });

    const result = await copyTemplateConnections(keyed, {
      sourceWorkspaceId: templateId,
      destinationWorkspaceId: demoId,
      sourceDb,
      destinationDb,
      now: NOW,
    });

    expect(result.copied.map((entry) => entry.sourceConnectionId)).toEqual([connectionId]);
    // Reported, not silently dropped: the operator has to find out the demo has
    // no Slack before the meeting rather than during it.
    expect(result.skipped).toEqual([
      { sourceConnectionId: personalId, connectorType: "google", displayName: "Google", reason: "personal_scope" },
    ]);

    const rows = await destinationDb.prepare(
      "SELECT COUNT(*) AS n FROM connector_connections WHERE workspace_id = ?",
    ).bind(demoId).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("leaves a connection whose provider revokes remotely behind, so a demo's Disconnect cannot kill the template's grant", async () => {
    // A copy shares the template's upstream grant. Google disables locally;
    // every other adapter with `revoke` calls the provider, and the presenter
    // owns the demo's Disconnect button. Such a connection is skipped and
    // reported rather than copied and hoped about.
    const { templateId, demoId, connectionId } = freshPair();
    const linearId = `${connectionId.slice(0, -1)}f`;
    const keyed = envWithKeys("2");
    await claimWorkspaceIdentity(templateId);
    await claimWorkspaceIdentity(demoId);
    const sourceDb = workspaceRuntimeDatabase(keyed, templateId);
    const destinationDb = workspaceRuntimeDatabase(keyed, demoId);
    await seedTemplateConnection(sourceDb, templateId, connectionId, 2);
    await seedTemplateConnection(sourceDb, templateId, linearId, 2, {
      scope: "workspace", ownerUserId: null, modelPluginId: "linear", connectorType: "linear",
    });

    const result = await copyTemplateConnections(keyed, {
      sourceWorkspaceId: templateId,
      destinationWorkspaceId: demoId,
      sourceDb,
      destinationDb,
      now: NOW,
    });

    expect(result.copied.map((entry) => entry.sourceConnectionId)).toEqual([connectionId]);
    expect(result.skipped).toEqual([
      { sourceConnectionId: linearId, connectorType: "linear", displayName: "Google", reason: "shared_grant" },
    ]);
    const rows = await destinationDb.prepare(
      "SELECT connector_type FROM connector_connections WHERE workspace_id = ?",
    ).bind(demoId).all<{ connector_type: string }>();
    expect((rows.results ?? []).map((row) => row.connector_type)).toEqual(["google"]);
  });

  it("does not create a second set of connections on a resumed preparation", async () => {
    const { templateId, demoId, connectionId } = freshPair();
    const keyed = envWithKeys("2");
    await claimWorkspaceIdentity(templateId);
    await claimWorkspaceIdentity(demoId);
    const sourceDb = workspaceRuntimeDatabase(keyed, templateId);
    const destinationDb = workspaceRuntimeDatabase(keyed, demoId);
    await seedTemplateConnection(sourceDb, templateId, connectionId, 2);

    const request = {
      sourceWorkspaceId: templateId,
      destinationWorkspaceId: demoId,
      sourceDb,
      destinationDb,
      now: NOW,
    };
    const first = await copyTemplateConnections(keyed, request);
    const resumed = await copyTemplateConnections(keyed, request);

    expect(resumed.copied[0]?.destinationConnectionId).toBe(first.copied[0]?.destinationConnectionId);
    const count = await destinationDb.prepare(
      "SELECT COUNT(*) AS n FROM connector_connections WHERE workspace_id = ?",
    ).bind(demoId).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
