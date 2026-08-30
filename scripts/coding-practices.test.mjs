import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";

import { noDynamicImportRule } from "./eslint-rules/no-dynamic-import.mjs";

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, {
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { rally: { rules: { "no-dynamic-import": noDynamicImportRule } } },
    rules: { "rally/no-dynamic-import": "error" },
  });
}

test("rejects dynamic JavaScript module imports and permits static imports", () => {
  const messages = lint('const module = await import("./provider.js");');
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /static import/u);
  assert.equal(lint('import module from "./provider.js";').length, 0);
  assert.equal(lint("ObjC.import('AppKit');").length, 0);
});
