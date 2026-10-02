import assert from "node:assert/strict";
import test from "node:test";

import { truncatedHeadings } from "./check-document-headings.mjs";

test("catches the damage that prompted this check", () => {
  // Verbatim from docs/security.md after the theme branch was rebased. The
  // entry was not the branch's own; the rebase ate `### 2026-0` off the front.
  const found = truncatedHeadings(
    "## Changelog\n\n8-13 — A saved message is rendered outside the application's origin\n\nBody.\n",
  );

  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.match(found[0].text, /A saved message/u);
});

test("reports every truncated heading, with its line", () => {
  const found = truncatedHeadings(
    ["### 2026-08-21 — Fine", "", "8-20 — First", "", "prose", "", "8-13 — Second"].join("\n"),
  );

  assert.deepEqual(found.map((problem) => problem.line), [3, 7]);
});

test("accepts a well-formed changelog", () => {
  assert.deepEqual(
    truncatedHeadings("### 2026-08-21 — A title\n\nBody with an — em dash in it.\n"),
    [],
  );
});

/**
 * The damage seen ate into the year, but a conflict could stop anywhere in the
 * prefix, so a surviving year is caught too.
 */
test("catches a heading that kept its year but lost its hashes", () => {
  assert.equal(truncatedHeadings("2026-08-21 — A title\n").length, 1);
});

test("leaves fenced code alone", () => {
  // A document explaining this very failure has to be able to show it.
  assert.deepEqual(truncatedHeadings("```\n8-13 — not a heading, an example\n```\n"), []);
  assert.deepEqual(truncatedHeadings("~~~text\n8-13 — also an example\n~~~\n"), []);
});

/**
 * Ordinary prose that happens to start with a number and contain an em dash is
 * not a heading. The pattern needs both halves of the changelog shape.
 */
test("does not fire on prose that merely contains an em dash", () => {
  assert.deepEqual(truncatedHeadings("The 8 regions — all of them — are listed.\n"), []);
  assert.deepEqual(truncatedHeadings("8-13 is a ratio, not a date.\n"), []);
});
