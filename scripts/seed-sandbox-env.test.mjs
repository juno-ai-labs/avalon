import assert from "node:assert/strict";
import test from "node:test";

import { buildEnvLocal, readValueFromLine, survivesRoundTrip } from "./seed-sandbox-env.mjs";

const example = [
  "# Copy to .env.local.",
  "APP_ENV=development",
  "OPENROUTER_API_KEY=",
  "OPENROUTER_PRIMARY_MODEL=x-ai/grok-4.3",
  "FIRECRAWL_API_KEY=",
  "GITHUB_APP_PRIVATE_KEY=",
  "RESEND_API_KEY=",
].join("\n");

test("a blank assignment takes the value the environment supplies", () => {
  const { text, filled } = buildEnvLocal(example, { OPENROUTER_API_KEY: "openrouter-placeholder-value" });
  assert.deepEqual(filled, ["OPENROUTER_API_KEY"]);
  assert.match(text, /^OPENROUTER_API_KEY=openrouter-placeholder-value$/mu);
});

test("an assignment that already carries a value in the example is left alone", () => {
  const { text, filled } = buildEnvLocal(example, { OPENROUTER_PRIMARY_MODEL: "x-ai/grok-9" });
  assert.deepEqual(filled, []);
  assert.match(text, /^OPENROUTER_PRIMARY_MODEL=x-ai\/grok-4\.3$/mu);
});

test("a variable absent or empty in the environment leaves the blank assignment blank", () => {
  const { text, filled } = buildEnvLocal(example, { FIRECRAWL_API_KEY: "" });
  assert.deepEqual(filled, []);
  assert.match(text, /^FIRECRAWL_API_KEY=$/mu);
});

// The fixtures below are deliberately word-like and low-entropy. A realistic
// key shape here trips Gitleaks' generic-api-key rule in CI, and the assertions
// care only that a value survives the round trip, not what it looks like.
test("every written value reads back as itself through the reader in sync-dev-env.mjs", () => {
  const environment = {
    OPENROUTER_API_KEY: "openrouter-placeholder-value",
    FIRECRAWL_API_KEY: "firecrawl-placeholder-value",
    RESEND_API_KEY: "resend-placeholder-value",
  };
  const { text, filled } = buildEnvLocal(example, environment);
  assert.deepEqual(filled.sort(), ["FIRECRAWL_API_KEY", "OPENROUTER_API_KEY", "RESEND_API_KEY"]);
  for (const line of text.split("\n")) {
    const parsed = readValueFromLine(line);
    if (!parsed || !(parsed.key in environment)) continue;
    assert.equal(parsed.value, environment[parsed.key], `${parsed.key} did not survive the round trip`);
  }
});

test("a multi-line PEM is skipped rather than written mangled", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----";
  const { text, filled, skipped } = buildEnvLocal(example, { GITHUB_APP_PRIVATE_KEY: pem });
  assert.deepEqual(filled, []);
  assert.deepEqual(skipped, ["GITHUB_APP_PRIVATE_KEY"]);
  // The blank assignment survives untouched, and no fragment of the key leaks in.
  assert.match(text, /^GITHUB_APP_PRIVATE_KEY=$/mu);
  assert.equal(text.includes("MIIEpAIBAAKC"), false);
});

test("values carrying a quote or a backslash are skipped, because the reader cannot return them", () => {
  const { filled, skipped } = buildEnvLocal(example, {
    OPENROUTER_API_KEY: '"quoted"',
    FIRECRAWL_API_KEY: "back\\slash",
    RESEND_API_KEY: " padded ",
  });
  assert.deepEqual(filled, ["FIRECRAWL_API_KEY"]);
  assert.deepEqual(skipped.sort(), ["OPENROUTER_API_KEY", "RESEND_API_KEY"]);
  // A backslash is inert to the reader, which does no unescaping — so it is kept.
  assert.equal(survivesRoundTrip("FIRECRAWL_API_KEY", "back\\slash"), true);
  // A wrapping quote pair would be stripped; surrounding whitespace would be trimmed.
  assert.equal(survivesRoundTrip("OPENROUTER_API_KEY", '"quoted"'), false);
  assert.equal(survivesRoundTrip("RESEND_API_KEY", " padded "), false);
});
