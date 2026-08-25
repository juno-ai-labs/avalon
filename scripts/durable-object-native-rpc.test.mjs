import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import { durableObjectNativeRpcRule } from "./eslint-rules/durable-object-native-rpc.mjs";

const config = {
  languageOptions: {
    ecmaVersion: 2024,
    parser: tseslint.parser,
    parserOptions: { sourceType: "module" },
  },
  plugins: { rally: { rules: { "durable-object-native-rpc": durableObjectNativeRpcRule } } },
  rules: { "rally/durable-object-native-rpc": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

test("rejects internal Durable Object fetch calls", () => {
  assert.equal(lint(`
    const stub = await durableObjectStubForWorkspace(env, namespace, workspaceId, name);
    await stub.fetch("https://room.internal/internal/events", init);
  `).length, 1);
  assert.equal(lint(`
    function deliver(stub: DurableObjectStub) {
      return stub["fetch"](new Request("https://room.internal/internal/events"));
    }
  `).length, 1);
  assert.equal(lint(`
    const stub = await durableObjectStubForWorkspace(env, namespace, workspaceId, name);
    const endpoint = "https://room.internal/internal/events";
    await stub.fetch(endpoint, init);
  `).length, 1);
  assert.equal(lint(`
    const stub = await durableObjectStubForWorkspace(env, namespace, workspaceId, name);
    const endpoint = "https://room.internal/internal/events";
    const request = new Request(endpoint, init);
    await stub.fetch(request);
  `).length, 1);
});

test("allows WebSocket upgrades and ordinary external HTTP", () => {
  assert.deepEqual(lint(`
    const stub = await durableObjectStubForWorkspace(env, namespace, workspaceId, name);
    await stub.fetch(new Request("https://room.internal/socket", init));
    await client.fetch("https://provider.example/v1/messages", init);
    await client.fetch("https://provider.example/internal/metadata", init);
    let mutableEndpoint = "https://provider.example/v1/messages";
    mutableEndpoint = getNextEndpoint();
    await client.fetch(mutableEndpoint, init);
  `), []);
});
