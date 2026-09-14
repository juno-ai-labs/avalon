import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { publishTelemetryArtifacts } from './publish-telemetry-artifacts.mjs';

const runtimeEnvironment = {
  RALLY_GLOBAL_TELEMETRY_R2_BUCKET: 'rally-global-telemetry',
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rally-publish-telemetry-test-'));
  const desktopDirectory = join(root, 'desktop');
  await writeFileBelow(desktopDirectory, 'package.json', '{"version":"1.96.0"}\n');
  for (const process of ['main', 'preload', 'renderer']) {
    await writeFileBelow(desktopDirectory, `out/${process}/index.js.map`, `map:${process}`);
  }
  await writeFileBelow(desktopDirectory, 'out/main/chunk.js.map', 'map:main-chunk');
  await writeFileBelow(
    desktopDirectory,
    'release/mac-arm64/Rally.app/Contents/MacOS/Rally',
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
      await writeFile(options.stdoutFile, 'MODULE mac arm64 TESTID Rally\nFUNC 1000 10 0 main\n');
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

function objectApi({
  corruptInventory = false,
  inventoryCacheStatus = 'DYNAMIC',
  inventoryInvalidJson = false,
  inventoryStatus = 200,
  inventoryTimestamp = '2026-08-13T19:09:29.001Z',
  putErrors = [],
  putInvalidJson = false,
  putResultOverrides = {},
  putStatus = 200,
  putSuccess = putStatus >= 200 && putStatus < 300,
} = {}) {
  const objects = new Map();
  const calls = [];
  let errorBodyCancelled = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const objectMatch = /\/r2\/buckets\/([^/]+)\/objects\/(.+)/u.exec(url.pathname);
    const inventoryMatch = /\/r2\/buckets\/([^/]+)\/objects$/u.exec(url.pathname);
    assert.ok(objectMatch || inventoryMatch, `unexpected object API URL ${url}`);
    const bucket = objectMatch?.[1] ?? inventoryMatch[1];
    const key = objectMatch?.[2] ?? url.searchParams.get('prefix');
    const target = `${bucket}/${key ?? ''}`;
    const headers = new Headers(init.headers);
    const call = {
      method: init.method ?? 'GET',
      target,
      jurisdiction: headers.get('cf-r2-jurisdiction'),
      contentType: headers.get('content-type'),
      cacheControl: headers.get('cache-control'),
      perPage: url.searchParams.get('per_page'),
      prefix: url.searchParams.get('prefix'),
      signal: init.signal,
      url: url.href,
    };
    calls.push(call);
    assert.ok(call.method === 'PUT' || call.method === 'GET', `unexpected object API method ${call.method}`);
    if (call.method === 'PUT') {
      assert.ok(objectMatch, 'PUT must address one object');
      const bytes = Buffer.from(init.body);
      const etag = createHash('md5').update(bytes).digest('hex');
      const uploaded = '2026-08-13T19:09:29.000Z';
      if (putStatus >= 200 && putStatus < 300 && putSuccess) {
        objects.set(target, {
          bytes,
          etag,
          key,
          lastModified: inventoryTimestamp,
        });
      }
      if (putInvalidJson) return new Response('not-json', { status: putStatus });
      return Response.json({
        success: putSuccess,
        errors: putErrors,
        result: {
          etag,
          key,
          size: String(bytes.byteLength),
          uploaded,
          version: 'test-upload-version',
          ...putResultOverrides,
        },
      }, { status: putStatus });
    }
    assert.ok(inventoryMatch, 'GET must use the authoritative object inventory');
    if (inventoryStatus < 200 || inventoryStatus >= 300) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('provider error'));
        },
        cancel() {
          errorBodyCancelled = true;
        },
      });
      return new Response(body, { status: inventoryStatus });
    }
    const object = objects.get(target);
    assert.ok(object, `expected uploaded object ${target}`);
    if (inventoryInvalidJson) {
      return new Response('not-json', { headers: { 'cf-cache-status': 'DYNAMIC' } });
    }
    return Response.json({
      success: true,
      result: [{
        etag: corruptInventory ? 'corrupt' : object.etag,
        key: object.key,
        last_modified: object.lastModified,
        size: object.bytes.byteLength,
      }],
    }, {
      headers: inventoryCacheStatus === null ? undefined : { 'cf-cache-status': inventoryCacheStatus },
    });
  };
  return {
    calls,
    fetchImpl,
    objects,
    get errorBodyCancelled() {
      return errorBodyCancelled;
    },
  };
}

