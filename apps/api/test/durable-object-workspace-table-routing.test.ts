import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { WORKSPACE_LOCAL_TABLES } from "../src/services/workspace-runtime-database";

/**
 * No Durable Object may name a WorkspaceDO table on its own regional binding.
 *
 * A service is constructed with `withWorkspaceRuntimeDatabase(env, workspaceId)`
 * and its `DB` is the router. A Durable Object is handed the raw environment and
 * nothing wraps it, so `this.env.DB` there is regional D1 — which, since
 * migration 0090 retired the product tables, does not have them. The statement
 * then fails as `no such table`, which is not one of an object's snake_case
 * codes, so it is never mapped and reaches the caller as `500 internal_error`
 * with the table name discarded before it reaches a log line.
 *
 * That failure has now been paid for three times: `slackUserIsLinked` joining
 * `workspace_members`, the origin-label read of `automation_directory`, and
 * the automation object resolving a delivery destination. Each was found by a
 * person hitting it in production. The invariant is mechanical, so it is checked here
 * rather than restated in another document.
 *
 * This imports the real `WORKSPACE_LOCAL_TABLES` rather than restating it. An
 * ESLint rule would be the other home, but rules are `.mjs` and would have to
 * carry their own copy of the list — which drifts exactly when a table is added,
 * the moment the guard matters most.
 */

const DURABLE_OBJECT_DIRECTORY = `${process.cwd()}/src/durable-objects`;

/** `this.env.DB.prepare(`…`)` and its `exec`/`batch` siblings, with the SQL. */
const REGIONAL_STATEMENT = /this\.env\.DB\s*\.\s*(?:prepare|exec|batch)\s*\(\s*`([^`]*)`/gsu;

function durableObjectSources(): string[] {
  return readdirSync(DURABLE_OBJECT_DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();
}

function misroutedTables(sql: string): string[] {
  return WORKSPACE_LOCAL_TABLES
    .filter((table) => new RegExp(`\\b${table}\\b`, "iu").test(sql))
    .sort();
}

describe("Durable Object workspace-table routing", () => {
  it.each(durableObjectSources())(
    "%s sends no workspace-local table to the regional binding",
    (fileName) => {
      const source = readFileSync(`${DURABLE_OBJECT_DIRECTORY}/${fileName}`, "utf8");
      const offenders = [...source.matchAll(REGIONAL_STATEMENT)].flatMap((match) => {
        const tables = misroutedTables(match[1] ?? "");
        // The line number, so a failure names the statement rather than the file.
        const line = source.slice(0, match.index).split("\n").length;
        return tables.length === 0 ? [] : [`${fileName}:${line} names ${tables.join(", ")}`];
      });
      expect(offenders).toEqual([]);
    },
  );

  it("is looking at the objects that exist", () => {
    // Guards the guard: a rename of the directory, or a regex that stops
    // matching, would otherwise leave this file passing over nothing at all.
    const sources = durableObjectSources();
    expect(sources).toContain("automation-do.ts");
    expect(sources).toContain("workspace-do.ts");
    expect(WORKSPACE_LOCAL_TABLES).toContain("connector_connections");
    expect(WORKSPACE_LOCAL_TABLES).toContain("slack_user_links");
    expect(
      [...readFileSync(`${DURABLE_OBJECT_DIRECTORY}/automation-do.ts`, "utf8")
        .matchAll(REGIONAL_STATEMENT)],
    ).not.toHaveLength(0);
  });
});
