import { describe, expect, test } from "vitest";
import type OpenAI from "openai";
import { validateAndHealMessages } from "../validate";

type Msg = OpenAI.ChatCompletionMessageParam;

function sys(content: string): Msg {
  return { role: "system", content };
}
function user(content: string): Msg {
  return { role: "user", content };
}
function assistant(
  content: string | null,
  toolCalls?: Array<{ id: string; name: string; args?: string }>,
): Msg {
  const base: OpenAI.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content,
  };
  if (toolCalls && toolCalls.length > 0) {
    base.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.args ?? "{}" },
    }));
  }
  return base;
}
function tool(toolCallId: string, content: string): Msg {
  return { role: "tool", tool_call_id: toolCallId, content };
}

describe("validateAndHealMessages", () => {
  test("clean conversation passes through unchanged", () => {
    const input: Msg[] = [sys("s"), user("hi"), assistant("hello"), user("again")];
    const result = validateAndHealMessages(input);
    expect(result.issues).toEqual([]);
    expect(result.messages).toEqual(input);
  });

  test("empty array is flagged but returned", () => {
    const result = validateAndHealMessages([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.kind).toBe("empty_messages");
    expect(result.issues[0]?.healed).toBe(false);
  });

  test("appends synthetic user turn when conversation ends on assistant text", () => {
    const input: Msg[] = [sys("s"), user("hi"), assistant("here is a summary")];
    const result = validateAndHealMessages(input);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.kind).toBe("trailing_assistant_with_content");
    expect(result.issues[0]?.healed).toBe(true);
    const last = result.messages.at(-1)!;
    expect(last.role).toBe("user");
  });

  test("drops trailing assistant that is fully empty", () => {
    const input: Msg[] = [sys("s"), user("hi"), assistant(null)];
    const result = validateAndHealMessages(input);
    expect(result.issues.some((i) => i.kind === "empty_assistant_mid")).toBe(true);
    // After dropping the empty assistant, the conversation correctly ends
    // on the user turn — no synthetic user turn needed.
    expect(result.issues.some((i) => i.kind === "trailing_assistant_with_content")).toBe(
      false,
    );
    expect(result.messages.at(-1)?.role).toBe("user");
  });

  test("drops orphan tool result with no matching assistant tool_call", () => {
    const input: Msg[] = [sys("s"), user("hi"), tool("call-nobody", "{}"), assistant("ok")];
    const result = validateAndHealMessages(input);
    expect(result.issues.some((i) => i.kind === "orphan_tool_result")).toBe(true);
    expect(result.messages).not.toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "call-nobody" }),
    );
  });

  test("strips unanswered tool_calls when next message is a user turn", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant("thinking", [{ id: "call-1", name: "search" }]),
      user("never mind"),
    ];
    const result = validateAndHealMessages(input);
    expect(
      result.issues.some((i) => i.kind === "dangling_tool_calls_unanswered"),
    ).toBe(true);
    const assistantOut = result.messages.find((m) => m.role === "assistant") as
      | OpenAI.ChatCompletionAssistantMessageParam
      | undefined;
    expect(assistantOut).toBeDefined();
    expect(assistantOut?.tool_calls).toBeUndefined();
    expect(assistantOut?.content).toBe("thinking");
  });

  test("drops empty assistant whose only payload was unanswered tool_calls", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant(null, [{ id: "call-1", name: "search" }]),
      user("never mind"),
    ];
    const result = validateAndHealMessages(input);
    expect(
      result.issues.some((i) => i.kind === "dangling_tool_calls_unanswered"),
    ).toBe(true);
    expect(result.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  test("preserves assistant message with tool_calls when tool results follow", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant(null, [{ id: "call-1", name: "search" }]),
      tool("call-1", "{\"ok\":true}"),
      assistant("done"),
      user("thanks"),
    ];
    const result = validateAndHealMessages(input);
    expect(result.issues).toEqual([]);
    expect(result.messages).toEqual(input);
  });

  test("drops empty mid-conversation user message", () => {
    const input: Msg[] = [sys("s"), user("hi"), user(""), assistant("ok"), user("k")];
    const result = validateAndHealMessages(input);
    expect(result.issues.some((i) => i.kind === "empty_user_content")).toBe(true);
    expect(result.messages).toHaveLength(4);
  });

  test("heals the exact Azure-rejection shape: trailing assistant text with no diff", () => {
    // Mirrors the failure we observed in production: session replay left
    // an assistant text summary as the final message, and OpenRouter →
    // Azure rejected the request with "assistant prefill not supported".
    const input: Msg[] = [
      sys("system prompt"),
      user("context block"),
      assistant("ok, what do you need?"),
      user("paste them individually"),
      assistant("posted two messages"),
      tool("call-1", "{}"),
      assistant("Here's the summary of 10 companies…"),
    ];
    const result = validateAndHealMessages(input);
    // The inner orphan "tool" after the plain assistant is detected (no
    // matching tool_calls), then the new trailing user is appended.
    expect(result.issues.length).toBeGreaterThan(0);
    const last = result.messages.at(-1)!;
    expect(last.role).toBe("user");
  });

  test("issues include the offending message index", () => {
    const input: Msg[] = [sys("s"), user("hi"), assistant(null), user("k")];
    const result = validateAndHealMessages(input);
    const issue = result.issues.find((i) => i.kind === "empty_assistant_mid");
    expect(issue).toBeDefined();
    expect(issue?.index).toBe(2);
  });
});

