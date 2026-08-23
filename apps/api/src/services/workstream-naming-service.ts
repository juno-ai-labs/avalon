import { normalizeModelText } from "@avalon/contracts/model-markdown";
import {
  renderWorkstreamNameMessages,
  type WorkstreamNameContextMessage,
} from "@avalon/agent-harness";
import { WorkstreamNameResultSchema } from "@avalon/contracts";
import { nowIso } from "@avalon/db";

import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import { logStructuredEvent } from "../observability/logger";
import { createMessageObjectPort } from "../runtime/message-port";
import { publishWorkstreamEvent } from "./integrations";
import { runStructuredInference } from "./structured-inference";

/**
 * The longest generated name that is written to a work stream. `title` holds
 * 180 characters, but a name that long is a sentence rather than a label, and
 * the sidebar truncates it anyway.
 */
const GENERATED_TITLE_MAX_LENGTH = 80;

/** The provisional title's ceiling, matching what `title` accepts. */
const PROVISIONAL_TITLE_MAX_LENGTH = 180;

/**
 * How many transcript messages a work stream has to reach before Avalon looks
 * at its name a second time.
 *
 * The first name is written from the opening request alone, which is all there
 * is at that point and is often not what the work turns out to be about — the
 * identifier, the person, or the actual problem usually arrives in the replies.
 * Five is roughly where a request has become an exchange.
 */
const RENAME_AFTER_MESSAGE_COUNT = 5;

/** How much of the transcript the second pass reads. */
const RENAME_CONTEXT_MESSAGE_LIMIT = 12;
const RENAME_CONTEXT_MESSAGE_CHARACTERS = 600;

const nameJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: GENERATED_TITLE_MAX_LENGTH },
  },
  required: ["title"],
};

/**
 * The title a work stream carries between being created and being named.
 *
 * A model call cannot sit in the creation path — the person who typed the
 * request is waiting on the response — so every work stream starts with the
 * first non-empty line of its objective and is renamed a moment later. That
 * makes this a fallback as well as a placeholder: it is the title a work stream
 * keeps for good when naming fails, when the model is unreachable, or when
 * `OPENROUTER_API_KEY` is unset.
 */
export function provisionalWorkstreamTitle(objective: string, fallback: string): string {
  const firstLine = objective.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? truncateUtf16Safe(firstLine, PROVISIONAL_TITLE_MAX_LENGTH) : fallback;
}

export interface WorkstreamNamingInput {
  workspaceId: string;
  workstreamId: string;
  objective: string;
  openingMessage: string;
  /** The title creation wrote, and the one that stands if naming produces none. */
  provisionalTitle: string;
  /** The creator, where one exists — a rollout bucketing attribute. */
  userId?: string | undefined;
}

/**
 * Name one work stream from the request that opened it, in the background.
 *
 * Never rejects and never throws — the model call and the write alike. Some
 * callers await this inline, having already created the work stream and
 * launched its run, so a failure here that escaped would turn a creation that
 * fully succeeded into an error at the caller. The title is cosmetic; the
 * creation is not.
 */
export async function nameWorkstream(env: Env, input: WorkstreamNamingInput): Promise<void> {
  await guarded(env, input.workspaceId, input.workstreamId, async () => {
    const title = await generateName(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      userId: input.userId,
      objective: input.objective,
      openingMessage: input.openingMessage,
    });
    // Advanced either way. A work stream whose naming failed keeps its
    // provisional title, and clients waiting on the name are told to stop
    // waiting — a skeleton that never resolves is worse than a plain title.
    await advanceTitle(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      from: "naming",
      to: "automatic",
      title,
      standingTitle: input.provisionalTitle,
    });
  });
}

/**
 * Run one naming pass and swallow whatever it throws.
 *
 * Every caller of this module is somewhere a name is the least important thing
 * happening: after a work stream is created, after a run has finished, beside a
 * message that is already durable. None of them can be failed by a title, and
 * the durable workflow step that calls the second pass would otherwise retry a
 * model call on a transient D1 error.
 */
async function guarded(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  pass: () => Promise<void>,
): Promise<void> {
  try {
    await pass();
  } catch (error) {
    logStructuredEvent(env, "warn", "workstream_naming_failed", {
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      // The model half reports its own failure and still settles the title;
      // reaching here means something else did — a read, the write, the row.
      stage: "pass",
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : "Work-stream naming failed",
    });
  }
}

