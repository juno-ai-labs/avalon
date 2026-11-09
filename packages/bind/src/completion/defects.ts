/**
 * Transient defects in an assembled completion, and the retry predicates that
 * decide whether to ask the same endpoint again.
 *
 * A completion can come back structurally intact at the transport layer and
 * still be unusable: the provider cut the stream mid-arguments, or closed it
 * having emitted nothing at all. Neither is an HTTP failure — there is no
 * status code to classify — so nothing upstream in the routing taxonomy sees
 * them. Left undetected they reach the agent loop, where a truncated tool call
 * is rejected as "invalid JSON in tool arguments" and burns a whole recovery
 * turn on something a plain retry fixes.
 *
 * The two defect kinds here are exactly the two that feed
 * `InferenceAttemptError`'s `completion_defect` arm, which the disposition
 * matrix routes to a same-endpoint retry before traversing providers.
 *
 * Everything in this module is pure. Types are structural rather than tied to
 * any SDK's message class, so a host assembling chunks by hand and a host
 * handing over an `openai` message both fit without a cast.
 */

import { toolCallArgumentsAbsent } from "./tool-calls";

/**
 * Additional attempts when a structured-output call returns content that will
 * not parse as JSON: the initial call plus this many retries. Providers
 * occasionally truncate or malform JSON even under a strict schema, and a fresh
 * attempt almost always comes back valid.
 */
export const DEFAULT_STRUCTURED_OUTPUT_MAX_RETRIES = 3;

/**
 * Same-endpoint retry budget for a transiently-corrupt completion. A fresh
 * attempt on the SAME endpoint usually recovers an intact response; a
 * persistently-broken endpoint exhausts these, and the route executor then
 * traverses to the next provider or model.
 */
export const DEFAULT_COMPLETION_DEFECT_MAX_RETRIES = 2;

