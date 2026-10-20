import type { NormalizedActivity } from "@rally/contracts";

type People = NonNullable<NormalizedActivity["externalPeople"]>;

/**
 * Each person occupies its own row: 10,000 full references exceed SQLite's 2 MB
 * row limit (https://developers.cloudflare.com/durable-objects/platform/limits/,
 * checked 2026-10-19). The ordinal enforces the user-selected per-event limit.
 * New events leave the old JSON column empty; legacy events keep their bounded
 * JSON until replacement or normal event retention, avoiding a startup rewrite.
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
];

/** Called within the event's existing transaction. */
export function writeConnectorEventPeople(sql: SqlStorage, eventId: string, people: People): void {
  for (const [position, person] of people.entries()) {
    sql.exec("INSERT INTO workspace_connector_event_people (event_id, position, person_json) VALUES (?, ?, ?)",
      eventId, position, JSON.stringify(person));
  }
}

export function readConnectorEventPeople(sql: SqlStorage, eventId: string): People {
  const rows = sql.exec<{ person_json: string }>(
    "SELECT person_json FROM workspace_connector_event_people WHERE event_id = ? ORDER BY position", eventId,
  ).toArray();
  if (rows.length > 0) return rows.map((row) => JSON.parse(row.person_json) as People[number]);
  const legacy = sql.exec<{ external_people_json: string }>(
    "SELECT external_people_json FROM workspace_connector_events WHERE event_id = ?", eventId,
  ).toArray()[0];
  return legacy ? JSON.parse(legacy.external_people_json) as People : [];
}

export function copyConnectorEventPeople(sql: SqlStorage, sourceId: string, destinationId: string): void {
  writeConnectorEventPeople(sql, destinationId, readConnectorEventPeople(sql, sourceId));
}
