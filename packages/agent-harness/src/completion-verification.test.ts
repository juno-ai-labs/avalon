import { describe, expect, it, vi } from "vitest";
import { completionConversationContext, judgeCompletionStop, type CompletionState } from "./completion-verification";

const state: CompletionState = {
  triggering_request: { id: "request", text: "Move the review to Thursday.", origin: "human_message" },
  candidate_final: "I found the event. I'm moving it now.", linked_context: [], tool_receipts: [],
  context_status: "resolved", evidence_coverage: "Test decision-time snapshot",
};

describe("completion verification", () => {
  it.each([
    ["answer_or_result", 0.70, true], ["answer_or_result", 0.71, false],
    ["blocker_or_question", 0.70, true], ["blocker_or_question", 0.95, false],
    ["announces_unfinished_work", 0.99, true], ["unclear", 0.99, true],
  ])("routes %s at %s to verification=%s", async (choice, confidence, reprompt) => {
    const fetcher = vi.fn(async () => Response.json({ model: "jev-1.14.0",
      answers: { stopping: { type: "choice", choice, confidence } } }));
    const result = await judgeCompletionStop({ apiKey: "test", state, fetch: fetcher });
    expect(result.reprompt).toBe(reprompt);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("verifies missing context even when the judge confidently accepts a stop", async () => {
    const result = await judgeCompletionStop({ apiKey: "test", state: { ...state, context_status: "unresolved" },
      fetch: async () => Response.json({ model: "jev-1.14.0",
        answers: { stopping: { type: "choice", choice: "answer_or_result", confidence: 0.99 } } }) });
    expect(result.reprompt).toBe(true);
  });

  it("falls back on unavailable or malformed judgments without retrying", async () => {
    for (const response of [new Response("unavailable", { status: 503 }), Response.json({ answers: {} })]) {
      const fetcher = vi.fn(async () => response);
      const result = await judgeCompletionStop({ apiKey: "test", state, fetch: fetcher });
      expect(result).toMatchObject({ reprompt: true, answer: null });
      expect(result.failureKind).toBeTruthy();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(await judgeCompletionStop({ state })).toMatchObject({ reprompt: true, failureKind: "credential_missing" });
  });

  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
    await expect(judgeCompletionStop({ apiKey: "test", state, signal: controller.signal, fetch: fetcher })).rejects.toThrow("cancelled");
  });

  it("uses the one-second judge deadline as a verification fallback", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      const result = judgeCompletionStop({ apiKey: "test", state, fetch: fetcher });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toMatchObject({ reprompt: true, failureKind: "typesafe_request_timed_out" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps nonadjacent instructions and later corrections without copying tool payloads or system policy", () => {
    const context = completionConversationContext([
      { role: "system", content: "System policy" },
      { role: "user", content: "Write the article and publish it." },
      { role: "assistant", content: "Which publication?" },
      { role: "tool", content: "Unrelated large provider output", tool_call_id: "call" },
      { role: "user", content: [{ type: "text", text: "Use the company blog; draft only." }] },
    ]);
    expect(context.map((item) => item.text)).toEqual([
      "Write the article and publish it.", "Which publication?", "Use the company blog; draft only.",
    ]);
  });
});
