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

const FIXTURE = "durable-object-sync-transaction-fixture.ts";

// The rule asks the type checker whether a callback returns a Promise, so every
// case below is linted with a program behind it — the state `eslint.config.mjs`
// arranges for `apps/api/src`, which is the only place the rule is enabled.
// `lintWithoutTypes` exists for the one test that proves the missing-program
// path fails loudly instead of passing everything.
const typedConfig = [{
  files: ["**/*.ts"],
  languageOptions: {
    ecmaVersion: 2024,
    parser: tseslint.parser,
    parserOptions: {
      sourceType: "module",
      projectService: { allowDefaultProject: [FIXTURE] },
      tsconfigRootDir: process.cwd(),
    },
  },
  plugins: plugin,
  rules: { "rally/durable-object-sync-transaction": "error" },
}];

const untypedConfig = {
  languageOptions: {
    ecmaVersion: 2024,
    parser: tseslint.parser,
    parserOptions: { sourceType: "module" },
  },
  plugins: plugin,
  rules: { "rally/durable-object-sync-transaction": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, typedConfig, { filename: FIXTURE });
}

function lintWithoutTypes(source) {
  return new Linter({ configType: "flat" }).verify(source, untypedConfig);
}

test("rejects explicitly async callbacks at every synchronous Durable Object boundary", () => {
  const messages = lint(`
    declare const storage: any, product: any, objectStore: any;
    declare function prepare(): Promise<string>;
    storage.transactionSync(async () => prepare());
    product.commitRuntimeMutation(async () => prepare(), true);
    objectStore["commitWithRegionalEffects"](async function () { return prepare(); }, []);
  `);
  assert.equal(messages.length, 3);
  for (const message of messages) assert.match(message.message, /completes synchronously/u);
});

test("uses TypeScript return types to reject indirect Promise callbacks", () => {
  const messages = lint(`
    declare const storage: any, product: any, objectStore: any;
    declare function prepare(): Promise<string>;
    const indirect = () => prepare();
    storage.transactionSync(() => prepare());
    product.commitRuntimeMutation(indirect, true);
    objectStore.commitWithRegionalEffects((): string | Promise<string> => "ready", []);
  `);
  assert.equal(messages.length, 3);
});

test("allows synchronous SQLite callbacks and unrelated async APIs", () => {
  assert.deepEqual(lint(`
    declare const storage: any, product: any, objectStore: any, queue: any;
    declare function prepare(): Promise<string>;
    storage.transactionSync(() => storage.sql.exec("DELETE FROM messages"));
    product.commitRuntimeMutation(() => ({ committed: true }), true);
    objectStore.commitWithRegionalEffects(function () { return 1; }, []);
    queue.consume(async () => prepare());
  `), []);
});

// Type information is scoped in `eslint.config.mjs` rather than enabled
// repository-wide, because opening a TypeScript program is the largest single
// cost in a lint run. That makes a config that enables this rule on untyped
// files a mistake worth failing on: reporting nothing there is indistinguishable
// from finding nothing wrong.
test("fails loudly when it is enabled on files no program covers", () => {
  assert.throws(
    () => lintWithoutTypes(`storage.transactionSync(() => prepare());`),
    /needs type information/u,
  );
});

test("still reads an explicitly async callback without a program", () => {
  // The syntactic half needs no checker, so it must not trip the guard above.
  const messages = lintWithoutTypes(`storage.transactionSync(async () => prepare());`);
  assert.equal(messages.length, 1);
});
