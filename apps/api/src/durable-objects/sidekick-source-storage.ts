import {
  SIDEKICK_SOURCE_ERRORS,
  SidekickSourceRequestSchema,
  SidekickSourceSchema,
  type SidekickSource,
  type SidekickSourceErrorCode,
  type SidekickSourceRequest,
} from "@rally/contracts";
import { ApiError } from "../lib/api-error";

/**
 * WorkspaceDO migration 145: Sidekick sources and the requests that ask for one.
 *
 * A source is one person's permission for events they can see on one
 * connection to start one Sidekick: their own connection, or an Organization
 * connection whose events are limited to an audience they are in. Until this migration that
 * permission was the person's delegation grant, which also lent their
 * accounts to every tool call; the two are now separate records, and nothing
 * about a trigger reads `sidekick_delegations`.
 *
 * The backfill keeps every Sidekick firing as it did. A person whose
 * connection a Sidekick is configured on, or is registered on now, gets a
 * source for that connection and those event types when they hold an allowed
 * delegation grant; so does every allowed delegate for an Organization
 * connection the Sidekick is configured on, because an event there with a
 * restricted audience was admitted through a delegate inside that audience. Their grant's membership incarnation carries over, so a person who
 * left and rejoined is no more a source than they were a delegate.
 *
 * A request's `person_name` is the asked person's name as it stood when they
 * answered, so the asker's Activity row names them without a read of D1; null
 * until they answer, and for a request a newer one cancelled.
 *
 * `docs/sidekick-sources.md` owns the mechanism.
 */
export const SIDEKICK_SOURCE_SCHEMA_STATEMENTS = [
  `CREATE TABLE sidekick_sources (
    sidekick_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    connector_type TEXT NOT NULL,
    event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
    condition TEXT CHECK (condition IS NULL OR length(condition) > 0),
    membership_incarnation TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('own_definition', 'request', 'migration')),
    request_id TEXT,
    approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (sidekick_id, user_id, connection_id)
  ) STRICT`,
  `CREATE INDEX sidekick_sources_by_user ON sidekick_sources(user_id, sidekick_id)`,
  `CREATE TABLE sidekick_source_requests (
    request_id TEXT PRIMARY KEY,
    sidekick_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    connector_type TEXT NOT NULL,
    event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
    condition TEXT CHECK (condition IS NULL OR length(condition) > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'declined', 'cancelled')),
    requested_by_user_id TEXT NOT NULL,
    requested_by_name TEXT NOT NULL,
    person_name TEXT,
    place_parent_kind TEXT CHECK (place_parent_kind IS NULL OR place_parent_kind IN ('canvas', 'automation')),
    place_parent_id TEXT,
    operation_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= 0),
    CHECK ((place_parent_kind IS NULL) = (place_parent_id IS NULL))
  ) STRICT`,
  // One open ask per person, Sidekick and connector: asking again replaces it.
  `CREATE UNIQUE INDEX sidekick_source_requests_pending ON sidekick_source_requests(sidekick_id, user_id, connector_type)
     WHERE state = 'pending'`,
  `CREATE INDEX sidekick_source_requests_by_sidekick ON sidekick_source_requests(sidekick_id, created_at)`,
  `CREATE INDEX sidekick_source_requests_by_place ON sidekick_source_requests(place_parent_kind, place_parent_id)
     WHERE place_parent_id IS NOT NULL`,
  // A retried ask finds what it already asked by its operation.
  `CREATE INDEX sidekick_source_requests_by_operation ON sidekick_source_requests(sidekick_id, operation_id)
     WHERE operation_id IS NOT NULL`,
  `INSERT INTO sidekick_sources
     (sidekick_id, user_id, connection_id, connector_type, event_types_json, condition, membership_incarnation,
      origin, request_id, approved_at, updated_at)
   SELECT watched.sidekick_id, watched.user_id, watched.connection_id, watched.connector_type,
          json_group_array(DISTINCT watched.event_type), NULL,
          json_extract(delegation.grant_json, '$.membershipIncarnation'), 'migration', NULL,
          unixepoch() * 1000, unixepoch() * 1000
     FROM (
       SELECT directory.automation_id AS sidekick_id, connection.owner_user_id AS user_id, connection.id AS connection_id,
              connection.connector_type AS connector_type, json_extract(evaluator.value, '$.source.eventType') AS event_type
         FROM automation_directory directory, json_each(directory.evaluator_projection_json) evaluator
         JOIN connector_connections connection ON connection.id = json_extract(evaluator.value, '$.source.connectionId')
        WHERE directory.evaluator_projection_json IS NOT NULL AND connection.scope = 'personal' AND connection.owner_user_id IS NOT NULL
       UNION
       SELECT registration.automation_id, connection.owner_user_id, connection.id, connection.connector_type, registration.event_type
         FROM workspace_external_event_registrations registration
         JOIN connector_connections connection ON connection.id = registration.connection_id
        WHERE registration.destination_kind = 'automation' AND registration.state = 'active'
          AND connection.scope = 'personal' AND connection.owner_user_id IS NOT NULL
       UNION
       SELECT directory.automation_id, granted.user_id, connection.id, connection.connector_type,
              json_extract(evaluator.value, '$.source.eventType')
         FROM automation_directory directory, json_each(directory.evaluator_projection_json) evaluator
         JOIN connector_connections connection ON connection.id = json_extract(evaluator.value, '$.source.connectionId')
         JOIN sidekick_delegations granted ON granted.sidekick_id = directory.automation_id
        WHERE directory.evaluator_projection_json IS NOT NULL AND connection.scope = 'workspace'
     ) watched
     JOIN sidekick_delegations delegation
       ON delegation.sidekick_id = watched.sidekick_id AND delegation.user_id = watched.user_id
    WHERE json_extract(delegation.grant_json, '$.allowed') = 1
      AND json_extract(delegation.grant_json, '$.membershipIncarnation') IS NOT NULL
      AND watched.event_type IS NOT NULL
    GROUP BY watched.sidekick_id, watched.user_id, watched.connection_id`,
] as const;

