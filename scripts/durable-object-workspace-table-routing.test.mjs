import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import { durableObjectWorkspaceTableRoutingRule } from "./eslint-rules/durable-object-workspace-table-routing.mjs";

const config = {
  languageOptions: {
    ecmaVersion: 2024,
    parser: tseslint.parser,
    parserOptions: { sourceType: "module" },
  },
  plugins: { rally: { rules: { "durable-object-workspace-table-routing": durableObjectWorkspaceTableRoutingRule } } },
  rules: { "rally/durable-object-workspace-table-routing": "error" },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

function misroutedTables(source) {
  return lint(source).map((message) => /`([a-z_]+)` lives in WorkspaceDO/u.exec(message.message)?.[1] ?? message.message);
}

test("rejects the three shipped incidents", () => {
  // slackUserIsLinked joined the Slack link table from a Durable Object.
  assert.deepEqual(misroutedTables(`
    const linked = await this.env.DB.prepare(
      \`SELECT 1 FROM slack_user_links link
         JOIN workspace_members member ON member.user_id = link.user_id
        WHERE link.workspace_id = ? AND link.slack_user_id = ?\`,
    ).bind(workspaceId, slackUserId).first();
  `), ["slack_user_links"]);
  // The work stream summary's origin-label read.
  assert.deepEqual(misroutedTables(
    "await this.env.DB.prepare(`SELECT title FROM automation_directory WHERE automation_id = ?`).bind(id).first()",
  ), ["automation_directory"]);
  // The automation object resolving a delivery destination.
  assert.deepEqual(misroutedTables(`
    const connection = await this.env.DB.prepare(
      "SELECT id, provider FROM connector_connections WHERE workspace_id = ? AND id = ?",
    ).bind(workspaceId, connectionId).first();
  `), ["connector_connections"]);
});

test("reads tables spread into the list from their own module", () => {
  assert.deepEqual(misroutedTables("this.env.DB.prepare(`DELETE FROM authorization_delivery WHERE job_key = ?`)"),
    ["authorization_delivery"]);
});

test("reads interpolated templates, concatenations, exec, and wrapped bindings", () => {
  assert.deepEqual(misroutedTables("this.env.DB.prepare(`SELECT * FROM resources WHERE id IN (${ids})`)"), ["resources"]);
  assert.deepEqual(misroutedTables(`this.env.DB.prepare("SELECT * FROM " + "memory_facts" + " WHERE id = ?")`), ["memory_facts"]);
  assert.deepEqual(misroutedTables("this.env.DB.exec(`DELETE FROM schedules`)"), ["schedules"]);
  assert.deepEqual(misroutedTables("this.env!.DB?.prepare(`SELECT 1 FROM Slack_User_Links`)"), ["slack_user_links"]);
  assert.deepEqual(misroutedTables("this.env.DB.batch([this.env.DB.prepare(`DELETE FROM digest_schedules`)])"),
    ["digest_schedules"]);
});

test("matches table names as whole identifiers, not substrings", () => {
  // `sandbox_imported_resources` is a regional table whose name contains
  // the workspace-local `resources`.
  assert.deepEqual(lint("this.env.DB.prepare(`SELECT id FROM sandbox_imported_resources WHERE workspace_id = ?`)"), []);
  assert.deepEqual(lint("this.env.DB.prepare(`SELECT id FROM slack_user_links_archive`)"), []);
});

test("allows regional tables on the regional binding", () => {
  assert.deepEqual(lint(`
    await this.env.DB.prepare(\`SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active'\`).bind(id).all();
    await this.env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first();
  `), []);
});

test("allows workspace-local tables through the object that owns them", () => {
  assert.deepEqual(lint(`
    this.state.storage.sql.exec("SELECT slack_user_id FROM slack_user_links WHERE user_id = ?", userId);
    await withWorkspaceRuntimeDatabase(this.env, workspaceId).DB.prepare(\`SELECT id FROM connector_connections\`).all();
    await this.workspaceDatabase(workspaceId).prepare(\`SELECT title FROM automation_directory\`).first();
  `), []);
});
