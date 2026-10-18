import { MESSAGE_MAX_CHARACTERS, type ConversationSuggestionKind } from "@rally/contracts";
import { renderSuggestionDraftMessages, suggestionDraftJsonSchema } from "@rally/agent-harness";
import type { Env } from "../env";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { runStructuredInference } from "./structured-inference";

/**
 * The suggestion drafter: one `runStructuredInference` role, `suggestion_draft`,
 * that writes the words a conversation suggestion carries once the classifier
 * has said the turn is worth it. A merge note for the parent's readers, or a
 * Breakout's opening prompt and subject. It runs after the chip is already
 * shown, so its latency never delays the chip, and its cost scales with
 * confident positives rather than with turns. A reply that is empty, over the
 * send limit, refused or unreachable is `null`: the caller withdraws the row,
 * because a suggestion without its words is not shown.
 * `docs/conversation-suggestions.md` owns the role.
 */
export interface SuggestionDraftInput {
  workspaceId: string;
  workstreamId: string;
  substreamId: string;
  kind: ConversationSuggestionKind;
  title: string;
  purpose: string;
  parentTitle: string | null;
  recent: Array<{ author: "person" | "rally"; text: string }>;
  judgedText: string;
  defer: (promise: Promise<unknown>) => void;
  signal?: AbortSignal | undefined;
}

export interface SuggestionDraft {
  text: string;
  subject: string | null;
}

export async function draftSuggestion(env: Env, input: SuggestionDraftInput): Promise<SuggestionDraft | null> {
  try {
    const { result } = await runStructuredInference(env, {
      role: "suggestion_draft",
      activity: "suggestion_draft",
      context: { workspaceId: input.workspaceId, workstreamId: input.workstreamId, substreamId: input.substreamId },
      messages: renderSuggestionDraftMessages({
        kind: input.kind,
        title: input.title,
        purpose: input.purpose,
        parentTitle: input.parentTitle,
        recent: input.recent,
        judgedText: input.judgedText,
      }),
      schemaName: input.kind === "merge_up" ? "suggestion_merge_note" : "suggestion_breakout_prompt",
      jsonSchema: suggestionDraftJsonSchema[input.kind],
      parse: (value) => parseDraft(input.kind, value),
      reasoningEffort: "none",
      defer: input.defer,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return result;
  } catch (error) {
    logWarn(env, "suggestion_draft_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      substream_id: input.substreamId,
      kind: input.kind,
      reason: diagnosticErrorCode(error, "suggestion_draft_failed"),
    });
    return null;
  }
}

function parseDraft(kind: ConversationSuggestionKind, value: unknown): SuggestionDraft {
  if (!value || typeof value !== "object") throw new Error("suggestion_draft_invalid");
  const record = value as { text?: unknown; prompt?: unknown; subject?: unknown };
  const text = typeof (kind === "merge_up" ? record.text : record.prompt) === "string"
    ? String(kind === "merge_up" ? record.text : record.prompt).trim()
    : "";
  if (text.length === 0) throw new Error("suggestion_draft_empty");
  if (text.length > MESSAGE_MAX_CHARACTERS) throw new Error("suggestion_draft_too_long");
  const subject = kind === "start_breakout" && typeof record.subject === "string" && record.subject.trim().length > 0
    ? record.subject.trim().slice(0, 120)
    : null;
  if (kind === "start_breakout" && subject === null) throw new Error("suggestion_draft_subject_missing");
  return { text, subject };
}
