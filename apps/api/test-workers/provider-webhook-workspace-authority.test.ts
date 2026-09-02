/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Where `ProviderWebhookService` reaches the connector rows a delivery is
 * decided by, once WorkspaceDO owns them.
 *
 * `connector_connections` is a WorkspaceDO table — migration 0090 dropped it
 * from regional D1 — so every statement naming it has to be issued on
 * `withWorkspaceRuntimeDatabase(env, workspaceId)`. The service stores a raw
 * `env` and never reassigns it, so each such call site wraps for itself, and
 * three of them did not:
 *
 * - the GitHub credential door (`withAuthorizedConnection`), whose refresh
 *   lease is an `UPDATE connector_connections … RETURNING`. Unwrapped it threw
 *   `no such table` before the payload was stored and before the receipt was
 *   written, so the *whole* delivery was discarded — including the healthy
 *   workspace-scope connections in unrelated workspaces that shared it.
 * - the credential envelope (`decryptVersionedConnectorCredentials`), whose
 *   rewrite of a trailing key version is dormant until someone increments
 *   `CONNECTOR_CREDENTIALS_KEY_VERSION` — at which point it would have fired on
 *   every delivery for all three providers at once, while blocking the very
 *   rewrite a key rotation is waiting on.
 * - the redelivery shortcut in `ingestVerified`, which is a third thing again:
 *   it reads `activities`, a table 0090 dropped and which is in *neither*
 *   authority, so no wrap can route it. Every other legacy path in the file is
 *   gated on `!env.WORKSPACE_DOS`; that one was not.
 *
 * A `D1_ERROR: no such table` is recognised by no error mapper here, so all
 * three surfaced as `500 internal_error` with the table name stripped from both
 * the response and the logs.
 *
 * These tests keep `connector_connections` where it actually lives and nowhere
 * else, so a statement pointed back at regional D1 fails here the way it failed
 * in production. The pre-cutover branches are deliberately *not* exercised:
 * `test/provider-webhooks.test.ts` builds its env with no `WORKSPACE_DOS`
 * binding at all and covers them, and reaching them from here would mean
 * declaring `connector_connections` in this suite's D1, which is the one thing
 * that would stop this file being evidence.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { decryptString, encryptString, sha256Hex } from "../src/lib/crypto";
import { ProviderWebhookService } from "../src/services/provider-webhook-service";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000fb700");
const OWNER_USER_ID = "00000000-0000-7000-8000-0000000fb710";
const WORKSPACE_CONNECTION_ID = "00000000-0000-7000-8000-0000000fb720";
const PERSONAL_CONNECTION_ID = "00000000-0000-7000-8000-0000000fb721";

const INSTALLATION_ID = "42";
const REPOSITORY = "avalon/example";
const NOW = "2026-08-29T10:00:00.000Z";

const GITHUB_SECRET = "github-webhook-secret";
/** Two keys, so a rotation is a real envelope change rather than a flag. */
const ACTIVE_CREDENTIALS_KEY = "provider-webhook-active-credentials-key";
const RETIRED_CREDENTIALS_KEY = "provider-webhook-retired-credentials-key";

const GITHUB_WEB_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const TOKEN_PATH = "/login/oauth/access_token";

const STALE_ACCESS_TOKEN = "github-user-token-about-to-expire";
const REFRESHED_ACCESS_TOKEN = "github-user-token-just-refreshed";

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

/**
 * The regional half: the placement row `durableObjectStubForWorkspace` reads,
 * the ingress routes that decide which workspaces a delivery reaches, and the
 * receipts.
 *
 * Deliberately no `connector_connections` and no `activities` — that is the
 * state of a migrated region, and creating either here would let the defects
 * this file covers pass.
 *
 * `IF NOT EXISTS` / `OR REPLACE` rather than the bare forms: `reset()` is
 * supposed to drop D1's schema, but `participant-notification.test.ts` records
 * an incomplete wipe leaving tables standing, where a bare `CREATE TABLE` then
 * fails as `already exists` and buries the original failure.
 */
