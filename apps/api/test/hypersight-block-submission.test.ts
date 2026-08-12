import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AVALON_SKILLS_PLUGIN_ID,
  AVALON_SKILL_TOOL_DEFINITIONS,
} from "@avalon/agent-harness";
import type { HarnessPlugin } from "@avalon/agent-harness";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";

/**
 * A HyperSight block used to be whatever assistant text the run trailed off
 * with, so a preamble or an apology rendered on the dashboard as the block. It
 * is now an argument to an explicit tool call, which moves the failure from
 * "renders the wrong thing" to "renders nothing" — and that failure has to be
 * recorded as one rather than stored as a completed empty block.
 */
const {
  hyperSightSubmissionPlugin,
  hyperSightBlockOutcome,
  resolveHarnessToolReceiptPolicy,
  createAvalonTools,
  createWorkstreamCorePlugins,
  workstreamRunLimits,
} = __integrationTesting;

const integrationsSource = readFileSync(
  fileURLToPath(new URL("../src/services/integrations.ts", import.meta.url)),
  "utf8",
);

const workflowInput = (): WorkstreamWorkflowInput => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  workstreamId: "00000000-0000-4000-8000-000000000002",
  harnessRunId: "00000000-0000-4000-8000-000000000003",
  region: "global",
  reason: "human_message",
  executionPrincipal: { type: "user", userId: "00000000-0000-4000-8000-000000000000" },
} as WorkstreamWorkflowInput);

/**
 * The parts of the frozen surface that authorization actually reads. Every
 * lookup below goes through `toolPolicyForCall`, which searches these two
 * collections and nothing else.
 */
function frozenSurface(corePlugins: HarnessPlugin[]) {
  return { corePlugins, plugins: [] } as unknown as Parameters<typeof resolveHarnessToolReceiptPolicy>[1];
}

function coreSurface(extra: HarnessPlugin[] = []) {
  const tools = createAvalonTools({} as Env, workflowInput());
  return frozenSurface([...createWorkstreamCorePlugins(tools), ...extra]);
}

const submission = (state: { markdown: string | null }) =>
  hyperSightSubmissionPlugin(state, async () => {});

describe("root-run limits", () => {
  it("keeps unattended HyperSight refreshes bounded independently of ordinary work streams", () => {
    expect(workstreamRunLimits(false)).toEqual({ maxIterations: 1_000 });
    expect(workstreamRunLimits(true)).toEqual({
      maxIterations: 8,
      maxToolCalls: 24,
      maxWallClockMs: 240_000,
      maxCostCents: 500,
    });
  });
});

describe("what the frozen surface will authorize", () => {
  /**
   * Bind builds the skills plugin from the `skills` the host passed, so it is
   * never in `corePlugins` and the host has to know its identity by name — the
   * same arrangement discovery has. Missing it made every catalog entry
   * unusable: `load_skill` threw `unauthorized`, which Bind treats as fatal.
   */
  it.each(AVALON_SKILL_TOOL_DEFINITIONS.map((definition) => definition))(
    "resolves $name, which Bind owns and the host never registers",
    (definition) => {
      const resolved = resolveHarnessToolReceiptPolicy(
        {
          pluginId: AVALON_SKILLS_PLUGIN_ID,
          canonicalToolName: definition.name,
          capability: definition.capability,
          mode: definition.mode,
          idempotency: definition.idempotency,
        },
        coreSurface(),
      );
      expect(resolved.definition.name).toBe(definition.name);
      // A core plugin: no connection behind it and no surface hash to pin.
      expect(resolved.connectionId).toBeNull();
      expect(resolved.toolSurfaceHash).toBeNull();
    },
  );

  it("resolves the HyperSight submission tool once its plugin is in the surface", () => {
    const plugin = submission({ markdown: null });
    const [tool] = plugin.tools;
    const identity = {
      pluginId: plugin.canonicalId,
      canonicalToolName: tool!.definition.name,
      capability: tool!.definition.capability,
      mode: tool!.definition.mode,
      idempotency: tool!.definition.idempotency,
    };

    expect(resolveHarnessToolReceiptPolicy(identity, coreSurface([plugin])).definition.name)
      .toBe("submit_block");
    // And handing it to Bind alone would not do: authorization reads the frozen
    // surface, so a plugin missing from it has every call refused.
    expect(() => resolveHarnessToolReceiptPolicy(identity, coreSurface()))
      .toThrow(/outside this run scope/u);
  });

  it("registers the submission plugin in the frozen surface rather than only in Bind's list", () => {
    // Structural, because no test can start a real run: the assertion that
    // matters is which array the plugin is pushed into.
    expect(integrationsSource).toContain("harnessTools.corePlugins.push(hyperSightSubmissionPlugin(");
    expect(integrationsSource).toContain("corePlugins: harnessTools.corePlugins,");
    expect(integrationsSource).not.toContain("[...harnessTools.corePlugins, hyperSightSubmissionPlugin(");
  });
});

