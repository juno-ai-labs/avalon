import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';

import { RALLY_APPLE_TEAM_ID, runWithTransientRetry } from './release-lib.mjs';

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

/**
 * Attempts at one Apple network call (a codesign timestamp, a notary submit, a
 * wait on a submission, a staple) whose failure was a dropped connection.
 *
 * Open on purpose (docs/adding-security-defensive-and-other-limits.md): the
 * macOS job's `timeout-minutes` already bounds a release that never reconnects,
 * so this ceiling changes nothing until the team picks a number. Each retry
 * waits 1s, doubling, capped at 30s (`runWithTransientRetry`).
 */
export const APPLE_NETWORK_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

// What macOS tools print when Apple was unreachable rather than when Apple
// refused: NSURLErrorDomain timeouts, unresolvable or unreachable hosts, a lost
// or offline connection (notarytool), a 429 or 5xx from the notary API, the
// timestamp server being unreachable (codesign) and CloudKit being unreachable
// (stapler). An authentication, signature or Invalid verdict is none of these.
const TRANSIENT_APPLE_NETWORK_FAILURE = new RegExp([
  String.raw`NSURLErrorDomain Code=-10(?:01|03|04|05|09)\b`,
  String.raw`HTTPError\(statusCode: (?:429|5\d\d)\b`,
  'The Internet connection appears to be offline',
  'The network connection was lost',
  'The request timed out',
  'A timestamp was expected but was not found',
  'The timestamp service is not available',
  'Network Unavailable',
].join('|'));

export function isTransientAppleNetworkFailure({ stdout = '', stderr = '' }) {
  return TRANSIENT_APPLE_NETWORK_FAILURE.test(`${stdout}\n${stderr}`);
}

/** Runs a command, echoing its output to this process, and returns its result. */
export async function runAndCapture(command, args, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveRun({ code: code ?? signal, stdout, stderr }));
  });
}

function commandFailure(label, result) {
  return new Error(`${label} failed with status ${String(result.code)}\n${result.stderr || result.stdout}`.trim());
}

/**
 * Runs one Apple network command until it succeeds, retrying only a dropped
 * connection. Throws on any other failure, or once the attempts are spent.
 */
export async function runAppleNetworkCommand(label, command, args, {
  exec = runAndCapture,
  sleep = sleepFor,
  maxAttempts = APPLE_NETWORK_MAX_ATTEMPTS,
} = {}) {
  const result = await runWithTransientRetry({
    attempt: () => exec(command, args),
    isTransient: isTransientAppleNetworkFailure,
    maxAttempts,
    sleep,
    onRetry: ({ attempt, delay }) => {
      console.warn(`${label} could not reach Apple on attempt ${attempt}; retrying in ${delay} ms`);
    },
  });
  if (result.code !== 0) throw commandFailure(label, result);
  return result;
}

function parseNotaryJson(label, result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} printed no JSON result\n${result.stderr || result.stdout}`.trim());
  }
}

/**
 * Submits `path` to Apple's notary service and waits for its verdict.
 *
 * Submit and wait are separate calls so that a connection lost while waiting
 * (Apple can take most of an hour) resumes the wait on the same submission id
 * instead of failing the release or uploading again. `timeout`, when given, is
 * passed to each `notarytool wait` call.
 */
export async function notarizeWithResumableWait({
  path,
  credentials,
  timeout,
  exec = runAndCapture,
  sleep = sleepFor,
  maxAttempts = APPLE_NETWORK_MAX_ATTEMPTS,
}) {
  const options = { exec, sleep, maxAttempts };
  const submitted = parseNotaryJson('notarytool submit', await runAppleNetworkCommand(
    'notarytool submit',
    '/usr/bin/xcrun',
    ['notarytool', 'submit', path, ...credentials, '--output-format', 'json'],
    options,
  ));
  const id = submitted?.id;
  if (typeof id !== 'string' || !id) throw new Error('notarytool submit returned no submission id');
  console.log(`Submitted ${path} for notarization as ${id}`);

  const waitArgs = ['notarytool', 'wait', id, ...credentials, '--output-format', 'json'];
  if (timeout) waitArgs.push('--timeout', timeout);
  const waited = await runWithTransientRetry({
    attempt: () => exec('/usr/bin/xcrun', waitArgs),
    isTransient: isTransientAppleNetworkFailure,
    maxAttempts,
    sleep,
    onRetry: ({ attempt, delay }) => {
      console.warn(`notarytool wait on ${id} could not reach Apple on attempt ${attempt}; resuming in ${delay} ms`);
    },
  });
  // notarytool exits non-zero on an Invalid verdict too, so read the verdict
  // whenever it printed one and fall back to the exit status only without it.
  let verdict;
  try {
    verdict = JSON.parse(waited.stdout);
  } catch {
    verdict = undefined;
  }
  if (verdict?.status === 'Accepted') return { id };
  if (typeof verdict?.status === 'string') {
    const log = await exec('/usr/bin/xcrun', ['notarytool', 'log', id, ...credentials]);
    throw new Error(
      `Apple notarization of ${path} ended ${verdict.status} (submission ${id})\n${log.stdout || log.stderr}`.trim(),
    );
  }
  throw commandFailure(`notarytool wait on ${id}`, waited);
}
