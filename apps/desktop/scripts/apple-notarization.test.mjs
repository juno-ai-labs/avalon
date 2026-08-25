import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  notarizationCredentialMode,
  notarytoolCredentialArgs,
  prepareNotarizationEnvironment,
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
