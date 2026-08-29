#!/usr/bin/env node
/**
 * Catches two files in `apps/api/test-workers/` addressing the same Durable
 * Object by name.
 *
 * Storage in that suite is isolated per file, but *object names* are not: an
 * id is resolved through the one Miniflare the pool shares across every
 * concurrently-running file, so two files naming the same object are two files
 * queueing on one input gate. `workspace-directory-reads.test.ts` records what
 * that looked like when it happened — reusing a busy id made the file wait for
 * whatever the rest of the run was doing to that object, "which showed up as a
 * `beforeAll` timeout rather than as a failure anyone could read". Three files
 * in the directory now carry a comment asserting their workspace is their own,
 * and one of them said so while sharing an id with two siblings.
 *
 * It lives here rather than in `scripts/eslint-rules/` because it is a
 * cross-file invariant: a per-file linter cannot see the collision.
 *
 * Scope, deliberately narrow: workspace ids written as literals in a test file,
 * which is how every file in the directory declares its own. A file that builds
 * ids from a prefix at runtime (`forced-migration`, `migration-reporting`)
 * declares no literal and is not compared — those two objects are per-test by
 * construction. Names imported from `helpers/` are shared on purpose and are
 * likewise out of scope, so the helpers are not read.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./entry-point.mjs";

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolved from this script's own location, never the working directory. */
export const workersSuiteDirectory = resolve(repositoryDirectory, "apps/api/test-workers");

/**
 * Every workspace id a file spells out. `asWorkspaceId` is the only way a name
 * for a `WorkspaceDO` is minted from a literal, so matching its argument finds
 * the declarations without needing to parse TypeScript.
 */
const WORKSPACE_ID_LITERAL = /asWorkspaceId\(\s*["'`]([0-9a-fA-F-]{36})["'`]\s*\)/gu;

export function workspaceIdLiterals(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(WORKSPACE_ID_LITERAL)) {
      found.push({ line: index + 1, id: match[1] });
    }
  });
  return found;
}

/**
 * `declarations` maps a file name to the ids it spells out. The answer names
 * every id that more than one file spells out, with the files sorted so the
 * message is stable.
 */
export function collisions(declarations) {
  const filesById = new Map();
  for (const [file, ids] of Object.entries(declarations)) {
    for (const id of new Set(ids)) {
      filesById.set(id, [...(filesById.get(id) ?? []), file]);
    }
  }
  return [...filesById.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files: [...files].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function check(directory = workersSuiteDirectory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const declarations = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const text = await readFile(join(directory, entry.name), "utf8");
    const ids = workspaceIdLiterals(text).map((declaration) => declaration.id);
    if (ids.length > 0) declarations[entry.name] = ids;
  }
  return collisions(declarations);
}

async function main() {
  const found = await check();
  if (found.length === 0) {
    console.log("Every workerd test file that names a workspace object names its own.");
    return;
  }
  throw new Error(
    `${found.length} Durable Object name${found.length === 1 ? " is" : "s are"} shared between test files:\n`
      + found.map(({ id, files }) => `  ${id}\n    ${files.join("\n    ")}`).join("\n")
      + "\nGive each file its own id: a shared name is a shared input gate, and the "
      + "symptom is a hook timing out in whichever file lost the race.",
  );
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Durable Object test name check failed");
    process.exitCode = 1;
  });
}
