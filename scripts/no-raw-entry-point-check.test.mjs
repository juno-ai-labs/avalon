import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";

import { noRawEntryPointCheckRule } from "./eslint-rules/no-raw-entry-point-check.mjs";

const config = {
  languageOptions: { ecmaVersion: 2024, sourceType: "module" },
  plugins: { avalon: { rules: { "no-raw-entry-point-check": noRawEntryPointCheckRule } } },
  rules: { "avalon/no-raw-entry-point-check": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

// The three spellings this repository actually had. They differ only in how the
// path is converted, which is the point: every one of them compares a path that
// keeps symlinks against one that resolves them.
test("rejects comparing fileURLToPath(import.meta.url) to process.argv[1]", () => {
  const messages = lint("if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { main(); }");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /isEntryPoint/u);
});

test("rejects the hand-built file:// URL, which is also wrong about escaping", () => {
  assert.equal(lint("if (import.meta.url === `file://${process.argv[1]}`) { main(); }").length, 1);
});

test("rejects pathToFileURL, which gets the encoding right and the symlink wrong", () => {
  // Worth pinning separately: this one looks like the careful version, so a
  // rule that only caught the naive spellings would leave the tidiest-looking
  // instance of the bug in place.
  assert.equal(lint("if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) { main(); }").length, 1);
});

test("rejects the comparison written the other way round", () => {
  assert.equal(lint("if (process.argv[1] === fileURLToPath(import.meta.url)) { main(); }").length, 1);
});

test("rejects an inequality, which guards the same decision inverted", () => {
  assert.equal(lint("if (fileURLToPath(import.meta.url) !== process.argv[1]) return;").length, 1);
});

test("accepts the helper the rule points at", () => {
  assert.deepEqual(lint("if (isEntryPoint(import.meta.url)) { main(); }"), []);
});

test("accepts the helper's own implementation", () => {
  // It compares two resolved paths held in locals, so neither operand mentions
  // `import.meta` or `argv[1]` and the rule needs no exemption for it — which
  // is what keeps the rule repository-wide rather than a list of exclusions.
  assert.deepEqual(
    lint(`
      export function isEntryPoint(moduleUrl) {
        const invoked = process.argv[1];
        if (!invoked) return false;
        try {
          return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl));
        } catch {
          return false;
        }
      }
    `),
    [],
  );
});

test("leaves unrelated uses of each side alone", () => {
  // Neither operand alone is a defect: reading argv, and resolving
  // import.meta.url to locate a file, are both ordinary.
  assert.deepEqual(lint('const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");'), []);
  assert.deepEqual(lint('if (process.argv[1] === "--check") { check(); }'), []);
  assert.deepEqual(lint("if (process.argv[2] === expected) { run(); }"), []);
});
