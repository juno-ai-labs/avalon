import { describe, expect, it } from "vitest";
import {
  accumulateAuxiliarySpend,
  accumulateRun,
  accumulateToolCall,
  accumulateTurn,
  emptyRunStats,
  type ModelTurnResult,
  type RunStats,
} from "../turn";

function turn(outputTokens: number, generationMs: number): ModelTurnResult {
  return {
    message: { role: "assistant", content: "ok", refusal: null },
    usage: {
      inputTokens: 100,
      outputTokens,
      cachedInputTokens: null,
      costCents: 0.5,
    },
    timings: { ttftMs: 120, generationMs },
  };
}

describe("run stats accumulation", () => {
  it("separates model time from tool time and derives tokens/sec", () => {
    let stats = emptyRunStats();
    stats = accumulateTurn(stats, turn(500, 2_000));
    stats = accumulateToolCall(stats, "search", 300);
    stats = accumulateTurn(stats, turn(500, 3_000));
    stats = accumulateToolCall(stats, "search", 200);
    stats = accumulateToolCall(stats, "read_file", 100);

    expect(stats.turns).toBe(2);
    expect(stats.toolCalls).toBe(3);
    expect(stats.inputTokens).toBe(200);
    expect(stats.outputTokens).toBe(1_000);
    expect(stats.costCents).toBe(1);
    expect(stats.modelTimeMs).toBe(5_000);
    expect(stats.toolTimeMs).toBe(600);
    // 1000 output tokens over 5s of model time — tool time excluded.
    expect(stats.outputTokensPerSecond).toBe(200);
    expect(stats.toolTimeBreakdownMs).toEqual({ search: 500, read_file: 100 });
  });

  it("reports null tokens/sec before any model time", () => {
    expect(emptyRunStats().outputTokensPerSecond).toBeNull();
    const stats = accumulateToolCall(emptyRunStats(), "noop", 50);
    expect(stats.outputTokensPerSecond).toBeNull();
  });
});

