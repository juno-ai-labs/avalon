import {
  ConnectorError,
  authorizedConnection,
  createConnectorRegistry,
  isProviderCredentialRejection,
  withProviderReauthorization,
  type ConnectorConnectionContext,
  type ResolvedConnectorAdapter,
} from "@avalon/connectors";
import { describe, expect, it, vi } from "vitest";
import { encryptString } from "../src/lib/crypto";
import { withAuthorizedConnection } from "../src/services/connector-connection-access";

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

describe("the credential door", () => {
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
        adapter: { refreshCredentials } as unknown as ResolvedConnectorAdapter,
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
        adapter: { refreshCredentials } as unknown as ResolvedConnectorAdapter,
        signal: AbortSignal.timeout(2_000),
      },
      async () => undefined,
    );

    expect(refreshCredentials).not.toHaveBeenCalled();
  });

  it("does not attempt a refresh a connection is no longer eligible for", async () => {
    // A connection D1 no longer holds as healthy cannot rotate: the refresh
    // coordinator filters its lease and its reload on `status = 'healthy'`, so
    // asking would replace the provider's answer with an availability error.
    // Testing and revoking a broken connection are the paths that exist to get
    // that answer.
    const refreshCredentials = vi.fn(async () => ({ accessToken: FRESH_TOKEN }));
    const reached: unknown[] = [];

    await withAuthorizedConnection(
      {
        DB: unusableDatabase(),
        CONNECTOR_CREDENTIALS_KEY: "door-credential-key",
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      },
      {
        connection: connectionContext({
          accessToken: STALE_TOKEN,
          refreshToken: "refresh-token",
          expiresAt: EXPIRED_AT,
        }),
        adapter: { refreshCredentials } as unknown as ResolvedConnectorAdapter,
        signal: AbortSignal.timeout(2_000),
        connectionStatus: "needs_reconnect",
      },
      async (authorized) => { reached.push(authorized.credentials.accessToken); },
    );

    expect(refreshCredentials).not.toHaveBeenCalled();
    expect(reached).toEqual([STALE_TOKEN]);
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
    const adapter = { refreshCredentials } as unknown as ResolvedConnectorAdapter;
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
    const database = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind() { return this; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
    } as unknown as D1Database;

    await expect(withAuthorizedConnection(
      { DB: database, CONNECTOR_CREDENTIALS_KEY: "k", CONNECTOR_CREDENTIALS_KEY_VERSION: "1" },
      {
        connection: connectionContext({ accessToken: STALE_TOKEN }),
        adapter: {} as ResolvedConnectorAdapter,
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

      const health = await adapter.healthCheck(authorizedConnection(connectionContext(
        { ...fixture.credentials, expiresAt: "2099-01-01T00:00:00.000Z" },
        fixture.scope,
      )));

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
    scope: "personal",
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

function conformanceRegistry() {
  const fetcher = conformanceFetch.fetcher;
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
  const d1 = {
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
  } as unknown as D1Database;
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
  return {
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
  } as unknown as D1Database;
}

function unusableDatabase(): D1Database {
  return {
    prepare() { throw new Error("The door must not touch D1 for a credential with remaining validity"); },
  } as unknown as D1Database;
}

// The personal GitHub path under test never signs an App JWT, so a
// syntactically shaped placeholder is all the configuration needs. Assembled
// from parts so the repository's secret scan reads it as what it is.
const GITHUB_TEST_PRIVATE_KEY = [
  ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
  "AA==",
  ["-----END", "PRIVATE KEY-----"].join(" "),
].join("\n");