/** The part of a streamed tool call this module reads. */
export interface StreamedToolCall {
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/**
 * The outputs of an assembled completion. `tool_calls` is `unknown[]` here
 * because the checks that only need "did the model call a tool" must accept a
 * host's full SDK union (which may include non-function tool calls);
 * {@link detectCompletionDefect} narrows it where it actually reads arguments.
 */
export interface CompletionOutputs {
  readonly content: string | null;
  readonly refusal?: string | null | undefined;
  readonly tool_calls?: readonly unknown[] | undefined;
}

/** {@link CompletionOutputs} with tool calls narrowed to the readable shape. */
export interface AssembledCompletion<TToolCall extends StreamedToolCall = StreamedToolCall>
  extends CompletionOutputs {
  readonly tool_calls?: readonly TToolCall[] | undefined;
}

/**
 * The defect vocabulary, named once so the routing taxonomy can reference it
 * rather than re-spelling the same two literals. `InferenceAttemptError`'s
 * `completion_defect` arm carries exactly these, and a third kind added here
 * must widen that arm too — which it will, by type error, only because both
 * sides read this one declaration.
 */
export type CompletionDefectKind = "empty_completion" | "truncated_tool_call";

export type CompletionDefect<TToolCall extends StreamedToolCall = StreamedToolCall> =
  /** The provider closed the stream having emitted no content, tool call, or refusal. */
  | Readonly<{ kind: "empty_completion" }>
  /** A tool call whose arguments never arrived intact. */
  | Readonly<{ kind: "truncated_tool_call"; toolCall: TToolCall }>;

/** True when `s` parses as JSON. */
export function jsonParses(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the transient defect in an assembled completion, or `null` when it is
 * usable.
 *
 * **Empty completion.** No content, no tool calls, no refusal. A refusal alone
 * is a legitimate output and is not a defect.
 *
 * **Truncated tool call.** Non-empty arguments that do not parse as JSON are
 * always a truncation — the provider cut the stream mid-arguments. *Empty*
 * arguments are the normal zero-arg shape and are not a defect **unless** the
 * stream was `cutByTokenLimit`: a length-truncated empty-args call is an
 * incomplete message, not a deliberate no-arg call, and exempting it would let
 * a dispatcher execute a tool off a half-streamed turn.
 *
 * `cutByTokenLimit` is the *fact*, not the wire spelling of it — OpenAI says
 * `finish_reason: "length"`, Anthropic says `max_tokens`, Gemini says
 * `MAX_TOKENS`. Taking the fact keeps the one behavioural rule in this module
 * from silently reading `false` for every host that isn't on an
 * OpenAI-compatible gateway, which would apply the zero-arg exemption to
 * exactly the truncated calls it exists to exclude.
 *
 * A tool call whose `arguments` are not a readable string is skipped rather
 * than inspected: {@link CompletionOutputs.tool_calls} accepts a host's full
 * SDK union, and a non-function member (OpenAI's `type: "custom"`) has no
 * arguments to truncate.
 */
export function detectCompletionDefect<TToolCall extends StreamedToolCall>(
  completion: AssembledCompletion<TToolCall>,
  cutByTokenLimit: boolean,
): CompletionDefect<TToolCall> | null {
  const toolCalls = completion.tool_calls;
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
  if (!completion.content && !hasToolCalls && !completion.refusal) {
    return { kind: "empty_completion" };
  }
  if (hasToolCalls) {
    const truncated = toolCalls.find((toolCall) => {
      const args: unknown = toolCall?.function?.arguments;
      if (typeof args !== "string") return false;
      // The same predicate the dispatcher reads, so the two halves of the
      // zero-argument rule cannot drift — see `tool-calls.ts`.
      if (toolCallArgumentsAbsent(args)) return cutByTokenLimit;
      return !jsonParses(args.trim());
    });
    if (truncated !== undefined) {
      return { kind: "truncated_tool_call", toolCall: truncated };
    }
  }
  return null;
}

/**
 * The part of a request's `response_format` that decides whether output is JSON
 * we can validate by parsing. Structural so any SDK's type fits.
 *
 * The two JSON spellings are the OpenAI-compatible wire values. The open
 * `(string & {})` arm keeps any other value assignable — a gateway with its own
 * vocabulary is not a type error — while still letting an editor complete the
 * two that {@link expectsJsonOutput} actually recognizes, so a near-miss like
 * `"json"` is visible at the call site rather than silently falling through to
 * "no JSON expected".
 */
export interface ResponseFormatShape {
  readonly type?: "text" | "json_object" | "json_schema" | (string & {}) | undefined;
}

/**
 * True when `response_format` asks the model for JSON. Free-form output
 * (`text`, or omitted) is never retried on a parse failure — there is nothing
 * to parse, so every completion would look like a defect.
 */
export function expectsJsonOutput(
  responseFormat: ResponseFormatShape | null | undefined,
): boolean {
  return (
    responseFormat?.type === "json_schema" || responseFormat?.type === "json_object"
  );
}

/**
 * Whether a structured-output completion holds parseable JSON.
 *
 * Tool calls and refusals are valid non-JSON outcomes and pass. A wholly empty
 * completion is a {@link detectCompletionDefect} concern, but a *whitespace-only*
 * one is truthy there and slips through — so this deliberately does NOT
 * short-circuit on empty content: an empty or whitespace string is not valid
 * JSON, fails the parse, and earns a retry.
 *
 * The ``` / ```json fences some models wrap JSON in are stripped first,
 * mirroring what structured consumers do before parsing. A bare `true` / `false`
 * is itself valid JSON, so a model that answers a boolean schema with the bare
 * literal still passes; only genuinely malformed or truncated JSON fails.
 */
export function structuredOutputParses(completion: CompletionOutputs): boolean {
  const toolCalls = completion.tool_calls;
  if (toolCalls !== undefined && toolCalls !== null && toolCalls.length > 0) {
    return true;
  }
  if (completion.refusal) return true;
  const content = (completion.content ?? "").trim();
  const unfenced = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return jsonParses(unfenced);
}
