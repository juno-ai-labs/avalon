import { z } from "zod";

/**
 * The names a model reads and writes, where they differ from storage.
 *
 * The product is Canvases and Sidekicks in an Organization. Storage keeps the
 * names of earlier pivots: an Organization is a `workspace`, a Canvas's id is
 * a `workstream` id, a conversation is a `substream`, a Canvas's remembered
 * facts are filed under `thread`. A model has no way to connect those words to
 * what a person calls the thing, so none of them crosses to a model: a tool
 * translates on the way out and on the way in, and storage, RPC and logs keep
 * the stored name. `docs/agent-tools.md` (rule 10) owns the rule.
 *
 * One map per stored enum says what each stored value is called. A value the
 * map leaves out is its own name.
 */
export type ModelNames<Stored extends string> = Readonly<Partial<Record<Stored, string>>>;

/** `workspace` is the Organization, wherever a scope, an audience or an owner is named. */
export const ORGANIZATION_MODEL_NAMES = { workspace: "organization" } as const;

type Named<Stored extends string, Names extends ModelNames<string>> =
  Stored extends keyof Names ? (Names[Stored] extends string ? Names[Stored] : Stored) : Stored;

/**
 * A resource Rally itself holds is stored under a provider named for the
 * product's code name (`avalon_upload`, `avalon_generated`, `avalon_note`).
 * The column is in every resource row and in queries across the tree, so it
 * stays; a model reads the product's name.
 */
export const RESOURCE_PROVIDER_MODEL_NAMES = {
  avalon_upload: "rally_upload",
  avalon_generated: "rally_generated",
  avalon_note: "rally_note",
} as const;

/** What a model reads for one stored value. */
export function modelName<Stored extends string, const Names extends ModelNames<string>>(
  names: Names,
  stored: Stored,
): Named<Stored, Names> {
  return ((names as Record<string, string | undefined>)[stored] ?? stored) as Named<Stored, Names>;
}

/** The values a model is offered for a stored enum, in the stored order. */
export function modelValues<const Stored extends string, const Names extends ModelNames<string>>(
  stored: readonly Stored[],
  names: Names,
): Named<Stored, Names>[] {
  return stored.map((value) => modelName(names, value));
}

/** The stored value for what a model sent: its model name, or the stored name itself. */
export function storedName<const Stored extends string>(
  stored: readonly Stored[],
  names: ModelNames<string>,
  sent: string,
): Stored | undefined {
  return stored.find((value) => modelName(names, value) === sent) ?? stored.find((value) => value === sent);
}

/**
 * A stored enum as a tool parameter: offered under its model names, parsed to
 * the stored value. A stored name the model is no longer shown is still
 * accepted, because instructions a Sidekick saved before the rename may spell
 * it, and never advertised: the JSON Schema lists the model names alone.
 */
export function modelEnum<const Stored extends string>(
  stored: readonly Stored[],
  names: ModelNames<string>,
): z.ZodType<Stored, string> {
  const offered: string[] = modelValues(stored, names);
  const accepted = [...new Set([...offered, ...stored])];
  return z.enum(accepted).meta({ enum: offered }).transform((sent, context): Stored => {
    const value = storedName(stored, names, sent);
    if (value !== undefined) return value;
    // Unreachable: the enum above admits only a model name or a stored one.
    context.addIssue({ code: "custom", message: "Not one of the offered values." });
    return z.NEVER;
  });
}

/**
 * A copy of a tool's own result with the named fields translated, at any
 * depth. For a result built by code that the product's own screens share,
 * whose scope fields therefore hold stored values. Only the listed keys are
 * touched, so a provider's or a person's data that happens to say `workspace`
 * is never rewritten.
 */
export function withModelNames<T>(value: T, names: ModelNames<string>, keys: readonly string[]): T {
  if (Array.isArray(value)) return value.map((entry) => withModelNames(entry, names, keys)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key,
    keys.includes(key) && typeof field === "string" ? modelName(names, field) : withModelNames(field, names, keys),
  ])) as T;
}

/**
 * Storage words inside a failure code, as a model reads the code. A code is
 * lower snake case (`workstream_archived`, `memory_workspace_principal_mismatch`).
 * A model is shown `canvas_archived`: the code it branches on names the thing
 * it was told about. Logs, receipts and events keep the stored code.
 */
const FAILURE_CODE_WORDS = { workstream: "canvas", workstreams: "canvases", substream: "conversation", substreams: "conversations",
  workspace: "organization", workspaces: "organizations", automation: "sidekick", automations: "sidekicks" } as const;

/**
 * Codes whose `workspace` is not the Organization: a sandbox's file workspace,
 * or the provider's own word for an account (a Slack workspace).
 */
const OTHER_WORKSPACE_CODE = /^(?:terminal|slack|linear|notion|granola|google|fireflies|ashby)_/u;

/** One failure code as a model reads it; anything that is not code-shaped is returned as written. */
export function modelFailureCode(code: string): string {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(code)) return code;
  const other = OTHER_WORKSPACE_CODE.test(code);
  return code.split("_").map((word) => {
    if (other && (word === "workspace" || word === "workspaces")) return word;
    return (FAILURE_CODE_WORDS as Record<string, string | undefined>)[word] ?? word;
  }).join("_");
}

/**
 * A failure's message as a model reads it. Only a message that is a bare
 * code, or opens with one (`page_id_invalid: Restart with…`), is touched. A
 * sentence is left as written, because it may echo what the model sent (a SQL
 * table it named, a path under `/workspace`) and has to echo it exactly.
 */
export function modelFailureText(text: string): string {
  const separator = text.indexOf(": ");
  const code = separator < 0 ? text : text.slice(0, separator);
  return `${modelFailureCode(code)}${separator < 0 ? "" : text.slice(separator)}`;
}

/**
 * A typed failure as a model reads it: the message and the code translated
 * together, the details untouched. The one place a failure crosses to a model
 * calls this, so a live result and one rebuilt from its receipt read the same.
 */
export function modelFailure<Data extends { code: string } | null | undefined>(
  failure: { error: string; data?: Data },
): { error: string; data?: Data } {
  return {
    error: modelFailureText(failure.error),
    ...(failure.data ? { data: { ...failure.data, code: modelFailureCode(failure.data.code) } } : {}),
  };
}
