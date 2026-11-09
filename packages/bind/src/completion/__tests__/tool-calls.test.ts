import { describe, expect, test } from "vitest";
import {
  parseToolCallArguments,
  toolCallArgumentsAbsent,
  type DispatchableToolCall,
} from "../tool-calls";
import { detectCompletionDefect } from "../defects";

const call = (args: string, type: string | undefined = "function"): DispatchableToolCall => ({
  type,
  function: { name: "do_thing", arguments: args },
});

describe("toolCallArgumentsAbsent", () => {
  test("empty and whitespace-only are both absent", () => {
    // A provider that pads its zero-arg payload is still saying "no
    // arguments"; treating "  " as content sends it to a parse that can only
    // fail.
    expect(toolCallArgumentsAbsent("")).toBe(true);
    expect(toolCallArgumentsAbsent("   ")).toBe(true);
    expect(toolCallArgumentsAbsent("\n\t ")).toBe(true);
  });

  test("anything else is present, including empty JSON containers", () => {
    expect(toolCallArgumentsAbsent("{}")).toBe(false);
    expect(toolCallArgumentsAbsent("[]")).toBe(false);
    expect(toolCallArgumentsAbsent('{"a":1}')).toBe(false);
  });
});

describe("parseToolCallArguments", () => {
  test("parses a normal object payload", () => {
    expect(parseToolCallArguments(call('{"path":"/tmp/a"}'))).toEqual({
      kind: "parsed",
      arguments: { path: "/tmp/a" },
    });
  });

  test("an explicit empty object parses to no arguments", () => {
    expect(parseToolCallArguments(call("{}"))).toEqual({
      kind: "parsed",
      arguments: {},
    });
  });

  // The rule this module exists to keep aligned with `detectCompletionDefect`.
  // Providers send "" for a zero-arg call as readily as "{}"; feeding "" to
  // JSON.parse killed a perfectly good call as "Invalid JSON in tool
  // arguments" and burned a recovery turn on a turn that was never broken.
  test("absent arguments dispatch as a zero-arg call, not a parse failure", () => {
    for (const raw of ["", "   ", "\n"]) {
      expect(parseToolCallArguments(call(raw))).toEqual({
        kind: "parsed",
        arguments: {},
      });
    }
  });

  test("a missing arguments field is the same as an empty one", () => {
    expect(parseToolCallArguments({ type: "function", function: { name: "x" } })).toEqual({
      kind: "parsed",
      arguments: {},
    });
    expect(parseToolCallArguments({ type: "function" })).toEqual({
      kind: "parsed",
      arguments: {},
    });
  });

  test("non-empty unparseable arguments are reported, not thrown", () => {
    // Every outcome has to end with the host emitting a `tool` message for
    // this id — an assistant tool call with no matching response is rejected
    // by the provider on the NEXT request, so throwing is never an option.
    const result = parseToolCallArguments(call('{"path":"/tmp/a'));
    expect(result.kind).toBe("unparseable");
    if (result.kind !== "unparseable") throw new Error("expected unparseable");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  test("valid JSON that is not an object is refused rather than dispatched", () => {
    // Tool arguments are a named parameter bag by definition. Handing a tool
    // an array or a bare scalar turns a clear failure here into a confusing
    // one inside the tool — and only AFTER it has been dispatched, which
    // matters for a tool whose side effect precedes its own validation.
    for (const raw of ["null", "[]", "42", '"a string"', "true"]) {
      const result = parseToolCallArguments(call(raw));
      expect(result.kind).toBe("unparseable");
    }
  });

  test("the detail names what actually arrived, not what typeof calls it", () => {
    // `typeof null` and `typeof []` are both "object" — reporting either as
    // "got object" describes the payload as the very thing it was rejected for
    // not being, and this string is what the model reads to correct itself.
    const detailFor = (raw: string): string => {
      const result = parseToolCallArguments(call(raw));
      if (result.kind !== "unparseable") throw new Error("expected unparseable");
      return result.detail;
    };
    expect(detailFor("null")).toBe("expected a JSON object, got null");
    expect(detailFor("[]")).toBe("expected a JSON object, got an array");
    expect(detailFor("42")).toBe("expected a JSON object, got number");
    expect(detailFor('"a string"')).toBe("expected a JSON object, got string");
    expect(detailFor("true")).toBe("expected a JSON object, got boolean");
  });

  test("a non-function tool call is refused by type", () => {
    const result = parseToolCallArguments({ type: "custom", function: undefined });
    expect(result).toEqual({ kind: "unsupported_type", type: "custom" });
  });

  test("an absent type is treated as the function call it almost always is", () => {
    // A host assembling calls by hand may not carry `type`. Refusing those
    // would break dispatch for every such host; a PRESENT non-function type is
    // the actual protocol drift.
    expect(parseToolCallArguments(call('{"a":1}', undefined))).toEqual({
      kind: "parsed",
      arguments: { a: 1 },
    });
  });
});

describe("the zero-argument rule holds across both halves", () => {
  // This is the pairing the module header describes. `detectCompletionDefect`
  // decides upstream whether a call survives to be dispatched;
  // `parseToolCallArguments` decides what dispatching it means. If they ever
  // disagree about "absent", one of these two assertions breaks.
  const zeroArg = { function: { name: "do_thing", arguments: "  " } };

  test("a zero-arg call on a normal stop is passed through AND dispatches", () => {
    expect(
      detectCompletionDefect({ content: null, tool_calls: [zeroArg] }, false),
    ).toBeNull();
    expect(parseToolCallArguments({ type: "function", ...zeroArg })).toEqual({
      kind: "parsed",
      arguments: {},
    });
  });

  test("the same call cut by the token limit is a defect and never reaches dispatch", () => {
    expect(
      detectCompletionDefect({ content: null, tool_calls: [zeroArg] }, true),
    ).toEqual({ kind: "truncated_tool_call", toolCall: zeroArg });
  });
});
