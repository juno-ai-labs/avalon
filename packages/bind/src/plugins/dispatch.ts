/**
 * Authoring and dispatching a tool: the mechanical half of writing one, which
 * every host had been reimplementing.
 *
 * A `ToolPlugin` is a bundle whose `execute` dispatches by tool name, because
 * that is the shape a plugin with shared setup wants. It is not the shape a
 * *single* tool wants, and a host with a flat list of tools ends up writing the
 * same four steps for each: switch on the name, parse the arguments, map a
 * parse failure onto a result the model can read, and encode the result as a
 * `role:"tool"` message. All four are mechanical, all four are easy to get
 * subtly wrong (the usual bug is a parse failure thrown rather than returned,
 * which turns a recoverable "you passed the wrong argument" into a dead run),
 * and none of them are where a host's judgement belongs.
 *
 * {@link defineTool} and {@link pluginFromTools} do those steps. They are a
 * convenience over the vocabulary in `./tool`, not a replacement for it: a
 * plugin that needs shared setup across its tools, or whose dispatch is genuinely
 * one decision, still writes `ToolPlugin` by hand and loses nothing.
 */
import { z } from "zod";
import type OpenAI from "openai";
import { sanitizeToolSchema } from "../tools/sanitize-schema";
import { stripControlChars } from "../tools/control-chars";
import type {
  ToolAnnotations,
  ToolDef,
  ToolPlugin,
  ToolResult,
} from "./tool";

/**
 * A tool that carries its own implementation.
 *
 * `execute` takes `unknown` and does the parsing itself, which is what lets a
 * heterogeneous array of tools — each with a different argument type — sit in
 * one `tools: DefinedTool[]` without a cast anywhere. It also makes a defined
 * tool independently useful: dispatch it directly and you still get argument
 * validation, without going through {@link pluginFromTools}.
 */
export interface DefinedTool<TCtx, TContentPart = unknown> extends ToolDef {
  /**
   * Run this tool against unvalidated arguments, parsing with `parameters`
   * first. A parse failure comes back as a `validation` result rather than a
   * throw, because the model can fix it on the next turn and a throw would end
   * the run instead.
   *
   * Does **not** apply `normalizeArgs` — that is the dispatcher's step, run
   * before the idempotency hash. Applying it here too would apply it twice.
   */
  execute(
    args: unknown,
    ctx: TCtx,
  ): Promise<ToolResult<TContentPart>> | ToolResult<TContentPart>;
}

/**
 * The declaration side of {@link defineTool}. `schema` is the single source of
 * truth: it is what the model is shown (converted to JSON Schema) and what the
 * model's arguments are validated against, so the two can never drift.
 */
export interface ToolSpec<TSchema extends z.ZodType, TCtx, TContentPart> {
  readonly name: string;
  readonly description: string;
  readonly schema: TSchema;
  execute(
    args: z.output<TSchema>,
    ctx: TCtx,
  ): Promise<ToolResult<TContentPart>> | ToolResult<TContentPart>;
  readonly annotations?: ToolAnnotations;
  readonly hidden?: boolean;
  readonly supportsProgress?: boolean;
  /**
   * Pre-computed JSON Schema, for a tool authored as raw JSON Schema rather
   * than zod. `schema` still validates the arguments.
   *
   * It is also the one way to author a tool whose `schema` is not
   * parse-idempotent (a `.transform()`, which `z.toJSONSchema` refuses to
   * convert). Doing so makes the schema's idempotence your responsibility:
   * `execute` parses defensively, so a dispatcher that already parsed hands
   * this a value the schema must still accept.
   */
  readonly rawJsonSchema?: Record<string, unknown>;
  /**
   * Pure canonicalization of already-validated arguments — sorting a set-like
   * array, lower-casing a key. Runs **after** the schema parse, per
   * `ToolDef.normalizeArgs`, so it receives defaults already applied and a
   * shape it can rely on; a normalizer handed raw model output would have to
   * re-check everything the schema just checked.
   *
   * Applied by the **dispatcher**, before the idempotency hash — not by
   * `execute`. It must be idempotent anyway (`f(f(x)) === f(x)`), because
   * nothing can stop a host applying it more than once.
   */
  readonly normalizeArgs?: (args: z.output<TSchema>) => z.output<TSchema>;
  readonly summarizeActivity?: (args: unknown) => string | null;
}

/**
 * Define one tool from its schema and implementation.
 *
 * The returned value is an ordinary {@link ToolDef} with an `execute` attached,
 * so it drops into anything that already consumes `ToolDef` — a catalog
 * renderer, a schema regression test — without an adapter.
 */
export function defineTool<
  TSchema extends z.ZodType,
  TCtx = unknown,
  TContentPart = unknown,
