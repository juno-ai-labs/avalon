import assert from "node:assert/strict";
import test from "node:test";

import {
  importableStatements,
  parseArguments,
  resolveLocalDatabase,
} from "./preview-digest-email.mjs";

test("defaults to the local D1 and a scratch output directory", () => {
  assert.deepEqual(parseArguments([]), { db: null, sql: null, out: "/tmp/digest-preview" });
});

test("takes an explicit database and output directory", () => {
  assert.deepEqual(
    parseArguments(["--db", "/tmp/global.sqlite", "--out", "/tmp/preview"]),
    { db: "/tmp/global.sqlite", sql: null, out: "/tmp/preview" },
  );
});

test("refuses a flag whose value is the next flag rather than reading a file named --out", () => {
  assert.throws(() => parseArguments(["--sql", "--out", "/tmp/preview"]), /--sql needs a value/u);
  assert.throws(() => parseArguments(["--db"]), /--db needs a value/u);
});

test("picks the D1 file rather than Miniflare's metadata database", () => {
  const resolved = resolveLocalDatabase("/state", ["metadata.sqlite", "aa.sqlite", "bb.sqlite", "notes.txt"]);

  assert.equal(resolved, "/state/bb.sqlite");
});

test("reports no database rather than guessing when the directory is empty", () => {
  assert.equal(resolveLocalDatabase("/state", ["metadata.sqlite"]), null);
});

test("takes a Wrangler dump so a remote workspace needs no sqlite3 binary", () => {
  assert.deepEqual(
    parseArguments(["--sql", "/tmp/global.sql"]),
    { db: null, sql: "/tmp/global.sql", out: "/tmp/digest-preview" },
  );
});

test("drops the parts of a dump a fresh in-memory database cannot replay", () => {
  const statements = importableStatements([
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
    "CREATE TABLE users (id TEXT PRIMARY KEY);",
    "INSERT INTO users VALUES ('a');",
    "COMMIT;",
  ].join("\n"));

  assert.deepEqual(statements, [
    "CREATE TABLE users (id TEXT PRIMARY KEY)",
    "INSERT INTO users VALUES ('a')",
  ]);
});
