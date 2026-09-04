import type { ToolDefinition } from "@rally/contracts";
import { createTestConnectorRegistry } from "./connector-registry";

/**
 * The one reader of a connector cursor declaration, and the one list of the
 * names they go by.
 *
 * Two suites guard the cursor contract from opposite sides:
 * `tool-argument-empty-strings.test.ts` asks whether the declaration forbids a
 * blank and says where its value comes from, and
 * `tool-schema-sanitization.test.ts` asks whether its `null` branch is authored
 * and survives the sanitizer. Both have to agree on which properties are
 * cursors and on how to read one, and they used to do that by keeping two
 * copies in step by hand. They diverged on the first edit that touched only
 * one: the sanitization copy answered "not a cursor" for a shape it could not
 * read, which is the silent uncovering the other copy was written to throw on.
 * One reader cannot diverge from itself.
 */
export const CURSOR_PARAMETERS = ["after", "cursor", "startCursor", "pageToken"] as const;

const MAX_BRANCH_DEPTH = 4;

/**
 * The branch of a declaration that states `type`, however the declaration is
 * spelled.
 *
 * Three outcomes, and the middle one is the point. A declaration that states a
 * type and it is not the one asked for is not that kind of declaration at all —
 * Slack's `read_message_context.after` is a count, not a cursor — so it is
 * `null`, skipped, correct. A declaration this cannot read is `"unreadable"`,
 * which every caller here throws on: a cursor silently dropped from a sweep
 * leaves its tool uncovered and the suite green, which is what happened when
 * Google's cursors moved to `anyOf`, and it is worse than a sweep that stops.
 */
function typedBranch(
  schema: Record<string, unknown>,
  type: "string" | "null",
  depth: number,
): Record<string, unknown> | null | "unreadable" {
  if (depth > MAX_BRANCH_DEPTH) return "unreadable";
  const declared = (Array.isArray(schema.type) ? schema.type : [schema.type])
    .filter((value): value is string => typeof value === "string");
  if (declared.includes(type)) return schema;
  if (declared.length > 0) return null;

  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (!branches?.length) return "unreadable";
  let sawUnreadable = false;
  for (const branch of branches) {
    // A branch that is not a schema object is not a branch this can rule on,
    // and skipping it quietly is the same silent pass the throw exists to stop.
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
      sawUnreadable = true;
      continue;
    }
    const nested = typedBranch(branch as Record<string, unknown>, type, depth + 1);
    if (nested === "unreadable") sawUnreadable = true;
    else if (nested !== null) return nested;
  }
  return sawUnreadable ? "unreadable" : null;
}

/** One property declaration off a tool's input schema, or nothing. */
export function propertySchema(tool: ToolDefinition, name: string): Record<string, unknown> | null {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
  const declared = properties?.[name];
  return declared && typeof declared === "object" && !Array.isArray(declared)
    ? declared as Record<string, unknown>
    : null;
}

function readBranch(
  tool: ToolDefinition,
  name: string,
  type: "string" | "null",
): Record<string, unknown> | null {
  const schema = propertySchema(tool, name);
  if (!schema) return null;
  const found = typedBranch(schema, type, 0);
  if (found === "unreadable") {
    throw new Error(
      `Unrecognized ${type} branch shape for ${tool.name}.${name}: ${JSON.stringify(schema)}`,
    );
  }
  return found;
}

/**
 * The string branch of a cursor declaration, or `null` when the property is not
 * a string cursor. Matching on the declared type as well as the name is what
 * keeps Slack's two numeric `search_messages.after` filters out of both sweeps.
 */
export function stringCursorSchema(tool: ToolDefinition, name: string): Record<string, unknown> | null {
  if (!CURSOR_PARAMETERS.includes(name as typeof CURSOR_PARAMETERS[number])) return null;
  return readBranch(tool, name, "string");
}

/** Whether a cursor declaration authors a `null` alternative at all. */
export function authorsNullBranch(tool: ToolDefinition, name: string): boolean {
  return readBranch(tool, name, "null") !== null;
}

/** Every registered connector tool that takes a pagination cursor, with the cursor's name. */
export function everyConnectorCursor(): Array<{ connector: string; tool: ToolDefinition; cursor: string }> {
  return createTestConnectorRegistry().list().flatMap((manifest) =>
    manifest.tools.flatMap((tool) =>
      CURSOR_PARAMETERS
        .filter((cursor) => stringCursorSchema(tool, cursor) !== null)
        .map((cursor) => ({ connector: manifest.type, tool, cursor }))));
}
