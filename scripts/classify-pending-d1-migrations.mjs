import process from "node:process";

import { isEntryPoint } from "./entry-point.mjs";

const MIGRATION_NAME = /\b\d{4}_[a-z0-9][a-z0-9_.-]*\.sql\b/giu;

/**
 * Classifies the remote ledger without moving unrelated migrations across the
 * Worker deploy. A configured destructive migration may reverse the normal
 * ordering only while it is the ledger's sole pending entry.
 */
export function classifyPendingD1Migrations(output, workerFirstMigrations) {
  const configured = Array.isArray(workerFirstMigrations)
    ? workerFirstMigrations
    : [workerFirstMigrations];
  const pending = [...new Set(output.match(MIGRATION_NAME) ?? [])];
  const selected = pending.filter((migration) => configured.includes(migration));
  if (selected.length === 0) return "worker_first=false";
  if (selected.length > 1) {
    throw new Error(`Only one Worker-first migration may be pending; found: ${selected.join(", ")}`);
  }
  const workerFirstMigration = selected[0];
  const companions = pending.filter((migration) => migration !== workerFirstMigration);
  if (companions.length > 0) {
    throw new Error(
      `${workerFirstMigration} must be the only pending migration; also pending: ${companions.join(", ")}`,
    );
  }
  return "worker_first=true";
}

if (isEntryPoint(import.meta.url)) {
  const workerFirstMigrations = process.argv.slice(2);
  if (workerFirstMigrations.length === 0) {
    throw new Error("Usage: classify-pending-d1-migrations.mjs <migration> [migration ...]");
  }
  let output = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) output += chunk;
  console.log(classifyPendingD1Migrations(output, workerFirstMigrations));
}
