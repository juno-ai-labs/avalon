import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TERMINAL_STATES,
  artifactGateDecision,
  artifactOutcomeOracle,
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

test("the artifact scenario runs only with a model and a Terminal, and says why otherwise", () => {
  assert.deepEqual(artifactGateDecision(true, "supported"), { run: true });
  const noModel = artifactGateDecision(false, "supported");
  assert.equal(noModel.run, false);
  assert.match(noModel.reason, /no model/);
  const noTerminal = artifactGateDecision(true, "unsupported");
  assert.equal(noTerminal.run, false);
  assert.match(noTerminal.reason, /Terminal is unsupported/);
  assert.match(artifactGateDecision(true, undefined).reason, /Terminal is unknown/);
});

test("a publish counts only when the Canvas lists a versioned artifact", () => {
  assert.equal(artifactOutcomeOracle({ artifacts: [] }).ok, false);
  assert.equal(artifactOutcomeOracle(null).ok, false, "an unreadable Canvas is not a publish");
  assert.equal(artifactOutcomeOracle({ artifacts: [{ resourceId: "r", version: 1 }] }).ok, true);
  assert.equal(artifactOutcomeOracle({ artifacts: [{ resourceId: "r", version: 0 }] }).ok, false);
});
