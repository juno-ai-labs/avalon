import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

/**
 * A HyperSight block used to be whatever assistant text the run trailed off
 * with, so a preamble or an apology rendered on the dashboard as the block. It
 * is now an argument to an explicit tool call, which moves the failure from
 * "renders the wrong thing" to "renders nothing" — and that failure has to be
 * recorded as one rather than stored as a completed empty block.
 */
const { hyperSightSubmissionPlugin, hyperSightBlockOutcome } = __integrationTesting;

describe("the HyperSight submission tool", () => {
  it("hands the submitted Markdown back to the run that is persisting the block", async () => {
    const state: { markdown: string | null } = { markdown: null };
    const [tool] = hyperSightSubmissionPlugin(state).tools;

    expect(state.markdown).toBeNull();
    const result = await tool!.execute({ markdown: "## Open threads\n\n- one" }, {} as never);

    expect(state.markdown).toBe("## Open threads\n\n- one");
    expect(result.output).toEqual({ submitted: true, characters: "## Open threads\n\n- one".length });
  });

  it("is a read, so a run that refuses write-mode tools can still submit its block", () => {
    const [tool] = hyperSightSubmissionPlugin({ markdown: null }).tools;
    // Not a provider write: it settles Avalon's own block record, and a
    // HyperSight run rejects every write-mode tool before it runs.
    expect(tool!.definition.mode).toBe("read");
  });

  it("rejects an empty submission rather than storing a blank block", async () => {
    const state: { markdown: string | null } = { markdown: null };
    const [tool] = hyperSightSubmissionPlugin(state).tools;

    await expect(tool!.execute({ markdown: "" }, {} as never)).rejects.toThrow();
    expect(state.markdown).toBeNull();
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

  it("keeps a stopped run stopped, and carries a failure's own reason through", () => {
    expect(hyperSightBlockOutcome({ status: "stopped" }, null)).toEqual({ status: "stopped" });
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