/**
 * Look at an Avalon-chosen name again once the work stream has become a
 * conversation, and replace it if the transcript says something better.
 *
 * Called wherever the transcript grows — a new message, the end of a run — so
 * the overwhelmingly common case is a work stream that will never be named
 * again, and that case has to cost almost nothing. Two things keep it cheap:
 * the status gate is in the `WHERE` clause, so a settled work stream never
 * evaluates the count at all, and the count itself stops at the threshold
 * rather than tallying a transcript thousands of messages long to learn it is
 * larger than five.
 *
 * It runs at most once, because a successful pass settles the title, and it
 * never touches a title a person set, because that title was settled when they
 * set it. Never rejects: see {@link guarded}.
 */
export async function refreshWorkstreamName(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  userId?: string | undefined;
}): Promise<void> {
  await guarded(env, input.workspaceId, input.workstreamId, async () => {
    // `naming` is eligible as well as `automatic` because a first pass that
    // never finished — the isolate went away mid-call — leaves the row in it.
    // This pass is the one thing that comes along afterwards, so it repairs the
    // row rather than stepping over it.
    const row = await env.DB.prepare(
      `SELECT w.title, w.title_status, w.objective
       FROM workstreams w
      WHERE w.id = ? AND w.workspace_id = ?
        AND w.title_status IN ('naming', 'automatic')`,
    ).bind(input.workstreamId, input.workspaceId).first<{
      title: string;
      title_status: "naming" | "automatic";
      objective: string;
    }>();
    if (!row) return;
    // The count is over exactly the rows the naming context reads, which is why
    // it is `saidMessages`' own counterpart rather than a predicate written out
    // again here. The transcript also holds a row per tool call and per
    // elicitation — and a run *ends* where those accumulate, which is one of
    // the two places this is called from. Counting them would trip the
    // threshold on a work stream that has said two things, and name it from
    // what the first pass already saw.
    //
    // It costs a second round trip, to the same object the row above came
    // from. The retired version got both from one statement because the router
    // rewrote `workstreams` and `messages` onto views side by side; the title
    // half belongs to the identity slice and cannot come through this port yet.
    const saidCount = await createMessageObjectPort(env, input.workspaceId, input.workstreamId)
      .saidMessageCount({ messageTypes: { include: ["text"] }, limit: RENAME_AFTER_MESSAGE_COUNT });
    if (saidCount < RENAME_AFTER_MESSAGE_COUNT) return;

    const title = await generateName(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      userId: input.userId,
      objective: row.objective,
      openingMessage: "",
      recentMessages: await loadNamingContext(env, input.workspaceId, input.workstreamId),
    });
    // Where the two passes differ. The first settles on a failure because a
    // skeleton is on screen waiting for it; here nothing is waiting — an
    // `automatic` title and a `settled` one render identically — so settling
    // would spend the one retry this work stream gets on a model that happened
    // to be unreachable. Left alone, the next message or run tries again. A row
    // still in `naming` is the exception: it is the first pass that never
    // finished, and its promise is the one that has to be kept.
    if (title === null && row.title_status === "automatic") return;
    await advanceTitle(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      from: row.title_status,
      to: title === null ? "automatic" : "settled",
      title,
      standingTitle: row.title,
    });
  });
}

/**
 * The transcript the second pass names from.
 *
 * The beginning of the conversation, not the end: a name describes what the
 * work stream is for, which is established in its opening exchange, while its
 * latest message is whatever happens to be in flight.
 */
