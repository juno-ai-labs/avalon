// The operator side of API tokens: the token's format and hash, and the SQL the
// script hands Wrangler, run against every checked-in regional migration.
// apps/api/test/api-token-exchange.test.ts exchanges the same literal token
// against the same literal hash, which is what ties the two halves together.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, listMigrationFiles } from "./d1-baseline.mjs";
import { mintSql, newApiToken, parseArguments, revokeSql } from "./api-token.mjs";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "migrations");

function migrated() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, MIGRATIONS, listMigrationFiles(MIGRATIONS));
  database.exec(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
    ('user-bot', NULL, 'bot@example.test', 'Bot', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    ('user-other', NULL, 'other@example.test', 'Other', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO sessions (id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at) VALUES
    ('session-bot', 'user-bot', NULL, 'global', 'hash-bot', '2027-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    ('session-other', 'user-other', NULL, 'global', 'hash-other', '2027-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');`);
  return database;
}

test("a token is the prefix and 32 random bytes, hashed the way the API hashes", () => {
  assert.deepEqual(newApiToken(Buffer.alloc(32, 7)), {
    token: "rally_at_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    tokenHash: "UIp8zbX_BEnmVIs6pPnPlPQXdwA3IH5ABDWmRYClx6U",
  });
});

test("mint inserts for the user with that address, case-insensitively, and for no one else", () => {
  const database = migrated();
  database.exec(mintSql({
    id: "token-1", email: "BOT@example.test", label: "nightly e2e", tokenHash: "hash-1",
    createdAt: "2026-10-06T00:00:00.000Z", expiresAt: undefined,
  }));
  database.exec(mintSql({
    id: "token-2", email: "nobody@example.test", label: "x", tokenHash: "hash-2",
    createdAt: "2026-10-06T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z",
  }));
  assert.deepEqual(database.prepare("SELECT id, user_id, token_hash, label, expires_at FROM api_tokens").all().map((row) => ({ ...row })), [
    { id: "token-1", user_id: "user-bot", token_hash: "hash-1", label: "nightly e2e", expires_at: null },
  ]);
});

test("a label with a quote is stored as text, not as SQL", () => {
  const database = migrated();
  database.exec(mintSql({
    id: "token-1", email: "bot@example.test", label: "o'clock', 'x", tokenHash: "hash-1",
    createdAt: "2026-10-06T00:00:00.000Z", expiresAt: undefined,
  }));
  assert.equal(database.prepare("SELECT label FROM api_tokens").get().label, "o'clock', 'x");
});

test("revoke stops the token, and signing out everywhere revokes only its user's sessions", () => {
  const database = migrated();
  database.exec(mintSql({
    id: "token-1", email: "bot@example.test", label: "e2e", tokenHash: "hash-1",
    createdAt: "2026-10-06T00:00:00.000Z", expiresAt: undefined,
  }));
  database.exec(revokeSql({ id: "token-1", signOutEverywhere: false, revokedAt: "2026-10-07T00:00:00.000Z" }));
  assert.equal(database.prepare("SELECT revoked_at FROM api_tokens").get().revoked_at, "2026-10-07T00:00:00.000Z");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NOT NULL").get().n, 0);

  database.exec(revokeSql({ id: "token-1", signOutEverywhere: true, revokedAt: "2026-10-08T00:00:00.000Z" }));
  assert.deepEqual(database.prepare("SELECT id, revoked_at FROM sessions ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "session-bot", revoked_at: "2026-10-08T00:00:00.000Z" },
    { id: "session-other", revoked_at: null },
  ]);
  // The first revocation's time stands.
  assert.equal(database.prepare("SELECT revoked_at FROM api_tokens").get().revoked_at, "2026-10-07T00:00:00.000Z");
});

test("arguments: each command requires what it acts on", () => {
  assert.deepEqual(parseArguments(["mint", "--email", "bot@example.test", "--label", "e2e", "--expires-at", "2027-01-01", "--remote"]), {
    command: "mint", remote: true, region: "global", signOutEverywhere: false,
    email: "bot@example.test", label: "e2e", expiresAt: "2027-01-01T00:00:00.000Z",
  });
  assert.throws(() => parseArguments(["mint", "--email", "bot@example.test"]), /mint needs --label/u);
  assert.throws(() => parseArguments(["mint", "--email", "a@b.c", "--label", "x", "--expires-at", "soon"]), /ISO 8601/u);
  assert.throws(() => parseArguments(["revoke"]), /revoke needs --id/u);
  assert.throws(() => parseArguments(["delete"]), /Usage/u);
});