>(spec: ToolSpec<TSchema, TCtx, TContentPart>): DefinedTool<TCtx, TContentPart> {
  // Hoisted so the closures below narrow it once; reading `spec.normalizeArgs`
  // inside each would re-widen it to possibly-undefined on every call.
  const normalize = spec.normalizeArgs;
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.schema,
    ...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
    ...(spec.hidden === undefined ? {} : { hidden: spec.hidden }),
    ...(spec.supportsProgress === undefined
      ? {}
      : { supportsProgress: spec.supportsProgress }),
    ...(spec.rawJsonSchema === undefined
      ? {}
      : { rawJsonSchema: spec.rawJsonSchema }),
    ...(normalize === undefined
      ? {}
      : {
          // Handed straight through, NOT re-parsed. `ToolDef.normalizeArgs` is
          // documented as post-parse canonicalization and every dispatcher
          // calls it that way, so re-parsing here was pure harm: it ran the
          // schema a second time, and on any input the schema could not
          // re-accept it silently returned the *un-normalized* value — which
          // is the idempotency hash, so two equivalent calls stopped agreeing
          // exactly when canonicalization mattered most.
          //
          // The cast is confined to this line. It is safe by the same contract:
          // the value is post-parse, so it is a `z.output<TSchema>`.
          normalizeArgs: normalize as (args: unknown) => unknown,
        }),
    ...(spec.summarizeActivity === undefined
      ? {}
      : { summarizeActivity: spec.summarizeActivity }),
    // Parses, and deliberately does NOT normalize.
    //
    // Normalization is the dispatcher's step — it has to happen before the
    // idempotency hash, which the harness never sees — and a dispatcher that
    // applies `normalizeArgs` and then calls this would otherwise apply it
    // twice. Once is a no-op for an idempotent canonicalizer and wrong for
    // anything else (`n => n + 1` reached `execute` as `n + 2`).
    //
    // The parse stays because this is also the entry point for a host with no
    // dispatcher of its own, and re-parsing an already-parsed value is a
    // no-op for any schema that can legally be a tool schema — `.transform()`
    // cannot (`z.toJSONSchema` rejects it, so the tool could never be
    // advertised), and `.default()` / `z.coerce` are both parse-idempotent.
    // A tool that supplies `rawJsonSchema` to bypass that conversion owns the
    // requirement itself; see `ToolSpec.rawJsonSchema`.
    execute: (args, ctx) => {
      const parsed = spec.schema.safeParse(args);
      if (!parsed.success) {
        return validationFailure(spec.name, args, parsed.error);
      }
      return spec.execute(parsed.data, ctx);
    },
  };
}

/**
 * Cap on the issues quoted back. A tool taking an array validates every
 * element, so one malformed argument can produce thousands — and the result
 * message is not transient: it is appended to the transcript and re-sent to
 * the provider on every remaining turn of the run. Ten is enough for a model
 * to act on; the rest are counted, not quoted.
 */
const MAX_QUOTED_ISSUES = 10;

/**
 * Quote model-supplied text back at it safely. A zod issue path can contain
 * input *keys* (via `z.record`), and this string reaches a host's logs and, in
 * Monad, a member-visible activity row — so control characters are replaced
 * with a space rather than deleted, keeping adjacent words apart, and the
 * result is bounded.
 */
function safeQuote(text: string): string {
  // `Array.from` iterates code points, so the bound cannot slice an astral
  // character in half and put a lone surrogate in the transcript.
  return Array.from(stripControlChars(text, " ")).slice(0, 200).join("");
}


/** How a tool's arguments failed to parse, phrased for the model. */
function validationFailure(
  toolName: string,
  args: unknown,
  error: z.ZodError,
): ToolResult<never> {
  const quoted = error.issues.slice(0, MAX_QUOTED_ISSUES).map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    const where = path ? safeQuote(path) : "(top level)";
    // zod renders an omitted key as "expected string, received undefined",
    // which reads as a *type* error — and a model that reads it that way
    // retries with the literal string "undefined" instead of supplying the
    // field. Resolving the path against the input is what tells the two apart.
    const omitted =
      issue.code === "invalid_type" && pathIsAbsent(args, issue.path);
    return `- ${where}: ${omitted ? "required, but missing" : safeQuote(issue.message)}`;
  });
  const hidden = error.issues.length - quoted.length;
  return {
    success: false,
    kind: "validation",
    // Leads with the outcome, itemizes what to change, and ends with the
    // action — the shape `ABORTED_TOOL_CALL_MESSAGE` established. A message
    // that only diagnoses leaves the model to guess whether to retry.
    error:
      `Invalid arguments for ${toolName} — the call did not run and nothing changed.\n` +
      quoted.join("\n") +
      (hidden > 0 ? `\n- (and ${hidden} more problems)` : "") +
      `\nFix these fields and call ${toolName} again with the same intent. ` +
      `Do not resend the same arguments.`,
  };
}

