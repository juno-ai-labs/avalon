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
  it("offers the built-in library through the shared substream harness", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function azureInferenceConfig(",
    );
    // Foreground and background substreams use this same harness. Skills
    // offer guidance; normal tool authorization still decides execution.
    expect(root).toContain("skills: [...BUILT_IN_SKILLS, ...sidekickCatalog.map((entry) => entry.skill)]");


  });

});

describe("what a run reports when Bind refuses a tool result", () => {
  it("wires the rejection port the production run would otherwise drop on the floor", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function azureInferenceConfig(",
    );

    // Bind synthesizes rejected tool results rather than throwing them. Keep
    // the rejection port so the model-facing refusal has an operational record.
    expect(root).toContain("onToolCallRejected: ({ toolCallId, code }) => {");
    expect(root).toContain('logStructuredEvent(env, "warn", "agent_tool_call_rejected", {');
    // Queryable fields, not prose: Workers Logs filters on these.
    for (const field of ["code,", "tool_call_id:", "workspace_id:", "workstream_id:", "run_id:"]) {
      expect(root).toContain(field);
    }
  });
});

describe("harness liveness-monitor lifetime", () => {
  it("starts the root monitor only after fallible pre-inference setup", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function azureInferenceConfig(",
    );

    expectOrdered(root, [
      'await liveness.pulse("run_start", true);',
      "promptPreparation.get();",
      "toolsPreparation.get();",
      "await loadTriggerFencedTranscriptMessages(",
      "await projectModelProtocolTranscript(",
      "await promptPreparation.get()",
      "await toolsPreparation.get()",
      "await persistImmutableRunScope(",
      "await persistInitialPluginActivations(",
      "await liveness.pulse(\"inference_start\", true);",
      "const livenessMonitor = liveness.startMonitor(5_000);",
      "try {\n    outcome = await runHarness({",
      "} finally {",
      "await livenessMonitor.stop();",
    ]);
  });


});
