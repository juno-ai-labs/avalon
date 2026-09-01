import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import { preferZodDirectObjectRule } from "./eslint-rules/prefer-zod-direct-object.mjs";

function lint(source, fix = false) {
  const linter = new Linter({ configType: "flat" });
  const config = {
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { rally: { rules: { "prefer-zod-direct-object": preferZodDirectObjectRule } } },
    rules: { "rally/prefer-zod-direct-object": "error" },
  };
  return fix ? linter.verifyAndFix(source, config) : linter.verify(source, config);
}

test("reports direct chained Zod object modes", () => {
  for (const source of [
    'import { z } from "zod"; const schema = z.object({ value: z.string() }).strict();',
    'import { z as schema } from "zod"; const value = schema.object({}).passthrough();',
    'import * as z from "zod"; const value = z.object({})["strict"]();',
    'import z from "zod"; const value = z.object({}).strict();',
    'import { z } from "zod"; const value = z.object({}).loose();',
  ]) {
    const messages = lint(source);
    assert.equal(messages.length, 1, source);
    assert.equal(messages[0].ruleId, "rally/prefer-zod-direct-object");
  }
});

test("classifies the enforced startup-allocation guard as a problem", () => {
  assert.equal(preferZodDirectObjectRule.meta.type, "problem");
});

test("autofixes direct chained Zod object modes without disturbing later chains", () => {
  const strict = lint(
    'import { z } from "zod"; const schema = z.object({ value: z.string() }).strict().optional();',
    true,
  );
  assert.equal(strict.fixed, true);
  assert.equal(
    strict.output,
    'import { z } from "zod"; const schema = z.strictObject({ value: z.string() }).optional();',
  );

  const loose = lint(
    'import * as schema from "zod"; const value = schema["object"]({}).passthrough();',
    true,
  );
  assert.equal(loose.fixed, true);
  assert.equal(loose.output, 'import * as schema from "zod"; const value = schema.looseObject({});');

  const commented = lint(
    'import { z } from "zod"; const value = z.object({}) /* keep this rationale */ .strict();',
    true,
  );
  assert.equal(commented.fixed, true);
  assert.equal(
    commented.output,
    'import { z } from "zod"; const value = z.strictObject({}) /* keep this rationale */ ;',
  );

  for (const [source, expected] of [
    [
      'import { z } from "zod"; const value = (z.object({})).strict();',
      'import { z } from "zod"; const value = (z.strictObject({}));',
    ],
    [
      'import { z } from "zod"; const value = (z.object({})).passthrough();',
      'import { z } from "zod"; const value = (z.looseObject({}));',
    ],
    [
      'import { z } from "zod"; const value = z.object({}).loose();',
      'import { z } from "zod"; const value = z.looseObject({});',
    ],
    [
      'import { z } from "zod"; const value = z.object().strict();',
      'import { z } from "zod"; const value = z.strictObject({});',
    ],
    [
      'import { z } from "zod"; const value = z.object().passthrough();',
      'import { z } from "zod"; const value = z.looseObject({});',
    ],
    [
      'import z from "zod"; const value = z.object({}).strict();',
      'import z from "zod"; const value = z.strictObject({});',
    ],
  ]) {
    const result = lint(source, true);
    assert.equal(result.fixed, true, source);
    assert.equal(result.output, expected, source);
    assert.deepEqual(result.messages, [], source);
  }
});

test("leaves non-Zod and non-direct object-mode chains alone", () => {
  for (const source of [
    'import { z } from "other"; const schema = z.object({}).strict();',
    'import { z } from "zod"; const base = z.object({}); const schema = base.strict();',
    'import { z } from "zod"; const schema = z.object({}).catchall(z.string()).strict();',
    'import { z } from "zod"; function build(z) { return z.object({}).strict(); }',
    'import { z } from "zod"; const schema = z.strictObject({});',
    'import { z } from "zod"; const schema = z.looseObject({});',
  ]) {
    assert.deepEqual(lint(source), [], source);
  }
});
