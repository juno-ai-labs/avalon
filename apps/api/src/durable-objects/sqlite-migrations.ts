export interface DurableObjectSqliteMigration {
  /** Positive, monotonically increasing, and immutable after release. */
  version: number;
  description: string;
  statements: readonly string[];
}

export interface ApplyDurableObjectSqliteMigrationsOptions {
  storage: DurableObjectStorage;
  migrations: readonly DurableObjectSqliteMigration[];
  component: string;
  workerVersionId: string;
  now?: number;
  afterMigrations?: (sql: SqlStorage, appliedVersions: readonly number[]) => void;
}

const BOOTSTRAP_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    implementation_hash TEXT NOT NULL,
    description TEXT NOT NULL,
    worker_version_id TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT
`;

/**
 * Fast deterministic fingerprint used to detect edited migration SQL.
 *
 * This input shape is already persisted by the original WorkstreamRoom
 * migration runner. Keep it stable: descriptions are operator metadata, while
 * changing this algorithm would strand existing object databases even when
 * their applied SQL is exactly the published history.
 */
export function durableObjectMigrationHash(migration: DurableObjectSqliteMigration): string {
  const input = `${migration.version}\n${migration.statements.join(";\n")}`;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function validateMigrations(
  component: string,
  migrations: readonly DurableObjectSqliteMigration[],
): void {
  let prior = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= prior) {
      throw new Error(`${component}_schema_versions_not_strictly_monotonic:${migration.version}`);
    }
    if (migration.description.trim().length === 0 || migration.statements.length === 0) {
      throw new Error(`${component}_schema_migration_incomplete:${migration.version}`);
    }
    for (const statement of migration.statements) {
      if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(statement)) {
        throw new Error(`${component}_schema_transaction_statement_forbidden:${migration.version}`);
      }
    }
    prior = migration.version;
  }
}

/**
 * Apply an object's complete, append-only SQLite migration history.
 *
 * The migration SQL and its receipt share one synchronous SQLite transaction;
 * an isolate cannot observe a half-applied schema. This utility intentionally
 * never touches DurableObjectStorage's key-value API.
 */
export function applyDurableObjectSqliteMigrations(
  options: ApplyDurableObjectSqliteMigrationsOptions,
): readonly number[] {
  validateMigrations(options.component, options.migrations);
  const appliedVersions: number[] = [];
  const latestKnownVersion = options.migrations.at(-1)?.version ?? 0;
  const now = options.now ?? Date.now();

  options.storage.transactionSync(() => {
    const sql = options.storage.sql;
    sql.exec(BOOTSTRAP_MIGRATIONS_TABLE);
    const ledgerColumns = new Set(sql.exec<{ name: string }>(
      `PRAGMA table_info(_sql_schema_migrations)`,
    ).toArray().map((column) => column.name));
    const requiredLedgerColumns = [
      "version",
      "implementation_hash",
      "worker_version_id",
      "applied_at",
    ];
    const missingLedgerColumn = requiredLedgerColumns.find((column) => !ledgerColumns.has(column));
    if (missingLedgerColumn) {
      throw new Error(`${options.component}_schema_ledger_incompatible:${missingLedgerColumn}`);
    }
    // The pre-cutover WorkstreamRoom ledger has every correctness field but
    // predates the human-readable description. Adding it is metadata-only and
    // lets the renamed SubstreamAgent retain its existing receipts verbatim.
    if (!ledgerColumns.has("description")) {
      sql.exec(`ALTER TABLE _sql_schema_migrations
        ADD COLUMN description TEXT NOT NULL DEFAULT 'legacy migration receipt'`);
    }
    const applied = sql.exec<{
      version: number;
      implementation_hash: string;
    }>(`SELECT version, implementation_hash FROM _sql_schema_migrations ORDER BY version`)
      .toArray();
    const unknown = applied.find((row) => row.version > latestKnownVersion);
    if (unknown) throw new Error(`${options.component}_schema_ahead:${unknown.version}`);
    const appliedByVersion = new Map(applied.map((row) => [row.version, row.implementation_hash]));

    for (const migration of options.migrations) {
      const implementationHash = durableObjectMigrationHash(migration);
      const existingHash = appliedByVersion.get(migration.version);
      if (existingHash !== undefined) {
        if (existingHash !== implementationHash) {
          throw new Error(`${options.component}_schema_hash_mismatch:${migration.version}`);
        }
        continue;
      }
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec(
        `INSERT INTO _sql_schema_migrations
           (version, implementation_hash, description, worker_version_id, applied_at)
         VALUES (?, ?, ?, ?, ?)`,
        migration.version,
        implementationHash,
        migration.description,
        options.workerVersionId,
        now,
      );
      appliedVersions.push(migration.version);
    }

    options.afterMigrations?.(sql, appliedVersions);
    if (appliedVersions.length > 0) {
      const violation = sql.exec<Record<string, SqlStorageValue>>(`PRAGMA foreign_key_check`)
        .toArray()[0];
      if (violation) throw new Error(`${options.component}_schema_foreign_key_violation`);
      sql.exec(`PRAGMA optimize`);
    }
  });

  return appliedVersions;
}
