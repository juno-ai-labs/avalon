import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import {
  noApplicationContractTestCastRule,
  noDirectCloudflareTestCastRule,
  noProductionDoubleAssertionRule,
} from "./eslint-rules/type-assertion-boundaries.mjs";

const rules = {
  "no-application-contract-test-cast": noApplicationContractTestCastRule,
  "no-direct-cloudflare-test-cast": noDirectCloudflareTestCastRule,
  "no-production-double-assertion": noProductionDoubleAssertionRule,
};

function lint(source, enabled) {
  return new Linter({ configType: "flat" }).verify(source, {
    languageOptions: {
      ecmaVersion: 2024,
      parser: tseslint.parser,
      parserOptions: { sourceType: "module" },
    },
    plugins: { rally: { rules } },
    rules: { [`rally/${enabled}`]: "error" },
  });
}

test("production code cannot erase a value before asserting another type", () => {
  assert.equal(lint("value as unknown as Contract", "no-production-double-assertion").length, 1);
  assert.deepEqual(lint("schema.parse(value)", "no-production-double-assertion"), []);
  assert.deepEqual(lint("value as Contract", "no-production-double-assertion"), []);
});

test("test doubles cannot assert past application-owned contracts", () => {
  for (const source of [
    'import type { Client as Port } from "@rally/contracts"; const client = {} as unknown as Port;',
    'import { operation } from "../src/service"; value as unknown as Parameters<typeof operation>[0];',
    'window.avalon = { copyText } as unknown as typeof window.avalon;',
  ]) {
    assert.equal(lint(source, "no-application-contract-test-cast").length, 1, source);
  }
  assert.deepEqual(
    lint('import type { Client } from "../src/client"; const client = {} satisfies Pick<Client, "read">;', "no-application-contract-test-cast"),
    [],
  );
  assert.deepEqual(
    lint('import type { Row } from "../src/store"; decoded as Row;', "no-application-contract-test-cast"),
    [],
  );
});

test("Cloudflare runtime casts stay inside typed test builders", () => {
  for (const source of [
    "value as Env",
    "value as unknown as D1Database",
    "value as D1Result<Row>[]",
    "value as unknown as R2Bucket",
  ]) {
    assert.equal(lint(source, "no-direct-cloudflare-test-cast").length, 1, source);
  }
  assert.deepEqual(
    lint("createTestEnv({ DB: createTestD1Database(database) })", "no-direct-cloudflare-test-cast"),
    [],
  );
  assert.deepEqual(lint('"prod" as Env["APP_ENV"]', "no-direct-cloudflare-test-cast"), []);
});