describe("accumulateRun — rolling a chain's child runs up", () => {
  function runStats(overrides: Partial<RunStats> = {}): RunStats {
    return { ...emptyRunStats(), ...overrides };
  }

  it("sums every total across runs", () => {
    const parent = runStats({
      turns: 2,
      toolCalls: 3,
      inputTokens: 200,
      outputTokens: 1_000,
      costCents: 1,
      modelTimeMs: 5_000,
      toolTimeMs: 600,
      toolTimeBreakdownMs: { search: 500, read_file: 100 },
    });
    const child = runStats({
      turns: 1,
      toolCalls: 2,
      inputTokens: 50,
      outputTokens: 500,
      costCents: 0.25,
      modelTimeMs: 2_000,
      toolTimeMs: 400,
      toolTimeBreakdownMs: { search: 300, write_file: 100 },
    });

    const total = accumulateRun(parent, child);

    expect(total.turns).toBe(3);
    expect(total.toolCalls).toBe(5);
    expect(total.inputTokens).toBe(250);
    expect(total.outputTokens).toBe(1_500);
    expect(total.costCents).toBe(1.25);
    expect(total.modelTimeMs).toBe(7_000);
    expect(total.toolTimeMs).toBe(1_000);
    // Overlapping tool names merge rather than one side winning.
    expect(total.toolTimeBreakdownMs).toEqual({
      search: 800,
      read_file: 100,
      write_file: 100,
    });
  });

  it("recomputes throughput from merged totals rather than averaging rates", () => {
    // Averaging the two rates would give (100 + 1000) / 2 = 550 tok/s, a
    // number neither run achieved and one the chain never sustained.
    const slow = runStats({ outputTokens: 100, modelTimeMs: 1_000 }); // 100 tok/s
    const fast = runStats({ outputTokens: 10_000, modelTimeMs: 10_000 }); // 1000 tok/s

    const total = accumulateRun(slow, fast);

    expect(total.outputTokens).toBe(10_100);
    expect(total.modelTimeMs).toBe(11_000);
    expect(total.outputTokensPerSecond).toBeCloseTo(918.18, 2);
  });

  it("lets model time exceed wall-clock when children ran concurrently", () => {
    // Three children each spending 10s of model time inside a 12s parent is
    // correct: 30s is what the chain COST, not how long it took.
    const children = [
      runStats({ modelTimeMs: 10_000, outputTokens: 1_000 }),
      runStats({ modelTimeMs: 10_000, outputTokens: 1_000 }),
      runStats({ modelTimeMs: 10_000, outputTokens: 1_000 }),
    ];
    const total = children.reduce(accumulateRun, runStats({ modelTimeMs: 2_000 }));
    expect(total.modelTimeMs).toBe(32_000);
  });

  it("reports null tokens/sec when no run produced model time", () => {
    const total = accumulateRun(
      runStats({ toolTimeMs: 100 }),
      runStats({ toolTimeMs: 200 }),
    );
    expect(total.outputTokensPerSecond).toBeNull();
  });

  it("folds an empty run without changing the totals", () => {
    const parent = runStats({
      turns: 2,
      outputTokens: 1_000,
      modelTimeMs: 5_000,
      toolTimeBreakdownMs: { search: 500 },
    });

    // Asserted against concrete values, not against another call of the same
    // function — `accumulateRun(a, empty) === accumulateRun(empty, a)` holds
    // for an implementation that returns `emptyRunStats()` unconditionally.
    // Note the fold also *recomputes* the rate the fixture left at null, which
    // is why this is not a literal identity.
    expect(accumulateRun(parent, emptyRunStats())).toEqual({
      ...parent,
      outputTokensPerSecond: 200,
    });
  });

  it("is order-independent, so a chain reduces however its children finish", () => {
    const a = runStats({ turns: 1, outputTokens: 10, modelTimeMs: 100, costCents: 1 });
    const b = runStats({ turns: 2, outputTokens: 20, modelTimeMs: 200, costCents: 2 });
    const c = runStats({ turns: 3, outputTokens: 30, modelTimeMs: 300, costCents: 3 });

    // Both orders pinned against the same concrete total, so a degenerate
    // implementation cannot satisfy this by agreeing with itself.
    const expected = {
      ...emptyRunStats(),
      turns: 6,
      outputTokens: 60,
      modelTimeMs: 600,
      costCents: 6,
      outputTokensPerSecond: 100,
    };
    expect([a, b, c].reduce(accumulateRun, emptyRunStats())).toEqual(expected);
    expect([c, a, b].reduce(accumulateRun, emptyRunStats())).toEqual(expected);
  });

  it("does not mutate either input", () => {
    const parent = runStats({ turns: 1, toolTimeBreakdownMs: { search: 100 } });
    const child = runStats({ turns: 1, toolTimeBreakdownMs: { search: 200 } });

    accumulateRun(parent, child);

    expect(parent.toolTimeBreakdownMs).toEqual({ search: 100 });
    expect(child.toolTimeBreakdownMs).toEqual({ search: 200 });
    expect(parent.turns).toBe(1);
  });
});

describe("cached input tokens", () => {
  function cachedTurn(cachedInputTokens: number | null): ModelTurnResult {
    return {
      message: { role: "assistant", content: "ok", refusal: null },
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens, costCents: 1 },
      timings: { ttftMs: null, generationMs: 1_000 },
    };
  }

  it("sums the reported figures and treats an unreported one as zero", () => {
    let stats = emptyRunStats();
    stats = accumulateTurn(stats, cachedTurn(80));
    stats = accumulateTurn(stats, cachedTurn(null));
    stats = accumulateTurn(stats, cachedTurn(120));

    // 200, not 200-and-a-bit-unknown: an unreported turn contributes nothing
    // rather than poisoning the total, so the number reads as a floor.
    expect(stats.cachedInputTokens).toBe(200);
    expect(stats.inputTokens).toBe(300);
  });

  it("rolls up across child runs", () => {
    const parent = { ...emptyRunStats(), cachedInputTokens: 500 };
    const child = { ...emptyRunStats(), cachedInputTokens: 250 };
    expect(accumulateRun(parent, child).cachedInputTokens).toBe(750);
  });
});

