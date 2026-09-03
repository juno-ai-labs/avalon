import { normalizeToolArguments, validateToolArguments } from "@rally/agent-harness";
import type { ToolDefinition } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { createTestConnectorRegistry, unconfiguredConnectorTypes } from "./helpers/connector-registry";

/**
 * A small model blanks an optional parameter it has nothing to put in rather
 * than omitting it, and a blanked pagination cursor is the case that reached
 * production: `after: ""` passed Linear's declared schema, went out as the
 * GraphQL cursor, and came back as a bare "Argument Validation Error" naming no
 * field. The model retried the same arguments five times and gave up without
 * creating the issue it was asked for.
 *
 * The repair is two halves that only work together, so they are tested
 * together here rather than in either package alone: a connector's schema
 * declares that its cursors and ids cannot be empty, and the harness drops a
 * blanked optional field whose schema says exactly that. Neither half is
 * allowed to become a silent drop of a value a tool would have accepted, which
 * is the second half of what these tests hold.
 */

/**
 * Every parameter name a connector paginates with. A cursor is opaque to the
 * model, so it is the parameter most often blanked and the one where an empty
 * value can never mean anything.
 *
 * `after` is also Slack's name for two numeric filters, so the walk below
 * matches on the declared type as well: a cursor is a string.
 */
const CURSOR_PARAMETERS = new Set(["after", "cursor", "startCursor", "pageToken"]);

function stringCursorSchema(tool: ToolDefinition, name: string): Record<string, unknown> | null {
  if (!CURSOR_PARAMETERS.has(name)) return null;
  const schema = propertySchema(tool, name);
  if (!schema) return null;
  // A cursor declared as `anyOf: [{string, minLength: 1}, {null}]` — the shape
  // that lets a caller spell "no cursor" as a value rather than an omission —
  // carries its `minLength` on the string branch, not at the top. Reading only
  // the top level does not fail here, it stops matching: the tool drops out of
  // the sweep and the guard passes without checking anything. Descending keeps
  // the union form covered by the rule the flat form has always been under.
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [schema];
  for (const branch of branches) {
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
    const candidate = branch as Record<string, unknown>;
    const types = Array.isArray(candidate.type) ? candidate.type : [candidate.type];
    if (types.includes("string")) return candidate;
  }
  return null;
}

function connectorTools(): Array<{ connector: string; tool: ToolDefinition }> {
  const registry = createTestConnectorRegistry();
  expect(unconfiguredConnectorTypes(registry)).toEqual([]);
  return registry.list().flatMap((manifest) =>
    manifest.tools.map((tool) => ({ connector: manifest.type, tool })));
}

function propertySchema(tool: ToolDefinition, name: string): Record<string, unknown> | null {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
  const declared = properties?.[name];
  return declared && typeof declared === "object" && !Array.isArray(declared)
    ? declared as Record<string, unknown>
    : null;
}

