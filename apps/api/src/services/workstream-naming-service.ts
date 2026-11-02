import { mentionLinksAsText } from "@rally/contracts/citations";
import { normalizeModelText } from "@rally/contracts/model-markdown";
import {
  renderWorkstreamNameMessages,
  type WorkstreamNameContextMessage,
} from "@rally/agent-harness";
import {
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
import { MAXIMUM_DESCRIPTION_CHARACTERS, provisionalWorkstreamDescription } from "./workstream-description-service";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { AUTHORITY_FENCED_CODE, ObjectPortError } from "../runtime/object-port-error";

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
    // A plain string, not an enum of the catalog: Google AI Studio refuses a
    // 253-value enum as "too much branching for serving", which failed every
    // naming call on a Gemini route, fallbacks included. The catalog is in the
    // prompt, and an answer off it is dropped to "no icon" at the parse rather
    // than failing the name with it. Required, so a provider honouring
    // `strict: true` cannot answer with a name and no icon.
    icon: { type: "string" },
  },
  required: ["title", "icon"],
};

/**
 * The same request with a summary beside the name, for the first pass over a
 * description derived from the opening message. A separate schema rather than
 * an optional field: under `strict: true` every property is required, and the
 * passes that write no description should not pay for one.
 */
const nameWithSummaryJsonSchema = {
  ...nameJsonSchema,
  properties: { ...nameJsonSchema.properties, summary: { type: "string" } },
  required: [...nameJsonSchema.required, "summary"],
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
  // A title is plain text: a mention reads as the `@Name` its author saw, not
  // the `[@Name](sidekick://…)` link the opening message stores.
  const firstLine = firstNonEmptyLine(mentionLinksAsText(objective));
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
  /** Read already-materialized history for the first naming pass. */
  useConversationContext?: boolean;
  /** The title creation wrote, and the one that stands if naming produces none. */
  provisionalTitle: string;
  /** The creator, where one exists — a rollout bucketing attribute. */
  userId?: string | undefined;
  /**
   * The description creation derived from the opening message, when it did.
   * The pass then asks for a summary in the same call and puts it in place of
   * this text, unless something else has replaced it first. Omitted where a
   * person wrote the description, which is theirs to keep.
   */
  provisionalDescription?: string | undefined;
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
      ...(input.useConversationContext ? { recentMessages: await loadNamingContext(env, input.workspaceId, input.workstreamId, input.substreamId) } : {}),
      summarize: input.provisionalDescription !== undefined,
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
      title: generated.title,
      icon: generated.icon,
      standingTitle: input.provisionalTitle,
    });
    if (input.provisionalDescription !== undefined && generated.summary !== null) {
      await summarizeDescription(env, {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        substreamId: input.substreamId,
        summary: generated.summary,
        provisionalDescription: input.provisionalDescription,
      });
    }
  });
}

/** What summarizing one existing conversation's description came to. */
export type DescriptionSummaryOutcome =
  | "summarized"
  | "has_description"
  | "unchanged"
  | "superseded"
  | "not_found"
  | "not_authoritative"
  | "archived"
  | "authored"
  | "not_a_thread"
  | "no_opening_message"
  | "not_the_opening_line";

/**
 * Summarize the description of a thread or Breakout that has none worth the
 * name: one created before the first naming pass asked for a summary, or a
 * Breakout opened without a message. The backfill's whole step for one
 * conversation, and what a Breakout's run settlement calls.
 *
 * Only a description that is empty or still the opening message's first line,
 * exactly as creation derived it, is sent to the model. That one comparison is what
 * makes the backfill safe to run twice and cheap to run over everything: a
 * description a person wrote, one the description loop already rewrote, and
 * one this step already summarized all fail it before any model call. The
 * write is the same compare-and-swap the first pass uses.
 *
 * A conversation whose object is not authoritative refuses every read, and
 * nothing the backfill does makes it one: initialization or an import makes it
 * authoritative, and a thread the directory lists whose object never got
 * either is stuck until someone repairs it. Reported as `not_authoritative`
 * so the row settles, rather than thrown, which retried it at its gate for
 * good (docs/thread-backfill.md, 2026-10-19).
 */
