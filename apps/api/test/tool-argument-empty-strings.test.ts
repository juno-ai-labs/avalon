import { normalizeToolArguments, validateToolArguments } from "@rally/agent-harness";
import type { ToolDefinition } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { createTestConnectorRegistry, unconfiguredConnectorTypes } from "./helpers/connector-registry";
import { CURSOR_PARAMETERS, propertySchema, stringCursorSchema } from "./helpers/connector-cursors";

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

function connectorTools(): Array<{ connector: string; tool: ToolDefinition }> {
  const registry = createTestConnectorRegistry();
  expect(unconfiguredConnectorTypes(registry)).toEqual([]);
  return registry.list().flatMap((manifest) =>
    manifest.tools.map((tool) => ({ connector: manifest.type, tool })));
}


/**
 * What every cursor description has to say, whichever connector serves it.
 *
 * Both clauses are the fix rather than decoration. A caller with no cursor
 * needs a value it can legitimately send, and a caller with one needs to be
 * told the value is copied rather than composed; the run that produced this
 * rule had a description in front of it four times and still invented a token
 * on all eight attempts, because the prose said "omit" while `minLength: 1`
 * said "at least one character".
 *
 * Matched case-insensitively, and on the shortest phrase that carries the
 * meaning, because the wording gets edited for tone and an assertion pinned to
 * a whole sentence fails a rewrite that kept every instruction.
 */
const CURSOR_CONTRACT = [
  {
    label: "`null` as the value to send when there is no cursor",
    says: (text: string) => text.includes("`null`"),
  },
  {
    label: "that the cursor is never constructed",
    says: (text: string) => text.toLowerCase().includes("never construct"),
  },
] as const;

/**
 * The result field each connector's cursor description names as its source.
 *
 * Every connector serving a cursor needs an entry, so a new one is a decision
 * somebody makes rather than a gap the sweep steps over. `null` is available
 * for a connector whose producing field genuinely cannot be named, and nothing
 * uses it: the one candidate was Granola, whose shape turned out to be pinned
 * by its own adapter tests.
 */
const CURSOR_SOURCE_FIELD: Record<string, string | null> = {
  google: "nextPageToken",
  linear: "pageInfo.endCursor",
  notion: "next_cursor",
  slack: "next_cursor",
  x: "next_cursor",
  granola: "cursor",
};

describe("blanked tool arguments", () => {
  it("leaves no connector paginating on a cursor its schema says may be empty", () => {
    const permissive = connectorTools().flatMap(({ connector, tool }) =>
      [...CURSOR_PARAMETERS]
        .map((name) => ({ name, schema: stringCursorSchema(tool, name) }))
        .filter(({ schema }) => schema !== null && typeof schema.minLength !== "number")
        .map(({ name }) => `${connector}.${tool.name}.${name}`));

    expect(permissive).toEqual([]);
  });

  it("leaves no connector paginating on a cursor whose description drops the contract", () => {
    // Declaring `minLength: 1` moved a model off `""` and onto an invented
    // token (`"/"`, `"1"`, `"next"` on Google's `pageToken`), which no
    // normalizer can recognize as the omission it meant. A cursor is opaque, so
    // the only thing that stops the invention is the schema saying what to send
    // when there is none and which field produced the value when there is.
    //
    // Asserted on the text rather than on the presence of a description,
    // because both instructions are load-bearing and either could be edited
    // away under a `description` that is still a string. A blank one fails here
    // too: it carries neither fragment.
    //
    // Read off the property rather than the string branch `stringCursorSchema`
    // returns: under the `anyOf` spelling the description sits on the property
    // and the constraints sit on the branch, and a check against the branch
    // would report every converted cursor as undescribed.
    const failures = connectorTools().flatMap(({ connector, tool }) =>
      [...CURSOR_PARAMETERS]
        .filter((name) => stringCursorSchema(tool, name) !== null)
        .flatMap((name) => {
          const where = `${connector}.${tool.name}.${name}`;
          const description = propertySchema(tool, name)?.description;
          if (typeof description !== "string") return [`${where}: no description`];
          if (!Object.hasOwn(CURSOR_SOURCE_FIELD, connector)) {
            return [`${where}: connector missing from CURSOR_SOURCE_FIELD`];
          }
          const source = CURSOR_SOURCE_FIELD[connector];
          return [
            ...CURSOR_CONTRACT
              .filter((clause) => !clause.says(description))
              .map((clause) => `${where}: does not state ${clause.label}`),
            ...(source !== null && !description.includes(`\`${source}\``)
              ? [`${where}: does not name \`${source}\` as the producing field`]
              : []),
          ];
        }));

    expect(failures).toEqual([]);
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