describe("validateAndHealMessages — allowedOpenToolCallIds (HITL Phase 1)", () => {
  test("fails loud when an ALLOWED (suspended) tool_call reaches the validator unpaired", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant("Pick one:", [{ id: "call_ask", name: "ask" }]),
      // No tool result for call_ask — a suspended call that must never be sent
      // unpaired. With it in the allowed set, that is a resume bug → fail loud.
    ];
    expect(() =>
      validateAndHealMessages(input, new Set(["call_ask"])),
    ).toThrow(/UNPAIRED/);
  });

  test("an allowed call that IS paired is kept (no throw, no strip)", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant("Pick one:", [{ id: "call_ask", name: "ask" }]),
      tool("call_ask", '{"resolvedVia":"form","answers":{}}'),
    ];
    const result = validateAndHealMessages(input, new Set(["call_ask"]));
    expect(result.issues.length).toBe(0);
    const a = result.messages.find(
      (m) => m.role === "assistant",
    ) as OpenAI.ChatCompletionAssistantMessageParam;
    expect(a.tool_calls?.[0]?.id).toBe("call_ask");
  });

  test("without an allowed set, an unpaired tool_call is stripped (today's behaviour, no throw)", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant("Pick one:", [{ id: "call_x", name: "do" }]),
    ];
    const result = validateAndHealMessages(input); // no set passed
    expect(
      result.issues.some((i) => i.kind === "dangling_tool_calls_unanswered"),
    ).toBe(true);
  });

  test("an empty allowed set is exactly today's behaviour (no throw, strips)", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant("Pick one:", [{ id: "call_x", name: "do" }]),
    ];
    const result = validateAndHealMessages(input, new Set());
    expect(
      result.issues.some((i) => i.kind === "dangling_tool_calls_unanswered"),
    ).toBe(true);
  });

  test("the throw is SCOPED to ids in the set: a non-allowed dangling call alongside an allowed one is still stripped, not thrown", () => {
    // call_other is a normal dangling tool_call (legitimately healable); call_ask
    // is the suspended one and IS paired here. The set lists only call_ask, so the
    // non-allowed dangling call_other must strip as today — NOT trigger the throw.
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant("Pick one:", [{ id: "call_ask", name: "ask" }]),
      tool("call_ask", '{"resolvedVia":"form","answers":{}}'),
      assistant("Also:", [{ id: "call_other", name: "do" }]),
      // No tool result for call_other.
    ];
    const result = validateAndHealMessages(input, new Set(["call_ask"]));
    expect(
      result.issues.some((i) => i.kind === "dangling_tool_calls_unanswered"),
    ).toBe(true);
    // call_ask stayed paired and present.
    const askMsg = result.messages.find(
      (m) =>
        m.role === "assistant" &&
        (m as OpenAI.ChatCompletionAssistantMessageParam).tool_calls?.some(
          (tc) => tc.id === "call_ask",
        ),
    );
    expect(askMsg).toBeDefined();
  });

  test("an ALLOWED unpaired call throws even when a non-allowed dangling call is also present", () => {
    const input: Msg[] = [
      sys("s"),
      user("hi"),
      assistant("Pick one:", [{ id: "call_ask", name: "ask" }]),
      assistant("Also:", [{ id: "call_other", name: "do" }]),
      // Neither paired; only call_ask is allowed-open → must fail loud on it.
    ];
    expect(() =>
      validateAndHealMessages(input, new Set(["call_ask"])),
    ).toThrow(/call_ask/);
  });
});