describe("the HyperSight submission tool", () => {
  it("makes the Markdown durable before it acknowledges the call", async () => {
    const state: { markdown: string | null } = { markdown: null };
    const persisted: string[] = [];
    const [tool] = hyperSightSubmissionPlugin(state, async (markdown) => {
      // Ordering is the point: the in-memory copy is a convenience, the row is
      // the record, and a retried attempt only ever sees the row.
      expect(state.markdown).toBeNull();
      persisted.push(markdown);
    }).tools;

    const result = await tool!.execute({ markdown: "## Open threads\n\n- one" }, {} as never);

    expect(persisted).toEqual(["## Open threads\n\n- one"]);
    expect(state.markdown).toBe("## Open threads\n\n- one");
    expect(result.output).toEqual({ submitted: true, characters: "## Open threads\n\n- one".length });
  });

  it("fails the call when the block cannot be persisted, instead of reporting success", async () => {
    const state: { markdown: string | null } = { markdown: null };
    const [tool] = hyperSightSubmissionPlugin(state, async () => {
      throw new Error("hypersight_block_ownership_lost");
    }).tools;

    await expect(tool!.execute({ markdown: "# Block" }, {} as never)).rejects.toThrow(/ownership_lost/u);
    expect(state.markdown).toBeNull();
  });

  it("is a read, so a run that refuses write-mode tools can still submit its block", () => {
    const [tool] = submission({ markdown: null }).tools;
    // Not a provider write: it settles Avalon's own block record, and a
    // HyperSight run rejects every write-mode tool before it runs.
    expect(tool!.definition.mode).toBe("read");
  });

  it("rejects an empty submission rather than storing a blank block", async () => {
    const state: { markdown: string | null } = { markdown: null };
    const [tool] = submission(state).tools;

    await expect(tool!.execute({ markdown: "" }, {} as never)).rejects.toThrow();
    expect(state.markdown).toBeNull();
  });

  it("tells the model the wire name it will actually see", () => {
    const plugin = submission({ markdown: null });
    const wireName = __integrationTesting.stableWireToolName(
      plugin.shortWireName!,
      plugin.tools[0]!.definition.name,
    );
    expect(wireName).toBe("hypersight_submit_block");
    // Both the standing instruction and the one-time nudge name that, not the
    // bare tool name — the nudge fires once, so naming a tool that is not on
    // the list spends the only retry.
    const prose = integrationsSource.slice(
      integrationsSource.indexOf("const HYPERSIGHT_PLUGIN_ID"),
      integrationsSource.indexOf("beforeToolCall: composeBeforeToolCallHooks("),
    );
    expect(prose).not.toMatch(/\$\{HYPERSIGHT_SUBMIT_TOOL_NAME\}/u);
    expect(prose).toContain("${HYPERSIGHT_SUBMIT_WIRE_NAME}");
  });
});

describe("how a HyperSight run settles", () => {
  it("fails a run that finished without ever calling the tool", () => {
    // Bind is satisfied — the model stopped of its own accord — but there is no
    // block. Recording this as `completed` leaves a panel that renders nothing
    // and explains nothing, which is the hardest failure to notice.
    expect(hyperSightBlockOutcome({ status: "completed" }, null)).toEqual({
      status: "failed",
      error: {
        code: "hypersight_block_not_submitted",
        message: "The run ended without submitting a block",
      },
    });
  });

  it("completes a run that submitted one", () => {
    expect(hyperSightBlockOutcome({ status: "completed" }, "# Block")).toEqual({ status: "completed" });
  });

  it("fails a run that asked for input, which HyperSight cannot give", () => {
    expect(hyperSightBlockOutcome({ status: "needs_input" }, null)).toEqual({
      status: "failed",
      error: { code: "hypersight_input_unavailable", message: "HyperSight cannot pause for input" },
    });
  });

  it("keeps a stopped run stopped and keeps its reason with it", () => {
    expect(hyperSightBlockOutcome({ status: "stopped" }, null)).toEqual({ status: "stopped" });
    expect(
      hyperSightBlockOutcome(
        { status: "stopped", error: { code: "stopped_by_user", message: "Stopped" } },
        null,
      ),
    ).toEqual({ status: "stopped", error: { code: "stopped_by_user", message: "Stopped" } });
  });

  it("carries a failure's own reason through", () => {
    expect(
      hyperSightBlockOutcome(
        { status: "failed", error: { code: "limit_reached", message: "Out of iterations" } },
        null,
      ),
    ).toEqual({
      status: "failed",
      error: { code: "limit_reached", message: "Out of iterations" },
    });
  });
});
