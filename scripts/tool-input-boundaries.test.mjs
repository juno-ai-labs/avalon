import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";

import { toolInputNumberBoundaryRule } from "./eslint-rules/tool-input-boundaries.mjs";

const config = {
  languageOptions: { ecmaVersion: 2024, sourceType: "module" },
  plugins: { rally: { rules: { "tool-input-number-boundary": toolInputNumberBoundaryRule } } },
  rules: { "rally/tool-input-number-boundary": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

test("accepts strict numeric tool fields", () => {
  assert.deepEqual(lint(`
    import { z } from "zod";
    const Args = z.object({ page: z.number().int().positive() });
    const tool = { inputSchema: z.toJSONSchema(Args) };
  `), []);
});

test("rejects permissive Zod number coercion in a tool module", () => {
  const messages = lint(`
    import { z } from "zod";
    const Args = z.object({ page: z.coerce.number().int().positive() });
    const tool = { inputSchema: z.toJSONSchema(Args) };
  `);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /strict z\.number/u);
});

test("rejects an aliased direct Zod coerce import", () => {
  const messages = lint(`
    import { z, coerce as convert } from "zod";
    const Args = convert.number();
    const tool = { inputSchema: z.toJSONSchema(Args) };
  `);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /ambiguous values/u);
});

test("does not govern non-tool request parsing", () => {
  assert.deepEqual(lint(`
    import { z } from "zod";
    const Query = z.object({ page: z.coerce.number().int().positive() });
    router.get("/items", (request) => Query.parse(request.query));
  `), []);
});

test("does not govern unrelated request parsing in a tool module", () => {
  assert.deepEqual(lint(`
    import { z } from "zod";
    const Query = z.object({ page: z.coerce.number().int().positive() });
    const Args = z.object({ resourceId: z.string() });
    const tool = { inputSchema: z.toJSONSchema(Args) };
    router.get("/items", (request) => Query.parse(request.query));
  `), []);
});

test("rejects a number-or-string compatibility union in a raw tool schema", () => {
  const messages = lint(`
    const numericCompatibility = { type: ["integer", "string"] };
    const tool = {
      inputSchema: {
        type: "object",
        properties: { page: numericCompatibility }
      }
    };
  `);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /number\/integer only/u);
});

test("allows nullability without advertising string compatibility", () => {
  assert.deepEqual(lint(`
    const tool = {
      inputSchema: { type: "object", properties: { page: { type: ["integer", "null"] } } }
    };
  `), []);
});

test("allows genuinely multi-type values such as spreadsheet cells", () => {
  assert.deepEqual(lint(`
    const tool = {
      inputSchema: {
        type: "object",
        properties: {
          value: { type: ["string", "number", "boolean", "null"] }
        }
      }
    };
  `), []);
});
