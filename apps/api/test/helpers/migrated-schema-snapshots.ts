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
  describeDatabase,
  type DatabaseDescription,
  type SchemaSnapshot,
  type SqliteTemplateVariant,
} from "./migrated-schema";

interface MigratedSchemaCapture {
  readonly snapshot: SchemaSnapshot;
  readonly description: DatabaseDescription;
}

export type MigratedSchemaSnapshots = Readonly<Record<SqliteTemplateVariant, MigratedSchemaCapture>>;

declare module "vitest" {
  interface ProvidedContext {
    migratedSchemaSnapshots: MigratedSchemaSnapshots;
  }
}

/** Captures every variant once. Called by the global setup, in Vitest's node context. */
export function captureMigratedSchemaSnapshots(): MigratedSchemaSnapshots {
  const captured = {} as Record<SqliteTemplateVariant, MigratedSchemaCapture>;
  for (const variant of ["regional", "pre-retirement", "legacy-product"] as const) {
    const template = buildTemplateDatabase(variant);
    try {
      captured[variant] = {
        snapshot: captureSchemaSnapshot(template),
        description: describeDatabase(template),
      };
    } finally {
      template.close();
    }
  }
  return captured;
}

const localCaptures = new Map<SqliteTemplateVariant, MigratedSchemaCapture>();

function migratedSchemaCapture(variant: SqliteTemplateVariant): MigratedSchemaCapture {
  const provided = inject("migratedSchemaSnapshots") as MigratedSchemaSnapshots | undefined;
  const shared = provided?.[variant];
  if (shared) return shared;
  const cached = localCaptures.get(variant);
  if (cached) return cached;
  const template = buildTemplateDatabase(variant);
  try {
    const capture = {
      snapshot: captureSchemaSnapshot(template),
      description: describeDatabase(template),
    };
    localCaptures.set(variant, capture);
    return capture;
  } finally {
    template.close();
  }
}

export function migratedSchemaSnapshot(variant: SqliteTemplateVariant): SchemaSnapshot {
  return migratedSchemaCapture(variant).snapshot;
}

export function migratedSchemaDescription(variant: SqliteTemplateVariant): DatabaseDescription {
  return migratedSchemaCapture(variant).description;
}
