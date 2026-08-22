/**
 * Builds the migrated database shapes once, before any test file runs.
 *
 * See `helpers/migrated-schema-snapshots.ts` for why: a module-level cache is a
 * per-file cache under Vitest's isolation, so without this the migration replay
 * runs once per file that opens a database.
 */
import type { TestProject } from "vitest/node";

import { captureMigratedSchemaSnapshots } from "./helpers/migrated-schema-snapshots";

export default function setup(project: TestProject): void {
  project.provide("migratedSchemaSnapshots", captureMigratedSchemaSnapshots());
}
