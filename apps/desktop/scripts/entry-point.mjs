// The desktop release scripts' copy of the repository's entry-point guard.
// `scripts/entry-point.mjs` at the repository root is the same function and
// carries the full reasoning for why the naive comparison is wrong.
//
// It is duplicated rather than imported across the two folders on purpose.
// `plan-release.test.mjs` proves the real planner by copying *this* directory
// into a throwaway git worktree and running the script from there, so anything
// a release script imports from outside this folder would resolve to the
// committed copy in that worktree rather than the one under test — passing or
// failing on the wrong code, which is the exact trap that test already warns
// about for the scripts themselves. The `avalon/no-raw-entry-point-check` lint
// rule holds both copies to the same idiom, so the duplication cannot drift
// back into the bug.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module identified by `moduleUrl` is this process's entry point.
 *
 * Pass `import.meta.url`. Both sides are resolved, so the answer is about which
 * file this is rather than how its path was spelled — a script reached through
 * a symlinked directory, as everything under macOS's `os.tmpdir()` is, still
 * recognises itself and runs.
 *
 * Fails closed: a path that cannot be resolved is not this module, and throwing
 * here would fail a release for a reason unrelated to the release.
 */
export function isEntryPoint(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
