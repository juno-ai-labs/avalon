import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FIXTURE_COMMIT = '4adf5555b2ab844f23c52982fc202357ff882695';
const FIXTURES = [
  {
    relativePath: 'test.dmp',
    sourcePath: 'testdata/test.dmp',
    sha256: '24b0ea7794b2d2523c46c9aea72c03ccbb0ab88ad76d8258d3752c7b71d233ff',
  },
  {
    relativePath: 'symbols/test_app.pdb/5A9832E5287241C1838ED98914E9B7FF1/test_app.sym',
    sourcePath: 'testdata/symbols/test_app.pdb/5A9832E5287241C1838ED98914E9B7FF1/test_app.sym',
    sha256: 'dc96d58edd5efea177a73ad6a013fa6f3d0d2b3be710431b5bddefbaab4eecb1',
  },
];
const IMAGE = `avalon-crash-symbolicator-integration:${process.pid}`;
const PROCESS_PRESSURE_CONTAINER = `avalon-symbolicator-pressure-${process.pid}`;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BUILD_CONTEXT = resolve(SCRIPT_DIRECTORY, '../crash-symbolicator');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'avalon-symbolicator-'));
function runDocker(arguments_, options = {}) {
  const result = spawnSync('docker', arguments_, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `docker ${arguments_.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

async function downloadFixture(fixture) {
  const url = `https://raw.githubusercontent.com/rust-minidump/rust-minidump/${FIXTURE_COMMIT}/${fixture.sourcePath}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, `fixture download failed with HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
  const destination = join(temporaryRoot, fixture.relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { mode: 0o644 });
}

function containerArguments(...command) {
  return [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--tmpfs=/workspace:rw,noexec,nosuid,size=32m,uid=10001,gid=10001,mode=0700',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=32m,uid=10001,gid=10001,mode=0700',
    `--volume=${temporaryRoot}:/fixtures:ro`,
    IMAGE,
    ...command,
  ];
}

function assertSanitized(value, key) {
  if (Array.isArray(value)) {
    for (const child of value) assertSanitized(child, key);
    return;
  }
  if (value === null || typeof value !== 'object') {
    if (
      typeof value === 'string'
      && ['debug_file', 'filename', 'file', 'source_file', 'path'].includes(key)
    ) {
      assert.equal(value.startsWith('/'), false, `absolute path leaked through ${key}`);
      assert.equal(
        /^[A-Za-z]:[\\/]/u.test(value),
        false,
        `drive path leaked through ${key}: ${value}`,
      );
    }
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    assert.equal(
      ['command_line', 'environment', 'memory', 'stack_memory', 'source_context'].includes(childKey),
      false,
      `prohibited processor field leaked: ${childKey}`,
    );
    assertSanitized(childValue, childKey);
  }
}

async function waitForProcessPressure() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = spawnSync('docker', ['logs', PROCESS_PRESSURE_CONTAINER], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.includes('ready')) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.fail('process-pressure container did not become ready');
}

try {
  for (const fixture of FIXTURES) await downloadFixture(fixture);
  writeFileSync(join(temporaryRoot, 'malformed.dmp'), 'not a minidump', { mode: 0o644 });
  // Native Linux bind mounts retain host permissions. Let only the public,
  // checksum-pinned fixture tree cross the test container's non-root boundary.
  chmodSync(temporaryRoot, 0o755);

  // The builder stage compiles `minidump-stackwalk` from source, which costs
  // roughly three and a half minutes and depends on nothing in this repository —
  // the same base image and pinned version every time. This script never reaches
  // for a remote cache itself: CI warms the runner's BuildKit cache from the
  // shared scope in the step before this one, so the layer is already resolved
  // here and the build is a cache lookup. Locally it is an ordinary build against
  // the daemon's own cache.
  // `--load` is required because that shared builder uses the `docker-container`
  // driver, whose result does not reach the image store otherwise, and the
  // checks below run the image by tag.
  runDocker(['build', '--quiet', '--load', '--tag', IMAGE, BUILD_CONTEXT]);

  assert.equal(runDocker(containerArguments('id', '-u')), '10001');

  const noEgressProbe = [
    'import socket',
    'sock = socket.socket()',
    'sock.settimeout(1)',
    'try:',
    "    sock.connect(('1.1.1.1', 443))",
    'except OSError:',
    '    raise SystemExit(0)',
    'raise SystemExit(1)',
  ].join('\n');
  runDocker(containerArguments('python3', '-c', noEgressProbe));

  const processPressureProbe = [
    'import subprocess',
    'import time',
    "children = [subprocess.Popen(['sleep', '300']) for _ in range(40)]",
    "print('ready', flush=True)",
    'time.sleep(300)',
  ].join('\n');
  runDocker([
    'run',
    '--detach',
    '--rm',
    '--network=none',
    '--name',
    PROCESS_PRESSURE_CONTAINER,
    IMAGE,
    'python3',
    '-c',
    processPressureProbe,
  ]);
  await waitForProcessPressure();

  const report = JSON.parse(runDocker(containerArguments(
    '/usr/local/bin/rally-symbolicate',
    '/fixtures/test.dmp',
    '/fixtures/symbols',
  )));
  assert.equal(report.status, 'ok', `valid fixture was rejected: ${JSON.stringify(report)}`);
  assert.ok(Array.isArray(report.threads) && report.threads.length > 0, 'fixture produced no threads');
  assert.match(JSON.stringify(report), /test_app/u, 'matching symbols were not applied');
  assertSanitized(report);

  const malformed = JSON.parse(runDocker(containerArguments(
    '/usr/local/bin/rally-symbolicate',
    '/fixtures/malformed.dmp',
    '/fixtures/symbols',
  )));
  assert.deepEqual(malformed, { status: 'malformed', reason: 'processor_failed' });

  console.log('Crash symbolicator container integration passed.');
} finally {
  spawnSync('docker', ['stop', PROCESS_PRESSURE_CONTAINER], { encoding: 'utf8' });
  spawnSync('docker', ['image', 'rm', '--force', IMAGE], { encoding: 'utf8' });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
