import { describe, expect, test } from "vitest";
import {
  detectCompletionDefect,
  expectsJsonOutput,
  jsonParses,
  structuredOutputParses,
} from "../defects";

function toolCall(args: string, name = "do_thing") {
  return { function: { name, arguments: args } };
}

describe("detectCompletionDefect", () => {
  test("no content, tool calls, or refusal is an empty completion", () => {
    expect(detectCompletionDefect({ content: null }, false)).toEqual({
      kind: "empty_completion",
    });
    expect(
      detectCompletionDefect({ content: "", refusal: null, tool_calls: [] }, false),
    ).toEqual({ kind: "empty_completion" });
  });

  test("a refusal alone is a valid completion, not a defect", () => {
    expect(
      detectCompletionDefect({ content: null, refusal: "I can't help with that" }, false),
    ).toBeNull();
  });

  test("content alone is a valid completion", () => {
    expect(detectCompletionDefect({ content: "hello" }, false)).toBeNull();
  });

  test("non-empty unparseable arguments are always a truncation", () => {
    const truncated = toolCall('{"path":"/tmp/a');
    expect(
      detectCompletionDefect({ content: null, tool_calls: [truncated] }, false),
    ).toEqual({ kind: "truncated_tool_call", toolCall: truncated });
  });

  test("well-formed arguments are not a defect", () => {
    expect(
      detectCompletionDefect(
        { content: null, tool_calls: [toolCall('{"path":"/tmp/a"}')] },
        false,
      ),
    ).toBeNull();
  });

  test("empty arguments are the legitimate zero-arg shape when the model stopped normally", () => {
    expect(
      detectCompletionDefect({ content: null, tool_calls: [toolCall("")] }, false),
    ).toBeNull();
    expect(
      detectCompletionDefect({ content: null, tool_calls: [toolCall("   ")] }, false),
    ).toBeNull();
  });

  test("empty arguments ARE a truncation when the generation was cut by the token limit", () => {
    // The distinguishing case: identical message, different finish_reason. A
    // length-cut empty-args call is a half-streamed turn, and exempting it would
    // let a dispatcher execute an optional-arg tool the model never finished
    // asking for.
    const cut = toolCall("");
    expect(detectCompletionDefect({ content: null, tool_calls: [cut] }, true)).toEqual(
      { kind: "truncated_tool_call", toolCall: cut },
    );
  });

  test("the FIRST truncated call is reported when several are present", () => {
    const good = toolCall("{}", "first");
    const bad = toolCall("{oops", "second");
    const alsoBad = toolCall("{also", "third");
    expect(
      detectCompletionDefect(
        { content: null, tool_calls: [good, bad, alsoBad] },
        false,
      ),
    ).toEqual({ kind: "truncated_tool_call", toolCall: bad });
  });

  test("an empty tool_calls array is still an empty completion", () => {
    // `[]` is falsy-adjacent in a way that is easy to get wrong: it is a
    // present array, so a `!== undefined` check alone would treat it as "the
    // model called a tool" and skip the empty-completion branch entirely.
    expect(detectCompletionDefect({ content: null, tool_calls: [] }, true)).toEqual({
      kind: "empty_completion",
    });
  });

  test("a tool call with no readable arguments is skipped, not inspected", () => {
    // `tool_calls` accepts a host's full SDK union, which may include members
    // with no `function` at all (OpenAI's `type: "custom"`). Reading
    // `.function.arguments` off one would throw a raw TypeError out of the
    // harness — classified as a non-transport client error, so the whole run
    // fails with no retry, on a completion that was perfectly usable.
    const custom = { type: "custom", custom: { name: "c", input: "..." } };
    expect(
      detectCompletionDefect(
        { content: "an answer", tool_calls: [custom as never] },
        true,
      ),
    ).toBeNull();
  });

  test("a readable truncation is still found alongside an unreadable sibling", () => {
    const custom = { type: "custom", custom: { name: "c", input: "..." } };
    const bad = toolCall("{oops");
    expect(
      detectCompletionDefect(
        { content: null, tool_calls: [custom as never, bad] },
        false,
      ),
    ).toEqual({ kind: "truncated_tool_call", toolCall: bad });
  });
});

describe("expectsJsonOutput", () => {
  test("json_schema and json_object expect JSON", () => {
    expect(expectsJsonOutput({ type: "json_schema" })).toBe(true);
    expect(expectsJsonOutput({ type: "json_object" })).toBe(true);
  });

  test("text, absent, and unknown formats do not", () => {
    expect(expectsJsonOutput({ type: "text" })).toBe(false);
    expect(expectsJsonOutput(undefined)).toBe(false);
    expect(expectsJsonOutput(null)).toBe(false);
    expect(expectsJsonOutput({})).toBe(false);
  });
});

describe("structuredOutputParses", () => {
  test("valid JSON content passes", () => {
    expect(structuredOutputParses({ content: '{"ok":true}' })).toBe(true);
  });

  test("malformed JSON fails", () => {
    expect(structuredOutputParses({ content: '{"ok":true' })).toBe(false);
  });

  test("a bare boolean is valid JSON and passes", () => {
    // Some models answer a boolean schema with the bare literal; rejecting it
    // would retry a perfectly good completion three times.
    expect(structuredOutputParses({ content: "true" })).toBe(true);
    expect(structuredOutputParses({ content: "false" })).toBe(true);
  });

  test("fenced JSON is unwrapped before parsing", () => {
    expect(structuredOutputParses({ content: '```json\n{"ok":true}\n```' })).toBe(true);
    expect(structuredOutputParses({ content: '```\n{"ok":true}\n```' })).toBe(true);
    expect(structuredOutputParses({ content: '```JSON\n{"ok":true}\n```' })).toBe(true);
  });

  test("empty and whitespace-only content fail rather than short-circuiting", () => {
    // A whitespace-only completion is truthy at the empty-completion check, so
    // it reaches here; it is not valid JSON and must earn a retry.
    expect(structuredOutputParses({ content: "" })).toBe(false);
    expect(structuredOutputParses({ content: "   \n " })).toBe(false);
    expect(structuredOutputParses({ content: null })).toBe(false);
  });

  test("tool calls and refusals are valid non-JSON outcomes", () => {
    expect(structuredOutputParses({ content: null, tool_calls: [{}] })).toBe(true);
    expect(structuredOutputParses({ content: "not json", refusal: "no" })).toBe(true);
  });

  test("an empty tool_calls array does not count as a tool call", () => {
    expect(structuredOutputParses({ content: "not json", tool_calls: [] })).toBe(false);
  });
});

describe("jsonParses", () => {
  test("distinguishes parseable from unparseable", () => {
    expect(jsonParses("{}")).toBe(true);
    expect(jsonParses("[1,2]")).toBe(true);
    expect(jsonParses("null")).toBe(true);
    expect(jsonParses("")).toBe(false);
    expect(jsonParses("{")).toBe(false);
    expect(jsonParses("undefined")).toBe(false);
  });
});