export async function summarizeExistingDescription(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  substreamId?: string | undefined;
  /**
   * Only write a description where there is none. Run settlement passes it:
   * a summary the model hands back as the opening line, or does not give,
   * leaves the opening line in place, and without this every later run
   * would ask again.
   */
  onlyWhenEmpty?: boolean;
}): Promise<DescriptionSummaryOutcome> {
  const identity = await createIdentityObjectPort(
    env, input.workspaceId, input.workstreamId, undefined, input.substreamId,
  ).identity().catch((error: unknown) => {
    if (error instanceof ObjectPortError && error.code === AUTHORITY_FENCED_CODE) return "not_authoritative" as const;
    throw error;
  });
  if (identity === "not_authoritative") return identity;
  if (!identity) return "not_found";
  if (input.onlyWhenEmpty && identity.description !== "") return "has_description";
  if (identity.archived_at != null) return "archived";
  if (identity.description_source === "authored") return "authored";
  // The same conversations the description loop leaves alone: a Sidekick's is
  // described by its definition, and a Space's hidden one has no reader.
  if (identity.parent_kind === "automation" || identity.parent_kind === "space") return "not_a_thread";
  const [opening] = await createMessageObjectPort(
    env, input.workspaceId, input.workstreamId, undefined, input.substreamId,
  ).saidMessages({ messageTypes: { include: ["text"] }, order: "oldest", limit: 1 });
  if (!opening) return "no_opening_message";
  const openingLine = provisionalWorkstreamDescription(opening.text_content, "");
  // Empty is the other description still waiting for one: a Breakout opened
  // without a message is provisioned with none, and nothing else writes it.
  if (identity.description !== "" && identity.description !== openingLine) return "not_the_opening_line";

  const generated = await generateName(env, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    objective: identity.description || openingLine,
    openingMessage: opening.text_content,
    summarize: true,
  });
  // Thrown rather than reported as unchanged, so the backfill retries this
  // conversation instead of settling it with the model down.
  if (generated.failed) throw new Error("description_summary_model_failed");
  if (generated.summary === null) return "unchanged";
  const applied = await summarizeDescription(env, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    substreamId: input.substreamId,
    summary: generated.summary,
    provisionalDescription: identity.description,
  });
  return applied === "applied" ? "summarized" : applied;
}

/**
 * Put the first pass's summary in place of the description creation derived,
 * if that description still stands.
 *
 * The same compare-and-swap the description loop writes through: a person, or
 * the loop, who replaced the description while the model was answering wins.
 * The write commits the directory projection with it, so the Channel's feed and
 * the sidebar move to the summary without a separate event.
 */
async function summarizeDescription(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  substreamId?: string | undefined;
  summary: string;
  provisionalDescription: string;
}): Promise<"applied" | "superseded" | "unchanged"> {
  if (input.summary === input.provisionalDescription) return "unchanged";
  const result = await createIdentityObjectPort(
    env, input.workspaceId, input.workstreamId, undefined, input.substreamId,
  ).redescribe({
    description: input.summary,
    expectedDescription: input.provisionalDescription,
    now: Date.now(),
  });
  logStructuredEvent(env, "info", "workstream_description_summarized", {
    workspace_id: input.workspaceId,
    workstream_id: input.workstreamId,
    outcome: result.outcome,
    summary_length: input.summary.length,
    provisional_length: input.provisionalDescription.length,
  });
  return result.outcome;
}

/**
 * Icon-only pass for a conversation created with its title (an import); see
 * `docs/workstream-naming.md#prepared-history`. Never rejects: see
 * {@link guarded}.
 */
export async function chooseWorkstreamIcon(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  objective: string;
  userId?: string | undefined;
}): Promise<void> {
  await guarded(env, input.workspaceId, input.workstreamId, async () => {
    const generated = await generateName(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      userId: input.userId,
      objective: input.objective,
      openingMessage: "",
      recentMessages: await loadNamingContext(env, input.workspaceId, input.workstreamId),
      iconOnly: true,
    });
    if (generated.icon === null) return;
    // No room event: `workstream_renamed` carries a title, and one read before
    // a person's rename could land after it. The directory projection that
    // commits with this write carries the icon instead.
    const result = await createIdentityObjectPort(env, input.workspaceId, input.workstreamId).rename({
      title: null,
      icon: generated.icon,
      from: "settled",
      to: "settled",
      now: Date.now(),
    });
    logStructuredEvent(env, "info", "workstream_icon_chosen", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      outcome: result.outcome,
      icon: result.icon,
    });
  });
}

/**
 * Icon-only pass for a Space created without one, read from its name alone;
 * see `docs/spaces.md#the-icon-rally-chooses`. Returns the icon, or `null` when
 * the model offered none, and never rejects. The caller writes it, because a
 * Space's appearance belongs to WorkspaceDO rather than to a work-stream
 * object.
 */
