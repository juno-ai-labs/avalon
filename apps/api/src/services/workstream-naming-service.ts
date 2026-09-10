import { normalizeModelText } from "@rally/contracts/model-markdown";
import {
  renderWorkstreamNameMessages,
  type WorkstreamNameContextMessage,
} from "@rally/agent-harness";
import {
  WORKSTREAM_ICON_KEYS,
  WORKSTREAM_NAME_RESULT_MAX_LENGTH,
  WorkstreamNameResultSchema,
  type WorkstreamIconKey,
} from "@rally/contracts";

import type { Env } from "../env";
import { firstNonEmptyLine, truncateUtf16Safe } from "../lib/text";
import { logStructuredEvent } from "../observability/logger";
import { createMessageObjectPort } from "../runtime/message-port";
import { publishWorkstreamEvent } from "./integrations";
import { runStructuredInference } from "./structured-inference";
import { createIdentityObjectPort } from "../runtime/identity-port";

/**
 * The longest generated name that is written to a work stream. `title` holds
 * 180 characters, but a generated name is a label a person scans in the sidebar
 * rather than a sentence, and thirty is the length the team set for it. The
 * prompt asks for the same number, so this is a backstop rather than the usual
 * path: replaying 89 named work streams through the prompt, the model overshot
 * in 4 of them. Twenty was tried and rejected — the same replay overshot in 37
 * of 89 there, which is the truncation naming the work stream rather than the
 * model.
 */
const GENERATED_TITLE_MAX_LENGTH = 30;

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

/**
 * The schema the request advertises, bounded by the parse ceiling rather than by
 * {@link GENERATED_TITLE_MAX_LENGTH}.
 *
 * The two are deliberately different numbers. This schema goes to the provider
 * under `strict: true` and is rendered into the conversation beside it, so
 * `maxLength` is a decoding bound and not only a hint: a provider that honours
 * it stops generating at exactly that character, mid-word. A name cut that way
 * arrives here already inside the target, so `truncateToWholeWords` returns it
 * untouched and the half word ships — the one truncation the whole-word cut
 * cannot see. The target is the prompt's job, which can ask for a whole name of
 * that length; only the ceiling belongs in a bound that chops.
 */
const nameJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: WORKSTREAM_NAME_RESULT_MAX_LENGTH },
    // Required rather than optional because the request goes out `strict: true`,
    // which is what makes the enum a decoding constraint: the provider can only
    // emit one of these keys, so the catalog in the prompt and the catalog here
    // cannot disagree about what the model is allowed to answer. An answer that
    // reaches the parser off the catalog anyway is dropped to "no icon" there
    // rather than failing the name with it.
    icon: { type: "string", enum: [...WORKSTREAM_ICON_KEYS] },
  },
  required: ["title", "icon"],
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
  const firstLine = firstNonEmptyLine(objective);
  return firstLine ? truncateUtf16Safe(firstLine, PROVISIONAL_TITLE_MAX_LENGTH) : fallback;
}

export interface WorkstreamNamingInput {
  workspaceId: string;
  workstreamId: string;
  /**
   * Which of the parent's conversations is being named; the main one by
   * default. A private child is named from its own opening message, through
   * its own object, and its rename is published into its own room — the parent
   * keeps whatever name it already had.
   */
  substreamId?: string | undefined;
  objective: string;
  openingMessage: string;
  /** The title creation wrote, and the one that stands if naming produces none. */
  provisionalTitle: string;
  /** The creator, where one exists — a rollout bucketing attribute. */
  userId?: string | undefined;
}

/**
 * Name one work stream from the request that opened it, and give it an icon, in
 * the background.
 *
 * Never rejects and never throws — the model call and the write alike. Some
 * callers await this inline, having already created the work stream and
 * launched its run, so a failure here that escaped would turn a creation that
 * fully succeeded into an error at the caller. The title is cosmetic; the
 * creation is not.
 */
