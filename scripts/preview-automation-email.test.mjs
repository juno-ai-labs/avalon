import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, SAMPLE_BODY } from "./preview-automation-email.mjs";

test("defaults to a scratch output directory and a completed run", () => {
  assert.deepEqual(parseArguments([]), {
    out: "/tmp/automation-email-preview",
    body: null,
    outcome: "completed",
  });
});

test("takes an explicit body, outcome and output directory", () => {
  assert.deepEqual(
    parseArguments(["--body", "/tmp/result.md", "--outcome", "failed", "--out", "/tmp/preview"]),
    { out: "/tmp/preview", body: "/tmp/result.md", outcome: "failed" },
  );
});

test("refuses a flag whose value is the next flag rather than reading a file named --out", () => {
  assert.throws(() => parseArguments(["--body", "--out", "/tmp/preview"]), /--body needs a value/u);
  assert.throws(() => parseArguments(["--out"]), /--out needs a value/u);
});

test("refuses an outcome the email has no state line for", () => {
  assert.throws(() => parseArguments(["--outcome", "cancelled"]), /--outcome must be one of/u);
});

test("the sample carries the constructs this email has rendered wrong", () => {
  // The point of a preview is to see the hard cases. A sample that dropped them
  // would go on looking fine through the change that broke them again.
  assert.match(SAMPLE_BODY, /^1\. /mu, "a ranked list");
  assert.match(SAMPLE_BODY, /^ {2}- \[/mu, "nested source links");
  assert.match(SAMPLE_BODY, /^\| Rank \|/mu, "a table");
  assert.match(SAMPLE_BODY, /^```json/mu, "a fenced block");
  assert.match(SAMPLE_BODY, /`tracking_id`/u, "an underscore inside code");
  assert.match(SAMPLE_BODY, /^> /mu, "a blockquote");
});
