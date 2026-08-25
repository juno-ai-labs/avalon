import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import {
  measureProviderJsonSchema,
  providerJsonSchemaComplexityRule,
} from "./eslint-rules/provider-json-schema-complexity.mjs";

const config = {
  languageOptions: { ecmaVersion: 2024, sourceType: "module" },
  plugins: { rally: { rules: { "provider-json-schema-complexity": providerJsonSchemaComplexityRule } } },
  rules: { "rally/provider-json-schema-complexity": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

test("accepts a structural model-facing schema", () => {
  const messages = lint(`
    const outputJsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        decisions: {
          type: "array",
          items: { type: "object", properties: { action: { type: "string", enum: ["add", "ignore"] } } }
        }
      },
      required: ["decisions"]
    };
    client.structured({ jsonSchema: outputJsonSchema });
  `);
  assert.deepEqual(messages, []);
});

test("rejects nested bounded arrays with explosive constrained-decoding state", () => {
  const messages = lint(`
    const outputJsonSchema = {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            properties: { linkedUsers: { type: "array", maxItems: 30, items: { type: "string" } } }
          }
        }
      }
    };
    client.structured({ jsonSchema: outputJsonSchema });
  `);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /nested bounded-array expansion 120 > 64/u);
});

test("rejects a provider schema with too many detailed constraints", () => {
  const constrainedProperties = Array.from({ length: 11 }, (_, index) =>
    `field${index}: { type: "string", maxLength: ${index + 1} }`,
  ).join(",");
  const messages = lint(`
    const outputJsonSchema = { type: "object", properties: { ${constrainedProperties} } };
    client.structured({ jsonSchema: outputJsonSchema });
  `);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /constraints 11 > 10/u);
});

test("measures depth and schema nodes independently of property-map objects", () => {
  assert.deepEqual(measureProviderJsonSchema({
    type: "object",
    properties: { rows: { type: "array", items: { type: "string" } } },
  }), {
    arrayExpansion: 1,
    constraints: 0,
    depth: 3,
    nodes: 3,
  });
});

test("traverses tuple-style items arrays", () => {
  assert.deepEqual(measureProviderJsonSchema({
    type: "array",
    items: [
      { type: "string", maxLength: 20 },
      { type: "object", properties: { enabled: { type: "boolean" } } },
    ],
  }), {
    arrayExpansion: 1,
    constraints: 1,
    depth: 3,
    nodes: 4,
  });
});
