/**
 * WorkspaceDO migration 146 takes "whose events may start this Sidekick" out
 * of delegation and into `sidekick_sources`. Its backfill is what keeps every
 * Sidekick firing as it did: a person whose delegation admitted a rule's
 * events gets a source for exactly those events on that connection, and
 * nobody gets one who was not letting events in before. A backfill that
 * missed a row would stop a Sidekick silently; one that added a row would
 * start reading somebody's account.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 146;
const openDatabases: DatabaseSync[] = [];

function migratedTo(version: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version > version) break;
    for (const statement of migration.statements) database.exec(statement);
  }
  // The schema refuses a row for any Organization but its own.
  database.prepare(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
    VALUES (1, 'workspace', 'global', 'wnam', 0, 0)`).run();
  return database;
}

function upgrade(database: DatabaseSync): void {
  for (const statement of WORKSPACE_DO_SCHEMA_MIGRATIONS.find((migration) => migration.version === VERSION)!.statements) {
    database.exec(statement);
  }
}

afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

const evaluator = (connectionId: string, eventType: string) => ({
  evaluatorId: crypto.randomUUID(), source: { connectorType: "google", connectionId, eventType }, when: { kind: "always" },
});

function sidekick(database: DatabaseSync, id: string, evaluators: unknown[]): void {
  database.prepare(`INSERT INTO automation_directory
    (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope, title, description, projected_at, evaluator_projection_json)
    VALUES (?, 'workspace', 'adam', 1, 'hosted', 'active', 'personal', 'Deals', '', 1, ?)`).run(id, JSON.stringify(evaluators));
}

function connection(database: DatabaseSync, id: string, scope: "personal" | "workspace", owner: string | null): void {
  database.prepare(`INSERT INTO connector_connections
    (id, workspace_id, connector_type, scope, owner_user_id, display_name, created_at, updated_at, model_plugin_id)
    VALUES (?, 'workspace', 'google', ?, ?, 'Mail', 'now', 'now', ?)`).run(id, scope, owner, `plugin_${id}`);
}

function delegation(database: DatabaseSync, sidekickId: string, userId: string, allowed: boolean, incarnation: string | null): void {
  database.prepare("INSERT INTO sidekick_delegations (sidekick_id, user_id, grant_json) VALUES (?, ?, ?)").run(sidekickId, userId, JSON.stringify({
    sidekickId, userId, allowed, generation: 1, membershipIncarnation: incarnation, source: "self_service", actorUserId: userId,
    requestId: "r", label: "Deals", grantedAt: 1, updatedAt: 1,
  }));
}

function registration(database: DatabaseSync, sidekickId: string, connectionId: string, eventType: string, state: "active" | "removed"): void {
  database.prepare(`INSERT INTO workspace_external_event_registrations
    (registration_id, destination_key, workspace_id, effective_after_event_sequence, connection_id, connector_type, event_type,
     evaluator_json, destination_kind, automation_id, state, created_at, updated_at)
    VALUES (?, ?, 'workspace', 0, ?, 'google', ?, '{}', 'automation', ?, ?, 1, 1)`)
    .run(crypto.randomUUID(), crypto.randomUUID(), connectionId, eventType, sidekickId, state);
}

interface SourceRow {
  sidekick_id: string; user_id: string; connection_id: string; event_type: string; connector_type: string;
  condition: string | null; membership_incarnation: string; request_id: string | null;
}
const sources = (database: DatabaseSync): SourceRow[] => database.prepare(
  `SELECT sidekick_id, user_id, connection_id, event_type, connector_type, condition, membership_incarnation, request_id
     FROM sidekick_sources ORDER BY sidekick_id, user_id, connection_id, event_type`,
).all() as unknown as SourceRow[];

const attention = (database: DatabaseSync): Record<string, string | null> => Object.fromEntries((database.prepare(
  "SELECT automation_id, delegation_attention_code FROM automation_directory ORDER BY automation_id",
).all() as { automation_id: string; delegation_attention_code: string | null }[]).map((row) => [row.automation_id, row.delegation_attention_code]));

describe("WorkspaceDO migration 146: sources backfilled from delegation", () => {
  it("gives a delegate a source for each connection of theirs a rule is configured or registered on, and nobody else one", () => {
    const database = migratedTo(VERSION - 1);
    connection(database, "adam-mail", "personal", "adam");
    connection(database, "maya-drive", "personal", "maya");
    connection(database, "left-mail", "personal", "left");
    connection(database, "withdrawn-mail", "personal", "withdrawn");
    connection(database, "stranger-mail", "personal", "stranger");
    // Configured on Adam's own mailbox, for two event types.
    sidekick(database, "deals", [evaluator("adam-mail", "email.received"), evaluator("adam-mail", "email.updated")]);
    delegation(database, "deals", "adam", true, "adam-membership");
    // Maya is a delegate whose Drive a portable rule was expanded onto: registered, not configured.
    delegation(database, "deals", "maya", true, "maya-membership");
    registration(database, "deals", "maya-drive", "sheets.spreadsheet_changed", "active");
    // A registration already removed lets nothing in, and gives nothing.
    registration(database, "deals", "maya-drive", "docs.document_changed", "removed");
    // No membership incarnation, a withdrawn grant, and no grant at all: none was letting events in.
    delegation(database, "deals", "left", true, null);
    registration(database, "deals", "left-mail", "email.received", "active");
    delegation(database, "deals", "withdrawn", false, "withdrawn-membership");
    registration(database, "deals", "withdrawn-mail", "email.received", "active");
    registration(database, "deals", "stranger-mail", "email.received", "active");

    upgrade(database);

    // One source for each event type, none of them an answer to a request.
    const made = (user: string, connectionId: string, eventType: string) => ({ sidekick_id: "deals", user_id: user, connection_id: connectionId,
      event_type: eventType, connector_type: "google", condition: null, membership_incarnation: `${user}-membership`, request_id: null });
    expect(sources(database)).toEqual([
      made("adam", "adam-mail", "email.received"), made("adam", "adam-mail", "email.updated"),
      made("maya", "maya-drive", "sheets.spreadsheet_changed"),
    ]);
  });

  it("gives every delegate a source on an Organization connection a rule is configured on", () => {
    const database = migratedTo(VERSION - 1);
    connection(database, "shared", "workspace", null);
    sidekick(database, "alerts", [evaluator("shared", "email.received")]);
    delegation(database, "alerts", "adam", true, "adam-membership");
    delegation(database, "alerts", "maya", true, "maya-membership");
    delegation(database, "alerts", "withdrawn", false, "withdrawn-membership");

    upgrade(database);

    // An event there limited to an audience was admitted through a delegate
    // inside it; each delegate keeps letting in what they could see.
    expect(sources(database).map((row) => [row.user_id, row.connection_id, row.event_type])).toEqual([
      ["adam", "shared", "email.received"],
      ["maya", "shared", "email.received"],
    ]);
  });

  it("marks stopped every Sidekick with a trigger that nobody lends an account to, whatever it said before, and no other", () => {
    const database = migratedTo(VERSION - 1);
    connection(database, "shared", "workspace", null);
    const migrated = (id: string, code: string | null, enrolled = 1) => database.prepare(
      "UPDATE automation_directory SET delegation_migrated = ?, delegation_attention_code = ? WHERE automation_id = ?").run(enrolled, code, id);
    // Its last delegate withdrew: before this migration its events were refused under the other warning.
    sidekick(database, "withdrawn-from", [evaluator("shared", "email.received")]);
    delegation(database, "withdrawn-from", "adam", false, "adam-membership");
    migrated("withdrawn-from", "event_no_eligible_delegate");
    // Somebody lends it an account: it goes on as it did.
    sidekick(database, "lent", [evaluator("shared", "email.received")]);
    delegation(database, "lent", "adam", true, "adam-membership");
    migrated("lent", null);
    // Nothing starts it by itself, so there is nothing to stop.
    sidekick(database, "knowledge", []);
    migrated("knowledge", null);
    // Its creator is enrolled on first use, which has not happened yet.
    sidekick(database, "not-yet-enrolled", [evaluator("shared", "email.received")]);
    migrated("not-yet-enrolled", null, 0);

    upgrade(database);

    expect(attention(database)).toEqual({
      "knowledge": null, "lent": null, "not-yet-enrolled": null, "withdrawn-from": "no_eligible_delegate",
    });
  });
});
