import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const integrationsSource = readFileSync(
  fileURLToPath(new URL("../src/services/integrations.ts", import.meta.url)),
  "utf8",
);

function section(start: string, end: string): string {
  const startIndex = integrationsSource.indexOf(start);
  const endIndex = integrationsSource.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return integrationsSource.slice(startIndex, endIndex);
}

function expectOrdered(source: string, markers: readonly string[]): void {
  let previousIndex = -1;
  for (const marker of markers) {
    const markerIndex = source.indexOf(marker);
    expect(markerIndex, `missing lifecycle marker: ${marker}`).toBeGreaterThan(previousIndex);
    previousIndex = markerIndex;
  }
}

describe("what a run may consult, and what it may do", () => {
  it("offers the built-in library to every run and settles authority in the tool loop instead", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function inlineChildOutcomeAsToolResult(",
    );
    // Offered to all of them. Withholding a skill would hide advice and never
    // authority, and would hide a future general skill along with it.
    expect(root).toContain("skills: [...BUILT_IN_SKILLS]");
    expect(root).not.toContain("blockDashboardRun ? {} : { skills:");

    // What a surface may *do* is decided here, by tool mode, before the call.
    expect(root).toContain('rejectToolModesBeforeCall(["write"], "Writes are not currently allowed"');

    const inlineChild = section(
      "function createInlineChildAgentTool(",
      "async function recordOpenRouterInferenceAttempt(",
    );
    expect(inlineChild).toContain('rejectToolModesBeforeCall(\n              ["write"],');
    expect(inlineChild).toContain("skills: [...BUILT_IN_SKILLS]");
  });

  it("takes a HyperSight block from a tool call, and asks again when the turn ends without one", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function inlineChildOutcomeAsToolResult(",
    );
    // The block is what was submitted, not whatever text the run trailed off
    // with — a preamble used to become part of the dashboard. `submitted` is
    // the row-backed value, so a retried attempt that replayed the submission
    // receipt instead of executing it still persists the block it has.
    // The call, not its argument spelling. The block row moved onto the object
    // in the block-dashboard slice and its key is `block_run_id` there rather
    // than `id`; an assertion that tracked the rename would be asserting on the
    // rename. What this line is for is that the value is read back from the row
    // at all, which is what makes a replayed submission survive.
    expect(root).toContain("readBlockDashboardBlockMarkdown(");
    expect(root).toContain("blockDashboardBlockOutcome(terminalResult, submitted)");
    expect(root).not.toContain("streamedText || null,");
    // And a turn that ends without the call is asked for it once.
    expect(root).toContain("onTurnWouldEnd:");
    expect(root).toContain("blockDashboardSubmissionAsked = true;");
  });
});

describe("harness liveness-monitor lifetime", () => {
  it("starts the root monitor only after fallible pre-inference setup", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function inlineChildOutcomeAsToolResult(",
    );

    expectOrdered(root, [
      "await loadTriggerFencedTranscriptMessages(",
      "await projectModelProtocolTranscript(",
      "await loadRunPromptContext(",
      "await loadHarnessTools(",
      "await persistImmutableRunScope(",
      "await persistInitialPluginActivations(",
      "await liveness.pulse(\"inference_start\", true);",
      "const livenessMonitor = liveness.startMonitor(5_000);",
      "try {",
      "outcome = await runHarness({",
      "} finally {",
      "await livenessMonitor.stop();",
    ]);
  });

  it("does not start the child monitor until its fallible tool surface exists", () => {
    const child = section(
      "function installInlineChildAgentTool(",
      "async function recordOpenRouterInferenceAttempt(",
    );

    expectOrdered(child, [
      "await createInlineChildHarnessSurface({",
      "await childLiveness.pulse(\"inference_start\", true);",
      "const childMonitor = childLiveness.startMonitor(5_000);",
      "try {",
      "await persistInlineChildScope(",
      "const outcome = await runHarness({",
      "} finally {",
      "await childMonitor.stop();",
    ]);
  });
});