async function seedRegionalDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL,
      placement_affinity TEXT NOT NULL, abandoned_at TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces
        (id, region, placement_affinity, abandoned_at)
      VALUES (?, 'global', 'wnam', NULL)`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS connector_ingress_routes (
      connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL,
      connector_type TEXT NOT NULL, scope TEXT NOT NULL, provider_account_id TEXT,
      provider_user_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS provider_webhook_receipts (
      provider TEXT NOT NULL, delivery_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload_ref TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT,
      error_json TEXT, PRIMARY KEY (provider, delivery_id)
    )`),
  ]);
}

async function seedIngressRoute(input: {
  connectionId: string;
  scope: "personal" | "workspace";
}): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO connector_ingress_routes
       (connection_id, workspace_id, region, connector_type, scope,
        provider_account_id, provider_user_id, status, updated_at)
     VALUES (?, ?, 'global', 'github', ?, ?, NULL, 'active', ?)`,
  ).bind(input.connectionId, WORKSPACE_ID, input.scope, INSTALLATION_ID, NOW).run();
}

interface SeededConnection {
  id: string;
  scope: "personal" | "workspace";
  modelPluginId: string;
  credentials: Record<string, unknown>;
  credentialKey: string;
  credentialKeyVersion: number;
}

/** The workspace half: the connector rows the delivery is decided from. */
async function seedWorkspaceConnection(input: SeededConnection): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify(input.credentials),
    input.credentialKey,
    input.id,
  );
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, encrypted_credentials, credential_iv, credential_key_version,
          granted_scopes_json, status, cursor_json, config_json,
          created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'github', ?, ?, ?, 'Avalon', ?, ?, ?, '[]', 'healthy', '{}', ?, ?, ?, ?)`,
      input.id,
      WORKSPACE_ID,
      input.scope,
      input.scope === "personal" ? OWNER_USER_ID : null,
      INSTALLATION_ID,
      encrypted.ciphertext,
      encrypted.iv,
      input.credentialKeyVersion,
      JSON.stringify({ region: "global", githubUserId: "7" }),
      NOW,
      NOW,
      input.modelPluginId,
    );
  });
}

interface StoredCredentialRow extends Record<string, string | number | null> {
  encrypted_credentials: string;
  credential_iv: string;
  credential_key_version: number;
  credential_refresh_lease_id: string | null;
  status: string;
}

/** Read a connector row back through the object that owns it. */
async function storedConnection(connectionId: string): Promise<StoredCredentialRow> {
  return runInDurableObject(workspaceStub(), (_instance, state) => (
    state.storage.sql.exec<StoredCredentialRow>(
      `SELECT encrypted_credentials, credential_iv, credential_key_version,
              credential_refresh_lease_id, status
         FROM connector_connections WHERE id = ?`,
      connectionId,
    ).one()
  ));
}

interface StoredReceipt extends Record<string, string | null> {
  event_type: string;
  payload_ref: string;
  processed_at: string | null;
  error_json: string | null;
}

async function storedReceipt(deliveryId: string): Promise<StoredReceipt | null> {
  return env.DB.prepare(
    `SELECT event_type, payload_ref, processed_at, error_json
       FROM provider_webhook_receipts WHERE provider = 'github' AND delivery_id = ?`,
  ).bind(deliveryId).first<StoredReceipt>();
}

function serviceFor(overrides: Partial<Env> = {}): ProviderWebhookService {
  // Annotated, not cast: the workers-suite `env` already satisfies `Env`, and
  // the lint rule is right that a cast here would hide binding drift.
  const testEnv: Env = {
    ...env,
    GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    CONNECTOR_CREDENTIALS_KEY: ACTIVE_CREDENTIALS_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
    ...overrides,
  };
  return new ProviderWebhookService(testEnv);
}

/** The GitHub App configuration that turns the personal-connection probe on. */
const GITHUB_APP_CONFIGURATION: Partial<Env> = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_CLIENT_ID: "github-client",
  GITHUB_APP_CLIENT_SECRET: "github-client-secret",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
};

