import type OpenAI from "openai";
import { TRAILING_USER_PLACEHOLDER } from "../prompts/trailing-user-placeholder";

/**
 * Heuristic issues detected in a `messages` array before it's sent to the
 * provider. These are defensive checks — upstream code is supposed to
 * produce valid conversations, but historical bugs (and the many providers
 * reachable via OpenRouter) have surfaced invalid shapes that different
 * providers reject in different ways. Logging and healing here keeps a
 * single run from failing outright when the shape is still salvageable.
 */
export type MessageIssueKind =
  | "empty_messages"
  | "trailing_assistant_with_content"
  | "trailing_assistant_empty"
  | "orphan_tool_result"
  | "dangling_tool_calls_unanswered"
  | "empty_assistant_mid"
  | "empty_user_content";

export interface MessageIssue {
  kind: MessageIssueKind;
  index: number;
  detail: string;
  healed: boolean;
}

export interface ValidateAndHealResult {
  messages: OpenAI.ChatCompletionMessageParam[];
  issues: MessageIssue[];
}

function isEmptyContent(
  content: OpenAI.ChatCompletionMessageParam["content"],
): boolean {
  if (content == null) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    return content.every((part) => {
      if (part && typeof part === "object" && "type" in part) {
        if (part.type === "text") {
          return !("text" in part) || !part.text || String(part.text).trim().length === 0;
        }
      }
      return false;
    });
  }
  return false;
}

function assistantHasToolCalls(
  msg: OpenAI.ChatCompletionAssistantMessageParam,
): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

/**
 * Run sanity checks against the outgoing `messages` array and attempt to
 * heal any detected issues. Returns the (possibly modified) messages along
 * with a list of issues found — the caller should log these as errors.
 *
 * Heuristics:
 *  - Empty array → flagged, not healable (provider will reject).
 *  - Trailing assistant with content → append a synthetic user turn so
 *    providers that don't support assistant prefill (Azure-hosted Claude
 *    via OpenRouter) accept the request.
 *  - Trailing assistant with no content / no tool_calls → drop it, then
 *    re-check the new tail.
 *  - Assistant with `tool_calls` not followed by matching tool results →
 *    strip the unanswered tool_calls. If the message has no other content
 *    either, drop it. Without this, the provider rejects the next turn.
 *  - Tool message whose `tool_call_id` doesn't match any preceding
 *    assistant `tool_calls` → drop the orphan.
 *  - Mid-conversation assistant with no content and no tool_calls → drop.
 *  - User message with entirely empty content → drop.
 */
