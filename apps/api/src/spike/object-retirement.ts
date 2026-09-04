/**
 * SPIKE — throwaway. Not production code, not on the release path.
 *
 * The object-local half of the workspace retirement protocol.
 *
 * Nothing in Rally retires a workspace today. `workspaces.abandoned_at` is the
 * closest thing: it is a D1 admission fence, it is reachable only by the last
 * remaining member closing their own workspace, and it says nothing to the
 * Durable Objects — their alarms keep firing, their outboxes keep draining, and
 * WorkspaceDO keeps applying whatever arrives. This module is the missing
 * half, built the cheapest way that can be tested: one object-local row per
 * object, written through the object's own SQL.
 *
 * A production version would put this in each class's migration list rather
 * than creating a table from a request handler
 * (`docs/durable-object-sqlite.md`: "Never patch a production object
 * opportunistically from a request handler"). The spike does it here on purpose,
 * so the branch can be deleted without leaving a released migration behind.
 */

const TABLE = "_spike_object_retirement";

export interface SpikeRetirement {
  retiredAt: number;
  /**
   * The work-stream authority generation this object was retired at.
   *
   * Every effect envelope carries `generation`, so this is the fence a retired
   * WorkspaceDO can compare an arriving effect against. See SPIKE-REPORT.md for
   * why a region-wide generation is the wrong shape for a per-workspace fence.
   */
  retiredGeneration: number;
  reason: string;
}

function ensureTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       retired_at INTEGER NOT NULL,
       retired_generation INTEGER NOT NULL,
       reason TEXT NOT NULL
     ) STRICT`,
  );
}

function tableExists(sql: SqlStorage): boolean {
  return sql.exec<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    TABLE,
  ).toArray().length > 0;
}

/** Synchronous, because the alarm-candidate hook that reads it is synchronous. */
export function readSpikeRetirement(sql: SqlStorage): SpikeRetirement | null {
  if (!tableExists(sql)) return null;
  const row = sql.exec<{
    retired_at: number; retired_generation: number; reason: string;
  }>(`SELECT retired_at, retired_generation, reason FROM ${TABLE} WHERE id = 1`).toArray()[0];
  return row
    ? { retiredAt: row.retired_at, retiredGeneration: row.retired_generation, reason: row.reason }
    : null;
}

/** Idempotent: retiring an already-retired object keeps the first instant. */
export function markSpikeRetired(sql: SqlStorage, input: {
  retiredAt: number;
  retiredGeneration: number;
  reason: string;
}): SpikeRetirement {
  ensureTable(sql);
  sql.exec(
    `INSERT INTO ${TABLE} (id, retired_at, retired_generation, reason)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    input.retiredAt,
    input.retiredGeneration,
    input.reason,
  );
  const current = readSpikeRetirement(sql);
  if (!current) throw new Error("spike_retirement_not_recorded");
  return current;
}
