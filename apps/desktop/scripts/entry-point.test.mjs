import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

// This folder keeps its own copy of the guard rather than importing the
// repository root's, because plan-release.test.mjs runs the release scripts out
// of a copy of this directory alone. The copy is the reason these tests exist:
// the root's suite cannot reach this file, so without them the duplicate could
// drift back into the bug with nothing noticing. `scripts/entry-point.test.mjs`
// at the root holds the fuller battery; these are the two properties every
// release script depends on.
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

const PROBE = `import { isEntryPoint } from ${JSON.stringify(join(scriptsDirectory, 'entry-point.mjs'))};
console.log(isEntryPoint(import.meta.url) ? 'ran' : 'did not run');
`;

test('an imported module is not the entry point', () => {
  // What keeps every release script's main() from firing when a test imports it
  // for the exported pieces. Named rather than passed as `import.meta.url`,
  // which under `node --test` is the entry point — the runner starts each test
  // file as its own program.
  assert.equal(isEntryPoint(new URL('./entry-point.mjs', import.meta.url).href), false);
});

test('an unresolvable invocation path is answered rather than thrown', () => {
  // Fails closed: a release must not die because a path could not be resolved.
  // Covered here as well as at the repository root because this folder keeps
  // its own copy, and this was the one property the two suites disagreed on.
  const original = process.argv[1];
  process.argv[1] = join(scriptsDirectory, 'no-such-directory/no-such-file.mjs');
  try {
    assert.equal(isEntryPoint(new URL('./entry-point.mjs', import.meta.url).href), false);
  } finally {
    process.argv[1] = original;
  }
});

test('a script reached through a symlinked directory still runs', () => {
  // The macOS release job's failure, at the level of the guard itself: every
  // path under that platform's os.tmpdir() arrives through `/var`, a symlink to
  // `/private/var`, and a script that fails this check exits 0 having published
  // nothing and said nothing.
  const enclosing = mkdtempSync(join(tmpdir(), 'rally-entry-point-'));
  try {
    const real = join(enclosing, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'probe.mjs'), PROBE);
    symlinkSync(real, join(enclosing, 'linked'));
    const output = execFileSync(
      process.execPath,
      [join(enclosing, 'linked', 'probe.mjs')],
      { encoding: 'utf8' },
    );
    assert.equal(output.trim(), 'ran');
  } finally {
    rmSync(enclosing, { recursive: true, force: true });
  }
});
