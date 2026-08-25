import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { noDirectWorkstreamsCacheWriteRule } from "./eslint-rules/renderer-cache-boundaries.mjs";

const rules = {
  "no-direct-workstreams-cache-write": noDirectWorkstreamsCacheWriteRule,
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

test("work-stream cache writes go through the typed helper", () => {
  for (const source of [
    `
      import { WORKSTREAMS_QUERY_KEY } from "./workstreams-cache";
      queryClient.setQueryData(WORKSTREAMS_QUERY_KEY, page);
    `,
    `queryClient.setQueryData(["workstreams"] as const, page);`,
    `
      import { WORKSTREAMS_QUERY_KEY as key } from "./workstreams-cache";
      queryClient.setQueriesData({ queryKey: key }, page);
    `,
    `
      import { WORKSTREAMS_QUERY_KEY } from "./workstreams-cache";
      const filters = { queryKey: WORKSTREAMS_QUERY_KEY };
      queryClient.setQueriesData(filters, page);
    `,
  ]) {
    assert.equal(lint(source, "no-direct-workstreams-cache-write").length, 1, source);
  }
  assert.deepEqual(
    lint(`setCachedWorkstreams(queryClient, page.items);`, "no-direct-workstreams-cache-write"),
    [],
  );
});
