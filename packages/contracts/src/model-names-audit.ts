import { readStructuredFailure } from "./index";
import { modelFailure } from "./model-names";

/**
 * Finds storage names in what a tool hands a model: a result's keys, its
 * values and its prose, at any depth.
 *
 * The rule is `docs/agent-tools.md` rule 10. `model-names.ts` is how a tool
 * keeps it; this is how a test proves a tool kept it, by walking what the
 * tool actually returned rather than reading its source. Tests are its only
 * callers. It lives beside the mapping so the list of words has one home.
 *
 * Three kinds of word are looked for:
 *
 * - **storage names**: `workstream`, `substream`, `workspace` (the
 *   Organization), `automation` (a Sidekick), `avalon` (Rally).
 * - **retired product words**: `thread`, `channel`, `breakout`, `space`,
 *   `project`. These were product names and are nothing now.
 *
 * Both are looked for in every key and in every value that is one token (an
 * enum value, a code, an id such as `workstream:…:substream:…`). In prose
 * (a string with a space in it) both are looked for too, unless the caller
 * says the prose is somebody's data (`dataProse`), where a retired product
 * word is an ordinary English or provider word (a Slack channel, an email
 * thread, a project plan) and only a storage name is a finding.
 *
 * `allow` removes honest uses before the search: a regular expression per
 * phrase. The defaults cover the two meanings of `workspace` that stay (a
 * sandbox's files, a provider's own word for an account).
 */
export interface StorageNameFinding {
  /** Where it was found, as a JSON path (`$.items[0].provider`). */
  path: string;
  /** `key` for a property name, `value` for a string. */
  where: "key" | "value";
  /** The word, lower case and singular. */
  word: string;
  /** The key or the string that holds it, shortened. */
  text: string;
}

export interface StorageNameAuditOptions {
  /** Phrases that are honest uses, removed before the search. Added to the defaults. */
  allow?: readonly RegExp[];
  /** Words this surface may say, for a provider's own vocabulary (`channel` for Slack). */
  allowWords?: readonly string[];
  /**
   * The prose in this value is a person's or a provider's data, so a retired
   * product word in a sentence is not a finding. Keys, one-token values and
   * storage names in prose are still findings.
   */
  dataProse?: boolean;
}

const STORAGE_WORDS = ["workstream", "substream", "workspace", "automation", "avalon"] as const;
const RETIRED_PRODUCT_WORDS = ["thread", "channel", "breakout", "space", "project"] as const;

