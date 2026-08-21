import process from "node:process";

import { isEntryPoint } from "./entry-point.mjs";

const MIGRATION_NAME = /\b\d{4}_[a-z0-9][a-z0-9_.-]*\.sql\b/giu;

/**
 * Classifies the remote ledger without moving unrelated migrations across the
 * Worker deploy. The destructive migration may reverse the normal ordering
 * only while it is the ledger's sole pending entry.
 */
export function classifyPendingD1Migrations(output, workerFirstMigration) {
  const pending = [...new Set(output.match(MIGRATION_NAME) ?? [])];
  if (!pending.includes(workerFirstMigration)) return "worker_first=false";
  const companions = pending.filter((migration) => migration !== workerFirstMigration);
  if (companions.length > 0) {
    throw new Error(
      `${workerFirstMigration} must be the only pending migration; also pending: ${companions.join(", ")}`,
    );
  }
  return "worker_first=true";
}

if (isEntryPoint(import.meta.url)) {
  const workerFirstMigration = process.argv[2];
  if (!workerFirstMigration) throw new Error("Usage: classify-pending-d1-migrations.mjs <migration>");
  let output = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) output += chunk;
  console.log(classifyPendingD1Migrations(output, workerFirstMigration));
}
