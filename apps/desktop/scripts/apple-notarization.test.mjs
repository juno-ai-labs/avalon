import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isTransientAppleNetworkFailure,
  notarizationCredentialMode,
  notarizeWithResumableWait,
  notarytoolCredentialArgs,
  prepareNotarizationEnvironment,
  runAppleNetworkCommand,
} from './apple-notarization.mjs';

test('notarization credential modes require complete, pinned credentials', () => {
  assert.equal(
    notarizationCredentialMode({
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: '7ZLT6A8W25',
    }),
    'apple-id',
  );
  assert.throws(
    () => notarizationCredentialMode({ APPLE_ID: 'release@example.com' }),
    /incomplete/u,
  );
  assert.throws(
    () => notarizationCredentialMode({
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: 'WRONGTEAM1',
    }),
    /Rally releases require/u,
  );
  assert.equal(
    notarizationCredentialMode({
      APPLE_API_KEY: '/tmp/AuthKey.p8',
      APPLE_API_KEY_ID: 'KEYID',
      APPLE_API_ISSUER: 'issuer',
    }),
    'api-key',
  );
  assert.equal(notarizationCredentialMode({ APPLE_KEYCHAIN_PROFILE: 'rally-notary' }), 'keychain-profile');
  assert.equal(
    notarizationCredentialMode({
      APPLE_KEYCHAIN_PROFILE: 'rally-notary',
      APPLE_TEAM_ID: '7ZLT6A8W25',
    }),
    'keychain-profile',
  );
  assert.throws(
    () => notarizationCredentialMode({
      APPLE_KEYCHAIN_PROFILE: 'rally-notary',
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: '7ZLT6A8W25',
    }),
    /exactly one/u,
  );
});

test('notarytool arguments support Apple ID, API key, and keychain profile authentication', () => {
  assert.deepEqual(
    notarytoolCredentialArgs({
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: '7ZLT6A8W25',
    }),
    ['--apple-id', 'release@example.com', '--team-id', '7ZLT6A8W25', '--password', 'secret'],
  );
  assert.deepEqual(
    notarytoolCredentialArgs({
      APPLE_API_KEY: '/tmp/AuthKey.p8',
      APPLE_API_KEY_ID: 'KEYID',
      APPLE_API_ISSUER: 'issuer',
    }),
    ['--key', '/tmp/AuthKey.p8', '--key-id', 'KEYID', '--issuer', 'issuer'],
  );
  assert.deepEqual(
    notarytoolCredentialArgs({
      APPLE_KEYCHAIN_PROFILE: 'rally-notary',
      APPLE_KEYCHAIN: '/tmp/release.keychain-db',
    }),
    ['--keychain-profile', 'rally-notary', '--keychain', '/tmp/release.keychain-db'],
  );
});

