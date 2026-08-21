import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./open-local-authority.mjs", import.meta.url), "utf8");

test("workspace authority upsert disambiguates SELECT from ON CONFLICT", () => {
  assert.match(
    source,
    /FROM workspaces\s+WHERE 1\s+ON CONFLICT\(workspace_id\) DO UPDATE/u,
    "SQLite requires a WHERE clause before the UPSERT when INSERT SELECT has a FROM clause",
  );
});
