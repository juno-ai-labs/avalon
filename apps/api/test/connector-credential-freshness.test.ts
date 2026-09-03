import { asWorkspaceId } from "@rally/contracts";
import { asHarnessRunId, asWorkstreamId } from "@rally/contracts";
import {
  ConnectorError,
  authorizedConnection,
  createConnectorRegistry,
  isProviderCredentialRejection,
  isRevokedGrantError,
  providerJson,
  withProviderReauthorization,
  type ConnectorConnectionContext,
} from "@rally/connectors";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "../src/lib/crypto";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import { __connectionServiceTesting } from "../src/services/connection-service";
import { withAuthorizedConnection } from "../src/services/connector-connection-access";
import type { CredentialRefreshAdapter } from "../src/services/connector-credential-refresh";
import { __integrationTesting } from "../src/services/integrations";
import type {
  PluginAuthorizationConnection,
  PluginAuthorizationInput,
} from "../src/services/integrations";
import { createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

/**
 * A connection reaches a provider only through `withAuthorizedConnection`,
 * because only that function can mint the branded type every provider-calling
 * adapter entry point demands. These are the two properties that makes worth
 * relying on: the door always refreshes, and an adapter that is handed a
 * credential the provider rejects mid-call recovers on its own.
 *
 * The second half is registry-driven on purpose. A connector added later is
 * enrolled by existing rather than by someone remembering to write a test for
 * it, which is the only version of this guarantee that survives new code.
 */

const STALE_TOKEN = "stale-access-token";
const FRESH_TOKEN = "rotated-access-token";
const EXPIRED_AT = "2020-01-01T00:00:00.000Z";

const openStores: DatabaseSync[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

describe("the credential door", () => {
  it("writes the rotated credential for a row the database believes is broken, and heals nothing", async () => {
    // The credential lands: that is what the rotation produced. The *status*
    // does not, and an earlier draft of this healed it to `healthy` — on the
    // reasoning that a provider honouring the refresh token has said the grant
    // is alive. It has, and grant liveness is not grant sufficiency: a token
    // exchange succeeds whatever scopes the installation holds, so healing here
    // would have cleared the incident's own `missing_scopes: reactions:read`
    // verdict within one token lifetime and reported a connection as working
    // while every scoped call kept failing.
    const statements: string[] = [];
    const database = recordingLeasedDatabase(
      await encryptString(
        JSON.stringify({ accessToken: STALE_TOKEN, refreshToken: "refresh-token", expiresAt: EXPIRED_AT }),
        "door-credential-key",
        "00000000-0000-7000-8000-00000000c0de",
      ),
      statements,
    );
    const connection = connectionContext({
      accessToken: STALE_TOKEN,
      refreshToken: "refresh-token",
      expiresAt: EXPIRED_AT,
    });

    await withAuthorizedConnection(
      {
        DB: database,
        CONNECTOR_CREDENTIALS_KEY: "door-credential-key",
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      },
      {
        connection,
        adapter: {
          refreshCredentials: async () => ({ accessToken: FRESH_TOKEN }),
        } satisfies CredentialRefreshAdapter,
        signal: AbortSignal.timeout(2_000),
      },
      async () => undefined,
    );

    // The refresh reached the provider and its result is in hand — the
    // behaviour the healthy-only lease used to make impossible.
    expect(connection.credentials.accessToken).toBe(FRESH_TOKEN);
    const persisted = statements.find((sql) => sql.includes("RETURNING id"));
    // Asserted on the statement's own text because this fake dispatches on SQL
    // rather than executing it. Both halves matter and only one is about the
    // gate: no status is written at all, and the row must not be resurrected
    // from `disabled`.
    expect(persisted).not.toContain("SET status");
    expect(persisted).not.toContain("error_json");
    expect(persisted).toContain("status <> 'disabled'");
  });

  it("refreshes an expiring credential before the operation reaches the provider", async () => {
    const refreshCredentials = vi.fn(async () => ({
      accessToken: FRESH_TOKEN,
      refreshToken: "next-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const secret = "door-credential-key";
    const connection = connectionContext({
      accessToken: STALE_TOKEN,
      refreshToken: "refresh-token",
      expiresAt: EXPIRED_AT,
    });
    const database = credentialDatabase(await encryptString(
      JSON.stringify(connection.credentials),
      secret,
      connection.id,
    ));
    const seen: unknown[] = [];

    await withAuthorizedConnection(
      { DB: database.d1, CONNECTOR_CREDENTIALS_KEY: secret, CONNECTOR_CREDENTIALS_KEY_VERSION: "1" },
      {
        connection,
        adapter: { refreshCredentials } satisfies CredentialRefreshAdapter,
        signal: AbortSignal.timeout(2_000),
      },
      async (authorized) => { seen.push(authorized.credentials.accessToken); },
    );

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([FRESH_TOKEN]);
  });

  it("leaves a credential with remaining validity untouched", async () => {
    const refreshCredentials = vi.fn(async () => ({ accessToken: FRESH_TOKEN }));
    const connection = connectionContext({
      accessToken: STALE_TOKEN,
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await withAuthorizedConnection(
      {
        DB: unusableDatabase(),
        CONNECTOR_CREDENTIALS_KEY: "door-credential-key",
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      },
      {
        connection,
        adapter: { refreshCredentials } satisfies CredentialRefreshAdapter,
        signal: AbortSignal.timeout(2_000),
      },
      async () => undefined,
    );

    expect(refreshCredentials).not.toHaveBeenCalled();
  });

  it("refreshes a connection the row believes is broken", async () => {
    // The status is a record of one past moment and nothing re-checks it, so a
    // stale `needs_reconnect` must not decide whether the provider is asked.
    // Gated on a healthy row, this refusal was itself the outage: a Slack
    // installation answered sixteen hours of events with
    // `Connector authorization is unavailable` without one call to Slack.
    const refreshCredentials = vi.fn(async () => ({ accessToken: FRESH_TOKEN }));
    const reached: unknown[] = [];

    await withAuthorizedConnection(
      {
        DB: leasedCredentialDatabase(await encryptString(
          JSON.stringify({ accessToken: STALE_TOKEN, refreshToken: "refresh-token", expiresAt: EXPIRED_AT }),
          "door-credential-key",
          "00000000-0000-7000-8000-00000000c0de",
        ), "door-credential-key"),
        CONNECTOR_CREDENTIALS_KEY: "door-credential-key",
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      },
      {
        connection: connectionContext({
          accessToken: STALE_TOKEN,
          refreshToken: "refresh-token",
          expiresAt: EXPIRED_AT,
        }),
        adapter: { refreshCredentials } satisfies CredentialRefreshAdapter,
        signal: AbortSignal.timeout(2_000),
      },
      async (authorized) => { reached.push(authorized.credentials.accessToken); },
    );

    expect(refreshCredentials).toHaveBeenCalled();
    expect(reached).toEqual([FRESH_TOKEN]);
  });

  it("redeems a rotating refresh token once when concurrent calls are both refused", async () => {
    // A rotating refresh token is single-use. Two calls refused at the same
    // moment must not each redeem it, or the loser's `invalid_grant` marks a
    // connection that was just rotated successfully as needing reconnection.
    const secret = "door-credential-key";
    const stale = { accessToken: STALE_TOKEN, refreshToken: "single-use-token" };
    const database = leasedCredentialDatabase(await encryptString(
      JSON.stringify(stale),
      secret,
      "00000000-0000-7000-8000-00000000c0de",
    ), secret);
    const refreshCredentials = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: FRESH_TOKEN, refreshToken: "next-single-use-token" };
    });
    const adapter = { refreshCredentials } satisfies CredentialRefreshAdapter;
    const env = {
      DB: database,
      CONNECTOR_CREDENTIALS_KEY: secret,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    };

    const call = async () => {
      let refused = false;
      return withAuthorizedConnection(
        env,
        { connection: connectionContext({ ...stale }), adapter, signal: AbortSignal.timeout(5_000) },
        (authorized) => withProviderReauthorization(
          authorized,
          {
            refresh: async () => { throw new Error("the door's serialized rotation must be preferred"); },
            isRejection: () => true,
            signal: AbortSignal.timeout(5_000),
          },
          async () => {
            if (!refused) {
              refused = true;
              throw new ConnectorError("unauthorized", "refused", { status: 401 });
            }
            return authorized.credentials.accessToken;
          },
        ),
      );
    };

    await expect(Promise.all([call(), call()])).resolves.toEqual([FRESH_TOKEN, FRESH_TOKEN]);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
  });

  it("marks a connection the provider refuses mid-operation for reconnect", async () => {
    const statements: string[] = [];
    const database = createTestD1Database({
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind() { return this; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
    });

    await expect(withAuthorizedConnection(
      { DB: database, CONNECTOR_CREDENTIALS_KEY: "k", CONNECTOR_CREDENTIALS_KEY_VERSION: "1" },
      {
        connection: connectionContext({ accessToken: STALE_TOKEN }),
        adapter: {} satisfies CredentialRefreshAdapter,
        signal: AbortSignal.timeout(2_000),
      },
      async () => {
        throw new ConnectorError("unauthorized", "revoked", {
          reconnectRequired: true,
          reason: "invalid_grant",
        });
      },
    )).rejects.toMatchObject({ code: "unauthorized", details: { reason: "invalid_grant" } });

    expect(statements.some((sql) => sql.includes("status = 'needs_reconnect'"))).toBe(true);
  });
});

describe("plugin revalidation verdicts", () => {
  const frozen = {
    pluginId: "connection:00000000-0000-7000-8000-00000000c0de",
    connectionId: "00000000-0000-7000-8000-00000000c0de",
    workspaceId: "00000000-0000-7000-8000-00000000ffff",
    connectorType: "granola",
  } satisfies PluginAuthorizationConnection;
  const input = {
    workspaceId: asWorkspaceId(frozen.workspaceId),
    parentId: asWorkstreamId("2e9f476e-8502-4b18-81ac-b89a75a0708e"),
    harnessRunId: asHarnessRunId("11c13ad0-a0c5-48ce-8479-061edb98e886"),
  } satisfies PluginAuthorizationInput;

  function recordingEnv() {
    const statements: string[] = [];
    return {
      statements,
      env: createTestEnv({
        DB: createTestD1Database({
          prepare(sql: string) {
            statements.push(sql);
            return { bind() { return this; }, async run() { return { success: true, meta: { changes: 1 } }; } };
          },
        }),
        LOG_LEVEL: "error",
      }),
    };
  }

  it("records a denial the adapter reported rather than threw", async () => {
    // Granola and Slack answer a refused credential with `{ ok: false,
    // reconnectRequired: true }` instead of throwing, so the credential door's
    // error path never sees it. Nothing else writes the verdict down.
    const { env, statements } = recordingEnv();

    await expect(__integrationTesting.pluginAuthorizationFromHealth(
      env,
      input,
      frozen,
      { ok: false, message: "Granola authorization was revoked", reconnectRequired: true },
    )).resolves.toBe("denied");

    expect(statements.some((sql) => sql.includes("status = 'needs_reconnect'"))).toBe(true);
  });

  it("leaves the connection alone when the check could not reach a decision", async () => {
    const { env, statements } = recordingEnv();

    await expect(__integrationTesting.pluginAuthorizationFromHealth(
      env,
      input,
      frozen,
      { ok: false, message: "TwitterAPI.io has no remaining credits" },
    )).resolves.toBe("indeterminate");

    // An unhealthy result that says nothing about authority must not take a
    // working connection out of the desktop.
    expect(statements.some((sql) => sql.includes("needs_reconnect"))).toBe(false);
  });

  it("authorizes a healthy connection without writing anything", async () => {
    const { env, statements } = recordingEnv();

    await expect(__integrationTesting.pluginAuthorizationFromHealth(
      env,
      input,
      frozen,
      { ok: true, message: "healthy" },
    )).resolves.toBe("authorized");

    expect(statements).toEqual([]);
  });
});

describe("refresh rejection classification", () => {
  it("marks a grant dead only when the provider says so", async () => {
    // A token endpoint answers both a revoked grant and Avalon's own malformed
    // request with HTTP 400. Classifying on status alone told members to
    // reconnect healthy accounts over our bugs.
    // Three answers, not two. A code naming a dead grant marks; a code naming
    // Avalon's own fault does not, whatever the status; anything else defers to
    // the status, because an unfamiliar word is not evidence.
    const revoked = new ConnectorError("provider_error", "bad", { status: 400, providerError: "invalid_grant" });
    const ourFault = new ConnectorError("provider_error", "bad", { status: 400, providerError: "invalid_request" });
    const badClient = new ConnectorError("unauthorized", "bad", { status: 401, providerError: "invalid_client" });

    expect(isRevokedGrantError(revoked)).toBe(true);
    expect(isRevokedGrantError(ourFault)).toBe(false);
    expect(isRevokedGrantError(badClient)).toBe(false);
    // Envelope shapes are flattened into `providerError` before this layer
    // sees them; the `it.each` below is what covers those.
    //
    // An unrecognized code falls through to the status test rather than
    // answering "not a rejection". A provider spelling a dead grant in a word
    // this list has not learned would otherwise leave the connection healthy,
    // failing every call and prompting nobody.
    const unfamiliar = new ConnectorError("provider_error", "bad", { status: 400, providerError: "grant_expunged" });
    expect(isRevokedGrantError(unfamiliar)).toBe(true);
    // With no code at all the same status test stands.
    expect(isRevokedGrantError(new ConnectorError("unauthorized", "x", { status: 401 }))).toBe(true);
    expect(isRevokedGrantError(new ConnectorError("provider_error", "x", { status: 400 }))).toBe(true);
    expect(isRevokedGrantError(new ConnectorError("provider_error", "x", { status: 500 }))).toBe(false);
  });

  it.each([
    { label: "OAuth `error`", body: { error: "invalid_grant" } },
    { label: "Notion's `code`", body: { object: "error", code: "invalid_grant", message: "bad" } },
    { label: "a nested envelope", body: { error: { code: "invalid_grant" } } },
  ])("carries the provider's error code out of a failed request: $label", async ({ body }) => {
    const fetcher = (async () => Response.json(body, { status: 400 })) as typeof fetch;
    await expect(providerJson(fetcher, "https://provider.test/token", { method: "POST" }))
      .rejects.toMatchObject({ details: { status: 400, providerError: "invalid_grant" } });
  });
});

describe("what a failed refresh does to the row", () => {
  // The predicate was right in both cases the host got wrong, so these assert
  // the outcome — is the connection marked? — rather than a boolean.
  function refreshFailingWith(error: unknown): Promise<string[]> {
    return doorStatementsForFailedRefresh(
      { refreshCredentials: async () => { throw error; } } satisfies CredentialRefreshAdapter,
      { accessToken: STALE_TOKEN, refreshToken: "refresh-token" },
    );
  }

  it("marks the connection when the provider refused the grant", async () => {
    const statements = await refreshFailingWith(new ConnectorError("unauthorized", "revoked", {
      status: 400,
      providerError: "invalid_grant",
      reconnectRequired: true,
    }));
    expect(statements.some((sql) => sql.includes("status = 'needs_reconnect'"))).toBe(true);
  });

  it("leaves it alone when the failure was Avalon's own request", async () => {
    // `invalid_client` is our configuration being wrong. No member fixes that
    // by reconnecting an account that still works.
    const statements = await refreshFailingWith(new ConnectorError("unauthorized", "bad client", {
      status: 401,
      providerError: "invalid_client",
    }));
    expect(statements.some((sql) => sql.includes("needs_reconnect"))).toBe(false);
  });

  it("still marks the connection when the adapter stated no verdict at all", async () => {
    // The safe default. Requiring the flag made forgetting it strand a
    // connection: healthy row, plugin dropped from every run, nobody prompted.
    // With nothing stated, the provider's own code decides.
    const statements = await refreshFailingWith(new ConnectorError("unauthorized", "revoked", {
      status: 400,
      providerError: "invalid_grant",
    }));
    expect(statements.some((sql) => sql.includes("status = 'needs_reconnect'"))).toBe(true);
  });

  it("marks an unclassifiable refusal rather than leaving it silent", async () => {
    const statements = await refreshFailingWith(new ConnectorError("unauthorized", "no", { status: 401 }));
    expect(statements.some((sql) => sql.includes("status = 'needs_reconnect'"))).toBe(true);
  });

  it("believes an adapter that says the grant is not the problem", async () => {
    const statements = await refreshFailingWith(new ConnectorError("unauthorized", "transient", {
      status: 401,
      reconnectRequired: false,
    }));
    expect(statements.some((sql) => sql.includes("needs_reconnect"))).toBe(false);
  });
});

/**
 * The other half of the freshness guarantee. The door refreshing is worth
 * nothing if a refresh the provider refuses leaves the row `healthy`: the
 * plugin is dropped from every run, no member is ever prompted, and only
 * somebody happening to press Test recovers it. Registry-driven for the same
 * reason as the recovery suite — a connector added later is enrolled by
 * existing, not by someone remembering.
 */
describe("adapter conformance: a revoked grant reaches the row", () => {
  const registry = conformanceRegistry(revokedGrantFetch);
  const adapters = registry.list()
    .map((manifest) => ({ type: manifest.type, adapter: registry.get(manifest.type) }))
    .filter(({ adapter }) => adapter.refreshCredentials);

  it("covers every adapter that can refresh a credential", () => {
    expect(adapters.map(({ type }) => type).sort())
      .toEqual(["github", "google", "granola", "linear", "notion", "slack"]);
  });

  for (const { type, adapter } of adapters) {
    it(`${type} leaves no connection reporting healthy after its grant is revoked`, async () => {
      const fixture = CREDENTIAL_FIXTURES[type];
      if (!fixture) throw new Error(`Add a credential fixture for the ${type} connector`);
      const statements = await doorStatementsForFailedRefresh(
        adapter,
        fixture.credentials,
        fixture.scope,
      );
      expect(statements.some((sql) => sql.includes("status = 'needs_reconnect'"))).toBe(true);
    });
  }

  it("does not mark a connection when the token endpoint faulted Avalon's own request", async () => {
    // The counterpart the suite above cannot express, since it revokes every
    // grant. GitHub is the case that had it backwards: it reported a token
    // failure as HTTP 200 with an `error` body and marked every one of them
    // `reconnectRequired`, so an `invalid_client` of ours sent members to
    // reconnect accounts that worked.
    const registry = conformanceRegistry((async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return url.pathname.endsWith("/access_token")
        ? Response.json({ error: "invalid_client", error_description: "wrong secret" })
        : Response.json({ ok: true });
    }) as typeof fetch);
    const statements = await doorStatementsForFailedRefresh(
      registry.get("github"),
      CREDENTIAL_FIXTURES.github!.credentials,
      "personal",
    );
    expect(statements.some((sql) => sql.includes("needs_reconnect"))).toBe(false);
  });
});

/**
 * Drives an expired credential through the door and returns every statement the
 * door issued, so a test can ask what the refusal did to the row.
 */
async function doorStatementsForFailedRefresh(
  adapter: CredentialRefreshAdapter,
  credentials: Record<string, unknown>,
  scope: "personal" | "workspace" = "workspace",
): Promise<string[]> {
  const statements: string[] = [];
  const secret = "coordinator-key";
  const connection = connectionContext({ ...credentials, expiresAt: EXPIRED_AT }, scope);
  const encrypted = await encryptString(JSON.stringify(connection.credentials), secret, connection.id);
  const database = createTestD1Database({
    prepare(sql: string) {
      statements.push(sql.replace(/\s+/gu, " ").trim());
      return {
        bind() { return this; },
        async first() {
          return sql.includes("credential_refresh_lease_id = ?")
            ? {
                encrypted_credentials: encrypted.ciphertext,
                credential_iv: encrypted.iv,
                credential_key_version: 1,
              }
            : null;
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
    },
  });

  await expect(withAuthorizedConnection(
    { DB: database, CONNECTOR_CREDENTIALS_KEY: secret, CONNECTOR_CREDENTIALS_KEY_VERSION: "1" },
    { connection, adapter, signal: AbortSignal.timeout(5_000) },
    async () => undefined,
  )).rejects.toBeDefined();
  return statements;
}

describe("repairing a connection under test", () => {
  const identity = { connectionId: "connection", connectorType: "granola" };
  const connection = authorizedConnection(connectionContext({}, "workspace"));
  const env = { LOG_LEVEL: "error" } as never;

  it("reports what a successful repair did", async () => {
    const adapter = { repair: async () => ({ repaired: true, message: "Re-enabled the webhook" }) };
    await expect(__connectionServiceTesting.attemptConnectorRepair(env, adapter, connection, identity))
      .resolves.toBe("Re-enabled the webhook");
  });

  it("says nothing when there was nothing to repair", async () => {
    const adapter = { repair: async () => ({ repaired: false }) };
    await expect(__connectionServiceTesting.attemptConnectorRepair(env, adapter, connection, identity))
      .resolves.toBeNull();
    await expect(__connectionServiceTesting.attemptConnectorRepair(env, {}, connection, identity))
      .resolves.toBeNull();
  });

  it("reports a failed repair without failing the test", async () => {
    // The health check that follows is still the answer being asked for, so
    // this must not throw — but a connection whose delivery is still broken
    // must not read the same as one that was fixed.
    const adapter = { repair: async () => { throw new Error("Granola refused the PATCH"); } };
    await expect(__connectionServiceTesting.attemptConnectorRepair(env, adapter, connection, identity))
      .resolves.toBe("A repair was attempted and failed: Granola refused the PATCH");
  });
});

describe("provider writes", () => {
  it("keeps the Granola webhook repair out of the health check", async () => {
    // A health check runs on every plugin activation. Re-enabling a webhook is
    // a write, and it belongs to an explicit connection test instead.
    const methods: string[] = [];
    const registry = createConnectorRegistry({
      granola: {
        redirectUri: "https://api.example.com/connections/granola/callback",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          methods.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
          return Response.json({
            notes: [],
            webhook_endpoints: [{ id: "whe_00000000000000", enabled: false }],
          });
        }) as typeof fetch,
      },
    });
    const adapter = registry.get("granola");
    const connection = authorizedConnection(connectionContext(
      { apiKey: "grn_workspace-key", webhookEndpointId: "whe_00000000000000" },
      "workspace",
    ));

    // Reported, not repaired, and not failed: reads still work, so the
    // connection stays loadable while the condition is visible.
    await expect(adapter.healthCheck(connection, AbortSignal.timeout(5_000)))
      .resolves.toMatchObject({ ok: true, message: expect.stringContaining("webhook endpoint is disabled") });
    expect(methods.some((call) => call.startsWith("PATCH"))).toBe(false);

    methods.length = 0;
    await expect(adapter.repair!(connection, AbortSignal.timeout(5_000)))
      .resolves.toMatchObject({ repaired: true });
    expect(methods.some((call) => call.startsWith("PATCH"))).toBe(true);
  });
});

describe("revalidation between model turns", () => {
  it("answers from Avalon's own records without calling the provider", async () => {
    // `reauthorizeActive` runs before every inference, so a provider round trip
    // here costs one call per active plugin per turn. Everything this check
    // exists to catch — a revoked grant, a removed member, an archived work
    // stream, a connection marked unhealthy — is already in D1.
    const statements: string[] = [];
    const database = createTestD1Database({
      prepare(sql: string) {
        statements.push(sql.replace(/\s+/gu, " ").trim().slice(0, 60));
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("FROM workspace_members")) return { status: "active" };
            if (sql.includes("FROM connector_connections")) {
              return {
                id: FROZEN.connectionId,
                workspace_id: FROZEN.workspaceId,
                connector_type: "granola",
                scope: "personal",
                owner_user_id: OWNER,
                granted_scopes_json: JSON.stringify(["granola.personal.read"]),
                encrypted_credentials: "ciphertext",
                credential_iv: "iv",
                cursor_json: "{}",
                config_json: "{}",
                status: "healthy",
              };
            }
            return null;
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
    });
    const fetcher = vi.fn(async () => new Response("{}"));
    // The archive gate is the work stream's own authority, not a row in D1.
    const objectStore = testWorkstreamObjectStore();
    openStores.push(objectStore);
    seedWorkstreamObjectRoot(objectStore, {
      workstreamId: "2e9f476e-8502-4b18-81ac-b89a75a0708e",
      workspaceId: FROZEN.workspaceId,
    });

    await expect(__integrationTesting.reauthorizeFrozenPlugin(
      {
        DB: database,
        SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
        AVALON_REGION: "global",
        CONNECTOR_CREDENTIALS_KEY: "k",
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
        TWITTER_API_IO_API_KEY: "k",
        fetch: fetcher,
      } as never,
      {
        workspaceId: FROZEN.workspaceId,
        workstreamId: "2e9f476e-8502-4b18-81ac-b89a75a0708e",
        harnessRunId: "11c13ad0-a0c5-48ce-8479-061edb98e886",
        executionPrincipal: { type: "user", userId: OWNER },
      } as never,
      FROZEN as never,
      AbortSignal.timeout(2_000),
      "continuation",
    )).resolves.toBe("authorized");

    expect(fetcher).not.toHaveBeenCalled();
    // Nothing was decrypted either: the credentials are not needed to answer.
    expect(statements.some((sql) => sql.includes("encrypted_credentials = ?"))).toBe(false);
  });
});

describe("continuation revalidation respects its deadline", () => {
  it("does not answer authorized when the deadline fires while D1 is answering", async () => {
    const controller = new AbortController();
    const database = createTestD1Database({
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("FROM workspace_members")) return { status: "active" };
            if (sql.includes("FROM workstreams")) {
              return { archived_at: null, automation_subscription_id: null, automation_run_id: null };
            }
            if (sql.includes("FROM connector_connections")) {
              // Every authority check passes, and the deadline lands while the
              // last of them is being answered — after the branch's own first
              // check has already gone by.
              controller.abort();
              return {
                id: FROZEN.connectionId,
                workspace_id: FROZEN.workspaceId,
                connector_type: "granola",
                scope: "personal",
                owner_user_id: OWNER,
                granted_scopes_json: JSON.stringify(["granola.personal.read"]),
                encrypted_credentials: "ciphertext",
                credential_iv: "iv",
                cursor_json: "{}",
                config_json: "{}",
                status: "healthy",
              };
            }
            return null;
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
    });

    await expect(__integrationTesting.reauthorizeFrozenPlugin(
      { DB: database } as never,
      {
        workspaceId: FROZEN.workspaceId,
        workstreamId: "2e9f476e-8502-4b18-81ac-b89a75a0708e",
        harnessRunId: "11c13ad0-a0c5-48ce-8479-061edb98e886",
        executionPrincipal: { type: "user", userId: OWNER },
      } as never,
      FROZEN as never,
      controller.signal,
      "continuation",
    )).resolves.toBe("indeterminate");
  });

  it("does not answer authorized once the run has been aborted", async () => {
    const aborted = AbortSignal.abort();
    await expect(__integrationTesting.reauthorizeFrozenPlugin(
      { DB: { prepare() { throw new Error("D1 must not be read after the deadline"); } } } as never,
      {
        workspaceId: FROZEN.workspaceId,
        workstreamId: "2e9f476e-8502-4b18-81ac-b89a75a0708e",
        harnessRunId: "11c13ad0-a0c5-48ce-8479-061edb98e886",
        executionPrincipal: { type: "user", userId: OWNER },
      } as never,
      FROZEN as never,
      aborted,
      "continuation",
    )).resolves.toBe("indeterminate");
  });
});

const OWNER = "00000000-0000-7000-8000-00000000a11e";
const FROZEN = {
  pluginId: "connection:00000000-0000-7000-8000-00000000c0de",
  connectionId: "00000000-0000-7000-8000-00000000c0de",
  workspaceId: "00000000-0000-7000-8000-00000000ffff",
  connectorType: "granola",
  scope: "personal" as const,
  ownerUserId: OWNER,
  grantedScopes: ["granola.personal.read"],
  shortWireName: "granola",
  modelPluginId: "plugin_granola",
};

/**
 * The credential a run starts with can still be rejected while the call is in
 * flight — a token revoked seconds ago, a provider expiring it early, a clock
 * that disagrees. Freshness at the door is therefore necessary but not
 * sufficient, and every adapter has to recover from a mid-call 401 by
 * refreshing and retrying rather than reporting a revoked grant.
 */
describe("adapter conformance: recovery from a rejected credential", () => {
  const registry = conformanceRegistry();
  const adapters = registry.list()
    .map((manifest) => ({ type: manifest.type, adapter: registry.get(manifest.type) }))
    .filter(({ adapter }) => adapter.refreshCredentials);

  it("covers every adapter that can refresh a credential", () => {
    expect(adapters.map(({ type }) => type).sort())
      .toEqual(["github", "google", "granola", "linear", "notion", "slack"]);
  });

  for (const { type, adapter } of adapters) {
    it(`${type} refreshes and retries when the provider rejects its token`, async () => {
      const fixture = CREDENTIAL_FIXTURES[type];
      if (!fixture) throw new Error(`Add a credential fixture for the ${type} connector`);
      const authorizations: string[] = [];
      conformanceFetch.configure(authorizations);
      // Registering the host's rotation is what tells a retry that went through
      // the door from one an adapter performed beside it. Asserting only that a
      // retry happened passes an adapter that redeems the stored refresh token
      // privately, which is the race the door exists to close.
      // Rotates whichever key this provider keeps its token under, without the
      // fixture having to name it.
      const rotate = vi.fn(async (refused: Record<string, unknown>) => Object.fromEntries(
        Object.entries(refused).map(([key, value]) => [key, value === STALE_TOKEN ? FRESH_TOKEN : value]),
      ));
      const connection = connectionContext(
        { ...fixture.credentials, expiresAt: "2099-01-01T00:00:00.000Z" },
        fixture.scope,
      );

      const health = await adapter.healthCheck(
        authorizedConnection(connection, rotate),
        AbortSignal.timeout(5_000),
      );

      if (authorizations.length === 0) {
        // Nothing was rejected because nothing was presented: this adapter's
        // health check does not authenticate with the connection's expiring
        // credential. The exemption is declared in the table rather than
        // inferred here, so an adapter that starts sending one fails until
        // somebody revisits this row.
        expect(fixture.presentsExpiringCredential).toBe(false);
        return;
      }

      // The provider rejected the stale token; the adapter must have obtained a
      // new one and repeated the call rather than surfacing the rejection.
      expect(authorizations.some((value) => value.includes(STALE_TOKEN))).toBe(true);
      expect(authorizations.some((value) => value.includes(FRESH_TOKEN))).toBe(true);
      expect(health.reconnectRequired ?? false).toBe(false);
      expect(rotate).toHaveBeenCalledTimes(1);
    });
  }
});

describe("credential rejection", () => {
  it("does not rotate over an authorization failure that never reached the provider", async () => {
    // Adapters raise `unauthorized` for policy and configuration failures too —
    // a tool invoked without its invocation token, an event from another
    // workspace. Rotating a single-use refresh token over one of those buys a
    // retry that fails identically.
    const refresh = vi.fn(async () => ({ accessToken: FRESH_TOKEN }));
    const connection = connectionContext({ accessToken: STALE_TOKEN, refreshToken: "refresh-token" });

    await expect(withProviderReauthorization(
      connection,
      {
        refresh,
        isRejection: (error) => isProviderCredentialRejection(
          error,
          (details) => details.status === 401,
        ),
        signal: AbortSignal.timeout(2_000),
      },
      async () => { throw new ConnectorError("unauthorized", "Slack event belongs to a different app"); },
    )).rejects.toThrow(/different app/u);

    expect(refresh).not.toHaveBeenCalled();
  });
});

/**
 * Credentials are shaped per provider, so the token key each adapter reads is
 * the one thing this table has to state. Everything else about the exchange —
 * the rejection, the token endpoint, the retry — is provider-neutral.
 */
const CREDENTIAL_FIXTURES: Record<string, {
  scope: "personal" | "workspace";
  credentials: Record<string, unknown>;
  /**
   * Whether this adapter's health check presents the connection's expiring
   * credential to the provider. Notion's introspects a token in the request
   * body under the integration's own client credentials, so its health check
   * has no bearer to have rejected.
   */
  presentsExpiringCredential: boolean;
}> = {
  google: {
    presentsExpiringCredential: true,
    scope: "workspace",
    credentials: { accessToken: STALE_TOKEN, refreshToken: "refresh-token" },
  },
  granola: {
    presentsExpiringCredential: true,
    scope: "personal",
    credentials: {
      accessToken: STALE_TOKEN,
      refreshToken: "refresh-token",
      tokenEndpoint: "https://auth.granola.test/token",
      clientId: "granola-client",
      tokenEndpointAuthMethod: "none",
      resource: "https://mcp.granola.test/mcp",
      tokenScope: "mcp offline_access",
    },
  },
  github: {
    presentsExpiringCredential: true,
    scope: "personal",
    credentials: { accessToken: STALE_TOKEN, refreshToken: "refresh-token" },
  },
  linear: {
    presentsExpiringCredential: true,
    scope: "personal",
    credentials: { accessToken: STALE_TOKEN, refreshToken: "refresh-token" },
  },
  notion: {
    presentsExpiringCredential: false,
    scope: "workspace",
    credentials: { accessToken: STALE_TOKEN, refreshToken: "refresh-token" },
  },
  slack: {
    presentsExpiringCredential: true,
    // The personal surface is the one whose token rotates. A workspace health
    // check additionally inventories bot scopes, which is a separate concern
    // from the credential exchange under test here.
    scope: "personal",
    credentials: { userAccessToken: STALE_TOKEN, refreshToken: "refresh-token" },
  },
};

/**
 * One provider-neutral stub: any request bearing the stale token is rejected,
 * any token-grant request mints the fresh one, and any request bearing the
 * fresh token succeeds. What each adapter asks for after the rejection is its
 * own business; that it asks at all is the property under test.
 */
const conformanceFetch = (() => {
  let authorizations: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");

    if (body.includes("grant_type=refresh_token") || url.pathname.endsWith("/token")) {
      return Response.json({
        access_token: FRESH_TOKEN,
        token_type: "Bearer",
        expires_in: 3_600,
        refresh_token: "next-refresh-token",
        // Slack and GitHub read their own token names off the same grant.
        authed_user: { access_token: FRESH_TOKEN },
        bot_access_token: FRESH_TOKEN,
        ok: true,
      });
    }

    const authorization = headers.get("authorization") ?? "";
    // Only a bearer credential is under test. Notion introspects a token in
    // the request body using the integration's own client credentials, which
    // is not the exchange this suite is about.
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return Response.json({ ok: true, active: true, bot: {} });
    }
    authorizations.push(authorization);
    if (authorization.includes(STALE_TOKEN)) {
      // Slack answers HTTP 200 with an error code; everyone else uses 401.
      // Both mean the same thing, and an adapter has to recover from its own.
      return url.hostname.endsWith("slack.com")
        ? Response.json({ ok: false, error: "token_expired" })
        : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    // A generous success body: every health check reads a different field, and
    // this stub is deliberately ignorant of which.
    return Response.json({
      ok: true,
      active: true,
      id: "provider-identity",
      repositories: [],
      data: { viewer: { id: "provider-identity" } },
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "stub" },
        tools: [{ name: "get_account_info", inputSchema: { type: "object", properties: {} } }],
        content: [{ text: JSON.stringify({ email: "person@example.com", workspace: { id: "w", name: "W" } }) }],
      },
      jsonrpc: "2.0",
    });
  }) as typeof fetch;
  return {
    fetcher,
    configure(sink: string[]) { authorizations = sink; },
  };
})();