export interface SidekickSourceWrite {
  sidekickId: string;
  userId: string;
  connectionId: string;
  connectorType: string;
  eventTypes: readonly string[];
  condition: string | null;
  membershipIncarnation: string;
  origin: SidekickSource["origin"];
  requestId: string | null;
}

export interface SidekickSourceRequestWrite {
  requestId: string;
  sidekickId: string;
  userId: string;
  connectorType: string;
  eventTypes: readonly string[];
  condition: string | null;
  requestedByUserId: string;
  requestedByName: string;
  place: { parentKind: "canvas" | "automation"; parentId: string } | null;
  operationId: string | null;
}

type SourceRow = {
  sidekick_id: string; user_id: string; connection_id: string; connector_type: string; event_types_json: string;
  condition: string | null; membership_incarnation: string; origin: string; request_id: string | null; approved_at: number; updated_at: number;
};
type RequestRow = {
  request_id: string; sidekick_id: string; user_id: string; connector_type: string; event_types_json: string;
  condition: string | null; state: string; requested_by_user_id: string; requested_by_name: string;
  place_parent_kind: string | null; place_parent_id: string | null; created_at: number; decided_at: number | null;
};

const SOURCE_COLUMNS = `sidekick_id, user_id, connection_id, connector_type, event_types_json, condition, membership_incarnation,
  origin, request_id, approved_at, updated_at`;
const REQUEST_COLUMNS = `request_id, sidekick_id, user_id, connector_type, event_types_json, condition, state,
  requested_by_user_id, requested_by_name, place_parent_kind, place_parent_id, created_at, decided_at`;
const REQUEST_INSERT_COLUMNS = `${REQUEST_COLUMNS}, operation_id`;

function source(row: SourceRow): SidekickSource {
  return SidekickSourceSchema.parse({
    sidekickId: row.sidekick_id, userId: row.user_id, connectionId: row.connection_id, connectorType: row.connector_type,
    eventTypes: JSON.parse(row.event_types_json), condition: row.condition,
    membershipIncarnation: row.membership_incarnation, origin: row.origin, requestId: row.request_id,
    approvedAt: row.approved_at, updatedAt: row.updated_at,
  });
}

function request(row: RequestRow): SidekickSourceRequest {
  return SidekickSourceRequestSchema.parse({
    requestId: row.request_id, sidekickId: row.sidekick_id, userId: row.user_id, connectorType: row.connector_type,
    eventTypes: JSON.parse(row.event_types_json), condition: row.condition, state: row.state,
    requestedByUserId: row.requested_by_user_id, requestedByName: row.requested_by_name,
    place: row.place_parent_kind && row.place_parent_id
      ? { parentKind: row.place_parent_kind, parentId: row.place_parent_id } : null,
    createdAt: row.created_at, decidedAt: row.decided_at,
  });
}

export function sidekickSourceError(code: SidekickSourceErrorCode): ApiError {
  const status = code === "sidekick_source_request_not_found" ? 404
    : code === "sidekick_source_request_not_yours" || code === "sidekick_source_request_requires_manager" ? 403 : 409;
  return new ApiError(status, code, SIDEKICK_SOURCE_ERRORS[code]);
}

/**
 * Sources and their requests, in the Organization object that owns the
 * Sidekick. No awaits: each write is one statement or one caller transaction.
 * Who may write is the caller's to decide; this holds only the rows.
 */
