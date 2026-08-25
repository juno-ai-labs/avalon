import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { RALLY_APPLE_TEAM_ID } from './release-lib.mjs';

function present(environment, name) {
  return Boolean(environment[name]?.trim());
}

function requireComplete(environment, names, label) {
  const missing = names.filter((name) => !present(environment, name));
  if (missing.length > 0) {
    throw new Error(`${label} notarization credentials are incomplete; missing ${missing.join(', ')}`);
  }
}

export function notarizationCredentialMode(environment = process.env) {
  if (
    present(environment, 'APPLE_TEAM_ID')
    && environment.APPLE_TEAM_ID.trim() !== RALLY_APPLE_TEAM_ID
  ) {
    throw new Error(
      `APPLE_TEAM_ID is ${environment.APPLE_TEAM_ID.trim()}; Rally releases require ${RALLY_APPLE_TEAM_ID}`,
    );
  }

  const appleIdNames = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const usesAppleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']
    .some((name) => present(environment, name));
  const apiKeyNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const usesApiKey = apiKeyNames.some((name) => present(environment, name));
  const usesKeychainProfile = present(environment, 'APPLE_KEYCHAIN_PROFILE');
  const configuredModes = [usesAppleId, usesApiKey, usesKeychainProfile].filter(Boolean).length;
  if (configuredModes > 1) {
    throw new Error('Configure exactly one Apple notarization credential mode');
  }

  if (usesAppleId) {
    requireComplete(environment, appleIdNames, 'Apple ID');
    return 'apple-id';
  }

  if (usesApiKey) {
    requireComplete(environment, apiKeyNames, 'App Store Connect API key');
    return 'api-key';
  }

  if (usesKeychainProfile) return 'keychain-profile';
  throw new Error(
    'Set Apple ID, App Store Connect API key, or notarytool keychain-profile credentials before building a release',
  );
}

export function notarytoolCredentialArgs(environment = process.env) {
  const mode = notarizationCredentialMode(environment);
  if (mode === 'apple-id') {
    return [
      '--apple-id',
      environment.APPLE_ID.trim(),
      '--team-id',
      environment.APPLE_TEAM_ID.trim(),
      '--password',
      environment.APPLE_APP_SPECIFIC_PASSWORD.trim(),
    ];
  }
  if (mode === 'api-key') {
    return [
      '--key',
      environment.APPLE_API_KEY.trim(),
      '--key-id',
      environment.APPLE_API_KEY_ID.trim(),
      '--issuer',
      environment.APPLE_API_ISSUER.trim(),
    ];
  }
  const args = ['--keychain-profile', environment.APPLE_KEYCHAIN_PROFILE.trim()];
  if (present(environment, 'APPLE_KEYCHAIN')) {
    args.push('--keychain', environment.APPLE_KEYCHAIN.trim());
  }
  return args;
}

async function isFile(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const PRIVATE_KEY_PEM_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

function decodeApiKey(value) {
  const trimmed = value.trim();
  if (trimmed.includes(PRIVATE_KEY_PEM_HEADER)) return `${trimmed}\n`;
  let decoded;
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  } catch {
    decoded = '';
  }
  if (!decoded.includes(PRIVATE_KEY_PEM_HEADER)) {
    throw new Error('APPLE_API_KEY must be a .p8 path, PEM text, or base64-encoded PEM text');
  }
  return `${decoded}\n`;
}

/**
 * electron-builder consumes APPLE_API_KEY before the post-build hook. Make a
 * file-backed key available to both stages when CI injects the key as a secret.
 */
export async function prepareNotarizationEnvironment(environment, secretDirectory) {
  const prepared = { ...environment };
  const mode = notarizationCredentialMode(prepared);
  if (mode !== 'api-key') return prepared;

  const configured = prepared.APPLE_API_KEY.trim();
  const configuredPath = resolve(configured);
  if (await isFile(configuredPath)) {
    prepared.APPLE_API_KEY = configuredPath;
    return prepared;
  }

  const keyPath = resolve(secretDirectory, `AuthKey_${prepared.APPLE_API_KEY_ID.trim()}.p8`);
  await writeFile(keyPath, decodeApiKey(configured), { encoding: 'utf8', mode: 0o600 });
  prepared.APPLE_API_KEY = keyPath;
  return prepared;
}

export async function assertApiKeyReadable(environment = process.env) {
  if (notarizationCredentialMode(environment) !== 'api-key') return;
  await readFile(environment.APPLE_API_KEY.trim());
}
