import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * `sync-dev-env.mjs` writes `.dev.vars.<region>` by iterating `workerKeys`, so a
 * value it computes but does not list there is discarded without a warning. That
 * is not hypothetical: `NOTION_INGRESS_BASE_URL` shipped computed-and-dropped,
 * and because the connector's redirect URI is derived from it, local
 * authorization silently addressed production instead.
 *
 * These are source-level checks rather than behavioural ones because the script
 * runs its work at import: it reads `.env.local` and writes both regional files
 * as a side effect, so it cannot be imported into a test process.
 */
const source = readFileSync(
  fileURLToPath(new URL("./sync-dev-env.mjs", import.meta.url)),
  "utf8",
);

function block(name, open, close) {
  const pattern = new RegExp(`const ${name} = \\${open}(.*?)\\n\\${close};`, "su");
  const match = pattern.exec(source);
  assert.ok(match, `sync-dev-env.mjs no longer declares ${name}`);
  return match[1];
}

const workerKeys = new Set([...block("workerKeys", "[", "]").matchAll(/"([^"]+)"/gu)].map((m) => m[1]));

test("every key the script assigns onto a region is serialized", () => {
  const assigned = [...source.matchAll(/regional\.([A-Z0-9_]+)\s*(?:\|\|=|=)/gu)].map((m) => m[1]);
  assert.ok(assigned.length > 0, "expected the script to assign regional values");
  const dropped = [...new Set(assigned)].filter((key) => !workerKeys.has(key)).sort();
  assert.deepEqual(dropped, [], `computed but never written to .dev.vars: ${dropped.join(", ")}`);
});

test("every safe default is serialized", () => {
  const defaults = [...block("safeDefaults", "{", "}").matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gmu)].map((m) => m[1]);
  assert.ok(defaults.length > 0, "expected safe defaults to be declared");
  const dropped = defaults.filter((key) => !workerKeys.has(key)).sort();
  assert.deepEqual(dropped, [], `defaulted but never written to .dev.vars: ${dropped.join(", ")}`);
});

test("the Notion ingress URL is serialized and derived from the region's own API", () => {
  assert.ok(
    workerKeys.has("NOTION_INGRESS_BASE_URL"),
    "NOTION_INGRESS_BASE_URL must be in workerKeys or local Notion OAuth addresses production",
  );
  assert.match(
    source,
    /regional\.NOTION_INGRESS_BASE_URL\s*=\s*local\.NOTION_INGRESS_BASE_URL\s*\|\|\s*regional\.PUBLIC_API_BASE_URL;/u,
    "each region's development ingress must default to that region's own Worker",
  );
});


test("Daytona Terminal configuration reaches each regional development Worker", () => {
  const regionalizable = new Set(
    [...block("regionalizableKeys", "[", "]").matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
  );
  const expected = [
    "TERMINAL_REGION_CAPABILITY",
    "DAYTONA_API_KEY",
    "DAYTONA_API_URL",
    "DAYTONA_TARGET",
    "DAYTONA_TERMINAL_SNAPSHOT",
    "TERMINAL_EMERGENCY_DISABLED",
  ];
  assert.deepEqual(
    expected.filter((key) => !workerKeys.has(key)),
    [],
    "Terminal configuration in .env.local must be written to .dev.vars",
  );
  assert.deepEqual(
    expected.filter((key) => !regionalizable.has(key)),
    [],
    "Terminal configuration must support independent configured deployment values",
  );
});