/**
 * A token endpoint that has revoked every grant, in each provider's own idiom.
 * Two of the six never send a status a caller could classify on: Slack answers
 * HTTP 200 with `{ok: false, error}` and GitHub answers HTTP 200 with
 * `{error}`, which is the whole reason the adapter, not the host, has to be
 * the one that says the grant is gone. The RFC-abiding adapters answer 400
 * with `invalid_grant`. Non-token requests still succeed, so the refresh is
 * the only thing that can fail.
 */
const revokedGrantFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
  if (body.includes("grant_type=refresh_token") || url.pathname.endsWith("/token")) {
    if (url.hostname.endsWith("slack.com")) return Response.json({ ok: false, error: "token_revoked" });
    if (url.hostname.endsWith("github.com")) return Response.json({ error: "bad_refresh_token" });
    return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
  }
  return Response.json({ ok: true, active: true });
}) as typeof fetch;

function conformanceRegistry(fetchOverride?: typeof fetch) {
  const fetcher = fetchOverride ?? conformanceFetch.fetcher;
  return createConnectorRegistry({
    granola: {
      redirectUri: "https://api.example.com/connections/granola/callback",
      mcpUrl: "https://mcp.granola.test/mcp",
      fetch: fetcher,
    },
    google: {
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "https://api.example.com/connections/google/callback",
      fetch: fetcher,
    },
    github: {
      appId: "1",
      clientId: "github-client",
      clientSecret: "github-secret",
      privateKey: GITHUB_TEST_PRIVATE_KEY,
      webhookSecret: "github-webhook-secret",
      redirectUri: "https://api.example.com/connections/github/callback",
      fetch: fetcher,
    },
    linear: {
      clientId: "linear-client",
      clientSecret: "linear-secret",
      redirectUri: "https://api.example.com/connections/linear/callback",
      fetch: fetcher,
    },
    notion: {
      clientId: "notion-client",
      clientSecret: "notion-secret",
      redirectUri: "https://api.example.com/connections/notion/callback",
      fetch: fetcher,
    },
    slack: {
      clientId: "slack-client",
      clientSecret: "slack-secret",
      signingSecret: "slack-signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    },
  });
}

function connectionContext(
  credentials: Record<string, unknown>,
  scope: "personal" | "workspace" = "workspace",
): ConnectorConnectionContext {
  return {
    id: "00000000-0000-7000-8000-00000000c0de",
    workspaceId: "00000000-0000-7000-8000-00000000ffff",
    scope,
    ownerUserId: scope === "personal" ? "00000000-0000-7000-8000-00000000a11e" : null,
    grantedScopes: [],
    credentials: { ...credentials },
    cursor: {},
    config: {},
  };
}

function credentialDatabase(encrypted: { ciphertext: string; iv: string }) {
  const row = { ...encrypted, leaseId: null as string | null };
  const d1 = createTestD1Database({
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes("credential_refresh_lease_id = ?")) {
                row.leaseId = String(values[0]);
                return {
                  encrypted_credentials: row.ciphertext,
                  credential_iv: row.iv,
                  credential_key_version: 1,
                };
              }
              if (sql.includes("RETURNING id")) return { id: "connection" };
              return null;
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
        },
      };
    },
  });
  return { d1 };
}

