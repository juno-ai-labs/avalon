export interface DurableObjectSqliteMigration {
  /** Positive, monotonically increasing, and immutable after release. */
  version: number;
  description: string;
  statements: readonly string[];
  /**
   * SQLite's documented table-rebuild procedure requires foreign keys to be
   * disabled before its transaction begins. Use only for a released migration
   * whose SQL depends on that legacy execution environment.
   *
   * A new migration must not reach for this, and not only as a matter of
   * preference: the pragma below is a no-op once anything in the same object
   * event has touched SQLite, which by the time a group runs is always. A
   * rebuild written against it runs with enforcement on and drops its
   * dependents for real. Replace a referenced parent by copying each dependent
   * aside and restoring it — WorkspaceDO migration 31 — and see
   * `docs/durable-object-sqlite.md`.
   */
  foreignKeys?: "disabled_during_rebuild";
  /**
   * Preserve a receipt written before execution mode was part of the migration
   * definition. Valid only when the released wrapper already supplied the same
   * foreign-key mode, so this records execution truth without editing its
   * immutable implementation fingerprint.
   */
  legacyHashWithoutExecutionMode?: true;
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
 * changing this algorithm would report drift against every existing object and
 * make the persisted receipts incomparable with the published history.
 */
export function durableObjectMigrationHash(migration: DurableObjectSqliteMigration): string {
  // The suffix is absent for every migration shipped before execution modes
  // existed, so their persisted fingerprints remain byte-for-byte stable.
  const executionMode = migration.foreignKeys === "disabled_during_rebuild"
    && migration.legacyHashWithoutExecutionMode !== true
    ? "\nforeign_keys=disabled_during_rebuild"
    : "";
  const input = `${migration.version}\n${migration.statements.join(";\n")}${executionMode}`;
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
    if (migration.legacyHashWithoutExecutionMode === true
      && migration.foreignKeys !== "disabled_during_rebuild") {
      throw new Error(`${component}_schema_legacy_execution_mode_invalid:${migration.version}`);
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
 * Each migration group and its receipts share one synchronous SQLite
 * transaction; an isolate cannot observe a half-applied migration. Groups are
 * split only where SQLite requires foreign-key enforcement to change outside a
 * transaction. A crash between groups leaves a complete, receipted schema that
 * the next construction resumes. This utility intentionally never touches
 * DurableObjectStorage's key-value API.
 */
export function applyDurableObjectSqliteMigrations(
  options: ApplyDurableObjectSqliteMigrationsOptions,
): readonly number[] {
  validateMigrations(options.component, options.migrations);
  const appliedVersions: number[] = [];
  const latestKnownVersion = options.migrations.at(-1)?.version ?? 0;
  const now = options.now ?? Date.now();
  const sql = options.storage.sql;

  const ledgerExists = sql.exec<{ name: string } & Record<string, SqlStorageValue>>(
    `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = '_sql_schema_migrations'`,
  ).toArray().length === 1;
  let ledgerNeedsDescription = false;
  const appliedByVersion = options.storage.transactionSync(() => {
    if (!ledgerExists) return new Map<number, string>();
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
    // lets the renamed AgentLoopDO retain its existing receipts verbatim.
    ledgerNeedsDescription = !ledgerColumns.has("description");
    const applied = sql.exec<{
      version: number;
      implementation_hash: string;
    }>(`SELECT version, implementation_hash FROM _sql_schema_migrations ORDER BY version`)
      .toArray();
    const unknown = applied.find((row) => row.version > latestKnownVersion);
    if (unknown) throw new Error(`${options.component}_schema_ahead:${unknown.version}`);
    const byVersion = new Map(applied.map((row) => [row.version, row.implementation_hash]));
    for (const migration of options.migrations) {
      const existingHash = byVersion.get(migration.version);
      const currentHash = durableObjectMigrationHash(migration);
      if (existingHash !== undefined && existingHash !== currentHash) {
        // A fingerprint disagreement is diagnostic evidence, not grounds to
        // make an otherwise usable object unavailable. Keep the persisted
        // receipt truthful and let subsequent SQL surface a real incompatibility.
        /* eslint-disable-next-line no-console */
        console.warn({
          event: "durable_object_schema_hash_mismatch",
          message: `${options.component}_schema_hash_mismatch:${migration.version}`,
          component: options.component,
          version: migration.version,
          workerVersionId: options.workerVersionId,
          recordedImplementationHash: existingHash,
          currentImplementationHash: currentHash,
        });
      }
    }
    return byVersion;
  });

  const ensureLedger = (): void => {
    sql.exec(BOOTSTRAP_MIGRATIONS_TABLE);
    if (ledgerNeedsDescription) {
      sql.exec(`ALTER TABLE _sql_schema_migrations
        ADD COLUMN description TEXT NOT NULL DEFAULT 'legacy migration receipt'`);
      ledgerNeedsDescription = false;
    }
  };

  const groups: Array<{
    foreignKeysDisabled: boolean;
    migrations: DurableObjectSqliteMigration[];
  }> = [];
  for (const migration of options.migrations.filter(({ version }) => !appliedByVersion.has(version))) {
    const foreignKeysDisabled = migration.foreignKeys === "disabled_during_rebuild";
    const prior = groups.at(-1);
    if (prior?.foreignKeysDisabled === foreignKeysDisabled) prior.migrations.push(migration);
    else groups.push({ foreignKeysDisabled, migrations: [migration] });
  }

  if (groups.length === 0) {
    options.storage.transactionSync(() => {
      ensureLedger();
      options.afterMigrations?.(sql, appliedVersions);
    });
    return appliedVersions;
  }

  for (const [groupIndex, group] of groups.entries()) {
    if (group.foreignKeysDisabled) sql.exec(`PRAGMA foreign_keys = OFF`);
    try {
      options.storage.transactionSync(() => {
        ensureLedger();
        for (const migration of group.migrations) {
          const implementationHash = durableObjectMigrationHash(migration);
          for (const [statementIndex, statement] of migration.statements.entries()) {
            try {
              sql.exec(statement);
            } catch (error) {
              const droppedTable = /^DROP\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)$/iu
                .exec(statement.trim())?.[1];
              const dependents = droppedTable
                ? sql.exec<{ name: string } & Record<string, SqlStorageValue>>(
                    `SELECT name FROM sqlite_schema
                      WHERE sql LIKE ? AND name != ? ORDER BY name`,
                    `%${droppedTable}%`,
                    droppedTable,
                  ).toArray().map(({ name }) => name).join(",")
                : "";
              const causeMessage = error instanceof Error && error.message.trim().length > 0
                ? `:${error.message.trim().replace(/\s+/gu, " ").slice(0, 160)}`
                : "";
              throw new Error(
                `${options.component}_schema_migration_statement_failed:${migration.version}:${statementIndex}:`
                  + statement.trim().replace(/\s+/gu, " ").slice(0, 96)
                  + (dependents ? `:referenced_by=${dependents}` : "")
                  + causeMessage,
                { cause: error },
              );
            }
          }
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

        if (groupIndex === groups.length - 1) options.afterMigrations?.(sql, appliedVersions);
        const violation = sql.exec<Record<string, SqlStorageValue>>(`PRAGMA foreign_key_check`)
          .toArray()[0];
        if (violation) throw new Error(`${options.component}_schema_foreign_key_violation`);
        sql.exec(`PRAGMA optimize`);
      });
    } finally {
      if (group.foreignKeysDisabled) sql.exec(`PRAGMA foreign_keys = ON`);
    }
  }

  return appliedVersions;
}
