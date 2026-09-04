import assert from "node:assert/strict";
import test from "node:test";
import {
  LOGPUSH_FIELD_NAMES,
  OBSERVABILITY_CONFIGURATIONS,
  SAVED_QUERY_DEFINITIONS,
  assessSavedQueries,
  assessLogpushJob,
  createCloudflareClient,
  reconcileLifecycleRules,
  savedQueryMatchesDefinition,
} from "./configure-cloudflare-observability.mjs";

test("saved views cover both regional APIs and every documented failure mode", () => {
  assert.equal(SAVED_QUERY_DEFINITIONS.length, 8);
  assert.deepEqual(
    SAVED_QUERY_DEFINITIONS.map((definition) => definition.name),
    [
      "Avalon · Failures",
      "Avalon · Invalid model output",
      "Avalon · Degraded connector workflows",
      "Avalon · Rejected model calls",
      "Avalon · Broken response contracts",
      "Avalon · Harness run outcomes",
      "Avalon · Slow root runs",
      "Avalon · Slow Terminal bootstrap",
    ],
  );
  for (const definition of SAVED_QUERY_DEFINITIONS) {
    const encoded = JSON.stringify(definition.parameters);
    for (const configuration of OBSERVABILITY_CONFIGURATIONS) {
      assert.match(encoded, new RegExp(configuration.script));
    }
  }
});

test("saved-query comparisons tolerate Cloudflare defaults and unordered filters", () => {
  const definition = SAVED_QUERY_DEFINITIONS[1];
  const stored = structuredClone(definition);
  stored.parameters.datasets = [];
  stored.parameters.calculations = [];
  stored.parameters.filterCombination = "AND";
  stored.parameters.filters.reverse();
  for (const entry of stored.parameters.filters) {
    if (entry.kind === "filter") delete entry.kind;
  }
  assert.equal(savedQueryMatchesDefinition(stored, definition), true);

  stored.parameters.limit = 50;
  assert.equal(savedQueryMatchesDefinition(stored, definition), false);
});

test("saved-query assessment reports every missing, stale, and duplicated definition in one pass", () => {
  const existing = SAVED_QUERY_DEFINITIONS.slice(0, 4).map((definition) => structuredClone(definition));
  const stale = structuredClone(SAVED_QUERY_DEFINITIONS[4]);
  stale.parameters.limit = 50;
  existing.push(stale);
  existing.push(structuredClone(SAVED_QUERY_DEFINITIONS[5]));
  existing.push(structuredClone(SAVED_QUERY_DEFINITIONS[5]));

  const assessment = assessSavedQueries(existing);

  assert.deepEqual(assessment.verified.map((definition) => definition.name), [
    "Avalon · Failures",
    "Avalon · Invalid model output",
    "Avalon · Degraded connector workflows",
    "Avalon · Rejected model calls",
  ]);
  assert.deepEqual(assessment.differences.map((difference) => ({
    kind: difference.kind,
    name: difference.definition.name,
  })), [
    { kind: "stale", name: "Avalon · Broken response contracts" },
    { kind: "duplicated", name: "Avalon · Harness run outcomes" },
    { kind: "missing", name: "Avalon · Slow root runs" },
    { kind: "missing", name: "Avalon · Slow Terminal bootstrap" },
  ]);
});

test("saved-query assessment exposes every production-style missing definition", () => {
  const assessment = assessSavedQueries(
    SAVED_QUERY_DEFINITIONS.slice(0, 4).map((definition) => structuredClone(definition)),
  );
  assert.deepEqual(
    assessment.differences.map((difference) => difference.definition.name),
    SAVED_QUERY_DEFINITIONS.slice(4).map((definition) => definition.name),
  );
  assert.ok(assessment.differences.every((difference) => difference.kind === "missing"));
});

test("lifecycle reconciliation preserves unrelated rules", () => {
  const multipartRule = {
    id: "abort-incomplete-multipart-uploads",
    enabled: true,
    conditions: { prefix: "" },
    abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
  };
  const result = reconcileLifecycleRules([multipartRule]);
  assert.equal(result.changed, true);
  assert.equal(result.rules.length, 2);
  assert.deepEqual(result.rules[0], multipartRule);
  assert.deepEqual(result.rules[1].deleteObjectsTransition, {
    condition: { type: "Age", maxAge: 7_776_000 },
  });

  const repeated = reconcileLifecycleRules(result.rules);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.rules, result.rules);
});

function validLogpushJob(configuration) {
  return {
    dataset: "workers_trace_events",
    enabled: true,
    destination_conf: `s3://${configuration.bucket}/workers-trace/{DATE}?secret-access-key=never-log-this`,
    filter: JSON.stringify({
      where: { key: "ScriptName", operator: "eq", value: configuration.script },
    }),
    output_options: {
      field_names: [...LOGPUSH_FIELD_NAMES].reverse(),
      sample_rate: 1,
      timestamp_format: "rfc3339",
    },
    last_complete: null,
    last_error: null,
    error_message: null,
  };
}

test("Logpush verification distinguishes pending, healthy, and failing delivery", () => {
  const configuration = OBSERVABILITY_CONFIGURATIONS[0];
  const pending = validLogpushJob(configuration);
  assert.deepEqual(assessLogpushJob(pending, configuration), {
    valid: true,
    problems: [],
    delivery: "pending",
  });

  const healthy = { ...pending, last_complete: "2026-08-03T12:00:00Z" };
  assert.equal(assessLogpushJob(healthy, configuration).delivery, "healthy");

  const failing = {
    ...pending,
    error_message: "failed s3://bucket/?secret-access-key=must-not-escape",
  };
  const assessment = assessLogpushJob(failing, configuration);
  assert.equal(assessment.delivery, "failing");
  assert.doesNotMatch(JSON.stringify(assessment), /must-not-escape/);
});

test("Cloudflare errors expose status and codes but not provider messages", async () => {
  const client = createCloudflareClient({
    accountId: "account",
    apiToken: "token",
    fetchImplementation: async () => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 10_000, message: "secret-access-key=must-not-escape" }],
    }), { status: 403, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    client("/workers/observability/queries"),
    (error) => error.status === 403
      && error.codes[0] === "10000"
      && !error.message.includes("must-not-escape"),
  );
});
