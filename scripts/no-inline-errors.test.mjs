import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { noInlineErrorsRule } from "./eslint-rules/no-inline-errors.mjs";

function lint(source) {
  return new Linter().verify(source, {
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { rally: { rules: { "no-inline-errors": noInlineErrorsRule } } },
    rules: { "rally/no-inline-errors": "error" },
  });
}

test("inline alerts, error styling and the retired primitive are rejected", () => {
  for (const source of [
    '<p role="alert">Send failed</p>',
    '<div role={"alert"}>Send failed</div>',
    '<p className="inline-error">Send failed</p>',
    '<span className={failed ? "status is-error" : "status"}>Send failed</span>',
    '<p className={clsx("copy", failed && "send-error")}>Send failed</p>',
    '<DropdownMenu.Label className="send-error">Send failed</DropdownMenu.Label>',
    '<p className={clsx({"inline-error": failed})}>Send failed</p>',
    '<p className={`copy ${failed ? "is-error" : ""}`}>Send failed</p>',
    '<InlineError>Send failed</InlineError>',
    'import { InlineError as Notice } from "./primitives";',
  ]) assert.equal(lint(source).length, 1, source);
});

test("acknowledged popups, loading states and historical status remain available", () => {
  for (const source of [
    '<ErrorNotice>Send failed</ErrorNotice>',
    '<AcknowledgedErrorDialog error={error} onAcknowledge={clear} />',
    '<main role="alertdialog"><button>OK</button></main>',
    '<p role="status">Uploading…</p>',
    '<div className="screen-error-state"><button>Retry</button></div>',
    '<StatusDot status="failed" />',
  ]) assert.deepEqual(lint(source), [], source);
});
