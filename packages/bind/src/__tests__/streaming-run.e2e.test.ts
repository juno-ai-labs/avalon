/**
 * End-to-end: the turn kernel, the routing executor, a real circuit breaker,
 * and the text stream, composed the way a streaming host composes them.
 *
 * Every other suite in this package tests one directory. That is a real gap
 * rather than a stylistic one — `runToolLoop` had never run against
 * `executeRoutePlan`, `executeRoutePlan` had never run against
 * `createCircuitBreaker` (it is given a stub), and `createTurnTextStream`'s
 * whole reason to exist is a boolean the executor reads on every attempt, which
 * until now had only ever been a literal in a fixture. A contract asserted twice
 * from opposite sides against two different objects is not asserted.
 *
 * The shape here is the real one: `callModel` is a closure over
 * `executeRoutePlan`, so a mid-turn provider failure traverses the plan for
 * real, the breaker accumulates real state across turns, and the stream sees
 * real attempt boundaries.
 */
import { describe, expect, test } from "vitest";
import type OpenAI from "openai";
import {
  runToolLoop,
  type ToolCallOutcome,
  type ToolLoopParams,
  type ToolLoopState,
} from "../loop/tool-loop";
import { executeRoutePlan, type AttemptOutcome } from "../routing/executor";
import { createCircuitBreaker } from "../routing/circuit-breaker";
import { ROUTE_POLICY_VERSION } from "../routing/policy";
import type { RouteCandidate, RoutePlan, RouteStage } from "../routing/plan";
import {
  createTurnTextStream,
  type TurnStreamEvent,
  type TurnTextStream,
} from "../completion/text-stream";
import { validateAndHealMessages } from "../transcript/validate";
import { assistant, freshState, recordingSink } from "../testing";
import { cmid, httpError, makeCandidate, requirements } from "../routing/__tests__/fixtures";

const PRIMARY = cmid("openai/primary-model");
const FALLBACK = cmid("openai/fallback-model");

const A = makeCandidate("provider-a", PRIMARY);
const B = makeCandidate("provider-b", PRIMARY);
const FB = makeCandidate("provider-b", FALLBACK);

function stage(
  kind: RouteStage["kind"],
  canonicalModelId: typeof PRIMARY,
  candidates: readonly RouteCandidate[],
): RouteStage {
  return {
    kind,
    canonicalModelId,
    policy: { mode: "ordered", providers: candidates.map((c) => c.providerId) },
    candidates,
  };
}

const TWO_STAGE: RoutePlan = {
  policyVersion: ROUTE_POLICY_VERSION,
  requirements: requirements(),
  stages: [stage("primary", PRIMARY, [A, B]), stage("fallback_model", FALLBACK, [FB])],
};

/**
 * A client implementing the documented rule in full: scope by `turnId`, apply in
 * `seq` order (buffering anything early, dropping anything replayed), then drop
 * stale epochs and clear on a reset.
 *
 * The `seq` step is what makes the epoch step sound, so the helper the whole
 * suite renders through has to do it — a helper that ordered by epoch alone
 * would assert the surface is correct while being exactly the client bug the
 * module exists to prevent.
 */
function render(events: readonly TurnStreamEvent[], turnId = "turn_0"): string {
  const mine = events.filter((event) => event.turnId === turnId);
  const held = new Map<number, TurnStreamEvent>();
  let nextSeq = 0;
  let newestEpoch = -1;
  let out = "";

  const apply = (event: TurnStreamEvent): void => {
    if (event.epoch < newestEpoch) return; // stale attempt
    newestEpoch = event.epoch;
    if (event.kind === "reset") out = "";
    else out += event.text;
  };

  for (const event of mine) {
    if (event.seq < nextSeq) continue; // replay or duplicate
    held.set(event.seq, event);
    for (let queued = held.get(nextSeq); queued !== undefined; queued = held.get(nextSeq)) {
      held.delete(nextSeq);
      nextSeq += 1;
      apply(queued);
    }
  }
  return out;
}

/**
 * The same client with the `turnId` scope dropped — the shape the contract read
 * as before turn identity was on the wire. Kept so the test below can show what
 * it costs rather than assert the rule from prose.
 */
function renderUnscoped(events: readonly TurnStreamEvent[]): string {
  let newestEpoch = -1;
  let out = "";
  for (const event of events) {
    if (event.epoch < newestEpoch) continue;
    newestEpoch = event.epoch;
    if (event.kind === "reset") out = "";
    else out += event.text;
  }
  return out;
}

/**
 * One scripted provider response: the text it streams, then either a failure or
 * the assistant message it completes with.
 */
type Response =
  | { chunks: readonly string[]; fail: true }
  | { chunks: readonly string[]; message: OpenAI.ChatCompletionMessage };

