import "../../../tests/isolated-region";
import type { ConnectorConnectionContext, ConnectorError } from "@rally/connectors";
import type { Scope } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { decryptString, encryptString, sha256 } from "../src/lib/crypto";
import { webhookIngestionRoutes } from "../src/routes/connections";
import {
  __providerWebhookTesting,
  ProviderWebhookService,
  type ProviderWebhookRawBody,
  type ProviderWebhookServiceOptions,
} from "../src/services/provider-webhook-service";
import { publishWorkspaceSync } from "../src/services/workspace-realtime-service";
import type * as WorkspaceRealtimeService from "../src/services/workspace-realtime-service";
import { createCloudflareTestBinding, createTestD1Database, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

// Which audience each publish names is the decision under test; that the
// Organization object honours an audience is proved on real sockets in
// `test-workers/workspace-socket-fanout.test.ts`.
vi.mock("../src/services/workspace-realtime-service", async (importOriginal) => ({
  ...await importOriginal<typeof WorkspaceRealtimeService>(),
  publishWorkspaceSync: vi.fn(async () => 0),
}));

const NOW = Date.parse("2026-08-01T18:00:00.000Z");
const ENCRYPTION_KEY = "provider-webhook-test-encryption-key";
const GITHUB_SECRET = "github-webhook-secret";
const LINEAR_SECRET = "linear-webhook-secret";
const NOTION_SECRET = "notion-verification-token";
const NOTION_SETUP_NONCE = "notion-one-time-setup-nonce";

const WORKSPACE_ONE = "00000000-0000-7000-8000-000000000001";
const WORKSPACE_TWO = "00000000-0000-7000-8000-000000000002";
const CONNECTION_ONE = "00000000-0000-7000-8000-000000000011";
const CONNECTION_TWO = "00000000-0000-7000-8000-000000000012";
const CONNECTION_THREE = "00000000-0000-7000-8000-000000000013";
const CONNECTION_FOUR = "00000000-0000-7000-8000-000000000014";
const USER_ONE = "00000000-0000-7000-8000-000000000021";
const USER_TWO = "00000000-0000-7000-8000-000000000022";
const LINEAR_DELIVERY = "00000000-0000-4000-8000-000000000031";
const NOTION_EVENT = "00000000-0000-4000-8000-000000000041";
const NOTION_WORKSPACE = "00000000-0000-4000-8000-000000000042";
const NOTION_OTHER_WORKSPACE = "00000000-0000-4000-8000-000000000043";
const NOTION_INTEGRATION = "00000000-0000-4000-8000-000000000044";
const NOTION_SUBSCRIPTION = "00000000-0000-4000-8000-000000000045";
const NOTION_BOT = "00000000-0000-4000-8000-000000000046";
const NOTION_OTHER_BOT = "00000000-0000-4000-8000-000000000047";
const NOTION_PAGE = "00000000-0000-4000-8000-000000000048";

interface StoredConnection extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connector_type: "github" | "linear" | "notion";
  scope: Scope;
  owner_user_id: string | null;
  provider_account_id: string | null;
  encrypted_credentials: string;
  credential_iv: string;
  granted_scopes_json: string;
  status: "healthy" | "needs_reconnect" | "error" | "disabled";
  cursor_json: string;
  config_json: string;
  error_json: string | null;
}

interface Receipt {
  provider: string;
  deliveryId: string;
  eventType: string;
  payloadRef: string;
  receivedAt: string;
  processedAt: string | null;
  errorJson: string | null;
}

interface StoredActivity {
  id: string;
  workspaceId: string;
  connectionId: string;
  connectionScope: Scope;
  connectionOwnerUserId: string | null;
  provider: string;
  providerEventId: string;
  eventType: string;
  dedupeKey: string;
  processingStatus: string;
  payloadRef: string;
  rawContentHash: string | null;
}

interface StoredResource {
  id: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  resourceType: string;
  providerResourceId: string;
  title: string;
  canonicalUrl: string | null;
  metadataJson: string;
}

interface StoredChallenge {
  encrypted_token: string;
  token_iv: string;
  credential_key_version: number;
  setup_nonce_hash: string | null;
  setup_generation: number | null;
  consumed_at: string | null;
}

interface StoredSetupNonce {
  verificationTokenHash: string | null;
  expiresAt: string;
  consumedAt: string | null;
  isCurrent: boolean;
  generation: number;
}

class FakeStatement {
  values: unknown[] = [];

  constructor(
    readonly database: FakeDatabase,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.sql, this.values) as T | null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.all(this.sql, this.values));
  }

  async run<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.run(this.sql, this.values));
  }
}