function issuesDelivery(): string {
  return JSON.stringify({
    action: "opened",
    installation: { id: Number(INSTALLATION_ID) },
    repository: {
      id: 10,
      full_name: REPOSITORY,
      html_url: `https://github.com/${REPOSITORY}`,
      owner: { login: "avalon" },
    },
    sender: { login: "octocat" },
    issue: {
      id: 20,
      node_id: "issue-node",
      number: 1,
      title: "Webhook support",
      body: "Ship provider events without changing whitespace",
      html_url: `https://github.com/${REPOSITORY}/issues/1`,
      created_at: "2026-08-29T09:59:00.000Z",
    },
  }, null, 2);
}

async function githubHeaders(rawBody: string, deliveryId: string): Promise<Headers> {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-github-delivery": deliveryId,
    "x-github-event": "issues",
    "x-hub-signature-256": `sha256=${await hmacHex(GITHUB_SECRET, rawBody)}`,
  });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A stand-in for GitHub's own HTTP API — the one collaborator in this file that
 * cannot run here.
 *
 * `vi.stubGlobal` rather than the service's `fetch` option, because the two
 * calls the personal-connection probe makes resolve their fetcher differently:
 * the repository read takes `githubConfig().fetch`, while the token refresh
 * goes through the registry adapter, which captured `globalThis.fetch` when it
 * was constructed. Stubbing the global covers both, and it is what
 * `helpers/openrouter-double.ts` does for the same reason — the test file, the
 * production modules and the object share one isolate here.
 *
 * Any other host is refused *and recorded*: a throw on its own is swallowed by
 * the connector error handling on the way out, so the recorded list is what
 * makes an unexpected call visible rather than a mystery later.
 */