/**
 * A `callModel` that drives a real `executeRoutePlan`, feeding a real text
 * stream. Responses are consumed one per ATTEMPT, so a script can make the
 * first provider die mid-stream and the second succeed.
 */
function streamingCallModel(
  responses: Response[],
  stream: TurnTextStream,
  breaker: ReturnType<typeof createCircuitBreaker>,
) {
  const attempted: string[] = [];
  const callModel = async (): Promise<{
    message: OpenAI.ChatCompletionMessage;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }> => {
    let result;
    try {
      result = await executeRoutePlan<OpenAI.ChatCompletionMessage>({
      plan: TWO_STAGE,
      breaker,
      completionDefectRetries: 0,
      attempt: (
        candidate,
        cursor,
      ): Promise<AttemptOutcome<OpenAI.ChatCompletionMessage>> => {
        attempted.push(String(candidate.providerId));
        stream.beginAttempt();
        const next = responses.shift();
        if (next === undefined) throw new Error("response script exhausted");
        for (const chunk of next.chunks) stream.observe(chunk);
        return Promise.resolve(
          "fail" in next
            ? {
                kind: "failure",
                error: httpError(candidate, cursor, 500, "server_error"),
                producedOutput: stream.producedOutput,
              }
            : { kind: "success", value: next.message },
        );
      },
      });
    } catch (error) {
      // A throw out of the executor — a host bug in `attempt`, a port raising —
      // must still close the turn, or an armed reset never lands and a dead
      // turn's narration stays on the surface. This helper is the composed
      // reference a consumer copies, so it models the discipline the README
      // states rather than the happy path alone.
      stream.finish("failed");
      throw error;
    }
    stream.finish(result.ok ? "succeeded" : "failed");
    if (!result.ok) throw new Error(`routing failed: ${result.reason}`);
    return { message: result.value, inputTokens: 10, outputTokens: 5, costCents: 1 };
  };
  return { callModel, attempted };
}

function loopParams(
  state: ToolLoopState,
  callModel: () => Promise<{
    message: OpenAI.ChatCompletionMessage;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }>,
  overrides: Partial<ToolLoopParams> = {},
) {
  const ran: string[] = [];
  return {
    ran,
    params: {
      state,
      activePlugins: new Set<string>(),
      maxIterations: 10,
      callModel,
      buildTools: () => [],
      runToolCall: async (
        tc: OpenAI.ChatCompletionMessageToolCall,
      ): Promise<ToolCallOutcome> => {
        ran.push(tc.id);
        return {
          toolMessage: { role: "tool", tool_call_id: tc.id, content: "{\"ok\":true}" },
        };
      },
      activatePlugins: () => {},
      activateSkills: () => {},
      ...overrides,
    },
  };
}