test('base64 App Store Connect keys are materialized with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-notary-test-'));
  try {
    const pem = '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n';
    const environment = await prepareNotarizationEnvironment(
      {
        APPLE_API_KEY: Buffer.from(pem).toString('base64'),
        APPLE_API_KEY_ID: 'KEYID',
        APPLE_API_ISSUER: 'issuer',
      },
      directory,
    );
    assert.equal(await readFile(environment.APPLE_API_KEY, 'utf8'), pem);
    assert.equal((await stat(environment.APPLE_API_KEY)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Verbatim from the v1.768.0 and v1.769.0 macOS release runs that failed.
const NOTARY_OFFLINE = 'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009 '
  + '"The Internet connection appears to be offline." UserInfo={_kCFStreamErrorCodeKey=50})';
const TIMESTAMP_MISSING = '/tmp/Rally.app/Contents/PlugIns/RallyDockTilePluginV2.docktileplugin: '
  + 'A timestamp was expected but was not found.';

function scripted(results) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    const next = results.shift();
    if (!next) throw new Error(`unexpected call ${command} ${args.join(' ')}`);
    return { stdout: '', stderr: '', ...next };
  };
  return { calls, exec };
}

const noSleep = async () => {};

test('Apple network failures are told apart from Apple refusing the request', () => {
  assert.equal(isTransientAppleNetworkFailure({ stderr: NOTARY_OFFLINE }), true);
  assert.equal(isTransientAppleNetworkFailure({ stderr: TIMESTAMP_MISSING }), true);
  assert.equal(isTransientAppleNetworkFailure({ stderr: 'Error: HTTPError(statusCode: 503, error: x)' }), true);
  assert.equal(isTransientAppleNetworkFailure({ stderr: 'Error: HTTPError(statusCode: 401, error: x)' }), false);
  assert.equal(isTransientAppleNetworkFailure({ stderr: 'errSecInternalComponent' }), false);
  assert.equal(isTransientAppleNetworkFailure({ stdout: '{"status":"Invalid"}' }), false);
});

test('a codesign whose timestamp server was unreachable is signed again', async () => {
  const { calls, exec } = scripted([{ code: 1, stderr: TIMESTAMP_MISSING }, { code: 0 }]);
  await runAppleNetworkCommand('codesign', '/usr/bin/codesign', ['--timestamp', 'x'], { exec, sleep: noSleep });
  assert.equal(calls.length, 2);
});

test('a codesign refused for another reason fails on the first attempt', async () => {
  const { calls, exec } = scripted([{ code: 1, stderr: 'errSecInternalComponent' }]);
  await assert.rejects(
    runAppleNetworkCommand('codesign', '/usr/bin/codesign', ['x'], { exec, sleep: noSleep }),
    /codesign failed with status 1\nerrSecInternalComponent/,
  );
  assert.equal(calls.length, 1);
});

test('a lost connection while waiting resumes the same submission instead of uploading again', async () => {
  const { calls, exec } = scripted([
    { code: 0, stdout: '{"id":"sub-1","message":"Successfully uploaded file"}' },
    { code: 1, stderr: NOTARY_OFFLINE },
    { code: 0, stdout: '{"id":"sub-1","status":"Accepted"}' },
  ]);
  const result = await notarizeWithResumableWait({
    path: '/tmp/Rally.zip',
    credentials: ['--key', 'k'],
    exec,
    sleep: noSleep,
  });
  assert.deepEqual(result, { id: 'sub-1' });
  assert.deepEqual(calls.map((call) => call.slice(1, 3)), [
    ['notarytool', 'submit'],
    ['notarytool', 'wait'],
    ['notarytool', 'wait'],
  ]);
  assert.equal(calls[1][3], 'sub-1');
  assert.equal(calls[2][3], 'sub-1');
});

test('an Invalid verdict fails with Apple\'s log and is not retried', async () => {
  const { calls, exec } = scripted([
    { code: 0, stdout: '{"id":"sub-2"}' },
    { code: 1, stdout: '{"id":"sub-2","status":"Invalid"}' },
    { code: 0, stdout: 'The binary is not signed with a valid Developer ID certificate.' },
  ]);
  await assert.rejects(
    notarizeWithResumableWait({ path: '/tmp/Rally.dmg', credentials: [], exec, sleep: noSleep }),
    /ended Invalid \(submission sub-2\)\nThe binary is not signed/,
  );
  assert.deepEqual(calls.at(-1).slice(1, 4), ['notarytool', 'log', 'sub-2']);
});

test('a wait that keeps losing its connection stops once the attempts are spent', async () => {
  const { calls, exec } = scripted([
    { code: 0, stdout: '{"id":"sub-3"}' },
    { code: 1, stderr: NOTARY_OFFLINE },
    { code: 1, stderr: NOTARY_OFFLINE },
  ]);
  await assert.rejects(
    notarizeWithResumableWait({
      path: '/tmp/Rally.dmg',
      credentials: [],
      timeout: '30m',
      exec,
      sleep: noSleep,
      maxAttempts: 2,
    }),
    /notarytool wait on sub-3 failed with status 1/,
  );
  assert.deepEqual(calls[1].slice(-2), ['--timeout', '30m']);
});
