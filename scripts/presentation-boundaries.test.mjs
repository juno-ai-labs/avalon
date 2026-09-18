import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { noDiagnosticMessageInPresentationRule } from "./eslint-rules/presentation-boundaries.mjs";

const rules = {
  "no-diagnostic-message-in-presentation": noDiagnosticMessageInPresentationRule,
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, {
    languageOptions: {
      ecmaVersion: 2024,
      parser: tseslint.parser,
      parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { rally: { rules } },
    rules: { "rally/no-diagnostic-message-in-presentation": "error" },
  });
}

test("presentation surfaces cannot read raw diagnostic messages", () => {
  for (const source of [
    `const copy = error.message;`,
    `const copy = error["message"];`,
    `return <InlineError>{failure.message}</InlineError>;`,
  ]) {
    assert.equal(lint(source).length, 1, source);
  }

  assert.deepEqual(lint(`return <InlineError>{failureCopy[failure]}</InlineError>;`), []);
});
