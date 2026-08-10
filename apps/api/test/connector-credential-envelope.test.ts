import { describe, expect, it } from "vitest";
import { decryptString, encryptString } from "../src/lib/crypto";
import { decryptVersionedConnectorCredentials } from "../src/services/connector-credential-envelope";

class RotationStatement {
  private values: unknown[] = [];

  constructor(private readonly database: RotationDatabase) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run<T>(): Promise<D1Result<T>> {
    this.database.update = this.values;
    return {
      success: true,
      results: [],
      meta: { changes: 1 } as D1Meta & Record<string, unknown>,
    };
  }
}

class RotationDatabase {
  update: unknown[] | null = null;

  prepare(sql: string) {
    expect(sql).toContain("WHERE id = ? AND encrypted_credentials = ?");
    return new RotationStatement(this) as unknown as D1PreparedStatement;
  }
}

describe("versioned connector credential envelopes", () => {
  it("decrypts an old version and opportunistically re-encrypts it with the active key", async () => {
    const oldKey = "old-connector-credential-key";
    const activeKey = "active-connector-credential-key";
    const plaintext = JSON.stringify({ accessToken: "secret" });
    const oldEnvelope = await encryptString(plaintext, oldKey, "connection-1");
    const database = new RotationDatabase();

    await expect(decryptVersionedConnectorCredentials({
      DB: database as unknown as D1Database,
      CONNECTOR_CREDENTIALS_KEY: activeKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
      CONNECTOR_CREDENTIALS_KEYS_JSON: JSON.stringify({ 1: oldKey }),
    }, {
      id: "connection-1",
      encrypted_credentials: oldEnvelope.ciphertext,
      credential_iv: oldEnvelope.iv,
      credential_key_version: 1,
    })).resolves.toBe(plaintext);

    expect(database.update).not.toBeNull();
    const [ciphertext, iv, version, , id, previousCiphertext, previousIv, previousVersion] = database.update!;
    expect([version, id, previousCiphertext, previousIv, previousVersion]).toEqual([
      2,
      "connection-1",
      oldEnvelope.ciphertext,
      oldEnvelope.iv,
      1,
    ]);
    await expect(decryptString(String(ciphertext), String(iv), activeKey, "connection-1"))
      .resolves.toBe(plaintext);
  });

  it("fails closed when a row references a retired key that is no longer configured", async () => {
    const oldEnvelope = await encryptString("secret", "retired-key", "connection-2");
    const database = new RotationDatabase();

    await expect(decryptVersionedConnectorCredentials({
      DB: database as unknown as D1Database,
      CONNECTOR_CREDENTIALS_KEY: "active-key",
      CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
    }, {
      id: "connection-2",
      encrypted_credentials: oldEnvelope.ciphertext,
      credential_iv: oldEnvelope.iv,
      credential_key_version: 1,
    })).rejects.toThrow("key version 1 is unavailable");
    expect(database.update).toBeNull();
  });
});
