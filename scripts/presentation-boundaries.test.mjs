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
    `const { message } = error;`,
    `const { message: copy } = requestError;`,
    `const { "message": copy } = error;`,
    `const copy = String(error);`,
    `const copy = requestError.toString();`,
    `const copy = query.error.message;`,
    `try {} catch (failure) { const copy = failure.message; }`,
    `try {} catch (caught) { const copy = String(caught); }`,
    `try {} catch (caught) { const diagnostic = caught; const copy = diagnostic.message; }`,
    `try {} catch (caught) { const diagnostic = caught; const forwarded = diagnostic; const copy = forwarded.message; }`,
  ]) {
    assert.equal(lint(source).length, 1, source);
  }

  for (const source of [
    `return <InlineError>{failureCopy[failure]}</InlineError>;`,
    `return <p>{overlay.message}</p>;`,
    `const { message } = overlay;`,
    `try {} catch (error) { const render = (error) => error.message; render({ message: "Try again." }); }`,
  ]) {
    assert.deepEqual(lint(source), [], source);
  }
});