class FakeDatabase {
  readonly connections: StoredConnection[] = [];
  readonly receipts = new Map<string, Receipt>();
  readonly activities: StoredActivity[] = [];
  readonly resources: StoredResource[] = [];
  readonly setupNonces = new Map<string, StoredSetupNonce>();
  challenge: StoredChallenge | null = null;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const statement of statements) {
      results.push(await (statement as unknown as FakeStatement).run());
    }
    return results;
  }

  first(sql: string, values: unknown[]): Record<string, unknown> | null {
    if (sql.includes("SELECT nonce.rowid AS setup_generation")) {
      const [region, verificationTokenHash] = values.map(String);
      if (region !== "global" || !this.challenge?.setup_nonce_hash) return null;
      const nonce = this.setupNonces.get(this.challenge.setup_nonce_hash);
      return nonce?.isCurrent
        && nonce.consumedAt !== null
        && nonce.verificationTokenHash === verificationTokenHash
        && this.challenge.setup_generation === nonce.generation
        ? { setup_generation: nonce.generation }
        : null;
    }
    if (sql.includes("FROM notion_webhook_setup_nonces")) {
      const nonce = this.setupNonces.get(String(values[0]));
      return nonce
          ? {
            verification_token_hash: nonce.verificationTokenHash,
            consumed_at: nonce.consumedAt,
            is_current: nonce.isCurrent ? 1 : 0,
          }
        : null;
    }
    if (sql.includes("FROM provider_webhook_challenges")) {
      return this.challenge
        ? {
            encrypted_token: this.challenge.encrypted_token,
            token_iv: this.challenge.token_iv,
            credential_key_version: this.challenge.credential_key_version,
            setup_nonce_hash: this.challenge.setup_nonce_hash,
            setup_generation: this.challenge.setup_generation,
            consumed_at: this.challenge.consumed_at,
          }
        : null;
    }
    if (sql.includes("FROM provider_webhook_receipts")) {
      const receipt = this.receipts.get(receiptKey(String(values[0]), String(values[1])));
      return receipt
        ? {
            event_type: receipt.eventType,
            payload_ref: receipt.payloadRef,
            processed_at: receipt.processedAt,
          }
        : null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  all(sql: string, values: unknown[]): D1Result<Record<string, unknown>> {
    if (sql.includes("FROM activities")) {
      const [provider, providerEventId, payloadRef] = values.map(String);
      return result(0, this.activities
        .filter((activity) =>
          activity.provider === provider &&
          activity.providerEventId === providerEventId &&
          activity.payloadRef === payloadRef &&
          ["pending", "failed"].includes(activity.processingStatus))
        .map((activity) => ({
          id: activity.id,
          workspace_id: activity.workspaceId,
        })));
    }
    if (!sql.includes("FROM connector_connections")) {
      throw new Error(`Unexpected all query: ${sql}`);
    }
    // One clause now: an inbound delivery reaches any connection a person has
    // not disabled, so whether a provider's event is processed no longer
    // depends on what this row believed about the grant.
    const rows = this.connections.filter((connection) => {
      if (connection.status === "disabled") return false;
      if (sql.includes("connector_type = 'notion'")) {
        return connection.connector_type === "notion"
          && connection.scope === "workspace"
          && values.includes(connection.provider_account_id);
      }
      if (sql.includes("json_extract(config_json, '$.githubUserId')")) {
        const config = JSON.parse(connection.config_json) as Record<string, unknown>;
        return connection.connector_type === "github"
          && connection.scope === "personal"
          && String(config.githubUserId ?? "") === String(values[0]);
      }
      return connection.connector_type === values[0]
        && connection.provider_account_id === values[1]
        && (!sql.includes("scope = 'workspace'") || connection.scope === "workspace");
    });
    return result(0, rows);
  }

  run(sql: string, values: unknown[]): D1Result {
    if (sql.includes("UPDATE notion_webhook_setup_nonces")) {
      const verificationTokenHash = String(values[0]);
      const consumedAt = String(values[1]);
      const nonceHash = String(values[2]);
      const expiresAfter = String(values[3]);
      const nonce = this.setupNonces.get(nonceHash);
      if (
        !nonce
        || !nonce.isCurrent
        || nonce.consumedAt !== null
        || nonce.expiresAt <= expiresAfter
      ) return result(0);
      nonce.verificationTokenHash = verificationTokenHash;
      nonce.consumedAt = consumedAt;
      return result(1);
    }
    if (sql.includes("INSERT INTO provider_webhook_receipts")) {
      const provider = String(values[0]);
      const deliveryId = String(values[1]);
      const eventType = String(values[2]);
      const payloadRef = String(values[3]);
      const receivedAt = String(values[4]);
      const key = receiptKey(provider, deliveryId);
      if (this.receipts.has(key)) return result(0);
      this.receipts.set(key, {
        provider,
        deliveryId,
        eventType,
        payloadRef,
        receivedAt,
        processedAt: null,
        errorJson: null,
      });
      return result(1);
    }
    if (sql.includes("INSERT INTO activities")) {
      const provider = String(values[23]);
      const deliveryId = String(values[24]);
      const payloadRef = String(values[25]);
      const receipt = this.receipts.get(receiptKey(provider, deliveryId));
      if (!receipt || receipt.payloadRef !== payloadRef || receipt.processedAt !== null) {
        return result(0);
      }
      const activity: StoredActivity = {
        id: String(values[0]),
        workspaceId: String(values[1]),
        connectionId: String(values[2]),
        connectionScope: values[3] as Scope,
        connectionOwnerUserId: values[4] == null ? null : String(values[4]),
        provider: String(values[5]),
        providerEventId: String(values[6]),
        eventType: String(values[7]),
        payloadRef: String(values[17]),
        dedupeKey: String(values[20]),
        rawContentHash: values[21] == null ? null : String(values[21]),
        processingStatus: "pending",
      };
      if (this.activities.some((candidate) =>
        candidate.connectionId === activity.connectionId &&
        (
          (candidate.providerEventId === activity.providerEventId &&
            candidate.eventType === activity.eventType) ||
          candidate.dedupeKey === activity.dedupeKey
        ))) return result(0);
      this.activities.push(activity);
      return result(1);
    }
    if (sql.includes("INSERT INTO resources")) {
      const [workspaceId, connectionId, provider, , , rowsJson, receiptProvider, deliveryId, payloadRef] = values;
      const receipt = this.receipts.get(receiptKey(String(receiptProvider), String(deliveryId)));
      if (!receipt || receipt.payloadRef !== payloadRef || receipt.processedAt !== null) {
        return result(0);
      }
      const rows = JSON.parse(String(rowsJson)) as Array<{
        id: string;
        resourceType: string;
        providerResourceId: string;
        title: string;
        canonicalUrl: string | null;
        metadataJson: string;
      }>;
      let changes = 0;
      for (const row of rows) {
        const existing = this.resources.find((candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.connectionId === connectionId &&
          candidate.provider === provider &&
          candidate.providerResourceId === row.providerResourceId);
        if (existing) {
          existing.resourceType = row.resourceType;
          existing.title = row.title;
          existing.canonicalUrl = row.canonicalUrl ?? existing.canonicalUrl;
          existing.metadataJson = JSON.stringify({
            ...JSON.parse(existing.metadataJson) as Record<string, unknown>,
            ...JSON.parse(row.metadataJson) as Record<string, unknown>,
          });
        } else {
          this.resources.push({
            id: row.id,
            workspaceId: String(workspaceId),
            connectionId: String(connectionId),
            provider: String(provider),
            resourceType: row.resourceType,
            providerResourceId: row.providerResourceId,
            title: row.title,
            canonicalUrl: row.canonicalUrl,
            metadataJson: row.metadataJson,
          });
        }
        changes += 1;
      }
      return result(changes);
    }
    if (sql.includes("INSERT INTO resources") && sql.includes("FROM json_each(?)")) {
      // Resource discovery is guarded by the same still-pending provider
      // receipt as the canonical activity insert. This fake does not need to
      // materialize resource rows; it only models the guarded upsert result.
      const provider = String(values[6]);
      const deliveryId = String(values[7]);
      const payloadRef = String(values[8]);
      const receipt = this.receipts.get(receiptKey(provider, deliveryId));
      return result(receipt && receipt.payloadRef === payloadRef && receipt.processedAt === null ? 1 : 0);
    }
    if (sql.includes("UPDATE connector_connections") && sql.includes("delivery_id")) {
      const [status, errorJson, , connectionId, , provider, deliveryId, payloadRef] = values;
      const receipt = this.receipts.get(receiptKey(String(provider), String(deliveryId)));
      if (!receipt || receipt.payloadRef !== payloadRef || receipt.processedAt !== null) {
        return result(0);
      }
      const connection = this.connections.find((candidate) => candidate.id === connectionId);
      if (!connection) return result(0);
      connection.status = status as StoredConnection["status"];
      connection.error_json = errorJson == null ? null : String(errorJson);
      return result(1);
    }
    if (sql.includes("SET processed_at")) {
      const [processedAt, provider, deliveryId, payloadRef] = values;
      const receipt = this.receipts.get(receiptKey(String(provider), String(deliveryId)));
      if (!receipt || receipt.payloadRef !== payloadRef) return result(0);
      receipt.processedAt ??= String(processedAt);
      receipt.errorJson = null;
      return result(1);
    }
    if (sql.includes("SET error_json") && sql.includes("provider_webhook_receipts")) {
      const [errorJson, provider, deliveryId, payloadRef] = values;
      const receipt = this.receipts.get(receiptKey(String(provider), String(deliveryId)));
      if (!receipt || receipt.payloadRef !== payloadRef) return result(0);
      receipt.errorJson = String(errorJson);
      return result(1);
    }
    if (sql.includes("INSERT INTO provider_webhook_challenges")) {
      let setupGeneration = values[5] == null ? null : Number(values[5]);
      if (sql.includes("FROM notion_webhook_setup_nonces")) {
        const nonceHash = String(values[6]);
        const verificationTokenHash = String(values[7]);
        const nonce = this.setupNonces.get(nonceHash);
        if (
          !nonce?.isCurrent
          || nonce.consumedAt === null
          || nonce.verificationTokenHash !== verificationTokenHash
        ) return result(0);
        setupGeneration = nonce.generation;
      } else if (
        this.challenge?.setup_generation != null
        && setupGeneration != null
        && setupGeneration < this.challenge.setup_generation
      ) {
        return result(0);
      }
      const replacement = {
        encrypted_token: String(values[1]),
        token_iv: String(values[2]),
        credential_key_version: Number(values[3]),
        setup_nonce_hash: values[4] == null ? null : String(values[4]),
        setup_generation: setupGeneration,
        consumed_at: null,
      };
      this.challenge = replacement;
      return result(1);
    }
    if (sql.includes("UPDATE provider_webhook_challenges")) {
      if (!this.challenge) return result(0);
      if (sql.includes("SET encrypted_token = ?")) {
        this.challenge.encrypted_token = String(values[0]);
        this.challenge.token_iv = String(values[1]);
        this.challenge.credential_key_version = Number(values[2]);
        this.challenge.consumed_at = null;
        return result(1);
      }
      this.challenge.consumed_at ??= String(values[0]);
      return result(1);
    }
    if (sql.includes("UPDATE connector_connections")) {
      if (sql.includes("SET status = 'needs_reconnect'")) {
        const [errorJson, , connectionId] = values;
        const connection = this.connections.find((candidate) => candidate.id === connectionId);
        if (!connection || connection.status !== "healthy") return result(0);
        connection.status = "needs_reconnect";
        connection.error_json = String(errorJson);
      }
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

class FakeBucket {
  readonly puts: Array<{ key: string; value: unknown; options: unknown }> = [];

  async put(key: string, value: unknown, options: unknown): Promise<void> {
    this.puts.push({ key, value, options });
  }
}

class FakeQueue {
  readonly messages: unknown[] = [];
  failuresRemaining = 0;

  async send(message: unknown): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("injected queue failure");
    }
    this.messages.push(message);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider-wide webhook ingestion", () => {
  it("stores exact GitHub bytes, fans out only to safe matching connections, and deduplicates", async () => {
    const database = new FakeDatabase();
    database.connections.push(
      await connection({
        id: CONNECTION_ONE,
        workspaceId: WORKSPACE_ONE,
        provider: "github",
        providerAccountId: "42",
        scope: "workspace",
        credentials: { installationId: "42", tokenKind: "installation" },
      }),
      await connection({
        id: CONNECTION_TWO,
        workspaceId: WORKSPACE_TWO,
        provider: "github",
        providerAccountId: "42",
        scope: "personal",
        ownerUserId: USER_TWO,
        credentials: { installationId: "42", accessToken: "personal-token" },
      }),
      await connection({
        id: CONNECTION_THREE,
        workspaceId: WORKSPACE_TWO,
        provider: "github",
        providerAccountId: "99",
        scope: "workspace",
        credentials: { installationId: "99" },
      }),
    );
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const githubFetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({ message: "Not Found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      ));
    const service = serviceFor(database, bucket, queue, {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "github-client",
      GITHUB_APP_CLIENT_SECRET: "github-client-secret",
      GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
    }, { fetch: githubFetch });
    const rawText = JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: {
        id: 10,
        full_name: "avalon/example",
        html_url: "https://github.com/avalon/example",
        owner: { login: "avalon" },
      },
      sender: { login: "octocat" },
      issue: {
        id: 20,
        node_id: "issue-node",
        number: 1,
        title: "Webhook support — café",
        body: "Ship provider events without changing whitespace",
        html_url: "https://github.com/avalon/example/issues/1",
        created_at: "2026-08-01T17:59:00.000Z",
      },
    }, null, 2);
    const rawBytes = new TextEncoder().encode(rawText);
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "x-github-delivery": "github-delivery-1",
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${await hmacHex(GITHUB_SECRET, rawText)}`,
    });

    await expect(service.ingestGitHub(rawBytes, headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 1,
    });
    expect(database.activities).toHaveLength(1);
    expect(database.activities[0]).toMatchObject({
      workspaceId: WORKSPACE_ONE,
      connectionId: CONNECTION_ONE,
      connectionScope: "workspace",
      connectionOwnerUserId: null,
      provider: "github",
      providerEventId: "github-delivery-1",
      eventType: "github.issue.opened",
    });
    expect(database.activities[0]?.payloadRef).toMatch(
      /^global\/provider-webhooks\/github\/[a-f0-9]{64}\.json$/u,
    );
    expect(database.activities[0]?.rawContentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(database.resources).toHaveLength(2);
    expect(database.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: WORKSPACE_ONE,
        connectionId: CONNECTION_ONE,
        resourceType: "github_repository",
        providerResourceId: "avalon/example",
      }),
      expect.objectContaining({
        workspaceId: WORKSPACE_ONE,
        connectionId: CONNECTION_ONE,
        resourceType: "github_issue",
        providerResourceId: "avalon/example#1",
      }),
    ]));
    expect(queue.messages).toEqual([{
      region: "global",
      workspaceId: WORKSPACE_ONE,
      activityId: database.activities[0]!.id,
      attempt: 0,
    }]);
    expect(bucket.puts).toHaveLength(1);
    expect(new Uint8Array(bucket.puts[0]!.value as ArrayBuffer)).toEqual(rawBytes);
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(String(githubFetch.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/avalon/example",
    );
    expect(githubFetch.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(new Headers(githubFetch.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer personal-token");

    await expect(service.ingestGitHub(rawBytes, headers)).resolves.toEqual({
      accepted: true,
      duplicate: true,
      activityCount: 0,
    });
    expect(database.activities).toHaveLength(1);
    expect(database.resources).toHaveLength(2);
    expect(queue.messages).toHaveLength(1);

    const conflictingBody = rawText.replace(
      "Ship provider events without changing whitespace",
      "A different signed delivery body",
    );
    const conflictingHeaders = new Headers(headers);
    conflictingHeaders.set(
      "x-hub-signature-256",
      `sha256=${await hmacHex(GITHUB_SECRET, conflictingBody)}`,
    );
    await expect(service.ingestGitHub(conflictingBody, conflictingHeaders))
      .rejects.toMatchObject({
        name: "ConnectorError",
        code: "provider_error",
      } satisfies Partial<ConnectorError>);
    expect(database.activities).toHaveLength(1);
    expect(bucket.puts).toHaveLength(1);
  });

  it("ingests a delivery the Global receiver verified without checking its signature again", async () => {
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      provider: "github",
      providerAccountId: "42",
      scope: "workspace",
      credentials: { installationId: "42", tokenKind: "installation" },
    }));
    const queue = new FakeQueue();
    const service = serviceFor(database, new FakeBucket(), queue);
    const rawBody = new TextEncoder().encode(JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: { id: 10, full_name: "avalon/example", html_url: "https://github.com/avalon/example", owner: { login: "avalon" } },
      issue: { id: 20, number: 1, title: "Verified once", html_url: "https://github.com/avalon/example/issues/1" },
    }));
    const verify = vi.spyOn(crypto.subtle, "verify");
    const sign = vi.spyOn(crypto.subtle, "sign");
    const delivery = {
      rawBody: rawBody.buffer,
      deliveryId: "github-verified-delivery-1",
      event: "issues",
      receivedAt: new Date(NOW).toISOString(),
    };

    await expect(service.ingestVerifiedGitHub(delivery)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 1,
    });
    expect(database.activities).toHaveLength(1);
    expect(database.activities[0]).toMatchObject({
      connectionId: CONNECTION_ONE,
      providerEventId: "github-verified-delivery-1",
      eventType: "github.issue.opened",
    });
    expect(queue.messages).toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();

    // A second copy of the delivery — a Queue redelivery, or GitHub sending it
    // again — is keyed on the delivery id and changes nothing.
    await expect(service.ingestVerifiedGitHub(delivery)).resolves.toEqual({
      accepted: true,
      duplicate: true,
      activityCount: 0,
    });
    expect(database.activities).toHaveLength(1);
    expect(queue.messages).toHaveLength(1);
  });

  it.each([
    ["deleted", "disabled"],
    ["suspend", "needs_reconnect"],
    ["unsuspend", "healthy"],
  ])("applies GitHub %s authorization state without creating an activity", async (action, status) => {
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      provider: "github",
      providerAccountId: "42",
      scope: "personal",
      ownerUserId: USER_ONE,
      credentials: { installationId: "42", accessToken: "personal-token" },
    }));
    database.connections[0]!.status = action === "unsuspend" ? "needs_reconnect" : "error";
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const rawBody = JSON.stringify({ action, installation: { id: 42 } });
    const headers = new Headers({
      "x-github-delivery": "github-installation-deleted-1",
      "x-github-event": "installation",
      "x-hub-signature-256": `sha256=${await hmacHex(GITHUB_SECRET, rawBody)}`,
    });

    await expect(service.ingestGitHub(rawBody, headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 0,
    });
    expect(database.connections[0]).toMatchObject({ status });
    if (action === "suspend") {
      expect(JSON.parse(database.connections[0]!.error_json!)).toMatchObject({
        code: "github_installation_suspended",
      });
    }
    expect(database.activities).toHaveLength(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("records bounded installation repository selection changes as one activity", async () => {
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      provider: "github",
      providerAccountId: "42",
      scope: "workspace",
      credentials: { installationId: "42", accessToken: "installation-token" },
    }));
    database.connections[0]!.status = "error";
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const rawBody = JSON.stringify({
      action: "added",
      installation: { id: 42 },
      sender: { id: 7, login: "octocat" },
      repositories_added: [
        { id: 10, name: "one", full_name: "avalon/one", html_url: "https://github.com/avalon/one", owner: { login: "avalon" } },
        { id: 11, name: "two", full_name: "avalon/two", html_url: "https://github.com/avalon/two", owner: { login: "avalon" } },
      ],
      repositories_removed: [
        { id: 12, name: "old", full_name: "avalon/old", html_url: "https://github.com/avalon/old", owner: { login: "avalon" } },
      ],
    });
    const headers = new Headers({
      "x-github-delivery": "github-repositories-added-1",
      "x-github-event": "installation_repositories",
      "x-hub-signature-256": `sha256=${await hmacHex(GITHUB_SECRET, rawBody)}`,
    });

    await expect(service.ingestGitHub(rawBody, headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 1,
    });
    expect(database.connections[0]?.status).toBe("healthy");
    expect(database.activities).toHaveLength(1);
    expect(database.activities[0]?.eventType).toBe("github.installation_repositories.added");
    expect(database.resources).toHaveLength(3);
    expect(JSON.parse(database.resources.find((resource) =>
      resource.providerResourceId === "avalon/one")!.metadataJson)).toMatchObject({ selected: true });
    expect(JSON.parse(database.resources.find((resource) =>
      resource.providerResourceId === "avalon/old")!.metadataJson)).toMatchObject({ selected: false });
    expect(queue.messages).toHaveLength(1);
  });

  it("matches GitHub user authorization revocation by sender ID without an installation", async () => {
    const database = new FakeDatabase();
    database.connections.push(
      await connection({
        id: CONNECTION_ONE,
        workspaceId: WORKSPACE_ONE,
        provider: "github",
        providerAccountId: "42",
        scope: "personal",
        ownerUserId: USER_ONE,
        credentials: { installationId: "42", githubUserId: "7", accessToken: "personal-token" },
        config: { region: "global", githubUserId: "7" },
      }),
      await connection({
        id: CONNECTION_TWO,
        workspaceId: WORKSPACE_TWO,
        provider: "github",
        providerAccountId: "42",
        scope: "personal",
        ownerUserId: USER_TWO,
        credentials: { installationId: "42", githubUserId: "8", accessToken: "other-token" },
        config: { region: "global", githubUserId: "8" },
      }),
    );
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const rawBody = JSON.stringify({
      action: "revoked",
      sender: { id: 7, login: "octocat" },
    });
    const headers = new Headers({
      "x-github-delivery": "github-authorization-revoked-1",
      "x-github-event": "github_app_authorization",
      "x-hub-signature-256": `sha256=${await hmacHex(GITHUB_SECRET, rawBody)}`,
    });

    await expect(service.ingestGitHub(rawBody, headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 0,
    });
    expect(database.connections[0]).toMatchObject({ status: "needs_reconnect" });
    expect(JSON.parse(database.connections[0]!.error_json!)).toMatchObject({
      code: "github_user_authorization_revoked",
      reconnectRequired: true,
    });
    expect(database.connections[1]).toMatchObject({ status: "healthy" });
    expect(database.activities).toHaveLength(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("rejects oversized provider bodies before storage or receipt writes", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue, {
      PROVIDER_WEBHOOK_MAX_BYTES: "10",
    });

    await expect(service.ingestGitHub(
      "0".repeat(25 * 1024 * 1024 + 1),
      new Headers(),
    )).rejects.toMatchObject({
      name: "ConnectorError",
      code: "payload_too_large",
    } satisfies Partial<ConnectorError>);
    expect(bucket.puts).toHaveLength(0);
    expect(database.receipts.size).toBe(0);
  });

  it("rejects a tampered GitHub signature before storage or receipt writes", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const rawBody = JSON.stringify({ installation: { id: 42 } }, null, 2);

    await expect(service.ingestGitHub(rawBody, new Headers({
      "x-github-delivery": "tampered-delivery",
      "x-github-event": "ping",
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    }))).rejects.toMatchObject({
      name: "ConnectorError",
      code: "invalid_signature",
    } satisfies Partial<ConnectorError>);
    expect(bucket.puts).toHaveLength(0);
    expect(database.receipts.size).toBe(0);
  });

  it("does not persist a valid regional delivery when no authorized connection matches", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const rawBody = JSON.stringify({
      action: "opened",
      installation: { id: 404 },
      repository: { name: "orphaned", full_name: "acme/orphaned", owner: { login: "acme" } },
      issue: { id: 1, number: 1, title: "No route" },
      sender: { id: 7, login: "octocat" },
    });

    await expect(service.ingestGitHub(rawBody, new Headers({
      "x-github-delivery": "github-unmatched-delivery-1",
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${await hmacHex(GITHUB_SECRET, rawBody)}`,
    }))).resolves.toEqual({ accepted: true, duplicate: false, activityCount: 0 });
    expect(bucket.puts).toHaveLength(0);
    expect(database.receipts.size).toBe(0);
    expect(database.resources).toHaveLength(0);
  });

  it("verifies Linear delivery metadata, normalizes lifecycle activity, and marks reconnect", async () => {
    const database = new FakeDatabase();
    database.connections.push(
      await connection({
        id: CONNECTION_ONE,
        workspaceId: WORKSPACE_ONE,
        provider: "linear",
        providerAccountId: "linear-org-1",
        scope: "workspace",
        credentials: { organizationId: "linear-org-1" },
      }),
      await connection({
        id: CONNECTION_TWO,
        workspaceId: WORKSPACE_TWO,
        provider: "linear",
        providerAccountId: "linear-org-1",
        scope: "personal",
        ownerUserId: USER_TWO,
        credentials: { organizationId: "linear-org-1" },
      }),
    );
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const payload = {
      action: "revoked",
      type: "OAuthApp",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-1",
      webhookTimestamp: NOW,
      createdAt: new Date(NOW).toISOString(),
      data: { id: "oauth-app-1", name: "Avalon" },
      actor: { id: "linear-user-1", name: "Admin" },
    };
    const rawBody = JSON.stringify(payload);
    const headers = new Headers({
      "linear-delivery": LINEAR_DELIVERY,
      "linear-event": "OAuthApp",
      "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
      "linear-timestamp": String(NOW),
    });

    await expect(service.ingestLinear(rawBody, headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 1,
    });
    expect(database.connections[0]).toMatchObject({ status: "needs_reconnect" });
    expect(database.connections[1]).toMatchObject({ status: "healthy" });
    expect(database.activities).toHaveLength(1);
    expect(database.activities[0]?.eventType).toBe("linear.oauth_app.revoked");
    expect(queue.messages).toHaveLength(1);
  });

  it("records Linear team-access changes without forcing OAuth reconnect", async () => {
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      provider: "linear",
      providerAccountId: "linear-org-1",
      scope: "workspace",
      credentials: { organizationId: "linear-org-1" },
    }));
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const deliveryId = "00000000-0000-4000-8000-000000000032";
    const rawBody = JSON.stringify({
      action: "teamAccessChanged",
      type: "PermissionChange",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-permissions",
      webhookTimestamp: NOW,
      createdAt: new Date(NOW).toISOString(),
      data: { id: "team-1", name: "Core" },
    });
    const headers = new Headers({
      "linear-delivery": deliveryId,
      "linear-event": "PermissionChange",
      "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
      "linear-timestamp": String(NOW),
    });

    await expect(service.ingestLinear(rawBody, headers)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      activityCount: 1,
    });
    expect(database.connections[0]).toMatchObject({ status: "healthy", error_json: null });
    expect(database.activities[0]?.eventType).toBe("linear.permission_change.team_access_changed");
  });

  it("fans Linear activity to a personal connection only after its token proves resource access", async () => {
    const database = new FakeDatabase();
    database.connections.push(
      await connection({
        id: CONNECTION_ONE,
        workspaceId: WORKSPACE_ONE,
        provider: "linear",
        providerAccountId: "linear-org-1",
        scope: "workspace",
        credentials: { organizationId: "linear-org-1" },
      }),
      await connection({
        id: CONNECTION_TWO,
        workspaceId: WORKSPACE_ONE,
        provider: "linear",
        providerAccountId: "linear-org-1",
        scope: "personal",
        ownerUserId: USER_ONE,
        credentials: {
          organizationId: "linear-org-1",
          oauthActor: "user",
          authorizedUserId: "linear-user-1",
          accessToken: "personal-linear-token",
        },
      }),
    );
    const linearFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: { resource: { id: "issue-1" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const service = serviceFor(database, new FakeBucket(), new FakeQueue(), {
      LINEAR_OAUTH_CLIENT_ID: "linear-client",
      LINEAR_OAUTH_CLIENT_SECRET: "linear-client-secret",
    }, { fetch: linearFetch });
    const deliveryId = "00000000-0000-4000-8000-000000000033";
    const rawBody = JSON.stringify({
      action: "update",
      type: "Issue",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-issue",
      webhookTimestamp: NOW,
      createdAt: new Date(NOW).toISOString(),
      data: { id: "issue-1", identifier: "AVA-1", title: "Fix activity fan-out" },
      actor: { id: "linear-user-1", name: "Adam", email: "adam@example.com" },
    });
    const headers = new Headers({
      "linear-delivery": deliveryId,
      "linear-event": "Issue",
      "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
      "linear-timestamp": String(NOW),
    });

    await expect(service.ingestLinear(rawBody, headers)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      activityCount: 2,
    });
    expect(linearFetch).toHaveBeenCalledTimes(1);
    expect(database.activities.map((activity) => activity.connectionScope).sort()).toEqual(["personal", "workspace"]);
    // An Organization connection matched too, so everybody hears of it.
    expect(vi.mocked(publishWorkspaceSync)).toHaveBeenCalledWith(
      expect.anything(), WORKSPACE_ONE, ["connector_connections", "resources"], undefined,
    );
  });

  it("tells only the owner of a personal connection that its resources moved", async () => {
    vi.mocked(publishWorkspaceSync).mockClear();
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_TWO,
      workspaceId: WORKSPACE_ONE,
      provider: "linear",
      providerAccountId: "linear-org-1",
      scope: "personal",
      ownerUserId: USER_ONE,
      credentials: {
        organizationId: "linear-org-1",
        oauthActor: "user",
        authorizedUserId: "linear-user-1",
        accessToken: "personal-linear-token",
      },
    }));
    const service = serviceFor(database, new FakeBucket(), new FakeQueue(), {
      LINEAR_OAUTH_CLIENT_ID: "linear-client",
      LINEAR_OAUTH_CLIENT_SECRET: "linear-client-secret",
    }, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
        JSON.stringify({ data: { resource: { id: "issue-2" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )),
    });
    const rawBody = JSON.stringify({
      action: "update",
      type: "Issue",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-issue",
      webhookTimestamp: NOW,
      createdAt: new Date(NOW).toISOString(),
      data: { id: "issue-2", identifier: "AVA-2", title: "Personal issue" },
      actor: { id: "linear-user-1", name: "Adam", email: "adam@example.com" },
    });
    const headers = new Headers({
      "linear-delivery": "00000000-0000-4000-8000-000000000034",
      "linear-event": "Issue",
      "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
      "linear-timestamp": String(NOW),
    });

    await expect(service.ingestLinear(rawBody, headers)).resolves.toMatchObject({ accepted: true, activityCount: 1 });

    expect(vi.mocked(publishWorkspaceSync)).toHaveBeenCalledWith(
      expect.anything(), WORKSPACE_ONE, ["connector_connections", "resources"], { audienceUserIds: [USER_ONE] },
    );
    // Activity is retired: the connection's own topics are the only news.
    expect(vi.mocked(publishWorkspaceSync)).toHaveBeenCalledTimes(1);
  });

  it("marks a personal Linear connection for reconnect when access proof loses authorization", async () => {
    const database = new FakeDatabase();
    database.connections.push(
      await connection({
        id: CONNECTION_ONE,
        workspaceId: WORKSPACE_ONE,
        provider: "linear",
        providerAccountId: "linear-org-1",
        scope: "workspace",
        credentials: { organizationId: "linear-org-1" },
      }),
      await connection({
        id: CONNECTION_TWO,
        workspaceId: WORKSPACE_ONE,
        provider: "linear",
        providerAccountId: "linear-org-1",
        scope: "personal",
        ownerUserId: USER_ONE,
        credentials: {
          organizationId: "linear-org-1",
          oauthActor: "user",
          authorizedUserId: "linear-user-1",
        },
      }),
    );
    const service = serviceFor(database, new FakeBucket(), new FakeQueue(), {
      LINEAR_OAUTH_CLIENT_ID: "linear-client",
      LINEAR_OAUTH_CLIENT_SECRET: "linear-client-secret",
    });
    const rawBody = JSON.stringify({
      action: "update",
      type: "Issue",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-issue",
      webhookTimestamp: NOW,
      createdAt: new Date(NOW).toISOString(),
      data: { id: "issue-1", identifier: "AVA-1", title: "Refresh connector authorization" },
    });
    const headers = new Headers({
      "linear-delivery": "00000000-0000-4000-8000-000000000035",
      "linear-event": "Issue",
      "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
      "linear-timestamp": String(NOW),
    });

    await expect(service.ingestLinear(rawBody, headers)).resolves.toMatchObject({
      accepted: true,
      activityCount: 1,
    });
    expect(database.connections[1]).toMatchObject({ status: "needs_reconnect" });
    expect(JSON.parse(database.connections[1]!.error_json!)).toMatchObject({
      code: "linear_user_authorization_expired",
    });
  });

  it("routes native Linear sessions only to the matching app identity and capability", () => {
    const base: ConnectorConnectionContext = {
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: ["linear.read", "linear.agent"],
      credentials: { appUserId: "linear-app-user-1" },
      cursor: {},
      config: {},
    };
    expect(__providerWebhookTesting.linearAgentConnectionMatches(base, "linear-app-user-1")).toBe(true);
    expect(__providerWebhookTesting.linearAgentConnectionMatches(
      { ...base, grantedScopes: ["linear.read"] },
      "linear-app-user-1",
    )).toBe(false);
    expect(__providerWebhookTesting.linearAgentConnectionMatches(base, "different-app-user")).toBe(false);
  });

  it("acknowledges stale Linear agent subscriptions without starting work while disabled", async () => {
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      provider: "linear",
      providerAccountId: "linear-org-1",
      scope: "workspace",
      credentials: { organizationId: "linear-org-1", appUserId: "linear-app-user-1" },
    }));
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const deliveryId = "00000000-0000-4000-8000-000000000034";
    const rawBody = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      appUserId: "linear-app-user-1",
      oauthClientId: "linear-oauth-client-1",
      organizationId: "linear-org-1",
      webhookId: "linear-agent-webhook-1",
      webhookTimestamp: NOW,
      createdAt: new Date(NOW).toISOString(),
      agentSession: {
        id: "linear-session-1",
        appUserId: "linear-app-user-1",
        organizationId: "linear-org-1",
        status: "pending",
        type: "delegation",
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
      promptContext: "Investigate the issue",
    });
    const headers = new Headers({
      "linear-delivery": deliveryId,
      "linear-event": "AgentSessionEvent",
      "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
      "linear-timestamp": String(NOW),
    });

    await expect(service.ingestLinear(rawBody, headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 0,
    });
    expect(database.receipts.size).toBe(0);
    expect(database.activities).toHaveLength(0);
    expect(bucket.puts).toHaveLength(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("acknowledges every accepted Linear delivery with HTTP 200", async () => {
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      provider: "linear",
      providerAccountId: "linear-org-1",
      scope: "workspace",
      credentials: { organizationId: "linear-org-1" },
    }));
    const at = Date.now();
    const rawBody = JSON.stringify({
      action: "create",
      type: "Issue",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-route",
      webhookTimestamp: at,
      createdAt: new Date(at).toISOString(),
      data: { id: "issue-route", identifier: "AVA-99", title: "Acknowledge me" },
    });
    const response = await webhookIngestionRoutes.request(
      "https://api.avalon.example/linear",
      {
        method: "POST",
        headers: {
          "linear-delivery": "00000000-0000-4000-8000-000000000033",
          "linear-event": "Issue",
          "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
          "linear-timestamp": String(at),
        },
        body: rawBody,
      },
      createTestEnv({
        DB: createTestD1Database(database),
        PAYLOADS: createCloudflareTestBinding<R2Bucket>(new FakeBucket()),
        ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>(new FakeQueue()),
        AVALON_REGION: "global",
        PUBLIC_API_BASE_URL: "https://api.avalon.example",
        LINEAR_INGRESS_BASE_URL: "https://linear.with-avalon.com",
        LINEAR_WEBHOOK_SECRET: LINEAR_SECRET,
        CONNECTOR_CREDENTIALS_KEY: ENCRYPTION_KEY,
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
        WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
        PROVIDER_WEBHOOK_MAX_BYTES: "2000000",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: true, duplicate: false });
  });

  it("recovers an unqueued lifecycle activity after its connection leaves healthy status", async () => {
    const database = new FakeDatabase();
    database.connections.push(await connection({
      id: CONNECTION_ONE,
      workspaceId: WORKSPACE_ONE,
      provider: "linear",
      providerAccountId: "linear-org-1",
      scope: "workspace",
      credentials: { organizationId: "linear-org-1" },
    }));
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    queue.failuresRemaining = 1;
    const service = serviceFor(database, bucket, queue);
    const rawBody = JSON.stringify({
      action: "revoked",
      type: "OAuthApp",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-recovery",
      webhookTimestamp: NOW,
      createdAt: new Date(NOW).toISOString(),
      data: { id: "oauth-app-1", name: "Avalon" },
    });
    const headers = new Headers({
      "linear-delivery": LINEAR_DELIVERY,
      "linear-event": "OAuthApp",
      "linear-signature": await hmacHex(LINEAR_SECRET, rawBody),
      "linear-timestamp": String(NOW),
    });

    await expect(service.ingestLinear(rawBody, headers)).rejects.toMatchObject({
      name: "ConnectorError",
      code: "provider_error",
    } satisfies Partial<ConnectorError>);
    expect(database.connections[0]?.status).toBe("needs_reconnect");
    expect(database.activities).toHaveLength(1);
    expect(database.receipts.get(`linear:${LINEAR_DELIVERY}`)?.processedAt).toBeNull();

    await expect(service.ingestLinear(rawBody, headers)).resolves.toEqual({
      accepted: true,
      duplicate: true,
      activityCount: 0,
    });
    expect(queue.messages).toEqual([{
      region: "global",
      workspaceId: WORKSPACE_ONE,
      activityId: database.activities[0]!.id,
      attempt: 0,
    }]);
    expect(database.receipts.get(`linear:${LINEAR_DELIVERY}`)?.processedAt).not.toBeNull();
  });

  it("claims a one-time nonce and encrypts the Notion verification challenge", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    const rawBody = JSON.stringify({ verification_token: NOTION_SECRET });
    await seedNotionSetupNonce(database, NOTION_SETUP_NONCE);

    await expect(service.ingestNotion(rawBody, new Headers(), "wrong-nonce"))
      .rejects.toMatchObject({
        name: "ConnectorError",
        code: "unauthorized",
      } satisfies Partial<ConnectorError>);
    expect(database.challenge).toBeNull();

    await expect(service.ingestNotion(rawBody, new Headers(), NOTION_SETUP_NONCE))
      .resolves.toEqual({ accepted: true, duplicate: false, activityCount: 0 });
    expect(database.challenge?.encrypted_token).not.toContain(NOTION_SECRET);
    await expect(decryptString(
      database.challenge!.encrypted_token,
      database.challenge!.token_iv,
      ENCRYPTION_KEY,
      "provider-webhook:notion:global",
    )).resolves.toBe(NOTION_SECRET);
    expect(bucket.puts).toHaveLength(0);

    await expect(service.ingestNotion(rawBody, new Headers(), NOTION_SETUP_NONCE))
      .resolves.toEqual({ accepted: true, duplicate: true, activityCount: 0 });

    await expect(service.ingestNotion(
      JSON.stringify({ verification_token: "replacement-secret" }),
      new Headers(),
      NOTION_SETUP_NONCE,
    )).rejects.toMatchObject({ code: "unauthorized" });

    const replacementNonce = "notion-replacement-setup-nonce";
    await seedNotionSetupNonce(database, replacementNonce);
    await expect(service.ingestNotion(
      JSON.stringify({ verification_token: "replacement-secret" }),
      new Headers(),
      replacementNonce,
    )).resolves.toEqual({ accepted: true, duplicate: false, activityCount: 0 });
    await expect(decryptString(
      database.challenge!.encrypted_token,
      database.challenge!.token_iv,
      ENCRYPTION_KEY,
      "provider-webhook:notion:global",
    )).resolves.toBe("replacement-secret");

    // Once a later nonce installs a token, replaying the earlier valid pair can
    // no longer restore the superseded signing secret.
    await expect(service.ingestNotion(rawBody, new Headers(), NOTION_SETUP_NONCE))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects an expired Notion setup nonce", async () => {
    const database = new FakeDatabase();
    const service = serviceFor(database, new FakeBucket(), new FakeQueue());
    await seedNotionSetupNonce(database, NOTION_SETUP_NONCE, NOW - 1);

    await expect(service.ingestNotion(
      JSON.stringify({ verification_token: NOTION_SECRET }),
      new Headers(),
      NOTION_SETUP_NONCE,
    )).rejects.toMatchObject({ code: "unauthorized" });
    expect(database.challenge).toBeNull();
  });

  it("prevents an older claimed challenge from winning after a newer setup", async () => {
    const database = new FakeDatabase();
    const service = serviceFor(database, new FakeBucket(), new FakeQueue());
    const oldNonce = "older-overlapping-setup-nonce";
    const newNonce = "newer-overlapping-setup-nonce";
    const oldToken = "older-overlapping-verification-token";
    const newToken = "newer-overlapping-verification-token";
    await seedNotionSetupNonce(database, oldNonce);
    await claimNotionSetupNonce(database, oldNonce, oldToken);
    await seedNotionSetupNonce(database, newNonce);
    await claimNotionSetupNonce(database, newNonce, newToken);

    await service.storeNotionChallengeToken(newToken, await sha256(newNonce));
    await expect(service.notionSetupGenerationForToken(newToken)).resolves.toBe(2);
    await expect(service.storeNotionChallengeToken(oldToken, await sha256(oldNonce)))
      .rejects.toMatchObject({ code: "unauthorized" });

    await expect(decryptString(
      database.challenge!.encrypted_token,
      database.challenge!.token_iv,
      ENCRYPTION_KEY,
      "provider-webhook:notion:global",
    )).resolves.toBe(newToken);
    expect(database.challenge?.setup_nonce_hash).toBe(await sha256(newNonce));
  });

  it("prevents older challenge replication from overwriting a newer enterprise generation", async () => {
    const database = new FakeDatabase();
    const service = serviceFor(
      database,
      new FakeBucket(),
      new FakeQueue(),
      { AVALON_REGION: "enterprise" },
    );

    await service.storeNotionChallengeToken("newer-enterprise-token", null, 2);
    await expect(service.storeNotionChallengeToken("older-enterprise-token", null, 1))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(decryptString(
      database.challenge!.encrypted_token,
      database.challenge!.token_iv,
      ENCRYPTION_KEY,
      "provider-webhook:notion:enterprise",
    )).resolves.toBe("newer-enterprise-token");
    expect(database.challenge?.setup_generation).toBe(2);
  });

  it("verifies Notion events and fans out only to matching accessible bots", async () => {
    const database = new FakeDatabase();
    database.connections.push(
      await connection({
        id: CONNECTION_ONE,
        workspaceId: WORKSPACE_ONE,
        provider: "notion",
        providerAccountId: NOTION_BOT,
        scope: "workspace",
        credentials: {
          notionWorkspaceId: NOTION_WORKSPACE,
          botId: NOTION_BOT,
          integrationId: NOTION_INTEGRATION,
        },
      }),
      await connection({
        id: CONNECTION_FOUR,
        workspaceId: WORKSPACE_TWO,
        provider: "notion",
        providerAccountId: NOTION_BOT,
        scope: "workspace",
        credentials: {
          notionWorkspaceId: NOTION_WORKSPACE,
          botId: NOTION_BOT,
          integrationId: "00000000-0000-4000-8000-000000000099",
        },
      }),
      await connection({
        id: CONNECTION_TWO,
        workspaceId: WORKSPACE_ONE,
        provider: "notion",
        providerAccountId: NOTION_OTHER_BOT,
        scope: "workspace",
        credentials: {
          notionWorkspaceId: NOTION_WORKSPACE,
          botId: NOTION_OTHER_BOT,
          integrationId: NOTION_INTEGRATION,
        },
      }),
      await connection({
        id: CONNECTION_THREE,
        workspaceId: WORKSPACE_TWO,
        provider: "notion",
        providerAccountId: NOTION_BOT,
        scope: "workspace",
        credentials: {
          notionWorkspaceId: NOTION_OTHER_WORKSPACE,
          botId: NOTION_BOT,
          integrationId: NOTION_INTEGRATION,
        },
      }),
    );
    // An unrelated inaccessible bot must be excluded by plaintext routing
    // before credential decryption, so its corrupt ciphertext cannot block the
    // target workspace's event.
    const inaccessibleConnection = database.connections.find(
      (candidate) => candidate.id === CONNECTION_TWO,
    )!;
    inaccessibleConnection.encrypted_credentials = "corrupt-ciphertext";
    inaccessibleConnection.credential_iv = "corrupt-iv";
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const service = serviceFor(database, bucket, queue);
    await seedNotionSetupNonce(database, NOTION_SETUP_NONCE);
    await service.ingestNotion(
      JSON.stringify({ verification_token: NOTION_SECRET }),
      new Headers(),
      NOTION_SETUP_NONCE,
    );
    const rawBody = JSON.stringify({
      id: NOTION_EVENT,
      type: "page.content_updated",
      workspace_id: NOTION_WORKSPACE,
      workspace_name: "Avalon",
      integration_id: NOTION_INTEGRATION,
      subscription_id: NOTION_SUBSCRIPTION,
      timestamp: new Date(NOW).toISOString(),
      attempt_number: 1,
      api_version: "2025-09-03",
      accessible_by: [{ type: "bot", id: NOTION_BOT }],
      entity: { type: "page", id: NOTION_PAGE },
      data: { title: "Project brief" },
      authors: [{ type: "person", id: "author-1" }],
    });
    const headers = new Headers({
      "x-notion-signature": `sha256=${await hmacHex(NOTION_SECRET, rawBody)}`,
    });

    await expect(service.ingestNotion(rawBody, headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 1,
    });
    expect(database.activities).toHaveLength(1);
    expect(database.activities[0]).toMatchObject({
      workspaceId: WORKSPACE_ONE,
      connectionId: CONNECTION_ONE,
      connectionScope: "workspace",
      connectionOwnerUserId: null,
      eventType: "notion.page.content_updated",
    });
    expect(queue.messages).toHaveLength(1);
    expect(database.challenge?.consumed_at).not.toBeNull();
  });
});