async function loadNamingContext(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<WorkstreamNameContextMessage[]> {
  const rows = await createMessageObjectPort(env, workspaceId, workstreamId)
    .saidMessages({
      messageTypes: { include: ["text"] },
      order: "oldest",
      limit: RENAME_CONTEXT_MESSAGE_LIMIT,
    });
  return rows.map((message) => ({
    author: message.author_type === "agent" ? "avalon" as const : "person" as const,
    text: truncateUtf16Safe(message.text_content, RENAME_CONTEXT_MESSAGE_CHARACTERS),
  }));
}

/**
 * Ask the naming agent for a name, or `null` when there is nothing usable.
 *
 * Reasoning is turned off rather than left to the model's default. Naming is a
 * one-shot relabelling of text the model has already been handed in full, so
 * thinking about it buys nothing and only adds latency to a rename the person
 * who created the work stream is watching for — asking for the lowest *effort*
 * instead would switch thinking on for a model that does none by default.
 *
 * Never throws. Every caller's alternative to a name is the title already on
 * the work stream, so a failure is logged and reported as "no name".
 */
async function generateName(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  userId?: string | undefined;
  objective: string;
  openingMessage: string;
  recentMessages?: WorkstreamNameContextMessage[];
}): Promise<string | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  try {
    const { result } = await runStructuredInference(env, {
      role: "workstream_naming",
      context: {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        ...(input.userId ? { userId: input.userId } : {}),
      },
      messages: renderWorkstreamNameMessages({
        objective: input.objective,
        ...(input.openingMessage.trim() ? { openingMessage: input.openingMessage } : {}),
        ...(input.recentMessages?.length ? { recentMessages: input.recentMessages } : {}),
      }),
      schemaName: "workstream_name",
      jsonSchema: nameJsonSchema,
      parse: (value) => WorkstreamNameResultSchema.parse(value),
      reasoningEffort: "none",
    });
    return normalizeGeneratedTitle(result.title);
  } catch (error) {
    logStructuredEvent(env, "warn", "workstream_naming_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      stage: "model",
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : "Work-stream naming failed",
    });
    return null;
  }
}

/**
 * Move the title on one step: write the generated name if there is one, and
 * record that this pass has run.
 *
 * Matching on the status the pass started from is what makes this safe to run
 * a second — or a thousandth — later. A person can rename a work stream from
 * its header while a call is in flight, and that rename settles the title; a
 * generated name arriving afterwards must not undo their edit. Losing that race
 * means the human's title stands and nothing is published, because the rename
 * they made already told everyone.
 */
async function advanceTitle(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  from: "naming" | "automatic";
  to: "automatic" | "settled";
  title: string | null;
  standingTitle: string;
}): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE workstreams SET title = COALESCE(?, title), title_status = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND title_status = ?`,
  ).bind(input.title, input.to, nowIso(), input.workstreamId, input.workspaceId, input.from).run();
  if (Number(result.meta.changes ?? 0) === 0) {
    logStructuredEvent(env, "debug", "workstream_name_superseded", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      pass: input.from,
    });
    return;
  }
  const title = input.title ?? input.standingTitle;
  logStructuredEvent(env, "info", "workstream_named", {
    workspace_id: input.workspaceId,
    workstream_id: input.workstreamId,
    pass: input.from,
    generated: input.title !== null,
    title_length: title.length,
  });
  await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
    type: "workstream_renamed",
    title,
    titleStatus: input.to,
  });
}

/**
 * Reduce one model answer to a title, or `null` when nothing is left.
 *
 * A small model asked for a label still occasionally returns a quoted phrase, a
 * Markdown heading, or a trailing period, and every one of those would be
 * visible in the sidebar. Repairing them here rather than adding more
 * prohibitions to the prompt keeps the rules the model has to follow short.
 */
export function normalizeGeneratedTitle(value: string): string | null {
  // A title is shown as plain text everywhere it appears — the sidebar, the
  // window, the menu bar, a Slack card — so TeX in one is repaired here rather
  // than by each of those, and the plain-text form is the right one: a Markdown
  // escape would be a backslash a reader sees.
  const collapsed = normalizeModelText(value).replace(/\s+/gu, " ").trim().replace(/^#+\s*/u, "");
  const unquoted = /^(["'“‘])(.+)(["'”’])$/u.exec(collapsed)?.[2] ?? collapsed;
  const trimmed = sentenceCased(unquoted.trim().replace(/[.,;:\s]+$/u, ""));
  if (trimmed.length === 0) return null;
  return truncateUtf16Safe(trimmed, GENERATED_TITLE_MAX_LENGTH);
}

/**
 * Capitalize a name that starts mid-sentence, and only then.
 *
 * A small model occasionally answers "invoice INV-2291 VAT totals", which reads
 * as a fragment beside the sentence-cased titles around it. The first word has
 * to be plain lowercase letters for this to fire, so a name opening on an
 * address, a version, or a brand that spells itself `iPhone` is left alone.
 */
function sentenceCased(value: string): string {
  const firstWord = value.split(" ", 1)[0] ?? "";
  if (!/^\p{Ll}+$/u.test(firstWord)) return value;
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
