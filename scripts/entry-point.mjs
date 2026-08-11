// How a script decides it is the program Node was asked to run, rather than a
// module something else imported — the guard that keeps a script's `main()`
// from firing when its test file imports it for the exported pieces.
//
// Comparing `process.argv[1]` against `fileURLToPath(import.meta.url)` directly,
// which every script here used to do, compares two spellings of one file rather
// than two files. `argv` keeps the path as it was written on the command line;
// `import.meta.url` is always resolved through symlinks. Reach a script through
// a symlinked directory and the two disagree, so it runs nothing and exits 0
// having done no work and printed nothing — which a caller reads as success,
// not as a script that never started. macOS's `os.tmpdir()` is such a directory
// (`/var` is a symlink to `/private/var`), and that is exactly how this bit the
// desktop release planner: the same test passed on Linux CI, where `/tmp` is
// real, and failed in the macOS release job with an empty release plan.
//
// `import.meta.main` says this in a word, but it only lands in Node 22.18 and
// this repository's `engines` allows 22.0 — where it is `undefined`, and every
// guard written on it silently stops running. That is the failure being fixed,
// so it is not the tool to fix it with.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module identified by `moduleUrl` is this process's entry point.
 *
 * Pass `import.meta.url`. Both sides are resolved, so the answer is about which
 * file this is rather than how its path was spelled.
 *
 * Fails closed: a path that cannot be resolved is not this module, and throwing
 * here would turn an unreadable working directory into a failure inside
 * whatever the caller guards — a release plan, a health check, a deployment.
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
