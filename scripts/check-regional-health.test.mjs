import assert from "node:assert/strict";
import test from "node:test";

import { checkRegion, failedCheckNames, isHealthy, parseRegions } from "./check-regional-health.mjs";

const respond = (status, body) => ({
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const healthy = { ok: true, region: "global", checks: { d1: { ok: true, message: "available" } } };
const unhealthy = {
  ok: false,
  region: "global",
  checks: { d1: { ok: true, message: "available" }, r2: { ok: false, message: "unavailable" } },
};

const silent = { log: () => {}, warn: () => {}, error: () => {}, wait: async () => {} };

test("only a 200 carrying ok:true counts as healthy", () => {
  assert.equal(isHealthy(200, { ok: true }), true);
  // The Worker answers 503 when a required check fails; neither half alone is enough.
  assert.equal(isHealthy(503, { ok: true }), false);
  assert.equal(isHealthy(200, { ok: false }), false);
  assert.equal(isHealthy(200, undefined), false);
});

test("failing checks are named so the log says what broke", () => {
  assert.deepEqual(failedCheckNames(unhealthy), ["r2 (unavailable)"]);
  assert.deepEqual(failedCheckNames(healthy), []);
  assert.deepEqual(failedCheckNames({}), []);
  assert.deepEqual(failedCheckNames(null), []);
});

test("a healthy region passes on the first attempt without retrying", async () => {
  let calls = 0;
  const result = await checkRegion("global", {
    ...silent,
    fetchHealth: async () => {
      calls += 1;
      return respond(200, healthy);
    },
  });
  assert.equal(result, true);
  assert.equal(calls, 1);
});

test("a region that recovers mid-check passes", async () => {
  let calls = 0;
  const result = await checkRegion("global", {
    ...silent,
    fetchHealth: async () => {
      calls += 1;
      return calls < 3 ? respond(503, unhealthy) : respond(200, healthy);
    },
  });
  assert.equal(result, true);
  assert.equal(calls, 3);
});

test("a persistently unhealthy region fails after every attempt", async () => {
  let calls = 0;
  const warnings = [];
  const result = await checkRegion("global", {
    ...silent,
    attempts: 3,
    warn: (message) => warnings.push(message),
    fetchHealth: async () => {
      calls += 1;
      return respond(503, unhealthy);
    },
  });
  assert.equal(result, false);
  assert.equal(calls, 3);
  assert.match(warnings[0], /r2 \(unavailable\)/u);
});

test("a non-JSON body is a failure, not a pass", async () => {
  // An HTML error page from a proxy must never be read as a healthy region.
  const result = await checkRegion("global", {
    ...silent,
    attempts: 2,
    fetchHealth: async () => respond(502, "<html>Bad Gateway</html>"),
  });
  assert.equal(result, false);
});

test("a network error is retried and does not pass the gate", async () => {
  let calls = 0;
  const result = await checkRegion("global", {
    ...silent,
    attempts: 2,
    fetchHealth: async () => {
      calls += 1;
      throw new Error("fetch failed");
    },
  });
  assert.equal(result, false);
  assert.equal(calls, 2);
});

test("regions default to configured deployments and unknown names are rejected", () => {
  assert.deepEqual(parseRegions([]), ["global"]);
  assert.deepEqual(parseRegions(["global"]), ["global"]);
  assert.throws(() => parseRegions(["apac"]), /Unknown region\(s\): apac/u);
});
