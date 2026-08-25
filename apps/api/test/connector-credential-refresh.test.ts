import type { ConnectorConnectionContext } from "@rally/connectors";
import { describe, expect, it, vi } from "vitest";
import { decryptString, encryptString } from "../src/lib/crypto";
import {
  ensureFreshConnectorCredentials,
  type CredentialRefreshAdapter,
} from "../src/services/connector-credential-refresh";
import { createTestD1Database } from "./helpers/cloudflare-test";

interface CredentialRow {
  id: string;
  workspaceId: string;
  encrypted: string;
  iv: string;
  status: string;
  leaseId: string | null;
  leaseExpiresAt: string | null;
}

class CredentialStatement {
  private values: unknown[] = [];
  constructor(private readonly database: CredentialDatabase, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  first<T>() { return this.database.first(this.sql, this.values) as Promise<T | null>; }
  run<T>() { return this.database.run(this.sql, this.values) as Promise<D1Result<T>>; }
}

class CredentialDatabase {
  constructor(readonly row: CredentialRow) {}
  prepare(sql: string) { return new CredentialStatement(this, sql); }

  async first(sql: string, values: unknown[]) {
    if (sql.startsWith("UPDATE connector_connections SET\n         credential_refresh_lease_id")) {
      const [leaseId, leaseExpiresAt, id, workspaceId, at] = values.map(String);
      if (this.row.id !== id || this.row.workspaceId !== workspaceId || this.row.status !== "healthy") return null;
      if (this.row.leaseId && String(this.row.leaseExpiresAt) >= String(at)) return null;
      this.row.leaseId = leaseId!;
      this.row.leaseExpiresAt = leaseExpiresAt!;
      return { encrypted_credentials: this.row.encrypted, credential_iv: this.row.iv, credential_key_version: 1 };
    }
    if (sql.startsWith("SELECT encrypted_credentials")) {
      return this.row.status === "healthy"
        ? { encrypted_credentials: this.row.encrypted, credential_iv: this.row.iv, credential_key_version: 1 }
        : null;
    }
    if (sql.includes("encrypted_credentials = ?") && sql.includes("RETURNING id")) {
      const [encrypted, iv, , , id, workspaceId, leaseId] = values;
      if (this.row.id !== id || this.row.workspaceId !== workspaceId || this.row.leaseId !== leaseId) return null;
      this.row.encrypted = String(encrypted);
      this.row.iv = String(iv);
      this.row.leaseId = null;
      this.row.leaseExpiresAt = null;
      return { id: this.row.id };
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  async run(sql: string, values: unknown[]) {
    if (sql.includes("credential_refresh_lease_id = NULL")) {
      const [id, workspaceId, leaseId] = values;
      if (this.row.id === id && this.row.workspaceId === workspaceId && this.row.leaseId === leaseId) {
        this.row.leaseId = null;
        this.row.leaseExpiresAt = null;
      }
      return d1Result();
    }
    if (sql.includes("status = 'needs_reconnect'")) {
      this.row.status = "needs_reconnect";
      return d1Result();
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

describe("connector credential refresh serialization", () => {
  it("uses a rotating refresh token exactly once across concurrent callers", async () => {
    const secret = "test-connector-credential-key";
    const stale = {
      botAccessToken: "xoxb-old",
      refreshToken: "xoxe-one-use",
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    const encrypted = await encryptString(JSON.stringify(stale), secret, "connection-1");
    const database = new CredentialDatabase({
      id: "connection-1",
      workspaceId: "workspace-1",
      encrypted: encrypted.ciphertext,
      iv: encrypted.iv,
      status: "healthy",
      leaseId: null,
      leaseExpiresAt: null,
    });
    const refreshCredentials = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        botAccessToken: "xoxb-new",
        refreshToken: "xoxe-next",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    });
    const adapter = { refreshCredentials } satisfies CredentialRefreshAdapter;
    const first = connection(stale);
    const second = connection(stale);
    const env = {
      DB: createTestD1Database(database),
      CONNECTOR_CREDENTIALS_KEY: secret,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    };

    await Promise.all([
      ensureFreshConnectorCredentials(env, first, adapter, AbortSignal.timeout(2_000)),
      ensureFreshConnectorCredentials(env, second, adapter, AbortSignal.timeout(2_000)),
    ]);

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(first.credentials).toMatchObject({ botAccessToken: "xoxb-new", refreshToken: "xoxe-next" });
    expect(second.credentials).toMatchObject({ botAccessToken: "xoxb-new", refreshToken: "xoxe-next" });
    await expect(decryptString(database.row.encrypted, database.row.iv, secret, "connection-1"))
      .resolves.toContain("xoxe-next");
  });
});

function connection(credentials: Record<string, unknown>): ConnectorConnectionContext {
  return {
    id: "connection-1",
    workspaceId: "workspace-1",
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: [],
    credentials: { ...credentials },
    cursor: {},
    config: {},
  };
}

function d1Result<T = unknown>(): D1Result<T> {
  return { success: true, results: [], meta: { changes: 1 } as D1Meta & Record<string, unknown> };
}