describe("blanked tool arguments", () => {
  it("leaves no connector paginating on a cursor its schema says may be empty", () => {
    const permissive = connectorTools().flatMap(({ connector, tool }) =>
      [...CURSOR_PARAMETERS]
        .map((name) => ({ name, schema: stringCursorSchema(tool, name) }))
        .filter(({ schema }) => schema !== null && typeof schema.minLength !== "number")
        .map(({ name }) => `${connector}.${tool.name}.${name}`));

    expect(permissive).toEqual([]);
  });

  it("drops a blanked cursor from every connector tool that takes one", () => {
    const surviving = connectorTools().flatMap(({ connector, tool }) =>
      [...CURSOR_PARAMETERS]
        .filter((name) => stringCursorSchema(tool, name) !== null)
        .filter((name) => {
          const schema = tool.inputSchema as Record<string, unknown>;
          const normalized = normalizeToolArguments({ [name]: "" }, schema, tool.mode) as Record<string, unknown>;
          return Object.prototype.hasOwnProperty.call(normalized, name);
        })
        .map((name) => `${connector}.${tool.name}.${name}`));

    expect(surviving).toEqual([]);
  });

  it("turns the call that failed in production into the one the model meant", () => {
    const listTeams = connectorTools()
      .find(({ connector, tool }) => connector === "linear" && tool.name === "list_teams")?.tool;
    if (!listTeams) throw new Error("expected the Linear connector to expose list_teams");
    const schema = listTeams.inputSchema as Record<string, unknown>;

    const normalized = normalizeToolArguments({ first: 50, after: "" }, schema, listTeams.mode);
    expect(normalized).toEqual({ first: 50 });
    expect(validateToolArguments(normalized, schema)).toBeNull();
  });

  it("reads a blanked optional filter as the omission its own description invites", () => {
    // `drive.search` tells the model to omit `query` to browse by file type
    // alone. Blanking it is how a model says that, and it used to be the one
    // spelling the tool refused.
    const driveSearch = connectorTools()
      .find(({ connector, tool }) => connector === "google" && tool.name === "drive.search")?.tool;
    if (!driveSearch) throw new Error("expected the Google connector to expose drive.search");
    const schema = driveSearch.inputSchema as Record<string, unknown>;

    const normalized = normalizeToolArguments({ query: "", fileType: "spreadsheet" }, schema, driveSearch.mode);
    expect(normalized).toEqual({ fileType: "spreadsheet" });
    expect(validateToolArguments(normalized, schema)).toBeNull();
  });

  it("keeps a remote server's required blank, however its schema says required", () => {
    // A hosted MCP server authors its own schemas and Rally forwards the call
    // without a local parse, so a required argument dropped here would reach a
    // write tool as an omission rather than as the error it is. `required` and
    // `properties` are routinely on different nodes in a generated schema.
    const registry = createTestConnectorRegistry();
    const adapter = registry.get("notion");
    const capability = adapter.dynamicAgentTools?.capabilities[0];
    if (!capability) throw new Error("expected Notion to declare a dynamic capability");

    const [remote] = __integrationTesting.validateDynamicConnectorTools(
      createTestEnv({}),
      adapter,
      "personal",
      [capability],
      "notion",
      [{
        name: "archive_record",
        description: "A write tool served by a third-party MCP server.",
        capability,
        mode: "write",
        idempotency: "record_before_execute",
        inputSchema: {
          type: "object",
          properties: { recordId: { type: "string", minLength: 1 } },
          allOf: [{ required: ["recordId"] }],
        },
      }],
    );
    if (!remote) throw new Error("expected the remote tool to survive validation");

    expect(normalizeToolArguments({ recordId: "" }, remote.inputSchema as Record<string, unknown>, remote.mode))
      .toEqual({ recordId: "" });
  });

  it("leaves a write's blanked field to the executor, which can name it", () => {
    // `assigneeId: null` clears an assignee and omitting it leaves the assignee
    // alone, so a dropped blank here would report a partial update as a
    // complete one. The declared schema still says `""` is not an assignee, so
    // the executor rejects the call and names the field.
    const updateIssue = connectorTools()
      .find(({ connector, tool }) => connector === "linear" && tool.name === "update_issue")?.tool;
    if (!updateIssue) throw new Error("expected the Linear connector to expose update_issue");
    const schema = updateIssue.inputSchema as Record<string, unknown>;
    const asked = { issueId: "issue-1", priority: 3, assigneeId: "" };

    expect(updateIssue.mode).toBe("write");
    expect(normalizeToolArguments(asked, schema, updateIssue.mode)).toEqual(asked);
    expect(validateToolArguments(asked, schema)).not.toBeNull();
  });

  it("keeps an empty string that asks a tool for something", () => {
    const tools = connectorTools();
    const updateIssue = tools
      .find(({ connector, tool }) => connector === "linear" && tool.name === "update_issue")?.tool;
    const contentsList = tools
      .find(({ connector, tool }) => connector === "github" && tool.name === "contents.list")?.tool;
    if (!updateIssue || !contentsList) throw new Error("expected Linear update_issue and GitHub contents.list");

    // Clearing an issue description.
    expect(normalizeToolArguments(
      { issueId: "issue-1", description: "" },
      updateIssue.inputSchema as Record<string, unknown>,
      updateIssue.mode,
    )).toEqual({ issueId: "issue-1", description: "" });

    // Listing a repository's root directory.
    expect(normalizeToolArguments(
      { repositoryId: "repo-1", path: "" },
      contentsList.inputSchema as Record<string, unknown>,
      contentsList.mode,
    )).toEqual({ repositoryId: "repo-1", path: "" });
  });
});
