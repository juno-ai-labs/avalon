/**
 * Reading a tool call the model asked for.
 *
 * This is the dispatch half of a rule whose other half lives in
 * `defects.ts`, and the two only work if they agree. `detectCompletionDefect`
 * decides that a tool call with *empty* arguments is legitimate — the normal
 * zero-argument shape, not a truncation — and passes it through to be run.
 * Something then has to run it, and that something has to reach the same
 * conclusion: empty arguments mean no arguments, not malformed JSON.
 *
 * Splitting those halves across a package boundary is how the original bug
 * happened. Providers send `""` for a zero-arg call as readily as `"{}"`, the
 * dispatcher fed `""` to `JSON.parse`, and a perfectly good call died as
 * "Invalid JSON in tool arguments" — a whole recovery turn spent on a turn
 * that was never broken. A host adopting only the detection half inherits the
 * permissive decision and has to independently invent the matching parse.
 *
 * So both halves read {@link toolCallArgumentsAbsent}. One definition, and a
 * change to what "absent" means cannot update one side and miss the other.
 */

/**
 * The shape this module reads. Structural rather than tied to an SDK's class,
 * and `type` is optional because a host assembling calls by hand may not carry
 * one — its absence is treated as the ordinary function call it almost always
 * is, while a *present* non-function type is refused.
 */
export interface DispatchableToolCall {
  readonly type?: string | undefined;
  readonly function?:
    | {
        readonly name?: string | undefined;
        readonly arguments?: string | undefined;
      }
    | undefined;
}

/**
 * Whether a tool call carried no arguments at all.
 *
 * Whitespace counts as absent: a provider that pads its zero-arg payload is
 * still saying "no arguments", and treating `"  "` as content sends it to a
 * JSON parse that can only fail.
 */
export function toolCallArgumentsAbsent(rawArguments: string): boolean {
  return rawArguments.trim().length === 0;
}

/**
 * What a tool call's arguments turned out to be.
 *
 * A tagged union rather than a throw, because every outcome here has to end
 * with the host emitting a `tool` message for this call's id. A transcript
 * where an assistant asked for a tool and no `tool` message answers it is
 * rejected by the provider on the *next* request, so "give up on this call"
 * is never an option — only "dispatch it" or "answer it with an error".
 */
export type ToolCallArguments =
  /** Dispatch with these. `{}` for a legitimate zero-argument call. */
  | { kind: "parsed"; arguments: Record<string, unknown> }
  /**
   * Not a function call, so there is nothing to dispatch. Present in the
   * OpenAI union (`type: "custom"`) and in whatever a future provider adds.
   */
  | { kind: "unsupported_type"; type: string }
  /**
   * Arguments that cannot be used: either not JSON at all, or JSON that is not
   * an object.
   *
   * The two have different histories, which matters for how the host words the
   * error. A *syntax* failure by this point is a real error rather than a
   * truncation — a cut-off stream is caught upstream by
   * `detectCompletionDefect` and retried, so anything still unparseable here
   * survived that. A payload that parsed but is not an object was never
   * eligible for that retry (it parses fine), so the model's next turn is its
   * only correction — which is why {@link detail} names what was wrong, and
   * why a host should put it in front of the model rather than only in a log.
   */
  | { kind: "unparseable"; detail: string };

/**
 * Read a tool call's arguments, or say why it cannot be dispatched.
 *
 * A parsed value that is not a JSON object — `"null"`, `"[]"`, `"42"`, all
 * valid JSON — is refused rather than passed on. Tool arguments are a named
 * parameter bag by definition, and handing a tool an array where it expects
 * fields turns a clear failure here into a confusing one inside the tool.
 */
export function parseToolCallArguments(
  toolCall: DispatchableToolCall,
): ToolCallArguments {
  if (toolCall.type !== undefined && toolCall.type !== "function") {
    return { kind: "unsupported_type", type: toolCall.type };
  }

  const raw = toolCall.function?.arguments;
  if (typeof raw !== "string" || toolCallArgumentsAbsent(raw)) {
    // The empty case and the missing case are the same call: the model named a
    // tool and gave it nothing, which is what a zero-argument tool looks like.
    return { kind: "parsed", arguments: {} };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "unparseable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // `typeof` alone is not a usable name here: it reports both `null` and an
    // array as "object", so the two payloads most likely to arrive would be
    // described as the very thing they were rejected for not being.
    const got =
      value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
    return { kind: "unparseable", detail: `expected a JSON object, got ${got}` };
  }

  return { kind: "parsed", arguments: value as Record<string, unknown> };
}