function useGitHubDouble(): { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const unexpected: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    unexpected.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url);
      calls.push(`${url.origin}${url.pathname}`);
      if (url.origin === GITHUB_WEB_ORIGIN && url.pathname === TOKEN_PATH) {
        return Response.json({
          access_token: REFRESHED_ACCESS_TOKEN,
          refresh_token: "github-user-refresh-token-rotated",
          expires_in: 28_800,
          token_type: "bearer",
          scope: "repo",
        });
      }
      if (url.origin === GITHUB_API_ORIGIN && url.pathname === `/repos/${REPOSITORY}`) {
        return Response.json({ id: 10, full_name: REPOSITORY, private: false });
      }
      unexpected.push(url.toString());
      throw new Error(`github_double_unexpected_request:${url.origin}${url.pathname}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Read before clearing so the next test starts clean even when this fails.
    const seen = [...unexpected];
    unexpected.length = 0;
    expect(seen, "outbound requests the GitHub double did not expect").toEqual([]);
  });

  return {
    get calls() {
      return calls;
    },
  };
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("provider webhook ingestion against the workspace authority", () => {
  // First, because it is the premise every other test in this file rests on.
  it("keeps the connector and activity tables out of regional D1, which is what makes the rest of this file evidence", async () => {
    await expect(env.DB.prepare(`SELECT id FROM connector_connections LIMIT 1`).all())
      .rejects.toThrow(/no such table: connector_connections/u);
    // Not in either authority: 0090 dropped it and no WorkspaceDO schema
    // declares it, so this is the table no wrap can route.
    await expect(env.DB.prepare(`SELECT id FROM activities LIMIT 1`).all())
      .rejects.toThrow(/no such table: activities/u);
    await expect(runInDurableObject(workspaceStub(), (_instance, state) => (
      state.storage.sql.exec(`SELECT id FROM activities LIMIT 1`).toArray()
    ))).rejects.toThrow(/no such table: activities/u);
  });

  describe("a redelivery whose receipt was never marked processed", () => {
    const DELIVERY_ID = "github-redelivered-issue-1";

    beforeEach(async () => {
      await seedIngressRoute({
        connectionId: WORKSPACE_CONNECTION_ID,
        scope: "workspace",
      });
      await seedWorkspaceConnection({
        id: WORKSPACE_CONNECTION_ID,
        scope: "workspace",
        modelPluginId: "plugin_github_installation",
        credentials: { installationId: INSTALLATION_ID, tokenKind: "installation" },
        credentialKey: ACTIVE_CREDENTIALS_KEY,
        credentialKeyVersion: 1,
      });
    });

    /**
     * The receipt a crash between the global receipt commit and the connector
     * enqueue leaves behind: present, matching, and `processed_at IS NULL`.
     * Seeded rather than produced by a first delivery so the state under test
     * is the only thing this test sets up — the payload reference is the same
     * `sha256` of the same bytes the service will compute.
     */
    async function seedPendingReceipt(rawBody: string): Promise<void> {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO provider_webhook_receipts
           (provider, delivery_id, event_type, payload_ref, received_at, processed_at, error_json)
         VALUES ('github', ?, 'issues', ?, ?, NULL, NULL)`,
      ).bind(
        DELIVERY_ID,
        `global/provider-webhooks/github/${await sha256Hex(rawBody)}.json`,
        NOW,
      ).run();
    }

    it("repairs it through the workspace path instead of reading the dropped activities table", async () => {
      const rawBody = issuesDelivery();
      await seedPendingReceipt(rawBody);

      // Under the unguarded shortcut this rejected: `no such table:
      // activities`, unmapped, as a 500 the provider retried into the same
      // branch forever.
      await expect(serviceFor().ingestGitHub(
        rawBody,
        await githubHeaders(rawBody, DELIVERY_ID),
      )).resolves.toEqual({ accepted: true, duplicate: true, activityCount: 0 });

      // The repair the main path performs, read back rather than inferred: the
      // receipt is settled, and settled without an error the shortcut would
      // have recorded.
      const receipt = await storedReceipt(DELIVERY_ID);
      expect(receipt?.processed_at).toEqual(expect.any(String));
      expect(receipt?.error_json).toBeNull();
    });

    it("still settles a redelivery whose connector rows only the workspace object has", async () => {
      const rawBody = issuesDelivery();
      await seedPendingReceipt(rawBody);
      await serviceFor().ingestGitHub(rawBody, await githubHeaders(rawBody, DELIVERY_ID));

      // The resources the main path re-applies live in the object, not in D1 —
      // proof the fall-through reached the modern effects rather than merely
      // declining to throw.
      const resources = await runInDurableObject(workspaceStub(), (_instance, state) => (
        state.storage.sql.exec<{ provider_resource_id: string }>(
          `SELECT provider_resource_id FROM resources WHERE connection_id = ? ORDER BY provider_resource_id`,
          WORKSPACE_CONNECTION_ID,
        ).toArray()
      ));
      expect(resources.map((row) => row.provider_resource_id)).toEqual([
        REPOSITORY,
        `${REPOSITORY}#1`,
      ]);
    });
  });

  describe("a personal GitHub connection whose token is inside the refresh window", () => {
    const DELIVERY_ID = "github-personal-issue-1";
    const github = useGitHubDouble();

    beforeEach(async () => {
      await seedIngressRoute({
        connectionId: PERSONAL_CONNECTION_ID,
        scope: "personal",
      });
      await seedWorkspaceConnection({
        id: PERSONAL_CONNECTION_ID,
        scope: "personal",
        modelPluginId: "plugin_github_personal",
        credentials: {
          installationId: INSTALLATION_ID,
          tokenKind: "user",
          accessToken: STALE_ACCESS_TOKEN,
          refreshToken: "github-user-refresh-token-stored",
          // Inside `ensureFreshConnectorCredentials`'s 60s window, which is
          // what puts the lease `UPDATE` on the delivery path at all. Relative
          // to the real clock because that predicate reads `Date.now()`
          // directly and no fixture epoch can stand in for it.
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
        credentialKey: ACTIVE_CREDENTIALS_KEY,
        credentialKeyVersion: 1,
      });
    });

    it("accepts the delivery and writes the receipt, taking the refresh lease in the workspace object", async () => {
      const rawBody = issuesDelivery();

      // Unwrapped, the lease claim threw before `PAYLOADS.put` and before the
      // receipt insert, so the whole delivery was discarded.
      await expect(serviceFor(GITHUB_APP_CONFIGURATION).ingestGitHub(
        rawBody,
        await githubHeaders(rawBody, DELIVERY_ID),
      )).resolves.toEqual({ accepted: true, duplicate: false, activityCount: 1 });

      const receipt = await storedReceipt(DELIVERY_ID);
      expect(receipt?.event_type).toBe("issues");
      expect(receipt?.processed_at).toEqual(expect.any(String));

      // The refresh really ran, through the door, against the provider.
      expect(github.calls).toEqual([
        `${GITHUB_WEB_ORIGIN}${TOKEN_PATH}`,
        `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}`,
      ]);
    });

    it("persists the refreshed token to the workspace object and releases the lease", async () => {
      const rawBody = issuesDelivery();
      await serviceFor(GITHUB_APP_CONFIGURATION).ingestGitHub(
        rawBody,
        await githubHeaders(rawBody, DELIVERY_ID),
      );

      const row = await storedConnection(PERSONAL_CONNECTION_ID);
      const credentials = JSON.parse(await decryptString(
        row.encrypted_credentials,
        row.credential_iv,
        ACTIVE_CREDENTIALS_KEY,
        PERSONAL_CONNECTION_ID,
      )) as Record<string, unknown>;
      expect(credentials.accessToken).toBe(REFRESHED_ACCESS_TOKEN);
      // Claimed and released in the object, not in a region that has no row to
      // claim.
      expect(row.credential_refresh_lease_id).toBeNull();
    });
  });

  describe("a connection whose stored credential key version trails the active one", () => {
    const DELIVERY_ID = "github-rotating-key-issue-1";
    const CREDENTIALS = { installationId: INSTALLATION_ID, tokenKind: "installation" };

    /** What a key rotation looks like mid-flight: version 2 active, 1 retired. */
    const ROTATING_KEYS: Partial<Env> = {
      CONNECTOR_CREDENTIALS_KEY: ACTIVE_CREDENTIALS_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
      CONNECTOR_CREDENTIALS_KEYS_JSON: JSON.stringify({ 1: RETIRED_CREDENTIALS_KEY }),
    };

    beforeEach(async () => {
      await seedIngressRoute({
        connectionId: WORKSPACE_CONNECTION_ID,
        scope: "workspace",
      });
      await seedWorkspaceConnection({
        id: WORKSPACE_CONNECTION_ID,
        scope: "workspace",
        modelPluginId: "plugin_github_installation",
        credentials: CREDENTIALS,
        credentialKey: RETIRED_CREDENTIALS_KEY,
        credentialKeyVersion: 1,
      });
    });

    it("re-encrypts the row in the workspace object rather than failing the delivery", async () => {
      const rawBody = issuesDelivery();

      // Unwrapped, the envelope's opportunistic rewrite threw while loading
      // the connection — before the payload, before the receipt — so every
      // delivery for every provider failed for as long as the rotation was in
      // progress.
      await expect(serviceFor(ROTATING_KEYS).ingestGitHub(
        rawBody,
        await githubHeaders(rawBody, DELIVERY_ID),
      )).resolves.toEqual({ accepted: true, duplicate: false, activityCount: 1 });

      const row = await storedConnection(WORKSPACE_CONNECTION_ID);
      expect(row.credential_key_version).toBe(2);
      // Readable with the active key, and unchanged in content: the rewrite is
      // the thing a rotation waits on, so proving the version moved without
      // proving the plaintext survived would be proving half of it.
      await expect(decryptString(
        row.encrypted_credentials,
        row.credential_iv,
        ACTIVE_CREDENTIALS_KEY,
        WORKSPACE_CONNECTION_ID,
      )).resolves.toBe(JSON.stringify(CREDENTIALS));
    });
  });
});
