import assert from "node:assert/strict";
import test from "node:test";
import { ESLint, Linter } from "eslint";
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
    `const { message } = error;`,
    `const { message: copy } = requestError;`,
    `const { "message": copy } = error;`,
    `const copy = String(error);`,
    `const copy = requestError.toString();`,
    `const copy = query.error.message;`,
  ]) {
    assert.equal(lint(source).length, 1, source);
  }

  for (const source of [
    `return <InlineError>{failureCopy[failure]}</InlineError>;`,
    `return <p>{overlay.message}</p>;`,
    `const { message } = overlay;`,
  ]) {
    assert.deepEqual(lint(source), [], source);
  }
});

test("the configured presentation scope includes every adapter that supplies guarded UI", async () => {
  const eslint = new ESLint({ overrideConfigFile: "eslint.config.mjs" });
  for (const file of [
    "apps/browser/src/conversation.tsx",
    "apps/desktop/src/renderer/components/sidekick-section.tsx",
    "apps/desktop/src/renderer/screens/conversation-surface.tsx",
    "apps/desktop/src/renderer/screens/workstream.tsx",
    "packages/ui/src/components/sidekick-section.tsx",
  ]) {
    const config = await eslint.calculateConfigForFile(file);
    assert.equal(config.rules["rally/no-diagnostic-message-in-presentation"][0], 2, file);
  }
});
