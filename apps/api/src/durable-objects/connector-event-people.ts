import type { NormalizedActivity } from "@rally/contracts";

type People = NonNullable<NormalizedActivity["externalPeople"]>;

/**
 * Each person occupies its own row: 10,000 full references exceed SQLite's 2 MB
 * row limit (https://developers.cloudflare.com/durable-objects/platform/limits/,
 * checked 2026-10-19). The ordinal enforces the user-selected per-event limit.
 * The old JSON column remains empty for compatibility with historical schemas.
 * Freeze the v122 limit here: a future policy change needs an appended migration,
 * not a shared constant that would change this applied migration's hash.
 */
export const CONNECTOR_EVENT_PEOPLE_MIGRATION = [
  `CREATE TABLE workspace_connector_event_people (
    event_id TEXT NOT NULL REFERENCES workspace_connector_events(event_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0 AND position < 10000),
    person_json TEXT NOT NULL CHECK (json_valid(person_json) AND json_type(person_json) = 'object'),
    PRIMARY KEY (event_id, position)
  ) STRICT`,
  `INSERT INTO workspace_connector_event_people (event_id, position, person_json)
   SELECT event.event_id, CAST(person.key AS INTEGER), person.value
     FROM workspace_connector_events event, json_each(event.external_people_json) person`,
  `UPDATE workspace_connector_events SET external_people_json = '[]'`,
];

/** Called within the event's existing transaction. */
export function writeConnectorEventPeople(sql: SqlStorage, eventId: string, people: People): void {
  for (const [position, person] of people.entries()) {
    sql.exec("INSERT INTO workspace_connector_event_people (event_id, position, person_json) VALUES (?, ?, ?)",
      eventId, position, JSON.stringify(person));
  }
}

export function readConnectorEventPeople(sql: SqlStorage, eventId: string): People {
  return sql.exec<{ person_json: string }>(
    "SELECT person_json FROM workspace_connector_event_people WHERE event_id = ? ORDER BY position", eventId,
  ).toArray().map((row) => JSON.parse(row.person_json) as People[number]);
}

export function copyConnectorEventPeople(sql: SqlStorage, sourceId: string, destinationId: string): void {
  sql.exec(`INSERT INTO workspace_connector_event_people (event_id, position, person_json)
    SELECT ?, position, person_json FROM workspace_connector_event_people WHERE event_id = ?`, destinationId, sourceId);
}