test('publishes every private artifact and verifies upload metadata in each regional inventory', async () => {
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
    assert.equal(targets.length, 5);
    for (const bucket of ['rally-global-telemetry']) {
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
    const inventoryGets = api.calls.filter(({ method }) => method === 'GET');
    assert.equal(inventoryGets.length, 5);
    assert.equal(
      inventoryGets.every(({ cacheControl, perPage, prefix }) => (
        cacheControl === 'no-cache' && perPage === '2' && prefix?.startsWith('telemetry/')
      )),
      true,
    );
    assert.equal(api.calls.every(({ signal }) => signal instanceof AbortSignal && !signal.aborted), true);
    assert.equal(
      api.calls.filter(({ method }) => method === 'PUT')
        .every(({ contentType }) => contentType === 'application/octet-stream'),
      true,
    );
    assert.equal(
      api.calls.filter(({ target }) => target.startsWith('rally-global-telemetry/'))
        .every(({ jurisdiction }) => jurisdiction === null),
      true,
    );

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('encodes Cloudflare object URL components', async () => {
  const { root, desktopDirectory } = await fixture();
  const api = objectApi();
  try {
    await publishTelemetryArtifacts({
      desktopDirectory,
      environment: { ...runtimeEnvironment, CLOUDFLARE_ACCOUNT_ID: 'test/account id' },
      fetchImpl: api.fetchImpl,
      runCommand: commandRunner().runCommand,
      temporaryRoot: root,
    });

    assert.match(api.calls[0].url, /\/accounts\/test%2Faccount%20id\/r2\/buckets\//u);
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

test('rejects a post-upload inventory mismatch', async () => {
  const second = await fixture();
  const secondApi = objectApi({ corruptInventory: true });
  try {
    await assert.rejects(
      publishTelemetryArtifacts({
        desktopDirectory: second.desktopDirectory,
        environment: runtimeEnvironment,
        fetchImpl: secondApi.fetchImpl,
        runCommand: commandRunner().runCommand,
        temporaryRoot: second.root,
      }),
      /Stored metadata mismatch/u,
    );
  } finally {
    await rm(second.root, { recursive: true, force: true });
  }
});

test('rejects oversized artifacts before any upload', async () => {
  const { root, desktopDirectory } = await fixture();
  await writeFile(
    join(desktopDirectory, 'out/main/index.js.map'),
    Buffer.alloc((16 * 1024 * 1024) + 1),
  );
  const api = objectApi();
  try {
    await assert.rejects(
      publishTelemetryArtifacts({
        desktopDirectory,
        environment: runtimeEnvironment,
        fetchImpl: api.fetchImpl,
        runCommand: commandRunner().runCommand,
        temporaryRoot: root,
      }),
      /telemetry\/javascript-symbols\/.*outside its allowed size/u,
    );
    assert.equal(api.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects Cloudflare upload failures without exposing provider response bodies', async (t) => {
  const cases = [
    {
      name: 'HTTP failure',
      api: objectApi({ putStatus: 503, putSuccess: false, putErrors: [{ code: 10001, message: 'secret detail' }] }),
      expected: /HTTP 503 \(success=false; error codes 10001\)/u,
    },
    {
      name: 'protocol failure',
      api: objectApi({ putSuccess: false }),
      expected: /HTTP 200 \(success=false\)/u,
    },
    {
      name: 'invalid JSON',
      api: objectApi({ putInvalidJson: true }),
      expected: /HTTP 200 \(invalid JSON response\)/u,
    },
  ];
  for (const failure of cases) {
    await t.test(failure.name, async () => {
      const { root, desktopDirectory } = await fixture();
      try {
        await assert.rejects(
          publishTelemetryArtifacts({
            desktopDirectory,
            environment: runtimeEnvironment,
            fetchImpl: failure.api.fetchImpl,
            runCommand: commandRunner().runCommand,
            temporaryRoot: root,
          }),
          (error) => failure.expected.test(error.message) && !error.message.includes('secret detail'),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('validates authoritative inventory responses without trusting cached object reads', async (t) => {
  await t.test('failed inventory response', async () => {
    const { root, desktopDirectory } = await fixture();
    const api = objectApi({ inventoryStatus: 503 });
    try {
      await assert.rejects(
        publishTelemetryArtifacts({
          desktopDirectory,
          environment: runtimeEnvironment,
          fetchImpl: api.fetchImpl,
          runCommand: commandRunner().runCommand,
          temporaryRoot: root,
        }),
        /Could not verify .* HTTP 503/u,
      );
      assert.equal(api.errorBodyCancelled, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const cacheStatus of ['HIT', 'STALE', 'UPDATING', 'REVALIDATED', null]) {
    await t.test(`non-dynamic inventory response: ${cacheStatus ?? 'missing'}`, async () => {
      const { root, desktopDirectory } = await fixture();
      const api = objectApi({ inventoryCacheStatus: cacheStatus });
      try {
        await assert.rejects(
          publishTelemetryArtifacts({
            desktopDirectory,
            environment: runtimeEnvironment,
            fetchImpl: api.fetchImpl,
            runCommand: commandRunner().runCommand,
            temporaryRoot: root,
          }),
          /Cloudflare returned a non-dynamic inventory/u,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  await t.test('invalid inventory response', async () => {
    const { root, desktopDirectory } = await fixture();
    const api = objectApi({ inventoryInvalidJson: true });
    try {
      await assert.rejects(
        publishTelemetryArtifacts({
          desktopDirectory,
          environment: runtimeEnvironment,
          fetchImpl: api.fetchImpl,
          runCommand: commandRunner().runCommand,
          temporaryRoot: root,
        }),
        /invalid inventory metadata/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('rejects upload metadata that does not attest to the exact submitted object', async (t) => {
  const cases = [
    ['etag', { etag: 'not-the-source-md5' }],
    ['size', { size: '999' }],
    ['key', { key: 'another-object' }],
    ['version', { version: '' }],
    ['timestamp', { uploaded: 'not-a-date' }],
  ];
  for (const [name, putResultOverrides] of cases) {
    await t.test(name, async () => {
      const { root, desktopDirectory } = await fixture();
      const api = objectApi({ putResultOverrides });
      try {
        await assert.rejects(
          publishTelemetryArtifacts({
            desktopDirectory,
            environment: runtimeEnvironment,
            fetchImpl: api.fetchImpl,
            runCommand: commandRunner().runCommand,
            temporaryRoot: root,
          }),
          /invalid upload metadata/u,
        );
        assert.equal(api.calls.filter(({ method }) => method === 'GET').length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('allows only sub-second inventory timestamp precision loss', async (t) => {
  for (const [name, timestamp, shouldPass] of [
    ['one second earlier', '2026-08-13T19:09:28.000Z', true],
    ['more than one second earlier', '2026-08-13T19:09:27.999Z', false],
  ]) {
    await t.test(name, async () => {
      const { root, desktopDirectory } = await fixture();
      const api = objectApi({ inventoryTimestamp: timestamp });
      try {
        const publication = publishTelemetryArtifacts({
          desktopDirectory,
          environment: runtimeEnvironment,
          fetchImpl: api.fetchImpl,
          runCommand: commandRunner().runCommand,
          temporaryRoot: root,
        });
        if (shouldPass) await publication;
        else await assert.rejects(publication, /Stored metadata mismatch/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
