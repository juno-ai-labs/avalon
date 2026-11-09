import { describe, expect, test } from "vitest";
import {
  createToolCallAccumulator,
  type ToolCallDelta,
} from "../stream-assembly";
import { detectCompletionDefect } from "../defects";
import { toolCallArgumentsAbsent } from "../tool-calls";

const feed = (...chunks: ToolCallDelta[][]) => {
  const acc = createToolCallAccumulator();
  for (const chunk of chunks) acc.observe(chunk);
  return acc;
};

describe("createToolCallAccumulator", () => {
  test("assembles one call from its fragments", () => {
    const acc = feed(
      [{ index: 0, id: "call_a", function: { name: "read_", arguments: '{"pa' } }],
      [{ index: 0, function: { name: "file", arguments: 'th":"/tmp/a"}' } }],
    );
    expect(acc.assembled()).toEqual([
      { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/a"}' } },
    ]);
  });

  // Footgun 3. Assigning instead of concatenating keeps only the last
  // fragment, so `read_file` arrives as `file` — an unknown-tool error naming
  // a tool the model never asked for.
  test("the NAME is concatenated, not assigned", () => {
    const acc = feed(
      [{ index: 0, id: "c", function: { name: "sp" } }],
      [{ index: 0, function: { name: "awn_" } }],
      [{ index: 0, function: { name: "agent" } }],
    );
    expect(acc.assembled()[0]?.function.name).toBe("spawn_agent");
  });

  // Footgun 1 + 4. Both fail silently: the calls still parse, the model just
  // gets the wrong tool's arguments.
  test("out-of-order deltas land in provider index order, not arrival order", () => {
    const acc = feed(
      [{ index: 1, id: "second", function: { name: "b", arguments: "{}" } }],
      [{ index: 0, id: "first", function: { name: "a", arguments: "{}" } }],
    );
    expect(acc.assembled().map((c) => c.id)).toEqual(["first", "second"]);
  });

  // Footgun 2. A call assembled without an id cannot be answered, and the
  // provider rejects the whole transcript on the NEXT request.
  test("an id arriving in a later chunk is still captured", () => {
    const acc = feed(
      [{ index: 0, function: { name: "do_thing", arguments: "{}" } }],
      [{ index: 0, id: "call_late" }],
    );
    expect(acc.assembled()[0]?.id).toBe("call_late");
  });

  test("a later empty id does not erase one already seen", () => {
    const acc = feed(
      [{ index: 0, id: "call_a", function: { name: "x" } }],
      [{ index: 0, id: "", function: { arguments: "{}" } }],
    );
    expect(acc.assembled()[0]?.id).toBe("call_a");
  });

  test("interleaved calls stay separate", () => {
    const acc = feed(
      [{ index: 0, id: "a", function: { name: "one", arguments: '{"x' } }],
      [{ index: 1, id: "b", function: { name: "two", arguments: '{"y' } }],
      [{ index: 0, function: { arguments: '":1}' } }],
      [{ index: 1, function: { arguments: '":2}' } }],
    );
    expect(acc.assembled()).toEqual([
      { id: "a", type: "function", function: { name: "one", arguments: '{"x":1}' } },
      { id: "b", type: "function", function: { name: "two", arguments: '{"y":2}' } },
    ]);
  });

  test("a zero-argument call assembles with empty arguments", () => {
    // Not a defect — `detectCompletionDefect` and `parseToolCallArguments`
    // both read this as the legitimate zero-arg shape.
    const acc = feed([{ index: 0, id: "z", function: { name: "list_all" } }]);
    expect(acc.assembled()).toEqual([
      { id: "z", type: "function", function: { name: "list_all", arguments: "" } },
    ]);
  });

  test("isEmpty distinguishes no calls from unassembled ones", () => {
    const empty = feed();
    expect(empty.isEmpty).toBe(true);
    expect(empty.assembled()).toEqual([]);

    const one = feed([{ index: 0, id: "a", function: { name: "x" } }]);
    expect(one.isEmpty).toBe(false);
  });

  test("undefined and empty chunks are no-ops", () => {
    const acc = createToolCallAccumulator();
    acc.observe(undefined);
    acc.observe([]);
    expect(acc.isEmpty).toBe(true);
  });

  test("a delta with an unusable index is dropped, not misfiled", () => {
    // Losing a call surfaces as a missing tool call; guessing a slot corrupts
    // a different one that will look perfectly valid.
    const acc = feed([
      { index: 0, id: "good", function: { name: "keep", arguments: "{}" } },
      { index: -1, id: "bad", function: { name: "drop" } },
      { index: 1.5, id: "worse", function: { name: "drop" } },
    ]);
    expect(acc.assembled().map((c) => c.id)).toEqual(["good"]);
  });

  test("assembled() is a snapshot and does not end accumulation", () => {
    const acc = createToolCallAccumulator();
    acc.observe([{ index: 0, id: "a", function: { name: "x", arguments: '{"a' } }]);
    const mid = acc.assembled();
    acc.observe([{ index: 0, function: { arguments: '":1}' } }]);
    expect(mid[0]?.function.arguments).toBe('{"a');
    expect(acc.assembled()[0]?.function.arguments).toBe('{"a":1}');
  });
});

describe("deltas that carry no index at all", () => {
  // A provider omitting `index` is describing a single call and is
  // intelligible; one sending `-1` or `"0"` is not. The old hand-rolled loop
  // folded the former into one slot by accident (`Map.get(undefined)`), and
  // dropping it instead silently loses a call the model asked for.
  test("an index-less delta assembles rather than being dropped", () => {
    const acc = feed([
      { id: "call_1", function: { name: "submit", arguments: "{}" } },
    ] as ToolCallDelta[]);
    expect(acc.droppedDeltas).toBe(0);
    expect(acc.assembled()).toEqual([
      { id: "call_1", type: "function", function: { name: "submit", arguments: "{}" } },
    ]);
  });

  test("index-less deltas for the same call fold into one", () => {
    const acc = feed(
      [{ id: "c", function: { name: "sub" } }] as ToolCallDelta[],
      [{ function: { name: "mit", arguments: "{}" } }] as ToolCallDelta[],
    );
    expect(acc.assembled()).toEqual([
      { id: "c", type: "function", function: { name: "submit", arguments: "{}" } },
    ]);
  });

  // Regression: the implicit call was first keyed with a sentinel INDEX
  // (`Number.MAX_SAFE_INTEGER`), which shares a keyspace with real ones — so an
  // explicit delta at that index merged with the implicit call and their names
  // concatenated. That is footgun 3, re-created by the fix for footgun 5.
  test("the implicit call never collides with an explicit maximal index", () => {
    const acc = feed([
      { index: Number.MAX_SAFE_INTEGER, id: "explicit", function: { name: "a" } },
      { id: "implicit", function: { name: "b" } },
    ] as ToolCallDelta[]);
    expect(acc.assembled()).toEqual([
      { id: "explicit", type: "function", function: { name: "a", arguments: "" } },
      { id: "implicit", type: "function", function: { name: "b", arguments: "" } },
    ]);
  });

  test("the implicit call sorts after every indexed one", () => {
    const acc = feed([
      { id: "implicit", function: { name: "z" } },
      { index: 0, id: "first", function: { name: "a" } },
    ] as ToolCallDelta[]);
    expect(acc.assembled().map((c) => c.id)).toEqual(["first", "implicit"]);
  });
});

describe("droppedDeltas", () => {
  test("counts every unplaceable delta so the loss is observable", () => {
    // The batch still comes back non-empty, so defect detection sees nothing
    // wrong and no retry fires. This counter is the only signal a call was lost.
    const acc = feed([
      { index: 0, id: "good", function: { name: "keep" } },
      { index: -1, id: "bad" },
      { index: 1.5, id: "worse" },
      { index: "0" as unknown as number, id: "worst" },
      { index: Number.NaN, id: "worstest" },
    ] as ToolCallDelta[]);
    expect(acc.droppedDeltas).toBe(4);
    expect(acc.assembled().map((c) => c.id)).toEqual(["good"]);
  });

  test("is zero when nothing was lost", () => {
    expect(feed([{ index: 0, id: "a", function: { name: "x" } }]).droppedDeltas).toBe(0);
    expect(createToolCallAccumulator().droppedDeltas).toBe(0);
  });
});

describe("the zero-argument rule holds through assembly", () => {
  // The contract stream-assembly shares with its two sibling modules: an
  // assembled zero-arg call must read as legitimate, not as a defect. Asserted
  // rather than left in a comment, so a change to any of the three breaks here.
  test("an assembled zero-arg call is not a defect and dispatches with no arguments", () => {
    const [call] = feed([{ index: 0, id: "z", function: { name: "list_all" } }]).assembled();
    if (call === undefined) throw new Error("expected one call");
    expect(detectCompletionDefect({ content: null, tool_calls: [call] }, false)).toBeNull();
    expect(toolCallArgumentsAbsent(call.function.arguments)).toBe(true);
    // The same shape cut by the token limit IS a defect.
    expect(
      detectCompletionDefect({ content: null, tool_calls: [call] }, true)?.kind,
    ).toBe("truncated_tool_call");
  });
});

describe("observe is defensive about its input", () => {
  test("null is a no-op, not a throw", () => {
    const acc = createToolCallAccumulator();
    acc.observe(null as unknown as undefined);
    expect(acc.isEmpty).toBe(true);
  });

  test("assembled() returns a fresh array each call", () => {
    // A caller that mutated the result must not corrupt a later caller's view.
    const acc = feed([{ index: 0, id: "a", function: { name: "x" } }]);
    expect(acc.assembled()).not.toBe(acc.assembled());
    expect(acc.isEmpty).toBe(false);
  });
});
