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
  it("offers the built-in library to roots and inline children while child writes remain denied", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function inlineChildOutcomeAsToolResult(",
    );
    // Offered to both live run kinds. Withholding a skill would hide advice and
    // never authority, and would hide a future general skill along with it.
    expect(root).toContain("skills: [...BUILT_IN_SKILLS, ...sidekickSnapshot.sources.map(sidekickHarnessSkill)]");

    const inlineChild = section(
      "function createInlineChildAgentTool(",
      "async function recordOpenRouterInferenceAttempt(",
    );
    // What the read-only child may *do* is decided by tool mode before the call.
    expect(inlineChild).toContain('rejectToolModesBeforeCall(\n              ["write"],');
    expect(inlineChild).toContain("skills: [...BUILT_IN_SKILLS]");
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
      "try {\n    outcome = await runHarness({",
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
