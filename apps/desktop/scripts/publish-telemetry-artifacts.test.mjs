import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { publishTelemetryArtifacts } from './publish-telemetry-artifacts.mjs';

const runtimeEnvironment = {
  AVALON_GLOBAL_TELEMETRY_R2_BUCKET: 'avalon-global-telemetry',
  AVALON_EU_TELEMETRY_R2_BUCKET: 'avalon-eu-telemetry',
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'avalon-publish-telemetry-test-'));
  const desktopDirectory = join(root, 'desktop');
  await writeFileBelow(desktopDirectory, 'package.json', '{"version":"1.96.0"}\n');
  for (const process of ['main', 'preload', 'renderer']) {
    await writeFileBelow(desktopDirectory, `out/${process}/index.js.map`, `map:${process}`);
  }
  await writeFileBelow(desktopDirectory, 'out/main/chunk.js.map', 'map:main-chunk');
  await writeFileBelow(
    desktopDirectory,
    'release/mac-arm64/Avalon.app/Contents/MacOS/Avalon',
    'mach-o',
  );
  return { root, desktopDirectory };
}

async function writeFileBelow(root, relativePath, value) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function commandRunner() {
  const calls = [];
  const runCommand = async (command, arguments_, options = {}) => {
    calls.push({ command, arguments: arguments_ });
    if (command === 'file') return { code: 0, signal: null, stdout: 'Mach-O 64-bit executable', stderr: '' };
    if (command === 'dump_syms') {
      await writeFile(options.stdoutFile, 'MODULE mac arm64 TESTID Avalon\nFUNC 1000 10 0 main\n');
      return { code: 0, signal: null, stdout: '', stderr: '' };
    }
    if (command === 'tar') {
      await writeFile(arguments_[1], 'native-archive');
      return { code: 0, signal: null, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`);
  };
  return { calls, runCommand };
}

function objectApi({ corruptVerification = false } = {}) {
  const objects = new Map();
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const match = /\/r2\/buckets\/([^/]+)\/objects\/(.+)/u.exec(url.pathname);
    assert.ok(match, `unexpected object API URL ${url}`);
    const [, bucket, key] = match;
    const target = `${bucket}/${key}`;
    const headers = new Headers(init.headers);
    const call = {
      method: init.method ?? 'GET',
      target,
      jurisdiction: headers.get('cf-r2-jurisdiction'),
    };
    calls.push(call);
    if (call.method === 'PUT') {
      objects.set(target, Buffer.from(init.body));
      return Response.json({ success: true, result: { key } });
    }
    const object = objects.get(target);
    assert.ok(object, `expected uploaded object ${target}`);
    return new Response(corruptVerification ? Buffer.from('corrupt') : object);
  };
  return { calls, fetchImpl, objects };
}

test('publishes every private artifact to both isolated regional buckets and verifies its bytes', async () => {
  const { root, desktopDirectory } = await fixture();
  const runner = commandRunner();
  const api = objectApi();
  try {
    await publishTelemetryArtifacts({
      desktopDirectory,
      environment: runtimeEnvironment,
      fetchImpl: api.fetchImpl,
      runCommand: runner.runCommand,
      temporaryRoot: root,
    });

    const targets = [...api.objects.keys()].sort();
    assert.equal(targets.length, 10);
    for (const bucket of ['avalon-global-telemetry', 'avalon-eu-telemetry']) {
      for (const process of ['main', 'preload', 'renderer']) {
        assert.ok(targets.includes(
          `${bucket}/telemetry/javascript-symbols/1.96.0/1.96.0/${process}/index.js.map`,
        ));
      }
      assert.ok(targets.includes(
        `${bucket}/telemetry/symbols/1.96.0/1.96.0/darwin/arm64.tar`,
      ));
      assert.ok(targets.includes(
        `${bucket}/telemetry/javascript-symbols/1.96.0/1.96.0/main/chunk.js.map`,
      ));
    }
    const verificationGets = api.calls.filter(({ method }) => method === 'GET');
    assert.equal(verificationGets.length, 10);
    assert.equal(
      api.calls.filter(({ target }) => target.startsWith('avalon-global-telemetry/'))
        .every(({ jurisdiction }) => jurisdiction === null),
      true,
    );
    assert.equal(
      api.calls.filter(({ target }) => target.startsWith('avalon-eu-telemetry/'))
        .every(({ jurisdiction }) => jurisdiction === 'eu'),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed before upload when a packaged process source map is missing', async () => {
  const { root, desktopDirectory } = await fixture();
  await rm(join(desktopDirectory, 'out/preload/index.js.map'));
  const runner = commandRunner();
  const api = objectApi();
  try {
    await assert.rejects(
      publishTelemetryArtifacts({
        desktopDirectory,
        environment: runtimeEnvironment,
        fetchImpl: api.fetchImpl,
        runCommand: runner.runCommand,
        temporaryRoot: root,
      }),
      /Missing source maps for: preload/u,
    );
    assert.equal(api.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects shared regional buckets and a post-upload checksum mismatch', async () => {
  const first = await fixture();
  const firstApi = objectApi();
  try {
    await assert.rejects(
      publishTelemetryArtifacts({
        desktopDirectory: first.desktopDirectory,
        environment: {
          ...runtimeEnvironment,
          AVALON_EU_TELEMETRY_R2_BUCKET: runtimeEnvironment.AVALON_GLOBAL_TELEMETRY_R2_BUCKET,
        },
        fetchImpl: firstApi.fetchImpl,
        runCommand: commandRunner().runCommand,
        temporaryRoot: first.root,
      }),
      /require distinct buckets/u,
    );
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }

  const second = await fixture();
  const secondApi = objectApi({ corruptVerification: true });
  try {
    await assert.rejects(
      publishTelemetryArtifacts({
        desktopDirectory: second.desktopDirectory,
        environment: runtimeEnvironment,
        fetchImpl: secondApi.fetchImpl,
        runCommand: commandRunner().runCommand,
        temporaryRoot: second.root,
      }),
      /Checksum mismatch/u,
    );
  } finally {
    await rm(second.root, { recursive: true, force: true });
  }
});
