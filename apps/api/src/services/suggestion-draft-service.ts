import { z } from "zod";
import { MESSAGE_MAX_CHARACTERS, type ConversationSuggestionKind } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { renderSuggestionDraftMessages, suggestionDraftJsonSchema } from "@rally/agent-harness";
import { resourceEmbeds } from "../durable-objects/conversation-suggestions";
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
  kind: Exclude<ConversationSuggestionKind, "mark_resolved">;
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
      parse: (value) => parseDraft(input.kind, value, input.judgedText),
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
      reason: zodDiagnosticCode(error, "suggestion_draft") ?? diagnosticErrorCode(error, "suggestion_draft_failed"),
    });
    return null;
  }
}

/** The subject is a chip title's worth of words; longer is cut, not refused. */
export const SUGGESTION_SUBJECT_MAXIMUM_CHARACTERS = 120;

const words = z.string().trim().min(1).max(MESSAGE_MAX_CHARACTERS);
const MergeNoteSchema = z.object({ text: words });
const BreakoutPromptSchema = z.object({ prompt: words, subject: z.string().trim().min(1) });

/**
 * The model's reply against a schema that mirrors `suggestionDraftJsonSchema`,
 * so a rejection names the field (CLAUDE.md, "Naming a schema failure") and the
 * structured-inference repair round sees a `ZodError`. A merge note keeps
 * every artifact the judged message embeds: the drafter sees a bounded head
 * of that message, so an embed past the bound is appended here rather than
 * asked of the model.
 */
export function parseDraft(kind: Exclude<ConversationSuggestionKind, "mark_resolved">, value: unknown, judgedText: string): SuggestionDraft {
  if (kind === "merge_up") {
    const note = MergeNoteSchema.parse(value);
    return { text: withEveryEmbed(note.text, judgedText), subject: null };
  }
  const draft = BreakoutPromptSchema.parse(value);
  return { text: draft.prompt, subject: [...draft.subject].slice(0, SUGGESTION_SUBJECT_MAXIMUM_CHARACTERS).join("") };
}

/** The note with each embed of the judged message it does not already carry, as a link on its own line. */
export function withEveryEmbed(note: string, judgedText: string): string {
  const carried = new Set(resourceEmbeds(note).map((embed) => embed.id));
  const missing = resourceEmbeds(judgedText).filter((embed) => !carried.has(embed.id));
  if (missing.length === 0) return note;
  return `${note}\n\n${missing.map((embed) => `[${embed.title}](resource://${embed.id})`).join("\n")}`;
}