describe("auxiliary spend", () => {
  const spend = { inputTokens: 4_000, outputTokens: 600, costCents: 2, modelTimeMs: 1_500 };

  it("adds tokens, cost and model time without counting a turn", () => {
    let stats = accumulateTurn(emptyRunStats(), turn(500, 2_000));
    stats = accumulateAuxiliarySpend(stats, spend);

    // The point of the split: a compaction costs real money and real latency,
    // but it is not an iteration the agent spent making progress — so `turns`
    // stays comparable with the loop's `maxIterations`.
    expect(stats.turns).toBe(1);
    expect(stats.inputTokens).toBe(4_100);
    expect(stats.outputTokens).toBe(1_100);
    expect(stats.costCents).toBe(2.5);
    expect(stats.modelTimeMs).toBe(3_500);
  });

  it("recomputes the rate from the new totals rather than carrying the old one", () => {
    const before = accumulateTurn(emptyRunStats(), turn(500, 2_000));
    expect(before.outputTokensPerSecond).toBe(250);

    const after = accumulateAuxiliarySpend(before, spend);
    // 1,100 output tokens over 3,500ms — not the 250/s the turn alone achieved.
    expect(after.outputTokensPerSecond).toBeCloseTo((1_100 / 3_500) * 1_000, 6);
  });

  it("leaves the rate null when nothing has taken any model time", () => {
    const stats = accumulateAuxiliarySpend(emptyRunStats(), {
      inputTokens: 10,
      outputTokens: 0,
      costCents: 0,
    });
    expect(stats.outputTokensPerSecond).toBeNull();
    expect(stats.modelTimeMs).toBe(0);
  });

  it("does not mutate its input", () => {
    const before = accumulateTurn(emptyRunStats(), turn(500, 2_000));
    accumulateAuxiliarySpend(before, spend);
    expect(before.inputTokens).toBe(100);
    expect(before.outputTokens).toBe(500);
  });

  it("counts a compaction's own cached tokens when the transport reports them", () => {
    const stats = accumulateAuxiliarySpend(emptyRunStats(), {
      ...spend,
      cachedInputTokens: 3_200,
    });
    expect(stats.cachedInputTokens).toBe(3_200);
  });
});

describe("tool names that collide with Object.prototype", () => {
  // A tool name comes from the model, so `constructor` / `toString` / `valueOf`
  // are all reachable. A bare `breakdown[name] ?? 0` reads the inherited
  // property, and `function Object() {...} + 5` is a STRING — a corrupted
  // entry that still typechecks as `number`.
  const HAZARDS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it.each(HAZARDS)("accumulates %s as a number", (name) => {
    const stats = accumulateToolCall(emptyRunStats(), name, 5);
    expect(typeof stats.toolTimeBreakdownMs[name]).toBe("number");
    expect(stats.toolTimeBreakdownMs[name]).toBe(5);
    expect(stats.toolTimeMs).toBe(5);
  });

  it("keeps summing across calls to the same hazardous name", () => {
    let stats = emptyRunStats();
    stats = accumulateToolCall(stats, "constructor", 5);
    stats = accumulateToolCall(stats, "constructor", 7);
    expect(stats.toolTimeBreakdownMs["constructor"]).toBe(12);
    expect(stats.toolCalls).toBe(2);
  });

  it("merges them correctly across child runs too", () => {
    const a = { ...emptyRunStats(), toolTimeBreakdownMs: { constructor: 5 } };
    const b = { ...emptyRunStats(), toolTimeBreakdownMs: { constructor: 7 } };
    const merged = accumulateRun(a, b);
    expect(typeof merged.toolTimeBreakdownMs["constructor"]).toBe("number");
    expect(merged.toolTimeBreakdownMs["constructor"]).toBe(12);
  });
});