export class SidekickSourceStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  forSidekick(sidekickId: string): SidekickSource[] {
    return this.storage.sql.exec<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM sidekick_sources WHERE sidekick_id = ? ORDER BY approved_at, user_id, connection_id`,
      sidekickId,
    ).toArray().map(source);
  }

  read(sidekickId: string, userId: string, connectionId: string): SidekickSource | null {
    const row = this.storage.sql.exec<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM sidekick_sources WHERE sidekick_id = ? AND user_id = ? AND connection_id = ?`,
      sidekickId, userId, connectionId,
    ).toArray()[0];
    return row ? source(row) : null;
  }

  /** Replace what one person lets in from one connection. The caller holds their consent. */
  put(write: SidekickSourceWrite, now: number): SidekickSource {
    const eventTypes = [...new Set(write.eventTypes)].sort();
    return source(this.storage.sql.exec<SourceRow>(
      `INSERT INTO sidekick_sources (${SOURCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sidekick_id, user_id, connection_id) DO UPDATE SET
         event_types_json = excluded.event_types_json, condition = excluded.condition,
         membership_incarnation = excluded.membership_incarnation, origin = excluded.origin,
         request_id = excluded.request_id, updated_at = excluded.updated_at
       RETURNING ${SOURCE_COLUMNS}`,
      write.sidekickId, write.userId, write.connectionId, write.connectorType, JSON.stringify(eventTypes), write.condition,
      write.membershipIncarnation, write.origin, write.requestId, now, now,
    ).one());
  }

  /** Whether a row went: the returned key is the witness. */
  remove(sidekickId: string, userId: string, connectionId: string): boolean {
    return this.storage.sql.exec(
      `DELETE FROM sidekick_sources WHERE sidekick_id = ? AND user_id = ? AND connection_id = ? RETURNING user_id`,
      sidekickId, userId, connectionId,
    ).toArray().length > 0;
  }

  requestsForSidekick(sidekickId: string): SidekickSourceRequest[] {
    return this.storage.sql.exec<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM sidekick_source_requests WHERE sidekick_id = ? ORDER BY created_at, request_id`,
      sidekickId,
    ).toArray().map(request);
  }

  /** What one asking operation already asked, in the order it asked. */
  requestsForOperation(sidekickId: string, operationId: string): SidekickSourceRequest[] {
    return this.storage.sql.exec<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM sidekick_source_requests WHERE sidekick_id = ? AND operation_id = ?
        ORDER BY created_at, request_id`, sidekickId, operationId,
    ).toArray().map(request);
  }

  readRequest(requestId: string): SidekickSourceRequest | null {
    const row = this.storage.sql.exec<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM sidekick_source_requests WHERE request_id = ?`, requestId,
    ).toArray()[0];
    return row ? request(row) : null;
  }

  /**
   * Ask one person. An ask still waiting for the same person, Sidekick and
   * connector is cancelled first, so the person answers what was asked last.
   * Returns the new request and the one it replaced, whose card and Activity
   * row the caller settles.
   */
  ask(write: SidekickSourceRequestWrite, now: number): { request: SidekickSourceRequest; replaced: SidekickSourceRequest | null } {
    const replaced = this.storage.sql.exec<RequestRow>(
      `UPDATE sidekick_source_requests SET state = 'cancelled', decided_at = ?
        WHERE sidekick_id = ? AND user_id = ? AND connector_type = ? AND state = 'pending'
        RETURNING ${REQUEST_COLUMNS}`,
      now, write.sidekickId, write.userId, write.connectorType,
    ).toArray()[0];
    const created = this.storage.sql.exec<RequestRow>(
      `INSERT INTO sidekick_source_requests (${REQUEST_INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?)
       RETURNING ${REQUEST_COLUMNS}`,
      write.requestId, write.sidekickId, write.userId, write.connectorType,
      JSON.stringify([...new Set(write.eventTypes)].sort()), write.condition,
      write.requestedByUserId, write.requestedByName, write.place?.parentKind ?? null, write.place?.parentId ?? null, now,
      write.operationId,
    ).one();
    return { request: request(created), replaced: replaced ? request(replaced) : null };
  }

  /** Settle a waiting request. Null when it was not waiting: somebody answered first. */
  settle(requestId: string, state: "approved" | "declined", now: number): SidekickSourceRequest | null {
    const row = this.storage.sql.exec<RequestRow>(
      `UPDATE sidekick_source_requests SET state = ?, decided_at = ? WHERE request_id = ? AND state = 'pending'
       RETURNING ${REQUEST_COLUMNS}`,
      state, now, requestId,
    ).toArray()[0];
    return row ? request(row) : null;
  }
}
