import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

import {
  OVERSIZE_MESSAGE_CHARACTERS,
  TERMINAL_STATES,
  buildPlan,
  modelGateDecision,
  runOutcomeOracle,
} from "./e2e-local.mjs";

// The oracles are the part of the e2e lane that can rot silently: a driver
// whose pass condition is wrong runs green forever over a broken system. Both
// defects below were real — the lane's first deployment failed 34 stop
// scenarios because `idle` was missing from the terminal set, and a
// credential-less environment must degrade to "terminal and truthful", never
// to "anything passes".

test("idle is a terminal state — the post-stop resting state is not a hang", () => {
  assert.ok(TERMINAL_STATES.includes("idle"));
  const verdict = runOutcomeOracle(true, { status: "idle", agentText: null });
  assert.equal(verdict.ok, false, "idle is terminal but is not a completed reply");
});

test("with a model, completed requires a reply and a hang is a failure", () => {
  assert.equal(runOutcomeOracle(true, { status: "completed", agentText: "PONG" }).ok, true);
  assert.equal(runOutcomeOracle(true, { status: "completed", agentText: null }).ok, false);
  assert.equal(runOutcomeOracle(true, { status: "timeout", agentText: null }).ok, false);
  assert.equal(runOutcomeOracle(true, { status: "failed", agentText: null }).ok, false);
  assert.equal(runOutcomeOracle(true, { status: "needs_input", agentText: null }).ok, true,
    "a clarifying question is the model's prerogative, not a defect");
});

test("without a model, terminal-and-truthful passes and silence still fails", () => {
  assert.equal(runOutcomeOracle(false, { status: "failed", agentText: null }).ok, true);
  assert.equal(runOutcomeOracle(false, { status: "timeout", agentText: null }).ok, false);
  assert.equal(runOutcomeOracle(false, { status: "completed", agentText: null }).ok, false,
    "completed with no reply and no model is a lie about what happened");
});

test("the plan interleaves lanes and cycles each lane's scenarios", () => {
  const plan = buildPlan({ happy: 3, sad: 2 }, {
    happy: ["a", "b"],
    sad: ["c"],
  });
  assert.deepEqual(plan, [["a", 0], ["b", 1], ["a", 2], ["c", 0], ["c", 1]]);
});

test("a missing model key refuses the lane unless degradation is chosen", () => {
  assert.equal(modelGateDecision(true, false).run, true);
  assert.equal(modelGateDecision(true, false).degraded, false);
  const refused = modelGateDecision(false, false);
  assert.equal(refused.run, false, "no key and no opt-out must refuse, not degrade silently");
  assert.match(refused.reason, /OPENROUTER_API_KEY/);
  const degraded = modelGateDecision(false, true);
  assert.equal(degraded.run, true);
  assert.equal(degraded.degraded, true);
});

// The lane is plain Node and the contract is TypeScript, so the ceiling exists
// twice and cannot be imported into agreement. This is the gate that keeps the
// copy honest. It is not hypothetical: the fixture sat at 50,001 while the
// ceiling moved to 100,000, which silently turned the one scenario that proves
// an over-long message is refused into one that creates a work stream and
// launches a model-backed run — passing nothing and costing a run every time.
test("the oversize scenario stays one character over the contract ceiling", () => {
  // `message-limits.ts`, not `index.ts`: the cap moved into a leaf module so
  // the substream contracts could spend it without closing an import cycle
  // through `index`, which still re-exports it unchanged.
  const contracts = readFileSync(
    new URL("../packages/contracts/src/message-limits.ts", import.meta.url),
    "utf8",
  );
  const declared = /export const MESSAGE_MAX_CHARACTERS = ([\d_]+);/u.exec(contracts);
  assert.ok(declared, "MESSAGE_MAX_CHARACTERS is no longer declared where this test reads it");
  const ceiling = Number(declared[1].replaceAll("_", ""));

  assert.equal(
    OVERSIZE_MESSAGE_CHARACTERS,
    ceiling + 1,
    "scripts/e2e-local.mjs must send exactly one character more than the contract accepts",
  );
});