async function connection(input: {
  id: string;
  workspaceId: string;
  provider: StoredConnection["connector_type"];
  providerAccountId: string;
  scope: Scope;
  ownerUserId?: string;
  credentials: Record<string, unknown>;
  config?: Record<string, unknown>;
}): Promise<StoredConnection> {
  const encrypted = await encryptString(
    JSON.stringify(input.credentials),
    ENCRYPTION_KEY,
    input.id,
  );
  return {
    id: input.id,
    workspace_id: input.workspaceId,
    connector_type: input.provider,
    scope: input.scope,
    owner_user_id: input.ownerUserId ?? null,
    provider_account_id: input.providerAccountId,
    encrypted_credentials: encrypted.ciphertext,
    credential_iv: encrypted.iv,
    granted_scopes_json: "[]",
    status: "healthy",
    cursor_json: "{}",
    config_json: JSON.stringify(input.config ?? { region: "global" }),
    error_json: null,
  };
}

function serviceFor(
  database: FakeDatabase,
  bucket: FakeBucket,
  queue: FakeQueue,
  overrides: Partial<Env> = {},
  options: ProviderWebhookServiceOptions = {},
): ProviderWebhookService {
  const env = createTestEnv({
    DB: createTestD1Database(database),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>(bucket),
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>(queue),
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.avalon.example",
    GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    LINEAR_WEBHOOK_SECRET: LINEAR_SECRET,
    NOTION_OAUTH_CLIENT_ID: NOTION_INTEGRATION,
    CONNECTOR_CREDENTIALS_KEY: ENCRYPTION_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
    PROVIDER_WEBHOOK_MAX_BYTES: "2000000",
    ...overrides,
  });
  return new ProviderWebhookService(env, { now: () => NOW, ...options });
}

