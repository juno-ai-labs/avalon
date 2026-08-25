import assert from "node:assert/strict";
import test from "node:test";

import {
  importableStatements,
  parseArguments,
  resolveLocalDatabase,
  sampleBody,
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

test("exercises the shapes the template has to survive", () => {
  const body = sampleBody({
    workstreams: [
      { id: "00000000-0000-4000-8000-000000000001", title: "Prepare the Acme follow-up" },
      { id: "00000000-0000-4000-8000-000000000002", title: "Investigate ENG-142" },
    ],
    otherName: "Samantha Lee",
    highlightCount: 1,
  });

  // A preview that only shows plain bullets proves nothing about the template.
  assert.match(body, /^## Needs you$/mu);
  assert.match(body, /\[Prepare the Acme follow-up\]\(https:\/\/rallywith\.ai\/app\/workstreams\//u);
  assert.match(body, /^> /mu);
  assert.match(body, /\*\*Owner still unassigned\.\*\*/u);
});

test("omits the priority section when nothing names the reader", () => {
  const body = sampleBody({
    workstreams: [{ id: null, title: "Investigate ENG-142" }],
    otherName: "Samantha Lee",
    highlightCount: 0,
  });

  assert.doesNotMatch(body, /## Needs you/u);
  // With no id there is nothing to link to, so the name is emphasized instead
  // of being turned into a URL that does not exist.
  assert.doesNotMatch(body, /\]\(https/u);
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
