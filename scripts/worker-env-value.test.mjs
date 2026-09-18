import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv } from "node:util";
import { workerEnvValue } from "./worker-env-value.mjs";

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