export async function chooseSpaceIcon(env: Env, input: {
  workspaceId: string;
  spaceId: string;
  name: string;
  userId?: string | undefined;
}): Promise<WorkstreamIconKey | null> {
  const generated = await generateName(env, {
    workspaceId: input.workspaceId,
    spaceId: input.spaceId,
    userId: input.userId,
    objective: input.name,
    openingMessage: "",
    iconOnly: true,
  });
  return generated.icon;
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
      title: generated.title,
      icon: generated.icon,
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

/** What one pass got out of the model: any part may be missing. */
interface GeneratedName {
  title: string | null;
  icon: WorkstreamIconKey | null;
  /** Only when the pass asked for one; see `nameWithSummaryJsonSchema`. */
  summary: string | null;
  /** The model call itself failed, as opposed to answering with nothing usable. */
  failed?: true;
}

const NOTHING_GENERATED: GeneratedName = { title: null, icon: null, summary: null };

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
 * A fallback whose provider refuses `none` is served its default instead; see
 * `reasoningEffortFor` in the agent harness.
 *
 * Never throws. Every caller's alternative is the title and icon already on the
 * work stream, so a failure is logged and reported as "nothing generated".
 */
async function generateName(env: Env, input: {
  workspaceId: string;
  /** The conversation being named, or the Space whose icon is chosen. */
  workstreamId?: string;
  spaceId?: string;
  userId?: string | undefined;
  objective: string;
  openingMessage: string;
  recentMessages?: WorkstreamNameContextMessage[];
  /** The caller writes no name, so the icon stands without one. */
  iconOnly?: boolean;
  /** Ask for a summary of the request beside the name. */
  summarize?: boolean;
}): Promise<GeneratedName> {
  if (!env.OPENROUTER_API_KEY) return NOTHING_GENERATED;
  try {
    const { result } = await runStructuredInference(env, {
      role: "workstream_naming",
      activity: "channel_naming",
      context: {
        workspaceId: input.workspaceId,
        ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
      },
      messages: renderWorkstreamNameMessages({
        objective: input.objective,
        ...(input.openingMessage.trim() ? { openingMessage: input.openingMessage } : {}),
        ...(input.recentMessages?.length ? { recentMessages: input.recentMessages } : {}),
        ...(input.summarize ? { summarize: true } : {}),
      }),
      schemaName: "workstream_name",
      jsonSchema: input.summarize ? nameWithSummaryJsonSchema : nameJsonSchema,
      parse: (value) => WorkstreamNameResultSchema.parse(value),
      reasoningEffort: "none",
    });
    const title = normalizeGeneratedTitle(result.title);
    // Tied to the name rather than written on its own. An icon is only ever
    // chosen alongside a name, and an answer whose name normalized away to
    // nothing is one this pass is reporting as unusable — writing its icon
    // anyway would spend the one icon a work stream gets on the pass that
    // failed. The icon pass is the exception: it writes no name, so a name
    // that normalized away says nothing about the icon beside it.
    if (input.iconOnly) return { title: null, icon: result.icon ?? null, summary: null };
    // The summary stands on its own: it describes the request, not the name,
    // and the backfill writes no name at all.
    const summary = input.summarize ? normalizeGeneratedSummary(result.summary ?? "") : null;
    if (title === null) return { ...NOTHING_GENERATED, summary };
    return { title, icon: result.icon ?? null, summary };
  } catch (error) {
    logStructuredEvent(env, "warn", "workstream_naming_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      space_id: input.spaceId,
      stage: "model",
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : "Work-stream naming failed",
    });
    return { ...NOTHING_GENERATED, failed: true };
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
  // One pass, one write, whichever conversation is being named. A private
  // child stores the icon it was given like any other conversation — the row
  // is there and the model already chose one — and no surface draws it: the
  // sidebar's child rows carry the branch line, and the payload that feeds
  // them has no appearance field to carry anything else.
  const result = await createIdentityObjectPort(
    env, input.workspaceId, input.workstreamId, undefined, input.substreamId,
  ).rename({
      title: input.title,
      icon: input.icon,
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

/**
 * Reduce a model's summary to the description it becomes, or `null` to keep
 * the one in force. Over the description loop's length is dropped rather than
 * cut: a summary cut mid-sentence reads worse than the request it replaces.
 */
export function normalizeGeneratedSummary(value: string): string | null {
  const collapsed = normalizeModelText(value).replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0 || collapsed.length > MAXIMUM_DESCRIPTION_CHARACTERS) return null;
  return collapsed;
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
