import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import { durableObjectRegionRoutingRule } from "./eslint-rules/durable-object-region-routing.mjs";

const config = {
  languageOptions: {
    ecmaVersion: 2024,
    parser: tseslint.parser,
    parserOptions: { sourceType: "module" },
  },
  plugins: { avalon: { rules: { "durable-object-region-routing": durableObjectRegionRoutingRule } } },
  rules: { "avalon/durable-object-region-routing": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

test("rejects direct Durable Object namespace routing operations", () => {
  for (const method of ["get", "getByName", "idFromName", "idFromString", "jurisdiction", "newUniqueId"]) {
    const messages = lint(`env.SUBSTREAM_AGENTS.${method}(value)`);
    assert.equal(messages.length, 1, method);
    assert.match(messages[0].message, /durableObjectStubForRegion/u);
  }
  assert.equal(lint(`env.CRASH_SYMBOLICATOR.getByName(crashId)`).length, 1);
});

test("rejects computed, optional, aliased, and typed namespace routing", () => {
  assert.equal(lint(`env.WORKSPACE_DOS["get"]?.(id)`).length, 1);
  assert.equal(lint(`const namespace = env.WORKSTREAM_DOS; namespace.idFromName(name)`).length, 1);
  assert.equal(lint(`const namespace: DurableObjectNamespace = binding; namespace.get(id)`).length, 1);
  assert.equal(lint(`const { getByName: resolve } = env.WORKSPACE_SCHEDULERS; resolve(name)`).length, 1);
  assert.equal(lint(`const { SUBSTREAM_AGENTS: agents } = env; agents.get(id)`).length, 1);
  assert.equal(lint(`function route(namespace: DurableObjectNamespace) { namespace.get(id); }`).length, 1);
  assert.equal(lint(`({ WORKSTREAM_DOS }) => WORKSTREAM_DOS.idFromName(name)`).length, 1);
});

test("rejects a namespace returned from a direct jurisdiction call", () => {
  const messages = lint(`
    const regional = env.SUBSTREAM_AGENTS.jurisdiction("eu");
    regional.getByName(name);
  `);
  assert.equal(messages.length, 2);
});

test("allows the centralized regional stub resolver and unrelated namespaces", () => {
  assert.deepEqual(lint(`
    const stub = durableObjectStubForRegion(
      env.SUBSTREAM_AGENTS,
      env.AVALON_REGION,
      name,
      env.APP_ENV,
    );
    await stub.fetch(request);
    cache.get(key);
  `), []);
});
