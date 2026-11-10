/**
 * Unit tests for `runToolCallsPooledByTool` — the per-tool worker pool that caps
 * concurrent calls to the SAME tool at `PER_TOOL_POOL_SIZE` (5) while letting
 * DIFFERENT tools run fully in parallel. Pure/deterministic: the `run` fn just
 * tracks in-flight concurrency, no real tools.
 */
import { describe, expect, test } from "vitest";
import type OpenAI from "openai";
import { runToolCallsPooledByTool } from "../tool-batch";

/** Minimal stand-in for a host outcome — the pool is generic over this. */
type ToolCallOutcome = { toolMessage: OpenAI.ChatCompletionToolMessageParam };

function fnCall(name: string, id: string): OpenAI.ChatCompletionMessageToolCall {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function customCall(name: string, id: string): OpenAI.ChatCompletionMessageToolCall {
  return { id, type: "custom", custom: { name, input: "" } };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("runToolCallsPooledByTool", () => {
  test("pools `custom` tool calls by their own name, not all together", async () => {
    // `custom` calls carry their name on a different field than `function`
    // ones. Keying on the type alone would collapse every custom tool in a
    // batch into one pool and serialize unrelated tools behind each other.
    const calls = [
      ...Array.from({ length: 4 }, (_, i) => customCall("alpha", `a${i}`)),
      ...Array.from({ length: 4 }, (_, i) => customCall("beta", `b${i}`)),
    ];
    let inFlight = 0;
    let peak = 0;
    const results = await runToolCallsPooledByTool(
      calls,
      async (tc): Promise<ToolCallOutcome> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return { toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" } };
      },
    );

    // Two independent pools of 4 — one shared pool would cap the peak at 5.
    expect(peak).toBe(8);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  test("caps concurrency at 5 for many calls to the SAME tool, preserving input order", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => fnCall("search__x", `c${i}`));
    let inFlight = 0;
    let peak = 0;
    const run = async (tc: OpenAI.ChatCompletionMessageToolCall): Promise<ToolCallOutcome> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return { toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" } };
    };

    const results = await runToolCallsPooledByTool(calls, run);

    expect(peak).toBe(5); // min(PER_TOOL_POOL_SIZE, 12)
    expect(results).toHaveLength(12);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // Results are written back into their original slots, so order is preserved.
    expect(
      results.map((r) =>
        r.status === "fulfilled"
          ? (r.value.toolMessage as OpenAI.ChatCompletionToolMessageParam).tool_call_id
          : null,
      ),
    ).toEqual(calls.map((c) => c.id));
  });

  test("DIFFERENT tools run in parallel (each group keeps its own cap)", async () => {
    const calls = [
      ...Array.from({ length: 3 }, (_, i) => fnCall("a__x", `a${i}`)),
      ...Array.from({ length: 3 }, (_, i) => fnCall("b__y", `b${i}`)),
    ];
    let inFlight = 0;
    let peak = 0;
    const run = async (tc: OpenAI.ChatCompletionMessageToolCall): Promise<ToolCallOutcome> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return { toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" } };
    };

    await runToolCallsPooledByTool(calls, run);

    // Two 3-call groups run concurrently and all 6 workers increment before the
    // first tick() resolves, so the peak is deterministically 6 — proving the two
    // groups truly overlap (not 5-cap-then-1, which a single shared pool would give).
    expect(peak).toBe(6);
  });

  test("an empty batch returns an empty result array", async () => {
    const results = await runToolCallsPooledByTool([], async () => ({
      toolMessage: { role: "tool", tool_call_id: "x", content: "{}" },
    }));
    expect(results).toEqual([]);
  });

  test("a rejecting run settles that slot as rejected without failing the batch", async () => {
    const calls = [fnCall("a__x", "ok"), fnCall("a__x", "bad")];
    const run = async (tc: OpenAI.ChatCompletionMessageToolCall): Promise<ToolCallOutcome> => {
      if (tc.id === "bad") throw new Error("boom");
      return { toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" } };
    };

    const results = await runToolCallsPooledByTool(calls, run);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
  });
});