export async function nameWorkstream(env: Env, input: WorkstreamNamingInput): Promise<void> {
  await guarded(env, input.workspaceId, input.workstreamId, async () => {
    const generated = await generateName(env, {
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
      substreamId: input.substreamId,
      from: "naming",
      to: "automatic",
      ...generated,
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
  /** Which conversation to look at again; the main one by default. */
  substreamId?: string | undefined;
  userId?: string | undefined;
}): Promise<void> {
  await guarded(env, input.workspaceId, input.workstreamId, async () => {
    // `naming` is eligible as well as `automatic` because a first pass that
    // never finished — the isolate went away mid-call — leaves the row in it.
    // This pass is the one thing that comes along afterwards, so it repairs the
    // row rather than stepping over it.
    const identity = await createIdentityObjectPort(
      env, input.workspaceId, input.workstreamId, undefined, input.substreamId,
    ).identity();
    // The eligibility test was a `WHERE` clause because the read was a
    // statement; it is a test on the row here.
    const titleStatus: "naming" | "automatic" | null =
      identity?.title_status === "naming" || identity?.title_status === "automatic"
        ? identity.title_status
        : null;
    const row = identity && titleStatus
      ? { title: identity.title, title_status: titleStatus, objective: identity.description }
      : null;
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
    const saidCount = await createMessageObjectPort(
      env, input.workspaceId, input.workstreamId, undefined, input.substreamId,
    ).saidMessageCount({ messageTypes: { include: ["text"] }, limit: RENAME_AFTER_MESSAGE_COUNT });
    if (saidCount < RENAME_AFTER_MESSAGE_COUNT) return;

    const generated = await generateName(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      userId: input.userId,
      objective: row.objective,
      openingMessage: "",
      recentMessages: await loadNamingContext(env, input.workspaceId, input.workstreamId, input.substreamId),
    });
    // Where the two passes differ. The first settles on a failure because a
    // skeleton is on screen waiting for it; here nothing is waiting — an
    // `automatic` title and a `settled` one render identically — so settling
    // would spend the one retry this work stream gets on a model that happened
    // to be unreachable. Left alone, the next message or run tries again. A row
    // still in `naming` is the exception: it is the first pass that never
    // finished, and its promise is the one that has to be kept.
    if (generated.title === null && row.title_status === "automatic") return;
    await advanceTitle(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      substreamId: input.substreamId,
      from: row.title_status,
      to: generated.title === null ? "automatic" : "settled",
      ...generated,
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
  substreamId?: string,
): Promise<WorkstreamNameContextMessage[]> {
  const rows = await createMessageObjectPort(env, workspaceId, workstreamId, undefined, substreamId)
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

/** What one pass got out of the model: either half may be missing. */
interface GeneratedName {
  title: string | null;
  icon: WorkstreamIconKey | null;
}

const NOTHING_GENERATED: GeneratedName = { title: null, icon: null };

/**
 * Ask the naming agent for a name and an icon, or for nothing usable.
 *
 * One call for both because they are one judgement about one work stream: the
 * icon has to stand for whatever the name leads with, and a second call would
 * be a second model reading the same request and agreeing with the first only
 * by luck. It costs a closed catalog in the prompt — every icon a person can
 * pick, each described — which is why the catalog is rendered from the shared
 * keys rather than written out beside them.
 *
 * Reasoning is turned off rather than left to the model's default. Naming is a
 * one-shot relabelling of text the model has already been handed in full, so
 * thinking about it buys nothing and only adds latency to a rename the person
 * who created the work stream is watching for — asking for the lowest *effort*
 * instead would switch thinking on for a model that does none by default.
 *
 * Never throws. Every caller's alternative is the title and icon already on the
 * work stream, so a failure is logged and reported as "nothing generated".
 */
async function generateName(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  userId?: string | undefined;
  objective: string;
  openingMessage: string;
  recentMessages?: WorkstreamNameContextMessage[];
}): Promise<GeneratedName> {
  if (!env.OPENROUTER_API_KEY) return NOTHING_GENERATED;
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
    const title = normalizeGeneratedTitle(result.title);
    // Tied to the name rather than written on its own. An icon is only ever
    // chosen alongside a name, and an answer whose name normalized away to
    // nothing is one this pass is reporting as unusable — writing its icon
    // anyway would spend the one icon a work stream gets on the pass that
    // failed.
    return title === null ? NOTHING_GENERATED : { title, icon: result.icon ?? null };
  } catch (error) {
    logStructuredEvent(env, "warn", "workstream_naming_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      stage: "model",
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : "Work-stream naming failed",
    });
    return NOTHING_GENERATED;
  }
}

/**
 * Move the title on one step: write the generated name and icon if there are
 * any, and record that this pass has run.
 *
 * Matching on the status the pass started from is what makes this safe to run
 * a second — or a thousandth — later. A person can rename a work stream from
 * its header while a call is in flight, and that rename settles the title; a
 * generated name arriving afterwards must not undo their edit. Losing that race
 * means the human's title stands and nothing is published, because the rename
 * they made already told everyone.
 *
 * The icon is offered on the same write and refused by it where one is already
 * stored, so what is published is the icon the object actually wrote rather
 * than the one this pass asked for.
 */
async function advanceTitle(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  substreamId?: string | undefined;
  from: "naming" | "automatic";
  to: "automatic" | "settled";
  title: string | null;
  icon: WorkstreamIconKey | null;
  standingTitle: string;
}): Promise<void> {
  // A private child has no appearance to choose. Its rows carry the branch
  // line, its header shows the parent's mark, and no surface anywhere reads a
  // child's own icon — so the pass asks for one, because it is the work
  // stream's own pass and one call answers both halves, and then throws that
  // half away here rather than writing an appearance nothing will ever draw.
  const namesMainConversation = (input.substreamId ?? "0") === "0";
  const result = await createIdentityObjectPort(
    env, input.workspaceId, input.workstreamId, undefined, input.substreamId,
  ).rename({
      title: input.title,
      icon: namesMainConversation ? input.icon : null,
      from: input.from,
      to: input.to,
      now: Date.now(),
    });
  if (result.outcome === "superseded") {
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
    icon: result.icon,
  });
  await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
    type: "workstream_renamed",
    title,
    titleStatus: input.to,
    ...(result.icon ? { icon: result.icon } : {}),
  }, input.substreamId);
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
  // Trailing punctuation is stripped on both sides of the cut: a model's own
  // full stop before it, and the comma a cut between two listed things leaves
  // behind after it.
  const cleaned = trimTrailing(unquoted.trim());
  if (cleaned.length === 0) return null;
  // Cased before the cut, so the cut is what bounds the result. An uppercase
  // mapping can be longer than what it replaces — `ß` becomes `SS`, `ﬁ` becomes
  // `FI` — so capitalizing afterwards could hand back 31 characters from a cap
  // of 30. Casing first also judges the whole word the model wrote rather than
  // whatever prefix of it survived.
  const shortened = trimTrailing(
    truncateToWholeWords(sentenceCased(cleaned), GENERATED_TITLE_MAX_LENGTH),
  );
  if (shortened.length === 0) return null;
  return shortened;
}

