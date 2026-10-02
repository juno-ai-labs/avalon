import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./entry-point.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

// A script that reports what the guard decided, so each case below can assert
// on behaviour observed from outside rather than on the comparison itself —
// the bug this replaces was invisible to every in-process assertion, because
// in-process the module is not the entry point either way.
const PROBE = `import { isEntryPoint } from ${JSON.stringify(join(scriptsDirectory, "entry-point.mjs"))};
console.log(isEntryPoint(import.meta.url) ? "ran" : "did not run");
`;

function inTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "entry-point-"));
  try {
    return run(directory);
  } finally {
    // Never follows a symlink into what it points at, so a linked source tree
    // is not at risk here.
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a module that nothing invoked is not the entry point", () => {
  // Named rather than passed as `import.meta.url`, which under `node --test` is
  // the entry point: the runner starts each test file as its own program. The
  // module under test is the one this file imported, and that is the case the
  // guard exists for — a script's main() must not fire when its test pulls the
  // file in for the exported pieces.
  assert.equal(isEntryPoint(new URL("./entry-point.mjs", import.meta.url).href), false);
});

test("the file Node was started with is the entry point", () => {
  inTemporaryDirectory((directory) => {
    const probe = join(directory, "probe.mjs");
    writeFileSync(probe, PROBE);
    assert.equal(execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim(), "ran");
  });
});

test("a script reached through a symlinked directory still recognises itself", () => {
  // The regression. macOS's `os.tmpdir()` is `/var/folders/…` and `/var` is a
  // symlink to `/private/var`, so on that platform every script run out of a
  // temporary directory arrives by a path that does not match its resolved one.
  // Comparing `process.argv[1]` to `import.meta.url` raw made such a script exit
  // 0 without running, which is how a green Linux CI shipped a macOS release job
  // that planned nothing. Built by hand rather than left to the platform, so the
  // case is covered wherever this suite runs.
  inTemporaryDirectory((directory) => {
    const real = join(directory, "real");
    mkdirSync(real);
    writeFileSync(join(real, "probe.mjs"), PROBE);
    const linked = join(directory, "linked");
    symlinkSync(real, linked);
    const output = execFileSync(process.execPath, [join(linked, "probe.mjs")], { encoding: "utf8" });
    assert.equal(output.trim(), "ran");
  });
});

test("a symlinked file, not merely a symlinked directory, is still the entry point", () => {
  // The other half of the same problem: `node <link-to-script>` rather than
  // `node <link-to-directory>/script`. Both spell one file two ways.
  inTemporaryDirectory((directory) => {
    const probe = join(directory, "probe.mjs");
    writeFileSync(probe, PROBE);
    const linked = join(directory, "linked-probe.mjs");
    symlinkSync(probe, linked);
    assert.equal(execFileSync(process.execPath, [linked], { encoding: "utf8" }).trim(), "ran");
  });
});

test("an unresolvable invocation path is answered rather than thrown", () => {
  // Fails closed. Whatever the caller guards — a release plan, a health check,
  // a deployment — must not fail because a path could not be resolved, so the
  // question has to have an answer even when the filesystem will not give one.
  const original = process.argv[1];
  process.argv[1] = resolve(scriptsDirectory, "no-such-directory/no-such-file.mjs");
  try {
    assert.equal(isEntryPoint(import.meta.url), false);
  } finally {
    process.argv[1] = original;
  }
});
