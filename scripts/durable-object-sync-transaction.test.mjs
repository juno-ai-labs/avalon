import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import { durableObjectSyncTransactionRule } from "./eslint-rules/durable-object-sync-transaction.mjs";

const plugin = {
  rally: {
    rules: { "durable-object-sync-transaction": durableObjectSyncTransactionRule },
  },
};

const baseConfig = {
  languageOptions: {
    ecmaVersion: 2024,
    parser: tseslint.parser,
    parserOptions: { sourceType: "module" },
  },
  plugins: plugin,
  rules: { "rally/durable-object-sync-transaction": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, baseConfig);
}

test("rejects explicitly async callbacks at every synchronous Durable Object boundary", () => {
  const messages = lint(`
    storage.transactionSync(async () => prepare());
    product.commitRuntimeMutation(async () => prepare(), true);
    objectStore["commitWithRegionalEffects"](async function () { return prepare(); }, []);
  `);
  assert.equal(messages.length, 3);
  for (const message of messages) assert.match(message.message, /completes synchronously/u);
});

test("uses TypeScript return types to reject indirect Promise callbacks", () => {
  const config = [{
    files: ["**/*.ts"],
    ...baseConfig,
    languageOptions: {
      ...baseConfig.languageOptions,
      parserOptions: {
        sourceType: "module",
        projectService: { allowDefaultProject: ["durable-object-sync-transaction-fixture.ts"] },
        tsconfigRootDir: process.cwd(),
      },
    },
  }];
  const messages = new Linter({ configType: "flat" }).verify(`
    declare function prepare(): Promise<string>;
    const indirect = () => prepare();
    storage.transactionSync(() => prepare());
    product.commitRuntimeMutation(indirect, true);
    objectStore.commitWithRegionalEffects((): string | Promise<string> => "ready", []);
  `, config, { filename: "durable-object-sync-transaction-fixture.ts" });
  assert.equal(messages.length, 3);
});

test("allows synchronous SQLite callbacks and unrelated async APIs", () => {
  assert.deepEqual(lint(`
    storage.transactionSync(() => storage.sql.exec("DELETE FROM messages"));
    product.commitRuntimeMutation(() => ({ committed: true }), true);
    objectStore.commitWithRegionalEffects(function () { return 1; }, []);
    queue.consume(async () => prepare());
  `), []);
});