/** Honest uses that every surface shares. */
const DEFAULT_ALLOWED: readonly RegExp[] = [
  // A sandbox's files.
  /\/workspace(?:\/[^\s"'`)]*)?/gu,
  /\b(?:terminal|sandbox|file)(?:'s)? workspaces?\b/giu,
  /\bworkspace(?:'s)? root\b/giu,
  // A provider's own word for an account.
  /\b(?:Slack|Notion|Granola|Linear|Fireflies|Ashby|Google) workspaces?\b/giu,
  // Two identifiers a model has to type or read exactly, which
  // `docs/rally-rebrand-inventory.md` keeps: the sandbox variable that names
  // the output directory, and the branch namespace Terminal pushes under.
  /\$?AVALON_RESOURCE_DIR\b/gu,
  /\bavalon\/[a-z0-9]+(?:-[a-z0-9]+)*\b/gu,
  // Google's product, capitalized: "not a Workspace document".
  /\bWorkspace (?:documents?|files?)\b/gu,
];

/** A key or one-token value as lower-case words: `workstreamId` and `workstream_id` are `workstream`, `id`. */
function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

const singular = (word: string): string => (word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word);

function wordsIn(text: string, words: readonly string[]): string[] {
  const found = new Set<string>();
  const parts = tokens(text).map(singular);
  parts.forEach((part, index) => {
    if (words.includes(part)) found.add(part);
    // `work stream`, `work_stream`, `workStream`.
    if (part === "work" && singular(parts[index + 1] ?? "") === "stream" && words.includes("workstream")) found.add("workstream");
    // A word glued to another with no boundary to split on (`workspaceid`).
    for (const word of STORAGE_WORDS) if (part !== word && part.includes(word) && words.includes(word)) found.add(word);
  });
  return [...found];
}

/** Every storage name in `value`; empty when a model would read none. */
export function storageNamesIn(value: unknown, options: StorageNameAuditOptions = {}): StorageNameFinding[] {
  const allow = [...DEFAULT_ALLOWED, ...(options.allow ?? [])];
  const permitted = new Set(options.allowWords ?? []);
  const every = [...STORAGE_WORDS, ...RETIRED_PRODUCT_WORDS].filter((word) => !permitted.has(word));
  const storageOnly = STORAGE_WORDS.filter((word) => !permitted.has(word));
  const findings: StorageNameFinding[] = [];
  const strip = (text: string) => allow.reduce((rest, phrase) => rest.replace(phrase, " "), text);
  const note = (path: string, where: "key" | "value", text: string, words: readonly string[]) => {
    for (const word of wordsIn(strip(text), words)) {
      findings.push({ path, where, word, text: text.length > 120 ? `${text.slice(0, 120)}…` : text });
    }
  };
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      const prose = /\s/u.test(node.trim());
      note(path, "value", node, prose && options.dataProse ? storageOnly : every);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, field] of Object.entries(node)) {
      note(`${path}.${key}`, "key", key, every);
      walk(field, `${path}.${key}`);
    }
  };
  walk(value, "$");
  return findings;
}

/**
 * What a thrown tool failure is to the model that reads it: its message and
 * its structured detail, translated exactly as the harness translates them
 * (`modelFailure`). A test walks this to audit a refusal.
 */
export function failureAsModelReads(error: unknown): { error: string; data?: unknown } {
  const structured = readStructuredFailure(error);
  return modelFailure({
    error: error instanceof Error ? error.message : String(error),
    ...(structured ? { data: structured } : {}),
  });
}

/** One finding as a line a failing test prints. */
export const describeStorageName = (finding: StorageNameFinding): string =>
  `${finding.path}: ${finding.where} says "${finding.word}" (${finding.text})`;

interface AuditableTool {
  definition: { name: string };
  execute(input: never, context: never): Promise<{ output: unknown; contentParts?: unknown; pagination?: unknown }>;
}

/** Thrown by an audited tool whose result or failure names storage. */
export class StorageNameLeakError extends Error {
  constructor(readonly tool: string, readonly findings: StorageNameFinding[]) {
    super(`${tool} hands the model a storage name:\n${findings.map(describeStorageName).join("\n")}`);
    this.name = "StorageNameLeakError";
  }
}

/**
 * One tool call, audited: what it returns and what it throws are walked, and
 * a leak fails the call with `StorageNameLeakError`. A failure the tool
 * throws is audited as the model reads it and then rethrown unchanged.
 */
export async function auditedToolCall<Result extends { output: unknown; contentParts?: unknown }>(
  tool: string,
  call: () => Promise<Result>,
  options: StorageNameAuditOptions = {},
): Promise<Result> {
  let result: Result;
  try {
    result = await call();
  } catch (error) {
    const findings = storageNamesIn(failureAsModelReads(error), options);
    if (findings.length > 0) throw new StorageNameLeakError(tool, findings);
    throw error;
  }
  const findings = storageNamesIn({ output: result.output, contentParts: result.contentParts }, options);
  if (findings.length > 0) throw new StorageNameLeakError(tool, findings);
  return result;
}

/**
 * The same tools, each audited (`auditedToolCall`), so every test that
 * already executes a tool also proves its result names no storage.
 */
export function auditedTools<Tool extends AuditableTool>(tools: readonly Tool[], options: StorageNameAuditOptions = {}): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: (input: never, context: never) =>
      auditedToolCall(tool.definition.name, () => tool.execute(input, context), options),
  }));
}

/**
 * `auditedTools` without the copy: each tool's own `execute` is replaced.
 * For a surface whose host recognizes a tool by identity (a refusing tool is
 * known by the object it is), where a copy would stop being that tool. Only
 * for tools the caller has just built and shares with nothing else.
 */
export function auditToolsInPlace<Tool extends AuditableTool>(tools: readonly Tool[], options: StorageNameAuditOptions = {}): void {
  for (const tool of tools) {
    const execute = tool.execute.bind(tool);
    tool.execute = ((input: never, context: never) =>
      auditedToolCall(tool.definition.name, () => execute(input, context), options)) as Tool["execute"];
  }
}
