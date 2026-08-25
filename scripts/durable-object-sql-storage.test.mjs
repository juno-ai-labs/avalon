import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import { durableObjectSqlStorageRule } from "./eslint-rules/durable-object-sql-storage.mjs";

const config = {
  languageOptions: {
    ecmaVersion: 2024,
    parser: tseslint.parser,
    parserOptions: { sourceType: "module" },
  },
  plugins: { rally: { rules: { "durable-object-sql-storage": durableObjectSqlStorageRule } } },
  rules: { "rally/durable-object-sql-storage": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

test("rejects every Durable Object key-value persistence operation", () => {
  for (const method of ["get", "put", "delete", "list", "transaction"]) {
    const messages = lint(`await this.state.storage.${method}("key")`);
    assert.equal(messages.length, 1, method);
    assert.match(messages[0].message, /SQLite tables only/u);
  }
});

test("rejects computed and optional key-value calls", () => {
  assert.equal(lint(`await state.storage["get"]?.("key")`).length, 1);
  assert.equal(lint(`await ctx?.storage?.put?.("key", value)`).length, 1);
});

test("tracks storage and destructured method aliases", () => {
  assert.equal(lint(`const store = state.storage; await store.get("key")`).length, 1);
  assert.equal(lint(`const store: DurableObjectStorage = state.storage; await store.list()`).length, 1);
  assert.equal(lint(`const { put: persist } = this.state.storage; await persist("key", value)`).length, 1);
});

test("allows explicit SQL plus non-KV Durable Object platform primitives", () => {
  assert.deepEqual(lint(`
    state.storage.sql.exec("SELECT * FROM messages WHERE id = ?", id);
    state.storage.transactionSync(() => state.storage.sql.exec("DELETE FROM messages"));
    await state.storage.getAlarm();
    await state.storage.setAlarm(Date.now() + 30_000);
    await state.storage.deleteAlarm();
    state.acceptWebSocket(socket);
  `), []);
});

test("does not govern unrelated application stores", () => {
  assert.deepEqual(lint(`await cache.get("key"); await database.transaction(work)`), []);
});
