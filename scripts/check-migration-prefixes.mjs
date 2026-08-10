#!/usr/bin/env node
// Fails when two D1 migrations in packages/db/migrations claim the same numeric
// prefix.
//
// Migration numbers are allocated by hand, so two pull requests opened from the
// same base both take the next free number and neither branch can see the
// conflict on its own: each holds one file, and git merges them without a
// textual conflict. The collision only becomes visible on main, after the
// second merge, by which point the files are immutable and both numbers are
// already recorded in `d1_migrations` in whatever order Wrangler happened to
// walk them. That is how prefixes 0039, 0041, and 0046 came to be duplicated
// below.
//
// So the check reads the union of the migration names on the base branch and
// the names in the checkout, rather than either alone: a branch that takes a
// number main has since used fails while it is still a pull request, which is
// the only point where renaming the file is still free. Because migrations are
// immutable once deployed, a name that reaches main stays on main, and unioning
// never resurrects a name that was legitimately withdrawn.

import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIRECTORY = "packages/db/migrations";

// Prefixes that were already duplicated on main when this check was written.
// The files are deployed and therefore immutable, so they are recorded rather
// than fixed. An entry only excuses that exact pair of names: a third file
// taking one of these numbers still fails. Nothing should ever be added here —
// a new collision is caught while its file can still be renamed.
export const KNOWN_COLLISIONS = {
  "0039": ["0039_slack_connector.sql", "0039_workstream_read_state.sql"],
  "0041": ["0041_slack_workspace_workstreams.sql", "0041_x_connector.sql"],
  "0046": ["0046_slack_workspace_tools.sql", "0046_x_workspace_only.sql"],
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Groups migration names by numeric prefix and reports the prefixes claimed by
 * more than one file, along with any file that carries no prefix at all — an
 * unnumbered file would otherwise pass every check silently.
 */
export function findCollisions(fileNames, knownCollisions = KNOWN_COLLISIONS) {
  const byPrefix = new Map();
  const unnumbered = [];

  for (const name of [...new Set(fileNames)].sort()) {
    const prefix = /^(\d+)_.+\.sql$/u.exec(name)?.[1];
    if (!prefix) {
      unnumbered.push(name);
      continue;
    }
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }

  const collisions = [];
  for (const [prefix, files] of [...byPrefix].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.length < 2) continue;
    const known = knownCollisions[prefix];
    if (known && known.length === files.length && known.every((name, index) => name === files[index])) {
      continue;
    }
    collisions.push({ prefix, files });
  }

  return { collisions, unnumbered };
}

/** Migration names in the working tree, which includes files not yet committed. */
export async function readCheckoutMigrations(directory = resolve(repositoryRoot, MIGRATIONS_DIRECTORY)) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

/** Migration names committed at a git ref, such as `origin/main`. */
export function readRefMigrations(ref, cwd = repositoryRoot) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, stdio: "ignore" });
  } catch {
    throw new Error(`Cannot resolve ${ref}; fetch it before running this check`);
  }
  const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", `${MIGRATIONS_DIRECTORY}/`], {
    cwd,
    encoding: "utf8",
  });
  return listing
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(`${MIGRATIONS_DIRECTORY}/`.length));
}

export function describe({ collisions, unnumbered }) {
  const lines = [];
  for (const { prefix, files } of collisions) {
    lines.push(`Prefix ${prefix} is claimed by ${files.length} migrations:`);
    for (const file of files) lines.push(`  ${MIGRATIONS_DIRECTORY}/${file}`);
  }
  for (const file of unnumbered) {
    lines.push(`${MIGRATIONS_DIRECTORY}/${file} is not named <number>_<name>.sql`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const refs = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--ref") throw new Error(`Usage: check-migration-prefixes.mjs [--ref <git-ref>]...`);
    const ref = argv[index + 1];
    if (!ref) throw new Error("--ref needs a git ref");
    refs.push(ref);
    index += 1;
  }

  const names = [...(await readCheckoutMigrations()), ...refs.flatMap((ref) => readRefMigrations(ref))];
  const result = findCollisions(names);
  const sources = ["the checkout", ...refs].join(" and ");

  if (result.collisions.length === 0 && result.unnumbered.length === 0) {
    console.log(`No duplicate migration prefixes across ${sources}.`);
    return;
  }

  throw new Error(
    `${describe(result)}\n\n`
      + `Migration numbers must be unique across ${sources}. Renumber the migration `
      + "added on this branch to the next free number and update anything that names it.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration prefix check failed");
    process.exitCode = 1;
  });
}
