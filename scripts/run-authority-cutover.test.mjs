import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRegion, runCutover, sqlLiteral } from "./run-authority-cutover.mjs";

const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));

function fakeDatabase(initialControl) {
  const state = {
    control: { ...initialControl },
    nonterminalRuns: 0,
    workstreamStates: {},
    workspaceStates: {},
    quarantined: [],
    statements: [],
  };
  const execSql = async (sql) => {
    state.statements.push(sql.replace(/\s+/gu, " ").trim());
    if (sql.includes("FROM workstream_authority_control")) {
      return { results: [{ ...state.control }], changes: 0 };
    }
    if (sql.includes("FROM harness_runs")) {
      return { results: [{ count: state.nonterminalRuns }], changes: 0 };
    }
    if (sql.includes("FROM workstream_authority_routes") && sql.includes("GROUP BY")) {
      return {
        results: Object.entries(state.workstreamStates).map(([routeState, count]) => (
          { state: routeState, count }
        )),
        changes: 0,
      };
    }
    if (sql.includes("FROM workspace_product_authority_routes") && sql.includes("GROUP BY")) {
      return {
        results: Object.entries(state.workspaceStates).map(([routeState, count]) => (
          { state: routeState, count }
        )),
        changes: 0,
      };
    }
    if (sql.includes("state = 'quarantined'")) {
      return { results: state.quarantined, changes: 0 };
    }
    if (sql.includes("SET phase = 'maintenance_draining'")) {
      if (state.control.phase !== "legacy_open") return { results: [], changes: 0 };
      state.control.phase = "maintenance_draining";
      state.control.generation += 1;
      return { results: [], changes: 1 };
    }
    if (sql.includes("SET phase = 'maintenance_importing'")) {
      if (state.nonterminalRuns > 0) {
        throw new Error("d1 execute did not succeed: workstream_authority_runs_not_drained");
      }
      state.control.phase = "maintenance_importing";
      return { results: [], changes: 1 };
    }
    if (sql.includes("SET phase = 'durable_object_open'")) {
      if (state.control.phase !== "maintenance_verified") return { results: [], changes: 0 };
      state.control.phase = "durable_object_open";
      return { results: [], changes: 1 };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
  return { state, execSql };
}

const quietDeps = (execSql, overrides = {}) => ({
  execSql,
  wait: async () => {},
  log: () => {},
  pollMs: 1,
  settleMs: 0,
  deadlineMs: 60_000,
  requestedBy: "test-operator",
  reason: "test cutover",
  ...overrides,
});

test("parseRegion accepts only the two regional configs", () => {
  assert.equal(parseRegion(["eu"]), "eu");
  assert.equal(parseRegion(["global"]), "global");
  assert.throws(() => parseRegion([]), /Usage/u);
  assert.throws(() => parseRegion(["us"]), /Usage/u);
});

test("sqlLiteral doubles quotes so operator text cannot escape the literal", () => {
  assert.equal(sqlLiteral("o'clock '); DROP"), "'o''clock ''); DROP'");
});

test("a region that already opened is a fast no-op", async () => {
  const { state, execSql } = fakeDatabase({
    phase: "durable_object_open",
    generation: 1,
    serving_contract_version: 1,
    required_serving_contract_version: 1,
  });
  assert.equal(await runCutover("eu", quietDeps(execSql)), "already_open");
  assert.equal(state.statements.filter((sql) => sql.startsWith("UPDATE")).length, 0);
});

test("a quarantined region fails loudly and performs no writes", async () => {
  const { state, execSql } = fakeDatabase({
    phase: "quarantined",
    generation: 2,
    serving_contract_version: 0,
    required_serving_contract_version: 1,
  });
  state.quarantined = [{ workstream_id: "ws-1", last_error_code: "workspace_product_import_conflict" }];
  await assert.rejects(runCutover("eu", quietDeps(execSql)), /NEW generation/u);
  assert.equal(state.statements.filter((sql) => sql.startsWith("UPDATE")).length, 0);
});

test("drives legacy_open through drain, import, verification, and the open flip", async () => {
  const { state, execSql } = fakeDatabase({
    phase: "legacy_open",
    generation: 0,
    serving_contract_version: 0,
    required_serving_contract_version: 1,
  });
  state.nonterminalRuns = 2;
  // Script the world the cron would produce: runs settle, then the campaign
  // imports, verifies, activates, and attests while the driver watches.
  let tick = 0;
  const wait = async () => {
    tick += 1;
    if (tick === 1) state.nonterminalRuns = 0;
    if (tick === 3) {
      state.control.phase = "maintenance_verified";
      state.workstreamStates = { active: 3 };
      state.workspaceStates = { verified: 1 };
    }
    if (tick === 4) {
      state.workspaceStates = { active: 1 };
      state.control.serving_contract_version = 1;
    }
  };
  assert.equal(await runCutover("global", quietDeps(execSql, { wait })), "opened");
  assert.equal(state.control.phase, "durable_object_open");
  assert.equal(state.control.generation, 1);
  const drainFlip = state.statements.find((sql) => sql.includes("SET phase = 'maintenance_draining'"));
  assert.match(drainFlip, /WHERE id = 1 AND phase = 'legacy_open'/u);
  assert.match(drainFlip, /'test-operator'/u);
  const openFlip = state.statements.find((sql) => sql.includes("SET phase = 'durable_object_open'"));
  assert.match(openFlip, /WHERE id = 1 AND phase = 'maintenance_verified'/u);
});

test("a mid-campaign quarantine stops the driver with route details", async () => {
  const { state, execSql } = fakeDatabase({
    phase: "maintenance_importing",
    generation: 1,
    serving_contract_version: 0,
    required_serving_contract_version: 1,
  });
  state.workstreamStates = { importing: 1, quarantined: 1 };
  state.quarantined = [{ workspace_id: "w-1", last_error_code: "workspace_product_import_incomplete" }];
  await assert.rejects(
    runCutover("eu", quietDeps(execSql)),
    /workspace_product_import_incomplete/u,
  );
});

test("the deploy workflow drives the cutover after both Workers, EU first, gated by health", async () => {
  const workflow = await readFile(join(repositoryDirectory, ".github/workflows/deploy-api.yml"), "utf8");
  const globalDeploy = workflow.indexOf("pnpm --filter @avalon/api deploy:global");
  const euCutover = workflow.indexOf("node scripts/run-authority-cutover.mjs eu");
  const euHealthGate = workflow.indexOf("node scripts/check-regional-health.mjs eu");
  const globalCutover = workflow.indexOf("node scripts/run-authority-cutover.mjs global");

  assert.notEqual(euCutover, -1, "the deploy must drive the EU cutover");
  assert.notEqual(globalCutover, -1, "the deploy must drive the Global cutover");
  // The campaign is executed by the deployed Worker's cron, so no cutover may
  // begin before both Workers are current; EU precedes Global to mirror the
  // deploy order; and a failed EU open must stop the run before Global drains.
  assert.ok(globalDeploy < euCutover, "the cutover must follow the Worker deploys");
  assert.ok(euCutover < euHealthGate && euHealthGate < globalCutover,
    "the EU health gate must sit between the two regional cutovers");
});

test("the deadline surfaces as a resumable failure, not silence", async () => {
  const { execSql, state } = fakeDatabase({
    phase: "maintenance_importing",
    generation: 1,
    serving_contract_version: 0,
    required_serving_contract_version: 1,
  });
  state.workstreamStates = { importing: 4 };
  let clock = 0;
  const deps = quietDeps(execSql, {
    now: () => { clock += 1_000; return clock; },
    deadlineMs: 5_000,
  });
  await assert.rejects(runCutover("eu", deps), /rerun this script to resume/u);
});