export function validateAndHealMessages(
  input: OpenAI.ChatCompletionMessageParam[],
  /**
   * Tool-call ids that are
   * *legitimately* open — a suspended `ask` awaiting a human answer. This is the
   * UNIVERSAL strip site (the host runs it before every model call),
   * and the never-send-unpaired invariant means a correct array never carries a
   * suspended call here unpaired. So this set is a **fail-loud assertion**, NOT a
   * silent-keep: if an allowed id reaches the validator unpaired, resume failed to
   * thread its answer — surface the bug rather than strip it (which would mask it)
   * or send it (which the provider would 400 on). Bounded to ids in the set:
   * callers that pass nothing (every legacy/non-HITL path) get exactly today's
   * non-throwing heal-and-log behaviour.
   */
  allowedOpenToolCallIds?: ReadonlySet<string>,
): ValidateAndHealResult {
  const issues: MessageIssue[] = [];

  if (input.length === 0) {
    issues.push({
      kind: "empty_messages",
      index: 0,
      detail: "messages array is empty",
      healed: false,
    });
    return { messages: [...input], issues };
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = [...input];

  // 1. Drop mid-conversation junk (empty assistants, orphan tool results,
  //    empty user messages). Walk front-to-back with a running set of
  //    pending tool_call_ids so orphan detection is accurate.
  const pendingToolCallIds = new Set<string>();
  const kept: OpenAI.ChatCompletionMessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "assistant") {
      const hasToolCalls = assistantHasToolCalls(msg);
      const emptyContent = isEmptyContent(msg.content) && !msg.refusal;

      if (!hasToolCalls && emptyContent) {
        issues.push({
          kind: "empty_assistant_mid",
          index: i,
          detail: "assistant message has no content, no tool_calls, no refusal",
          healed: true,
        });
        continue;
      }

      if (hasToolCalls) {
        for (const tc of msg.tool_calls!) {
          pendingToolCallIds.add(tc.id);
        }
      }
      kept.push(msg);
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id;
      if (!toolCallId || !pendingToolCallIds.has(toolCallId)) {
        issues.push({
          kind: "orphan_tool_result",
          index: i,
          detail: `tool message with tool_call_id=${toolCallId ?? "(missing)"} does not match any pending assistant tool_call`,
          healed: true,
        });
        continue;
      }
      pendingToolCallIds.delete(toolCallId);
      kept.push(msg);
      continue;
    }

    if (msg.role === "user" && isEmptyContent(msg.content)) {
      issues.push({
        kind: "empty_user_content",
        index: i,
        detail: "user message has empty content",
        healed: true,
      });
      continue;
    }

    kept.push(msg);
  }

  // 2. After a first pass, any remaining pendingToolCallIds belong to an
  //    assistant message whose tool_calls are never answered. Strip those
  //    tool_calls from the relevant assistant message(s); drop the message
  //    entirely if nothing else remains.
  if (pendingToolCallIds.size > 0) {
    // Fail-loud assertion: a legitimately-suspended call must
    // never reach the provider unpaired (never-send-invariant) — if one does,
    // resume failed to thread its answer. Surface it instead of silently
    // stripping (which masks the bug) or sending (which 400s). Scoped to ids in
    // the set, so legacy callers (empty/undefined) are unaffected.
    if (allowedOpenToolCallIds && allowedOpenToolCallIds.size > 0) {
      for (const id of pendingToolCallIds) {
        if (allowedOpenToolCallIds.has(id)) {
          throw new Error(
            `validateAndHealMessages: suspended tool_call ${id} reached the provider UNPAIRED — resume did not thread its answer (never-send-unpaired invariant violated)`,
          );
        }
      }
    }
    for (let i = kept.length - 1; i >= 0; i--) {
      const msg = kept[i]!;
      if (msg.role !== "assistant" || !assistantHasToolCalls(msg)) continue;
      const remainingCalls = msg.tool_calls!.filter(
        (tc) => !pendingToolCallIds.has(tc.id),
      );
      if (remainingCalls.length === msg.tool_calls!.length) continue;

      const strippedIds = msg.tool_calls!
        .filter((tc) => pendingToolCallIds.has(tc.id))
        .map((tc) => tc.id);
      const emptyContent = isEmptyContent(msg.content) && !msg.refusal;

      if (remainingCalls.length === 0 && emptyContent) {
        issues.push({
          kind: "dangling_tool_calls_unanswered",
          index: i,
          detail: `dropped assistant message with unanswered tool_calls [${strippedIds.join(", ")}] and no other content`,
          healed: true,
        });
        kept.splice(i, 1);
      } else {
        issues.push({
          kind: "dangling_tool_calls_unanswered",
          index: i,
          detail: `stripped unanswered tool_calls [${strippedIds.join(", ")}] from assistant message`,
          healed: true,
        });
        if (remainingCalls.length === 0) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Rest destructuring removes tool_calls without mutating the input message.
          const { tool_calls: _tc, ...rest } =
            msg as OpenAI.ChatCompletionAssistantMessageParam;
          kept[i] = rest as OpenAI.ChatCompletionAssistantMessageParam;
        } else {
          kept[i] = {
            ...msg,
            tool_calls: remainingCalls,
          } as OpenAI.ChatCompletionAssistantMessageParam;
        }
      }
    }
  }

  // 3. Drop empty assistant messages at the tail — they can only be there
  //    if the prior pass re-exposed one, but handle defensively.
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!;
    if (last.role !== "assistant") break;
    const hasToolCalls = assistantHasToolCalls(last);
    const emptyContent = isEmptyContent(last.content) && !last.refusal;
    if (hasToolCalls || !emptyContent) break;
    issues.push({
      kind: "trailing_assistant_empty",
      index: kept.length - 1,
      detail: "dropped trailing assistant message with no content/tool_calls",
      healed: true,
    });
    kept.pop();
  }

  // 4. If the tail is still an assistant message (with content or
  //    tool_calls), append a synthetic user turn so providers that don't
  //    support assistant-prefill accept the request.
  if (kept.length > 0) {
    const last = kept[kept.length - 1]!;
    if (last.role === "assistant") {
      issues.push({
        kind: "trailing_assistant_with_content",
        index: kept.length - 1,
        detail:
          "conversation ends with assistant; appending synthetic user turn to avoid provider prefill rejection",
        healed: true,
      });
      kept.push({ role: "user", content: TRAILING_USER_PLACEHOLDER });
    }
  }

  if (kept.length === 0) {
    issues.push({
      kind: "empty_messages",
      index: 0,
      detail: "all messages were dropped during healing; nothing to send",
      healed: false,
    });
  }

  return { messages: kept, issues };
}
