import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Every exception in `.gitleaks.toml` is a hole in the secret-scanning gate,
 * and the gate itself runs only in the `secrets` CI job — which installs
 * Gitleaks, scans, and reports on what it finds *today*. Nothing in it can
 * notice that an exception has been widened until a real credential rides
 * through the widened one. These tests are that missing half: they read the
 * shipped configuration and check the bounds the comments beside each pattern
 * claim, because those bounds are the whole reason the exceptions are safe.
 *
 * They deliberately do not run Gitleaks — the binary exists only in that job,
 * so a test that shelled out to it would run nowhere else. The patterns are
 * matched against the same strings Gitleaks would hand them, which keeps this
 * in the ordinary `pnpm test:scripts` lane.
 *
 * The one thing to know before adding a pattern: Gitleaks compiles with Go's
 * RE2 and this file compiles with JavaScript's engine, and they are not the
 * same language. RE2 rejects backreferences and lookaround that JavaScript
 * accepts, and Go's inline flags — `(?i)` most of all, which appears throughout
 * Gitleaks' own default rules — throw in `new RegExp`. Keep allowlist patterns
 * to literals, character classes, quantifiers, and anchors, which mean the same
 * thing in both, or this file will start lying in one direction or the other.
 */

const config = readFileSync(fileURLToPath(new URL("../.gitleaks.toml", import.meta.url)), "utf8");

/**
 * The `regexes = [ … ]` array, as the literal strings Gitleaks compiles.
 *
 * Anchored on the array's own opening and closing lines rather than swept from
 * the first mention of `regexes` to the end of the file. The patterns contain
 * `[…]` character classes and this file's own prose contains the word, so a
 * looser reader would either stop inside a pattern or pull the `paths` entries
 * in — and because the callers below filter by content, it would do so
 * silently, leaving every assertion here passing over nothing.
 */
function allowlistRegexes(source) {
  const lines = source.split("\n");
  const opened = lines.findIndex((line) => /^\s*regexes\s*=\s*\[\s*$/u.test(line));
  assert.notEqual(opened, -1, "the allowlist must open a regexes array on its own line");
  const closed = lines.findIndex((line, index) => index > opened && /^\s*\]\s*$/u.test(line));
  assert.notEqual(closed, -1, "the regexes array must be closed on its own line");
  const patterns = [...lines.slice(opened + 1, closed).join("\n").matchAll(/'''(?<pattern>[\s\S]*?)'''/gu)]
    .map((match) => match.groups.pattern);
  assert.ok(patterns.length > 0, "the regexes array must not be empty");
  return patterns;
}

test("every allowlisted pattern is one this file has reasoned about", () => {
  // The guard that makes the rest of this worth having. An exception added
  // without a test for its bound is the failure this file exists to prevent, so
  // adding one here is deliberately not optional.
  assert.equal(
    allowlistRegexes(config).length,
    3,
    "a new .gitleaks.toml allowlist pattern needs a test in this file proving what it still rejects",
  );
});

test("the placeholder PEM exception admits only a short alphabetic body", () => {
  const patterns = allowlistRegexes(config).filter((pattern) => pattern.includes("PRIVATE KEY"));
  assert.equal(patterns.length, 1);
  const allowlist = new RegExp(patterns[0], "u");

  // What it is for: a placeholder in a test that asserts redaction or
  // configuration handling rather than carrying key material.
  assert.match(String.raw`-----BEGIN PRIVATE KEY-----\nunused-test-key\n-----END PRIVATE KEY-----`, allowlist);
  assert.match(String.raw`-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----`, allowlist);

  // What it must never admit: real key material is hundreds of base64
  // characters with digits and `+`, `/`, `=` — none of which the body accepts,
  // and all of which run far past its 39-character ceiling.
  const material = `${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ".repeat(4)}0+/=`;
  assert.doesNotMatch(String.raw`-----BEGIN PRIVATE KEY-----\n${material}\n-----END PRIVATE KEY-----`, allowlist);
  // The ceiling itself, from both sides.
  assert.match(String.raw`-----BEGIN PRIVATE KEY-----\n${"a".repeat(39)}\n-----END PRIVATE KEY-----`, allowlist);
  assert.doesNotMatch(String.raw`-----BEGIN PRIVATE KEY-----\n${"a".repeat(40)}\n-----END PRIVATE KEY-----`, allowlist);
  // A single digit disqualifies the body, which is what stops a truncated real
  // key from reading as a placeholder — base64 of any DER header reaches one
  // within a couple of dozen characters.
  assert.doesNotMatch(String.raw`-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----`, allowlist);
  // Worth knowing what is *not* excluded: a purely alphabetic prefix short
  // enough to fit the ceiling passes, because at 39 characters and no digits it
  // carries no key material — it is a header fragment, not a key.
  assert.match(String.raw`-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----`, allowlist);
});

test("the Access audience exception admits exactly one reviewed identifier", () => {
  const patterns = allowlistRegexes(config).filter((pattern) => /^\^[0-9a-f]{64}\$$/u.test(pattern));
  assert.equal(patterns.length, 1);
  const allowlist = new RegExp(patterns[0], "u");

  // What it is for: the migration tracker's Cloudflare Access Application
  // Audience tag, which the default `generic-api-key` rule flags because the
  // variable name contains `access` and the value is 64 high-entropy
  // characters. An AUD tag is an identifier — the `aud` claim of every
  // assertion Access mints for that application — and holding it grants
  // nothing; minting an assertion the Worker accepts needs the team's signing
  // key.
  const reviewed = "3be03aa107462e6a4f7dce1320cd32d15acabfb7e9ad3d64926965a81fab07e4";
  assert.match(reviewed, allowlist);

  // The bound the comment beside it claims: pinned to that one literal, not to
  // its shape. This is what stops the exception from becoming "any hex-encoded
  // key anywhere in the repository".
  assert.doesNotMatch("8dd38792dd9ed8b1320addd09502d0ff14799ed0af143900e493b493a5240bac", allowlist);
  assert.doesNotMatch(`${reviewed.slice(0, 63)}0`, allowlist);
  // Anchored at both ends, so it cannot be reached by embedding the reviewed
  // value inside a longer secret.
  assert.doesNotMatch(`${reviewed}a`, allowlist);
  assert.doesNotMatch(`a${reviewed}`, allowlist);
  assert.doesNotMatch(reviewed.slice(0, 63), allowlist);
});


test("the Granola fixture exception admits only the encoded synthetic phrase", () => {
  const patterns = allowlistRegexes(config).filter((pattern) => pattern.includes("whsec_"));
  assert.equal(patterns.length, 1);
  const allowlist = new RegExp(patterns[0], "u");
  const fixture = `whsec_${Buffer.from("provider-issued-secret").toString("base64")}`;
  assert.match(fixture, allowlist);
  assert.doesNotMatch(`whsec_${Buffer.from("different-provider-secret").toString("base64")}`, allowlist);
  assert.doesNotMatch(`${fixture}a`, allowlist);
  assert.doesNotMatch(`a${fixture}`, allowlist);
  assert.doesNotMatch(fixture.slice(0, -1), allowlist);
});
