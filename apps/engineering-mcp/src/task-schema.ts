import { applyDurableObjectSqliteMigrations, type DurableObjectSqliteMigration } from "../../api/src/durable-objects/sqlite-migrations";

// The first release uses SQLite; there is no deployed KV predecessor to migrate.
const MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "Operator-owned task state and segmented input/result payloads",
  statements: [
    `CREATE TABLE engineering_task (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      task_id TEXT NOT NULL,
      subject TEXT NOT NULL, audience TEXT NOT NULL, email TEXT,
      name TEXT NOT NULL CHECK (name IN ('query_data_lake', 'retire_org')),
      status TEXT NOT NULL CHECK (status IN ('working', 'completed', 'cancelled')),
      status_message TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      CHECK ((status = 'working' AND expires_at IS NULL) OR (status != 'working' AND expires_at IS NOT NULL))
    ) STRICT`,
    `CREATE TABLE engineering_task_payloads (
      kind TEXT PRIMARY KEY CHECK (kind IN ('input', 'result')),
      chunk_count INTEGER NOT NULL CHECK (chunk_count > 0)
    ) STRICT`,
    `CREATE TABLE engineering_task_chunks (
      kind TEXT NOT NULL REFERENCES engineering_task_payloads(kind) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      content TEXT NOT NULL,
      PRIMARY KEY (kind, position)
    ) STRICT`,
  ],
}];

export function initializeTaskSchema(storage: DurableObjectStorage, workerVersionId: string) {
  applyDurableObjectSqliteMigrations({ storage, migrations: MIGRATIONS, component: "engineering_task", workerVersionId });
}
