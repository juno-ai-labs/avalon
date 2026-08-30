import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { decryptString, encryptString } from "../src/lib/crypto";
import { decryptVersionedConnectorCredentials } from "../src/services/connector-credential-envelope";
import { connectionObjectFixture, storedConnectionEnvelope } from "./helpers/connection-object";

/**
 * The opportunistic re-encryption is a compare-and-set against the exact
 * envelope it decrypted, and it runs against a real WorkspaceDO here.
 *
 * It used to run against a hand-written `D1Database` that asserted on the SQL
 * text — `expect(sql).toContain("WHERE id = ? AND encrypted_credentials = ?")`
 * — and recorded the bindings for the test to unpack positionally. That could
 * only ever check that the statement looked right, never that the predicate
 * did anything: the fake applied no predicate at all, so a rotation that
 * should have lost to a concurrent write would have been recorded as a win.
 */
const WORKSPACE = "00000000-0000-7000-8000-0000000e0001";
const CONNECTION = "00000000-0000-7000-8000-0000000e0002";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("versioned connector credential envelopes", () => {
  it("decrypts an old version and opportunistically re-encrypts it with the active key", async () => {
    const oldKey = "old-connector-credential-key";
    const activeKey = "active-connector-credential-key";
    const plaintext = JSON.stringify({ accessToken: "secret" });
    const oldEnvelope = await encryptString(plaintext, oldKey, CONNECTION);
    const { env, objectDatabase } = connectionObjectFixture({
      workspaceId: WORKSPACE,
      connectionId: CONNECTION,
      credentials: { ciphertext: oldEnvelope.ciphertext, iv: oldEnvelope.iv, keyVersion: 1 },
      env: {
        CONNECTOR_CREDENTIALS_KEY: activeKey,
        CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
        CONNECTOR_CREDENTIALS_KEYS_JSON: JSON.stringify({ 1: oldKey }),
      },
      register: (database) => { databases.push(database); },
    });

    await expect(decryptVersionedConnectorCredentials(env, {
      id: CONNECTION,
      workspace_id: WORKSPACE,
      encrypted_credentials: oldEnvelope.ciphertext,
      credential_iv: oldEnvelope.iv,
      credential_key_version: 1,
    })).resolves.toBe(plaintext);

    const stored = storedConnectionEnvelope(objectDatabase, CONNECTION);
    expect(stored.credential_key_version).toBe(2);
    expect(stored.encrypted_credentials).not.toBe(oldEnvelope.ciphertext);
    await expect(decryptString(
      String(stored.encrypted_credentials),
      String(stored.credential_iv),
      activeKey,
      CONNECTION,
    )).resolves.toBe(plaintext);
  });

  it("leaves the row alone when another writer replaced the envelope first", async () => {
    // The property the SQL-shape assertion could not reach. A rotation holds
    // plaintext decrypted from an envelope that an OAuth completion has since
    // replaced; writing anyway would store ciphertext the stored IV cannot
    // open, and the connection would need reconnecting to recover.
    const oldKey = "old-connector-credential-key";
    const activeKey = "active-connector-credential-key";
    const plaintext = JSON.stringify({ accessToken: "secret" });
    const staleEnvelope = await encryptString(plaintext, oldKey, CONNECTION);
    const winner = await encryptString(JSON.stringify({ accessToken: "newer" }), activeKey, CONNECTION);
    const { env, objectDatabase } = connectionObjectFixture({
      workspaceId: WORKSPACE,
      connectionId: CONNECTION,
      credentials: { ciphertext: winner.ciphertext, iv: winner.iv, keyVersion: 2 },
      env: {
        CONNECTOR_CREDENTIALS_KEY: activeKey,
        CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
        CONNECTOR_CREDENTIALS_KEYS_JSON: JSON.stringify({ 1: oldKey }),
      },
      register: (database) => { databases.push(database); },
    });

    await expect(decryptVersionedConnectorCredentials(env, {
      id: CONNECTION,
      workspace_id: WORKSPACE,
      encrypted_credentials: staleEnvelope.ciphertext,
      credential_iv: staleEnvelope.iv,
      credential_key_version: 1,
    })).resolves.toBe(plaintext);

    expect(storedConnectionEnvelope(objectDatabase, CONNECTION)).toEqual({
      encrypted_credentials: winner.ciphertext,
      credential_iv: winner.iv,
      credential_key_version: 2,
    });
  });

  it("fails closed when a row references a retired key that is no longer configured", async () => {
    const oldEnvelope = await encryptString("secret", "retired-key", CONNECTION);
    const { env, objectDatabase } = connectionObjectFixture({
      workspaceId: WORKSPACE,
      connectionId: CONNECTION,
      credentials: { ciphertext: oldEnvelope.ciphertext, iv: oldEnvelope.iv, keyVersion: 1 },
      env: {
        CONNECTOR_CREDENTIALS_KEY: "active-key",
        CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
      },
      register: (database) => { databases.push(database); },
    });

    await expect(decryptVersionedConnectorCredentials(env, {
      id: CONNECTION,
      workspace_id: WORKSPACE,
      encrypted_credentials: oldEnvelope.ciphertext,
      credential_iv: oldEnvelope.iv,
      credential_key_version: 1,
    })).rejects.toThrow("key version 1 is unavailable");
    expect(storedConnectionEnvelope(objectDatabase, CONNECTION).credential_key_version).toBe(1);
  });
});