describe("a retractable surface keeps the whole fallback chain", () => {
  test("provider A dies mid-stream, B succeeds, and the reader sees only B's answer", async () => {
    // The claim the module was written for, end to end. Before it, A's partial
    // text either stayed on screen with B's answer appended, or the turn failed
    // outright because `producedOutput` withheld traversal.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: "turn_0" });
    const breaker = createCircuitBreaker({ now: () => 0 });
    const { callModel, attempted } = streamingCallModel(
      [
        { chunks: ["The answer ", "is 4"], fail: true },
        { chunks: ["The answer ", "is 42"], message: assistant("The answer is 42") },
      ],
      stream,
      breaker,
    );

    const state = freshState();
    const { params } = loopParams(state, callModel);
    await runToolLoop(params);

    expect(attempted).toEqual(["provider-a", "provider-b"]);
    expect(render(sink.events)).toBe("The answer is 42");
    expect(sink.events.filter((e) => e.kind === "reset")).toHaveLength(1);
    // The transcript carries one assistant turn, not two.
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("a NON-retractable surface stops at the first provider, as it always did", async () => {
    // The regression guard on the other half: moving emission into the package
    // must not quietly re-enable duplicate delivery for a surface that cannot
    // take anything back.
    const sink = recordingSink(false);
    const stream = createTurnTextStream({ sink, turnId: "turn_0" });
    const breaker = createCircuitBreaker({ now: () => 0 });
    const { callModel, attempted } = streamingCallModel(
      [
        { chunks: ["posted "], fail: true },
        { chunks: ["never reached"], message: assistant("unused") },
      ],
      stream,
      breaker,
    );

    const { params } = loopParams(freshState(), callModel);
    await expect(runToolLoop(params)).rejects.toThrow(/routing failed/);
    expect(attempted).toEqual(["provider-a"]);
  });

  test("a failure BEFORE any byte traverses without wiping anything", async () => {
    // The common case — connection refused, a 429, a 5xx at the header. Nothing
    // was shown, so there is nothing to retract and no reset should reach the
    // client to make it flicker.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: "turn_0" });
    const { callModel } = streamingCallModel(
      [
        { chunks: [], fail: true },
        { chunks: ["clean answer"], message: assistant("clean answer") },
      ],
      stream,
      createCircuitBreaker({ now: () => 0 }),
    );

    await runToolLoop(loopParams(freshState(), callModel).params);
    expect(sink.events.every((e) => e.kind === "text")).toBe(true);
    expect(render(sink.events)).toBe("clean answer");
  });

  test("maxResets latching actually stops the executor traversing", async () => {
    // The boundary is a boolean read between two modules on every attempt, and
    // it had only ever been a literal in a fixture. With a budget of one wipe,
    // the plan must stop after the second failure rather than reaching the
    // fallback model.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: "turn_0", maxResets: 1 });
    const { callModel, attempted } = streamingCallModel(
      [
        { chunks: ["one"], fail: true },
        { chunks: ["two"], fail: true },
        { chunks: ["three"], fail: true },
      ],
      stream,
      createCircuitBreaker({ now: () => 0 }),
    );

    await expect(runToolLoop(loopParams(freshState(), callModel).params)).rejects.toThrow(
      /routing failed/,
    );
    // A and B ran; the fallback-model stage was withheld by the clamp.
    expect(attempted).toEqual(["provider-a", "provider-b"]);
    expect(stream.producedOutput).toBe(true);
  });
});

describe("the breaker accumulates real state across a multi-turn run", () => {
  test("an endpoint that fails every turn is eventually skipped without an attempt", async () => {
    // Three turns, provider A failing mid-stream on each. The breaker's
    // threshold is 2, so turn 3 must not attempt A at all — and the stream must
    // stay coherent when the first attempt of a turn is the one that succeeds.
    const sink = recordingSink(true);
    const breaker = createCircuitBreaker({ failureThreshold: 2, now: () => 0 });
    const state = freshState();
    const attemptedByTurn: string[][] = [];

    for (let turn = 0; turn < 3; turn++) {
      const stream = createTurnTextStream({ sink, turnId: `turn_${turn}` });
      const last = turn === 2;
      const { callModel, attempted } = streamingCallModel(
        [
          { chunks: [`turn ${turn} partial`], fail: true },
          {
            chunks: [`turn ${turn} answer`],
            message: last
              ? assistant(`turn ${turn} answer`)
              : assistant(`turn ${turn} answer`, [{ id: `c${turn}`, name: "noop" }]),
          },
        ],
        stream,
        breaker,
      );
      // One turn per loop run: the model script is per-turn, and the loop would
      // otherwise consume the next turn's responses.
      const { params } = loopParams(state, callModel, { maxIterations: 1 });
      await runToolLoop(params);
      attemptedByTurn.push(attempted);
    }

    expect(attemptedByTurn[0]).toEqual(["provider-a", "provider-b"]);
    expect(attemptedByTurn[1]).toEqual(["provider-a", "provider-b"]);
    // Two consecutive failures opened A, so turn 3 never touches it — the
    // second `provider-b` is the fallback-model stage, which also runs there.
    expect(attemptedByTurn[2]).not.toContain("provider-a");
  });

  test("each turn's stream restarts at epoch 0, and a client keyed per turn is fine", async () => {
    // The epoch is per-TURN, not per-run, so a client that carries `newestEpoch`
    // across turns would reject turn 2 entirely. Asserted here because the
    // module's client rule reads as global until you see this.
    const perTurn: TurnStreamEvent[][] = [];
    const state = freshState();
    const breaker = createCircuitBreaker({ now: () => 0 });

    for (let turn = 0; turn < 2; turn++) {
      const sink = recordingSink(true);
      const stream = createTurnTextStream({ sink, turnId: `turn_${turn}` });
      const { callModel } = streamingCallModel(
        [{ chunks: [`turn ${turn}`], message: assistant(`turn ${turn}`) }],
        stream,
        breaker,
      );
      await runToolLoop(loopParams(state, callModel, { maxIterations: 1 }).params);
      perTurn.push(sink.events);
    }

    expect(perTurn.map((events) => events[0]?.epoch)).toEqual([0, 0]);
    expect(perTurn.map((events) => events[0]?.seq)).toEqual([0, 0]);
    expect(perTurn.map((events) => events[0]?.turnId)).toEqual(["turn_0", "turn_1"]);
    expect(perTurn.map((events, turn) => render(events, `turn_${turn}`))).toEqual([
      "turn 0",
      "turn 1",
    ]);
  });
});

describe("a multi-turn, multi-tool run that streams throughout", () => {
  test("three turns, five tool calls, a mid-stream fallback, and a healable transcript", async () => {
    // The composed case: turn 1 asks for three tools, turn 2 asks for two more
    // and its FIRST provider dies mid-stream, turn 3 answers. What this catches
    // that no unit test can: the loop losing transcript coherence when one
    // `callModel` burned several attempts internally, and the healed transcript
    // disagreeing with what the loop actually built.
    const sink = recordingSink(true);
    const breaker = createCircuitBreaker({ now: () => 0 });
    const state = freshState();
    const allRan: string[] = [];

    const turns: Response[][] = [
      [
        {
          chunks: ["Looking ", "into it"],
          message: assistant("Looking into it", [
            { id: "t1", name: "search" },
            { id: "t2", name: "read" },
            { id: "t3", name: "list" },
          ]),
        },
      ],
      [
        { chunks: ["Almost "], fail: true },
        {
          chunks: ["Nearly ", "done"],
          message: assistant("Nearly done", [
            { id: "t4", name: "write" },
            { id: "t5", name: "notify" },
          ]),
        },
      ],
      [{ chunks: ["All ", "done."], message: assistant("All done.") }],
    ];

    for (const [turn, responses] of turns.entries()) {
      const stream = createTurnTextStream({ sink, turnId: `turn_${turn}` });
      const { callModel } = streamingCallModel([...responses], stream, breaker);
      const { params, ran } = loopParams(state, callModel, { maxIterations: 1 });
      await runToolLoop(params);
      allRan.push(...ran);
    }

    expect(allRan).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(render(sink.events, "turn_0")).toBe("Looking into it");
    expect(render(sink.events, "turn_1")).toBe("Nearly done");
    expect(render(sink.events, "turn_2")).toBe("All done.");
    // Why `turnId` is on the wire: epoch and seq both restart each turn, so a
    // client that carried "newest epoch" across turns drops everything after
    // the first turn that retried — here, turn 2's answer never renders.
    expect(renderUnscoped(sink.events)).toBe("Nearly done");
    // Exactly one wipe, from turn 2's mid-stream failure.
    expect(sink.events.filter((e) => e.kind === "reset")).toHaveLength(1);

    expect(state.messages.filter((m) => m.role === "tool")).toHaveLength(5);
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(3);

    // The check a host runs before every request, and the one that catches a
    // loop leaving a dangling `tool_calls` message. Every call the loop appended
    // is answered, so the healer reports nothing to repair — the only edit is
    // the trailing nudge it adds because the transcript ends on an assistant
    // turn, which is a shape rule rather than damage.
    const healed = validateAndHealMessages(state.messages);
    expect(healed.issues.map((issue) => issue.kind)).toEqual([
      "trailing_assistant_with_content",
    ]);
    expect(healed.messages.slice(0, state.messages.length)).toEqual(state.messages);
  });
});

describe("the client rule under a transport that reorders and duplicates", () => {
  // The race the module exists for, driven through the documented client rather
  // than asserted in prose. Ordering by `epoch` alone is not enough: it is
  // `seq` that makes the epoch step sound.
  const turn: TurnStreamEvent[] = [
    { kind: "text", turnId: "turn_0", epoch: 0, seq: 0, text: "The answer is 4" },
    { kind: "reset", turnId: "turn_0", epoch: 1, seq: 1, reason: "attempt_failed" },
    { kind: "text", turnId: "turn_0", epoch: 1, seq: 2, text: "The answer is 42" },
  ];

  test("a same-epoch reorder — the retry's text arriving before its own reset", () => {
    // The case an epoch-only client gets exactly backwards: it accepts the text,
    // then the late reset clears it and the surface ends up blank.
    const reordered = [turn[0], turn[2], turn[1]] as TurnStreamEvent[];
    expect(render(reordered)).toBe("The answer is 42");
  });

  test("a duplicated text event is applied once, not appended twice", () => {
    expect(render([turn[0], turn[1], turn[2], turn[2]] as TurnStreamEvent[])).toBe(
      "The answer is 42",
    );
  });

  test("a replayed reset cannot erase text that already superseded it", () => {
    expect(render([...turn, turn[1]] as TurnStreamEvent[])).toBe("The answer is 42");
  });

  test("a stale delta from the wiped attempt is dropped, not appended", () => {
    // This one `seq` alone cannot catch — the late delta has a fresh seq and a
    // stale epoch, which is precisely why both keys are on the wire.
    const late: TurnStreamEvent = {
      kind: "text",
      turnId: "turn_0",
      epoch: 0,
      seq: 3,
      text: " …no wait",
    };
    expect(render([...turn, late])).toBe("The answer is 42");
  });

  test("in-order delivery renders the same thing, so the buffering is inert", () => {
    expect(render(turn)).toBe("The answer is 42");
  });
});
