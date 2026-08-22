/**
 * One migrated shape per variant, for the whole run.
 *
 * Capturing a shape means replaying the migrations, which costs ~800ms. Vitest
 * gives each test file its own module registry, so a module-level cache is a
 * per-file cache: the suite paid that 800ms 78 times, once for every file that
 * opens a database. The global setup builds all three shapes before any file
 * runs and hands them over as plain data, so a worker deserializes a snapshot
 * instead of replaying 95 migrations to derive it again.
 *
 * The local fallback is for running a file directly against a config with no
 * global setup; it is the same capture, just not shared.
 */
import { inject } from "vitest";

import {
  buildTemplateDatabase,
  captureSchemaSnapshot,
  type SchemaSnapshot,
  type SqliteTemplateVariant,
} from "./migrated-schema";

export type MigratedSchemaSnapshots = Readonly<Record<SqliteTemplateVariant, SchemaSnapshot>>;

declare module "vitest" {
  interface ProvidedContext {
    migratedSchemaSnapshots: MigratedSchemaSnapshots;
  }
}

/** Captures every variant once. Called by the global setup, in Vitest's node context. */
export function captureMigratedSchemaSnapshots(): MigratedSchemaSnapshots {
  const captured = {} as Record<SqliteTemplateVariant, SchemaSnapshot>;
  for (const variant of ["regional", "pre-retirement", "legacy-product"] as const) {
    const template = buildTemplateDatabase(variant);
    try {
      captured[variant] = captureSchemaSnapshot(template);
    } finally {
      template.close();
    }
  }
  return captured;
}

const localSnapshots = new Map<SqliteTemplateVariant, SchemaSnapshot>();

export function migratedSchemaSnapshot(variant: SqliteTemplateVariant): SchemaSnapshot {
  const provided = inject("migratedSchemaSnapshots") as MigratedSchemaSnapshots | undefined;
  const shared = provided?.[variant];
  if (shared) return shared;
  const cached = localSnapshots.get(variant);
  if (cached) return cached;
  const template = buildTemplateDatabase(variant);
  try {
    const snapshot = captureSchemaSnapshot(template);
    localSnapshots.set(variant, snapshot);
    return snapshot;
  } finally {
    template.close();
  }
}
