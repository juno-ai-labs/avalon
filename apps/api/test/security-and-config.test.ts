import "../../../tests/isolated-region";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  createGoogleConnector,
  type ConnectorConnectionContext,
  type ResolvedConnectorAdapter,
} from "@rally/connectors";
import { createApp } from "../src/app";
import { numericEnv } from "../src/env";
import { decryptString, encryptString, hmacSha256, randomToken, timingSafeEqualText } from "../src/lib/crypto";
import { redact } from "../src/observability/logger";
import { AuthService } from "../src/services/auth-service";
import { __connectionServiceTesting } from "../src/services/connection-service";
import { withAuthorizedConnection } from "../src/services/connector-connection-access";
import { __integrationTesting } from "../src/services/integrations";
import {
  isAllowedSocketOrigin,
  issueSocketTicket,
  issueTranscriptionSocketTicket,
  verifySocketTicket,
  verifyTranscriptionSocketTicket,
} from "../src/services/socket-service";
import {
  __realtimeTranscriptionTesting,
  azureRealtimeWebSocketUrl,
  parseTranscriptionClientEvent,
  transcriptionSessionUpdate,
} from "../src/services/realtime-transcription-service";
import { __resourceServiceTesting } from "../src/services/resource-service";
import { memberSafeHarnessError } from "../src/services/workstream-service";
import { createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

describe("API security utilities", () => {
  it("round-trips authenticated encrypted values without exposing plaintext", async () => {
    const secret = randomToken(32);
    const encrypted = await encryptString('{"refreshToken":"sensitive"}', secret);
    expect(encrypted.ciphertext).not.toContain("sensitive");
    await expect(decryptString(encrypted.ciphertext, encrypted.iv, secret)).resolves.toBe(
      '{"refreshToken":"sensitive"}',
    );
  });

  it("binds connector ciphertext to the connection identity", async () => {
    const secret = randomToken(32);
    const encrypted = await encryptString('{"refreshToken":"sensitive"}', secret, "connection-1");
    await expect(
      decryptString(encrypted.ciphertext, encrypted.iv, secret, "connection-1"),
    ).resolves.toBe('{"refreshToken":"sensitive"}');
    await expect(
      decryptString(encrypted.ciphertext, encrypted.iv, secret, "connection-2"),
    ).rejects.toThrow();
  });

  it("creates deterministic HMACs and compares them without early length exits", async () => {
    const first = await hmacSha256("secret", "payload");
    const second = await hmacSha256("secret", "payload");
    expect(timingSafeEqualText(first, second)).toBe(true);
    expect(timingSafeEqualText(first, `${second}x`)).toBe(false);
  });

  it("redacts nested credential-like fields from structured logs", () => {
    expect(
      redact({
        connection: { refreshToken: "secret", displayName: "Google" },
        authorization: "Bearer x",
        prompt: "private instructions",
        emailBody: "private email",
        connectorContent: "private provider data",
        fileContent: "private file",
        modelContext: "private context",
      }),
    ).toEqual({
      connection: { refreshToken: "[REDACTED]", displayName: "Google" },
      authorization: "[REDACTED]",
      prompt: "[REDACTED]",
      emailBody: "[REDACTED]",
      connectorContent: "[REDACTED]",
      fileContent: "[REDACTED]",
      modelContext: "[REDACTED]",
    });
  });

  it("never exposes persisted harness exception or provider detail to members", () => {
    const providerFailure = memberSafeHarnessError(JSON.stringify({
      code: "provider_error",
      message: "OpenRouter rejected sk-secret with upstream body: private",
    }));
    expect(providerFailure).toEqual({
      code: "provider_error",
      message: "A connected service returned an error, so this run stopped",
    });
    expect(JSON.stringify(providerFailure)).not.toContain("sk-secret");

    for (const unsafeValue of [
      JSON.stringify({ code: "attacker-controlled-code", message: "database credentials" }),
      "not-json",
      JSON.stringify({ message: "filesystem path and stack" }),
    ]) {
      expect(memberSafeHarnessError(unsafeValue)).toEqual({
        code: "harness_execution_failed",
        message: "Rally could not complete this run. Retrying is unlikely to help — copy the request ID for support",
      });
    }
    expect(memberSafeHarnessError(null)).toBeNull();
  });

  it("resolves both provider failure codes to their own member-safe sentence", () => {
    // A provider outage and a refused endpoint each get a sentence naming a next
    // action, and neither falls through to the generic bucket — the whole point
    // of adding the codes was that `harness_execution_failed` tells a member
    // Avalon broke and gives them no reason to try again.
    expect(memberSafeHarnessError(JSON.stringify({
      code: "provider_unavailable",
      message: "upstream body that must never be shown",
    }))).toEqual({
      code: "provider_unavailable",
      message: "The model service could not complete this request. This usually clears on its own — try again in a moment",
    });
    expect(memberSafeHarnessError(JSON.stringify({
      code: "provider_circuit_open",
      message: "upstream body that must never be shown",
    }))).toEqual({
      code: "provider_circuit_open",
      message: "Rally has paused requests to this model. Try again shortly — if it keeps happening, copy the request ID for support",
    });
  });

  it("attaches resources with watching off until a canonical watch is activated", () => {
    // The watch upsert itself moved into WorkspaceDO as `enableResourceWatch`;
    // its re-enable behaviour runs for real in
    // `test-workers/workspace-resources-inventory.test.ts` rather than being
    // pinned as source text here.
    // The reader production runs. A second, pre-cutover copy of this query used
    // to carry the same rule and this assertion was pointed at *that* one —
    // which is how a source-text assertion outlives the code it describes.
    const resourceSql = __resourceServiceTesting.resourceWithWatchStateSql.replace(/\s+/gu, " ");
    expect(resourceSql).toContain("rw.enabled = 1");
    expect(resourceSql).not.toContain("next_poll_at");

    const at = "2026-08-01T12:00:00.000Z";
    expect(__resourceServiceTesting.resourceWatchMode({ supportsWatches: true, supportsPolling: true }, at)).toEqual({
      watchType: "incremental",
      nextPollAt: at,
    });
    expect(__resourceServiceTesting.resourceWatchMode({ supportsWatches: true, supportsPolling: false }, at)).toEqual({
      watchType: "webhook",
      nextPollAt: null,
    });
    expect(() => __resourceServiceTesting.resourceWatchMode({ supportsWatches: false, supportsPolling: false }, at))
      .toThrow("This connector does not support resource watches");
  });

  it("preserves offline credentials only for the same stable Google account", () => {
    const existing = {
      id: "connection-1",
      workspace_id: "workspace-1",
      connector_type: "google",
      scope: "personal" as const,
      owner_user_id: "user-1",
      provider_account_id: "google-account-1",
      model_plugin_id: "plugin_google",
    };
    const reconciled = __connectionServiceTesting.reconcileGoogleAccount(
      existing,
      { refreshToken: "offline-token", providerAccountId: "google-account-1" },
      {
        accessToken: "new-access-token",
        providerAccountId: "google-account-1",
        providerAccountEmail: "adam@example.com",
      },
    );
    expect(reconciled).toMatchObject({
      providerAccountId: "google-account-1",
      displayName: "Google · adam@example.com",
      credentials: { refreshToken: "offline-token", accessToken: "new-access-token" },
    });
    expect(() =>
      __connectionServiceTesting.reconcileGoogleAccount(
        existing,
        { refreshToken: "offline-token" },
        { refreshToken: "different", providerAccountId: "google-account-2" },
      )
    ).toThrow(/same Google account/i);
  });

  it("labels each Google capability preset distinctly", () => {
    expect(__connectionServiceTesting.googleConnectionDisplayName(
      ["gmail.read", "calendar.read", "calendar.write"],
      "Google · adam@example.com",
    )).toBe("Google Mail + Calendar · adam@example.com");
    expect(__connectionServiceTesting.googleConnectionDisplayName(
      ["drive.read", "docs.read", "docs.write", "sheets.read", "sheets.write"],
      "Google · adam@example.com",
    )).toBe("Google Drive + Docs + Sheets · adam@example.com");
    expect(__connectionServiceTesting.googleConnectionDisplayName(
      ["gmail.read", "drive.read"],
      "Google · adam@example.com",
    )).toBe("Google Workspace · adam@example.com");
  });

  it("deduplicates approved Google provider scopes and rejects partially granted consent", () => {
    const scopes = __connectionServiceTesting.googleProviderScopesForCapabilities([
      "gmail.read",
      "gmail.draft",
      "gmail.send",
      "calendar.read",
      "calendar.write",
      "docs.read",
      "docs.write",
      "sheets.read",
      "sheets.write",
    ]);
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ]);

    expect(() => __connectionServiceTesting.assertGoogleCapabilitiesGranted(
      ["gmail.read", "calendar.write"],
      { scopes: ["https://www.googleapis.com/auth/gmail.modify"] },
    )).toThrow(/calendar\.write/u);
    expect(() => __connectionServiceTesting.assertGoogleCapabilitiesGranted(
      ["docs.read", "docs.write", "sheets.read", "sheets.write"],
      { scopes: ["https://www.googleapis.com/auth/drive.file"] },
    )).toThrow(/docs\.read, sheets\.read/u);
    expect(() => __connectionServiceTesting.assertGoogleCapabilitiesGranted(
      ["calendar.read", "calendar.write"],
      { scopes: ["https://www.googleapis.com/auth/calendar.events"] },
    )).toThrow(/calendar\.read/u);
    expect(() => __connectionServiceTesting.assertGoogleCapabilitiesGranted(
      ["docs.read", "docs.write"],
      { scopes: ["https://www.googleapis.com/auth/drive"] },
    )).not.toThrow();
    expect(() => __connectionServiceTesting.assertGoogleCapabilitiesGranted(
      [
        "gmail.draft",
        "gmail.send",
        "calendar.read",
        "calendar.write",
        "docs.read",
        "docs.write",
        "sheets.read",
        "sheets.write",
      ],
      {
        scopes: [
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/drive.file",
        ],
      },
    )).not.toThrow();
  });

  it("requires Linear to grant both resource and native-agent permissions", () => {
    expect(() => __connectionServiceTesting.assertLinearCapabilitiesGranted(
      ["linear.read", "linear.agent"],
      { providerScopes: ["read", "app:assignable", "app:mentionable", "write"] },
    )).not.toThrow();
    expect(() => __connectionServiceTesting.assertLinearCapabilitiesGranted(
      ["linear.read", "linear.agent"],
      { providerScopes: ["read", "app:assignable"] },
    )).toThrow(/app:mentionable/u);
    expect(() => __connectionServiceTesting.assertLinearCapabilitiesGranted(
      ["linear.read", "linear.agent"],
      { providerScopes: ["read", "app:assignable", "app:mentionable"] },
    )).toThrow(/write/u);
    expect(() => __connectionServiceTesting.assertLinearCapabilitiesGranted(
      ["linear.issue.create"],
      { providerScopes: ["read"] },
    )).toThrow(/issues:create/u);
  });

  it("keeps Linear native-agent authorization behind the regional runtime gate", () => {
    expect(() => __connectionServiceTesting.assertLinearNativeAgentCapabilityEnabled(
      ["linear.read", "linear.agent"],
      {},
      "protocol_only",
    )).toThrow(/not operational/u);
    expect(() => __connectionServiceTesting.assertLinearNativeAgentCapabilityEnabled(
      ["linear.read", "linear.agent"],
      { LINEAR_NATIVE_AGENT_ENABLED: "true" },
      "protocol_only",
    )).toThrow(/not operational/u);
    expect(() => __connectionServiceTesting.assertLinearNativeAgentCapabilityEnabled(
      ["linear.read", "linear.agent"],
      {},
      "operational",
    )).toThrow(/not enabled/u);
    expect(() => __connectionServiceTesting.assertLinearNativeAgentCapabilityEnabled(
      ["linear.read", "linear.agent"],
      { LINEAR_NATIVE_AGENT_ENABLED: "true" },
      "operational",
    )).not.toThrow();
    expect(() => __connectionServiceTesting.assertLinearNativeAgentCapabilityEnabled(
      ["linear.read"],
      {},
      "protocol_only",
    )).not.toThrow();
  });

  it("keeps Linear native-agent capabilities workspace-owned", () => {
    expect(() => __connectionServiceTesting.assertLinearScopeCapabilities(
      "personal",
      ["linear.read", "linear.agent"],
    )).toThrow(/workspace connection/u);
    expect(() => __connectionServiceTesting.assertLinearScopeCapabilities(
      "personal",
      ["linear.read", "linear.issue.create"],
    )).not.toThrow();
    expect(() => __connectionServiceTesting.assertLinearScopeCapabilities(
      "workspace",
      ["linear.read", "linear.agent"],
    )).not.toThrow();
  });

  it("keeps a personal Linear reconnect bound to the same human identity", () => {
    expect(() => __connectionServiceTesting.assertSameLinearPersonalIdentity(
      { authorizedUserId: "linear-user-1" },
      { authorizedUserId: "linear-user-1" },
    )).not.toThrow();
    expect(() => __connectionServiceTesting.assertSameLinearPersonalIdentity(
      { authorizedUserId: "linear-user-1" },
      { authorizedUserId: "linear-user-2" },
    )).toThrow(/same personal Linear user/u);
    expect(() => __connectionServiceTesting.assertSameLinearPersonalIdentity(
      {},
      {},
    )).toThrow(/personal user identity/u);
  });

  it("keeps a workspace Linear reconnect bound to the same app identity", () => {
    expect(() => __connectionServiceTesting.assertSameLinearWorkspaceIdentity(
      { appUserId: "linear-app-1" },
      { appUserId: "linear-app-1" },
    )).not.toThrow();
    expect(() => __connectionServiceTesting.assertSameLinearWorkspaceIdentity(
      { appUserId: "linear-app-1" },
      { appUserId: "linear-app-2" },
    )).toThrow(/same Linear application identity/u);
  });

  it("recognizes the D1 uniqueness failure used for Linear identity races", () => {
    expect(__connectionServiceTesting.isUniqueConstraintError(
      new Error("D1_ERROR: UNIQUE constraint failed: connector_connections.workspace_id"),
    )).toBe(true);
    expect(__connectionServiceTesting.isUniqueConstraintError(new Error("network unavailable"))).toBe(false);
  });

  it("persists credentials mutated by a reactive connector refresh with connection-bound encryption", async () => {
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const encryptionKey = randomToken(32);
    // A mid-call rejection rotates under the credential-refresh lease, so this
    // stub answers the lease claim and the write-back the coordinator performs.
    const database = createTestD1Database({
      prepare(sql: string) {
        const update = { sql, values: [] as unknown[] };
        return {
          bind(...values: unknown[]) {
            update.values = values;
            return {
              async first() {
                if (sql.includes("credential_refresh_lease_id = ?, credential_refresh_lease_expires_at = ?")) {
                  const encrypted = await encryptString(
                    JSON.stringify({
                      accessToken: "expired-access-token",
                      refreshToken: "offline-refresh-token",
                    }),
                    encryptionKey,
                    String(values[2]),
                  );
                  return {
                    encrypted_credentials: encrypted.ciphertext,
                    credential_iv: encrypted.iv,
                    credential_key_version: 7,
                  };
                }
                if (sql.includes("RETURNING id")) {
                  updates.push(update);
                  return { id: "connection" };
                }
                return null;
              },
              async run() {
                if (sql.includes("encrypted_credentials = ?")) updates.push(update);
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    });
    const connection = connectorContext({
      accessToken: "expired-access-token",
      refreshToken: "offline-refresh-token",
    });
    const requestedTokens: string[] = [];
    const adapter = createGoogleConnector({
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "https://api.example.com/connections/google/callback",
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = String(request);
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({
            access_token: "rotated-access-token",
            expires_in: 3_600,
            token_type: "Bearer",
          });
        }
        if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")) {
          const token = new Headers(init?.headers).get("authorization") ?? "";
          requestedTokens.push(token);
          return token === "Bearer rotated-access-token"
            ? Response.json({ messages: [] })
            : Response.json({ error: "unauthorized" }, { status: 401 });
        }
        throw new Error(`Unexpected Google URL: ${url}`);
      }) as typeof fetch,
    });

    await expect(withAuthorizedConnection(
      {
        DB: database,
        CONNECTOR_CREDENTIALS_KEY: encryptionKey,
        CONNECTOR_CREDENTIALS_KEY_VERSION: "7",
      },
      {
        connection,
        adapter: adapter as ResolvedConnectorAdapter,
        signal: new AbortController().signal,
      },
      (authorized) => adapter.executeTool(
        "gmail.search",
        { query: "from:example.com" },
        {
          connection: authorized,
          principal: { type: "workspace", workspaceId: asWorkspaceId(connection.workspaceId) },
          signal: new AbortController().signal,
        },
      ),
    )).resolves.toMatchObject({ summary: "Found 0 Gmail messages" });

    expect(requestedTokens).toEqual([
      "Bearer expired-access-token",
      "Bearer rotated-access-token",
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toContain("WHERE id = ? AND workspace_id = ?");
    const [ciphertext, iv, keyVersion, , persistedConnectionId, persistedWorkspaceId] = updates[0]!.values;
    expect(keyVersion).toBe(7);
    expect(persistedConnectionId).toBe(connection.id);
    expect(persistedWorkspaceId).toBe(connection.workspaceId);
    expect(String(ciphertext)).not.toContain("rotated-access-token");
    await expect(decryptString(
      String(ciphertext),
      String(iv),
      encryptionKey,
      connection.id,
    )).resolves.toContain("rotated-access-token");
  });

  it("marks revoked connector grants for reconnect and stores only a sanitized reason", async () => {
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const database = createTestD1Database({
      prepare(sql: string) {
        const update = { sql, values: [] as unknown[] };
        updates.push(update);
        return {
          bind(...values: unknown[]) {
            update.values = values;
            return this;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    });
    const connection = connectorContext({
      accessToken: "expired-access-token",
      refreshToken: "must-never-be-persisted-in-an-error",
    });

    await expect(withAuthorizedConnection(
      {
        DB: database,
        CONNECTOR_CREDENTIALS_KEY: randomToken(32),
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      },
      {
        connection,
        adapter: {} as ResolvedConnectorAdapter,
        signal: new AbortController().signal,
      },
      async () => {
        throw new ConnectorError("unauthorized", "Google authorization was revoked", {
          reconnectRequired: true,
          reason: "invalid_grant",
          payload: { refreshToken: "must-never-be-persisted-in-an-error" },
        });
      },
    )).rejects.toMatchObject({
      code: "unauthorized",
      details: { reconnectRequired: true, reason: "invalid_grant" },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toContain("status = 'needs_reconnect'");
    expect(updates[0]!.sql).toContain("WHERE id = ? AND workspace_id = ?");
    const serializedError = String(updates[0]!.values[0]);
    expect(serializedError).toContain("invalid_grant");
    expect(serializedError).not.toContain("must-never-be-persisted-in-an-error");
    expect(updates[0]!.values.slice(-2)).toEqual([connection.id, connection.workspaceId]);
  });
});

function connectorContext(credentials: Record<string, unknown>): ConnectorConnectionContext {
  return {
    id: "00000000-0000-7000-8000-000000000010",
    workspaceId: "00000000-0000-7000-8000-000000000011",
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: ["gmail.read"],
    credentials,
    cursor: {},
    config: {},
  };
}

describe("environment guardrails", () => {
  it("rejects oversized refresh bodies before authentication work", async () => {
    const body = JSON.stringify({ refreshToken: "a".repeat(5_000) });
    const response = await createApp().request(
      "https://api.example.com/auth/refresh",
      {
        method: "POST",
        headers: {
          "content-length": String(new TextEncoder().encode(body).byteLength),
          "content-type": "application/json",
        },
        body,
      },
      createTestEnv({
        ALLOWED_ORIGINS: "app://avalon",
        AVALON_REGION: "global",
        LOG_LEVEL: "error",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it('allows conditional image reads and exposes the preview validator to the renderer', async () => {
    const response = await createApp().request('https://api.example.com/resources/00000000-0000-7000-8000-000000000001/preview', {
      method: 'OPTIONS',
      headers: { origin: 'app://rallywithai', 'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,if-none-match,x-rally-client-contract' },
    }, createTestEnv({ ALLOWED_ORIGINS: 'app://rallywithai', AVALON_REGION: 'global', LOG_LEVEL: 'error' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('if-none-match');
    expect(response.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('etag');
  });

  it("allows the desktop upload and idempotency headers in CORS preflights", async () => {
    const response = await createApp().request(
      "https://api.example.com/automations/00000000-0000-7000-8000-000000000001/run",
      {
        method: "OPTIONS",
        headers: {
          origin: "app://avalon",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type,idempotency-key,x-rally-draft-id,x-avalon-draft-id",
        },
      },
      createTestEnv({
        ALLOWED_ORIGINS: "app://avalon",
        AVALON_REGION: "global",
        LOG_LEVEL: "error",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("app://avalon");
    const allowedHeaders = response.headers.get("access-control-allow-headers")?.toLowerCase();
    expect(allowedHeaders).toContain("idempotency-key");
    expect(allowedHeaders).toContain("x-rally-draft-id");
    // A build shipped before the rename sends the superseded spelling and
    // cannot be made to send anything else. Chromium matches this list
    // literally, so dropping it rejects that build at the preflight.
    expect(allowedHeaders).toContain("x-avalon-draft-id");
  });

  it.each(['global', 'enterprise'] as const)(
    "allows the deployed desktop correlation header on %s mutation preflights",
    async (region) => {
      const response = await createApp().request(
        "https://api.example.com/workstreams",
        {
          method: "OPTIONS",
          headers: {
            origin: "app://avalon",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,content-type,x-rally-client-contract,x-avalon-client-contract,x-rally-operation-id,x-avalon-operation-id,x-request-id",
          },
        },
        createTestEnv({
          ALLOWED_ORIGINS: "app://avalon",
          AVALON_REGION: region,
          LOG_LEVEL: "error",
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("app://avalon");
      const allowedHeaders = response.headers.get("access-control-allow-headers")?.toLowerCase();
      expect(allowedHeaders).toContain("x-rally-operation-id");
      expect(allowedHeaders).toContain("x-avalon-operation-id");
      // The desktop sends its wire contract on every request, so a missing
      // entry here blocks the preflight for *every* call rather than for the
      // two routes that read it — and a blocked preflight reaches the renderer
      // as a bare network error with no Worker log behind it.
      expect(allowedHeaders).toContain("x-rally-client-contract");
      expect(allowedHeaders).toContain("x-avalon-client-contract");
      // The desktop stamps `x-request-id` on every call so its performance
      // traces name the same id the Worker's rows carry. A missing entry here
      // is a blocked preflight, which reaches the renderer as a bare network
      // error and never reaches a Worker log at all.
      expect(allowedHeaders).toContain("x-request-id");
      expect(response.headers.get("access-control-expose-headers")?.toLowerCase())
        .toContain("x-request-id");
    },
  );

  it("allows live work-stream PUT requests in CORS preflights", async () => {
    const response = await createApp().request(
      "https://api.example.com/workstreams/00000000-0000-7000-8000-000000000001/pin",
      {
        method: "OPTIONS",
        headers: {
          origin: "app://avalon",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "authorization,content-type",
        },
      },
      createTestEnv({
        ALLOWED_ORIGINS: "app://avalon",
        AVALON_REGION: "global",
        LOG_LEVEL: "error",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("app://avalon");
    expect(response.headers.get("access-control-allow-methods")?.split(",")).toContain("PUT");
  });

  it("uses a safe fallback for invalid positive numeric limits", () => {
    const env = createTestEnv({ HARNESS_CHILD_MAX_TOOL_CALLS: "not-a-number" });
    expect(numericEnv(env, "HARNESS_CHILD_MAX_TOOL_CALLS", 8)).toBe(8);
    env.HARNESS_CHILD_MAX_TOOL_CALLS = "12";
    expect(numericEnv(env, "HARNESS_CHILD_MAX_TOOL_CALLS", 8)).toBe(12);
  });

  it("does not expose development session creation outside the explicit dev guard", async () => {
    const env = createTestEnv({ APP_ENV: "production", RALLY_DEV_AUTH: "false" });
    await expect(new AuthService(env).createDevelopmentSession()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(new AuthService(env).createDevelopmentIdentitySession()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it.each([
    "http://127.0.0.1/private",
    "http://[fd00::1]/private",
    "http://metadata.google.internal/latest",
  ])("rejects inherent web fetches to non-public literal host %s", (url) => {
    expect(() => __integrationTesting.assertSafePublicUrl(url)).toThrow(/private|local/i);
  });

  it("scopes short-lived socket tickets to one region, workspace, user, and work stream", async () => {
    const env = createTestEnv({ SESSION_SIGNING_KEY: "test-signing-key", AVALON_REGION: "global" });
    const ticket = await issueSocketTicket(
      env,
      {
        sessionId: "session",
        userId: asUserId("00000000-0000-7000-8000-000000000001"),
        workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000002"),
        region: "global",
        role: "owner",
      },
      { kind: "canvas", id: "00000000-0000-7000-8000-000000000003" },
    );
    await expect(verifySocketTicket(env, ticket)).resolves.toMatchObject({
      sessionId: "session",
      userId: "00000000-0000-7000-8000-000000000001",
      workspaceId: "00000000-0000-7000-8000-000000000002",
      parentKind: "canvas",
      parentId: "00000000-0000-7000-8000-000000000003",
      substreamId: "0",
      region: "global",
    });
    await expect(
      verifySocketTicket({ ...env, SESSION_SIGNING_KEY: "another-key" }, ticket),
    ).rejects.toMatchObject({ code: "invalid_socket_ticket" });
  });

  it("requires an exact configured Origin for WebSocket upgrades", () => {
    const env = createTestEnv({ ALLOWED_ORIGINS: "app://avalon, http://localhost:5173/" });
    expect(isAllowedSocketOrigin(env, "app://avalon")).toBe(true);
    expect(isAllowedSocketOrigin(env, "http://localhost:5173")).toBe(true);
    expect(isAllowedSocketOrigin(env, "https://with-avalon.com.evil.example")).toBe(false);
    expect(isAllowedSocketOrigin(env, null)).toBe(false);
  });

  it("keeps Azure dictation credentials server-side and scopes its socket ticket", async () => {
    const env = createTestEnv({
      SESSION_SIGNING_KEY: "test-signing-key",
      AVALON_REGION: "enterprise",
      AZURE_OPENAI_ENDPOINT: "https://avalon-enterprise.openai.azure.com/ignored/path",
      AZURE_OPENAI_REALTIME_DEPLOYMENT: "avalon-live-transcription",
    });
    const auth = {
      sessionId: "session",
      userId: asUserId("00000000-0000-7000-8000-000000000001"),
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000002"),
      region: "enterprise" as const,
      role: "owner" as const,
    };
    const ticket = await issueTranscriptionSocketTicket(env, auth);

    await expect(verifyTranscriptionSocketTicket(env, ticket)).resolves.toMatchObject({
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      region: "enterprise",
    });
    await expect(verifySocketTicket(env, ticket)).rejects.toMatchObject({ code: "invalid_socket_ticket" });
    expect(azureRealtimeWebSocketUrl(env)).toBe(
      "https://avalon-enterprise.openai.azure.com/openai/v1/realtime?intent=transcription",
    );
  });

  it("builds the Azure transcription session and accepts only audio-buffer events", () => {
    expect(transcriptionSessionUpdate("gpt-live-transcribe-deployment")).toMatchObject({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: { model: "gpt-live-transcribe-deployment", delay: "minimal" },
            turn_detection: null,
          },
        },
      },
    });
    expect(parseTranscriptionClientEvent(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: "AQID",
    }))).toEqual({ type: "input_audio_buffer.append", audio: "AQID" });
    expect(parseTranscriptionClientEvent(JSON.stringify({ type: "input_audio_buffer.commit" }))).toEqual({
      type: "input_audio_buffer.commit",
    });
    expect(parseTranscriptionClientEvent(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: "not base64",
    }))).toBeNull();
    expect(parseTranscriptionClientEvent(JSON.stringify({
      type: "session.update",
      session: { audio: { input: { transcription: { model: "other-model" } } } },
    }))).toBeNull();
    expect(__realtimeTranscriptionTesting.base64DecodedByteLength("AQID")).toBe(3);
    expect(__realtimeTranscriptionTesting.base64DecodedByteLength("not base64")).toBeNull();
    expect(__realtimeTranscriptionTesting.sendableCloseCode(1000)).toBe(1000);
    expect(__realtimeTranscriptionTesting.sendableCloseCode(1006)).toBe(1011);
    expect(__realtimeTranscriptionTesting.sendableCloseCode(4_001)).toBe(4_001);
    expect(__realtimeTranscriptionTesting.limits).toMatchObject({
      maxConcurrentUserSessions: 2,
      maxConcurrentWorkspaceSessions: 20,
      sessionLeaseRefreshMs: 60_000,
      sessionLeaseSeconds: 120,
    });
  });

  it("batches rapid model deltas before publishing realtime frames", async () => {
    let now = 0;
    const published: string[] = [];
    const batcher = __integrationTesting.createTextDeltaBatcher(
      async (delta) => { published.push(delta); },
      { maxCharacters: 5, maxDelayMs: 100, now: () => now },
    );

    await batcher.push("a");
    await batcher.push("bc");
    expect(published).toEqual([]);
    await batcher.push("de");
    expect(published).toEqual(["abcde"]);
    now = 101;
    await batcher.push("f");
    expect(published).toEqual(["abcde", "f"]);
    await batcher.push("gh");
    await batcher.flush();
    expect(published).toEqual(["abcde", "f", "gh"]);

    // A caller retracting text drops what is pending rather than flushing it,
    // so the abandoned fragment never reaches the client ahead of the frame
    // that replaces it.
    await batcher.push("ij");
    batcher.discard();
    await batcher.flush();
    expect(published).toEqual(["abcde", "f", "gh"]);
  });
});