/**
 * Is the key a zod issue points at genuinely absent?
 *
 * Checked with `in` rather than by comparing the value to `undefined`, so a
 * field explicitly present as `undefined` is reported as the wrong type rather
 * than as missing. `JSON.parse` never produces `undefined`, so this only
 * matters for a host dispatching pre-parsed arguments — which is exactly the
 * caller `defineTool` supports.
 */
function pathIsAbsent(value: unknown, path: ReadonlyArray<PropertyKey>): boolean {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return true;
    if (!(segment in (current as object))) return true;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return false;
}

export interface PluginSpec<TCtx, TContentPart> {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly DefinedTool<TCtx, TContentPart>[];
  readonly systemMessage?: string;
  readonly icon?: string;
  readonly isAvailable?: () => boolean;
}

/**
 * Bundle self-contained tools into a {@link ToolPlugin}.
 *
 * The generated `execute` is only a name resolver — each tool already validates
 * its own arguments (see {@link DefinedTool}). An unknown name is a *returned*
 * `not_found` failure rather than a throw: it happens whenever a resumed
 * session's history references a tool that has since been retired, and a run
 * should survive that.
 */
export function pluginFromTools<TCtx = unknown, TContentPart = unknown>(
  spec: PluginSpec<TCtx, TContentPart>,
): ToolPlugin<TCtx, TContentPart> {
  const byName = new Map<string, DefinedTool<TCtx, TContentPart>>();
  for (const tool of spec.tools) {
    if (byName.has(tool.name)) {
      // Thrown, not returned: two tools sharing a name is an authoring mistake
      // that makes one of them permanently unreachable, and it should fail at
      // construction rather than at whichever call happens to resolve first.
      throw new Error(
        `pluginFromTools: plugin "${spec.name}" declares two tools named "${tool.name}".`,
      );
    }
    byName.set(tool.name, tool);
  }

  return {
    name: spec.name,
    description: spec.description,
    ...(spec.systemMessage === undefined
      ? {}
      : { systemMessage: spec.systemMessage }),
    ...(spec.icon === undefined ? {} : { icon: spec.icon }),
    ...(spec.isAvailable === undefined
      ? {}
      : { isAvailable: spec.isAvailable }),
    tools: [...spec.tools],
    async execute(toolName, args, ctx) {
      const tool = byName.get(toolName);
      if (!tool) {
        return {
          success: false,
          kind: "not_found",
          // Leads with the outcome and ends with an action. A bare "unknown
          // tool" is indistinguishable from a transient miss, and a model
          // reading it that way re-issues the same call every iteration until
          // the budget runs out — which is exactly the state this arm exists
          // to survive (a resumed session referencing a retired tool).
          error:
            `No tool named "${safeQuote(toolName)}" exists on plugin "${spec.name}" — ` +
            `nothing ran and nothing changed, and calling it again will fail the ` +
            `same way. Use one of the tools currently listed for "${spec.name}", ` +
            `or finish the task without it.`,
        };
      }
      return await tool.execute(args, ctx);
    },
  };
}

/**
 * Convert a tool to the wire definition a provider is shown.
 *
 * `rawJsonSchema` wins when present (an MCP tool forwards its server's schema
 * verbatim); otherwise the zod schema is converted. Either way the result goes
 * through {@link sanitizeToolSchema}, because a strict validator rejects the
 * *entire* request on the first unsupported construct — one bad tool takes
 * every other tool down with it.
 *
 * `wireName` exists because tool naming is host policy: Monad encodes
 * `plugin__tool` so it can route a call back to its plugin, and a host with a
 * flat namespace does not need to. Defaults to the tool's own name.
 *
 * Returns the narrow `ChatCompletionFunctionTool` rather than the
 * `ChatCompletionTool` union — a tool built from a parameter schema is always
 * the function variant, and returning the union would make every caller narrow
 * past a `custom` case that cannot occur. It still assigns to the union.
 *
 * Converts whatever it is handed. **Skip `hidden` tools in the caller's catalog
 * loop** — a hidden tool stays runnable so a resumed session's history still
 * resolves, but advertising it puts a retired tool back in front of the model.
 */
export function toolWireDefinition(
  tool: ToolDef,
  wireName: string = tool.name,
): OpenAI.ChatCompletionFunctionTool {
  const jsonSchema =
    tool.rawJsonSchema ??
    // zod's converter is typed as its own JSON Schema shape; the wire wants a
    // plain object, which is what it structurally is.
    (z.toJSONSchema(tool.parameters) as Record<string, unknown>);
  return {
    type: "function",
    function: {
      name: wireName,
      description: tool.description,
      parameters: sanitizeToolSchema(jsonSchema),
    },
  };
}