function trimTrailing(value: string): string {
  return value.replace(/[.,;:\s]+$/u, "");
}

/**
 * Cut a name to `maximum` characters at a word boundary.
 *
 * The last whole word that fits wins, because the tail of a cut word reads as a
 * typo. That is the whole of what this buys: no half words. It does *not* stop
 * a name ending mid-thought — a cut landing after `to`, `from`, `and` or `the`
 * gives `Podcast episode from the`, and the cut cannot tell a word the model
 * meant to continue from one it meant to end on. Ruling that out would need a
 * closed set of function words per language, and the prompt writes names in the
 * language of the request; at thirty characters the cut fires on about one name
 * in twenty, which is what makes living with it reasonable, and at twenty it
 * was two in five, which is what ruled twenty out.
 *
 * A single word longer than the cap has no boundary to cut at and is cut where
 * it must be, short of splitting a surrogate pair, which would leave a half that
 * renders as a replacement character.
 */
function truncateToWholeWords(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const words = value.split(" ");
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length === 0 ? word.length : length + 1 + word.length;
    if (next > maximum) break;
    kept.push(word);
    length = next;
  }
  // Two ways there is no whole-word cut worth taking, and both end in the
  // mid-word one. The first word may not fit at all. Or it may fit and the
  // second may not, which leaves the name as its own opening word — `Fix`,
  // `Debug`, `Rename` — which is the framing word the prompt tells the model to
  // drop, and which every work stream whose second word is long is then called.
  // One long token does it: a URL, an address, a compound identifier. Cutting
  // mid-word keeps the characters that tell two such names apart, and an ugly
  // name that is distinct beats a tidy one that is not.
  if (kept.length === 0 || (kept.length === 1 && words.length > 1)) {
    return truncateUtf16Safe(value, maximum);
  }
  return kept.join(" ");
}

/**
 * Capitalize a name that starts mid-sentence, and only then.
 *
 * A small model occasionally answers "invoice INV-2291 totals", which reads as
 * a fragment beside the sentence-cased titles around it. The first word has to
 * be plain lowercase letters for this to fire, so a name opening on an address,
 * a version, or a brand that spells itself `iPhone` is left alone.
 */
function sentenceCased(value: string): string {
  const firstWord = value.split(" ", 1)[0] ?? "";
  // An apostrophe inside the first word does not make it a spelling to leave
  // alone: `danny's invoice` opens mid-sentence exactly as `danny invoice`
  // does. A capital anywhere in it still does.
  if (!/^\p{Ll}+(?:['’]\p{Ll}+)*$/u.test(firstWord)) return value;
  // By code point rather than by code unit. The test above accepts a letter
  // outside the Basic Multilingual Plane — `\p{Ll}` under `u` does — and
  // `slice(0, 1)` on one of those is half a surrogate pair, which uppercases to
  // itself and leaves the name lowercase with the guard having passed.
  const first = String.fromCodePoint(value.codePointAt(0) ?? 0);
  return first.toUpperCase() + value.slice(first.length);
}