async function seedNotionSetupNonce(
  database: FakeDatabase,
  nonce: string,
  expiresAt = NOW + 30 * 60 * 1_000,
): Promise<void> {
  for (const stored of database.setupNonces.values()) stored.isCurrent = false;
  database.setupNonces.set(await sha256(nonce), {
    verificationTokenHash: null,
    expiresAt: new Date(expiresAt).toISOString(),
    consumedAt: null,
    isCurrent: true,
    generation: database.setupNonces.size + 1,
  });
}

async function claimNotionSetupNonce(
  database: FakeDatabase,
  nonce: string,
  verificationToken: string,
): Promise<void> {
  const stored = database.setupNonces.get(await sha256(nonce));
  if (!stored) throw new Error("The test setup nonce is missing");
  stored.verificationTokenHash = await sha256(verificationToken);
  stored.consumedAt = new Date(NOW).toISOString();
}

function receiptKey(provider: string, deliveryId: string): string {
  return `${provider}:${deliveryId}`;
}

function result<T = unknown>(changes: number, rows: T[] = []): D1Result<T> {
  return {
    success: true,
    results: rows,
    meta: { changes } as D1Meta & Record<string, unknown>,
  };
}

async function hmacHex(secret: string, body: ProviderWebhookRawBody): Promise<string> {
  const raw = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body instanceof Uint8Array
      ? body
      : new Uint8Array(body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const exactBytes = new Uint8Array(raw.byteLength);
  exactBytes.set(raw);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, exactBytes.buffer));
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
