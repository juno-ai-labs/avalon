import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv } from "node:util";
import { parseWorkerEnvValue, workerEnvValue } from "./worker-env-value.mjs";

test("JSON Worker configuration survives dotenv parsing", () => {
  for (const value of [
    { otpDigits: 6, ttlSeconds: 600, maxFailedAttempts: 3 },
    { label: "Guest's #1 \"workspace\"", path: "C:\\files", text: "two\nlines" },
  ]) {
    const encoded = workerEnvValue("CONFIG_JSON", JSON.stringify(value));
    assert.deepEqual(JSON.parse(parseEnv(`CONFIG_JSON=${encoded}`).CONFIG_JSON), value);
  }
});

test("ordinary Worker values retain their existing representation", () => {
  assert.equal(parseEnv(`BROWSER_APP_ORIGIN=${workerEnvValue("BROWSER_APP_ORIGIN", "http://127.0.0.1:8794")}`).BROWSER_APP_ORIGIN,
    "http://127.0.0.1:8794");
});

test("legacy generated JSON strings migrate without losing nested escaping", () => {
  const value = JSON.stringify({ label: 'Guest "team"', path: 'C:\\files' });
  const decoded = parseWorkerEnvValue('CONFIG_JSON', JSON.stringify(value));
  assert.equal(decoded, value);
  // Node parseEnv is the dotenv-reader proxy; the browser Worker test proves
  // runtime behavior separately, not Wrangler's environment parser.
  assert.deepEqual(JSON.parse(parseEnv(`CONFIG_JSON=${workerEnvValue('CONFIG_JSON', decoded)}`).CONFIG_JSON), JSON.parse(value));
});

test("malformed JSON names its setting without exposing the value", () => {
  assert.throws(() => workerEnvValue('EMAIL_LOGIN_POLICY_JSON', '{secret-value'), { message: 'EMAIL_LOGIN_POLICY_JSON is not valid JSON' });
});