/**
 * Models the one part of D1 the rotation coordinator depends on: a lease only
 * one caller can hold, and a credential blob that changes when the holder
 * rotates it. Everything else is a no-op.
 */
function leasedCredentialDatabase(
  encrypted: { ciphertext: string; iv: string },
  secret: string,
): D1Database {
  const row = { ...encrypted, leaseId: null as string | null };
  void secret;
  return createTestD1Database({
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes("credential_refresh_lease_id = ?, credential_refresh_lease_expires_at = ?")) {
                if (row.leaseId) return null;
                row.leaseId = String(values[0]);
                return {
                  encrypted_credentials: row.ciphertext,
                  credential_iv: row.iv,
                  credential_key_version: 1,
                };
              }
              if (sql.includes("SELECT encrypted_credentials")) {
                return {
                  encrypted_credentials: row.ciphertext,
                  credential_iv: row.iv,
                  credential_key_version: 1,
                };
              }
              if (sql.includes("RETURNING id")) {
                if (row.leaseId !== String(values[6])) return null;
                row.ciphertext = String(values[0]);
                row.iv = String(values[1]);
                row.leaseId = null;
                return { id: "connection" };
              }
              return null;
            },
            async run() {
              if (sql.includes("credential_refresh_lease_id = NULL")) row.leaseId = null;
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  });
}

function unusableDatabase(): D1Database {
  return createTestD1Database({
    prepare() { throw new Error("The door must not touch D1 for a credential with remaining validity"); },
  });
}

// The personal GitHub path under test never signs an App JWT, so a
// syntactically shaped placeholder is all the configuration needs. Assembled
// from parts so the repository's secret scan reads it as what it is.
const GITHUB_TEST_PRIVATE_KEY = [
  ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
  "AA==",
  ["-----END", "PRIVATE KEY-----"].join(" "),
].join("\n");

/** `leasedCredentialDatabase`, plus a record of the SQL it was asked to run. */
function recordingLeasedDatabase(
  encrypted: { ciphertext: string; iv: string },
  statements: string[],
): D1Database {
  const inner = leasedCredentialDatabase(encrypted, "door-credential-key");
  return createTestD1Database({
    prepare(sql: string) {
      statements.push(sql);
      return inner.prepare(sql);
    },
  });
}
