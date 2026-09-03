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
  plugins: { rally: { rules: { "durable-object-region-routing": durableObjectRegionRoutingRule } } },
  rules: { "rally/durable-object-region-routing": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

test("rejects direct Durable Object namespace routing operations", () => {
  for (const method of ["get", "getByName", "idFromName", "idFromString", "jurisdiction", "newUniqueId"]) {
    const messages = lint(`env.SUBSTREAM_AGENTS.${method}(value)`);
    assert.equal(messages.length, 1, method);
    assert.match(messages[0].message, /durableObjectStubForWorkspace/u);
  }
  assert.equal(lint(`env.CRASH_SYMBOLICATOR.getByName(crashId)`).length, 1);
});

test("rejects computed, optional, aliased, and typed namespace routing", () => {
  assert.equal(lint(`env.WORKSPACE_DOS["get"]?.(id)`).length, 1);
  assert.equal(lint(`const namespace = env.WORKSTREAM_DOS; namespace.idFromName(name)`).length, 1);
  assert.equal(lint(`const namespace: DurableObjectNamespace = binding; namespace.get(id)`).length, 1);
  assert.equal(lint(`const { getByName: resolve } = env.WORKSTREAM_DOS; resolve(name)`).length, 1);
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

test("rejects the low-level regional resolver outside its boundary", () => {
  assert.equal(lint(`durableObjectStubForRegion(namespace, region, name, environment, hint)`).length, 1);
});

test("allows the centralized workspace and singleton resolvers and unrelated namespaces", () => {
  assert.deepEqual(lint(`
    const stub = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, workspaceId, name);
    const singleton = durableObjectStubForRegionalSingleton(env, env.CRASH_SYMBOLICATOR, crashId);
    await stub.fetch(request);
    await singleton.fetch(request);
    cache.get(key);
  `), []);
});
