#!/usr/bin/env node
// Plans Sideline's automatic macOS release from the newest reachable Sideline
// tag. The tag's commit is the release watermark: only installed-app inputs
// changed after that commit justify another signed and notarized build.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from '../../desktop/scripts/entry-point.mjs';
import { parseVersion } from '../../desktop/scripts/release-lib.mjs';

const sidelineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(sidelineDirectory, '../..');

export const SIDELINE_RELEASE_EXACT_PATHS = new Set([
  '.github/workflows/release-sideline-macos.yml',
  '.npmrc',
  'apps/desktop/scripts/apple-notarization.mjs',
  'apps/desktop/scripts/apply-release-version.mjs',
  'apps/desktop/scripts/blockmap.mjs',
  'apps/desktop/scripts/entry-point.mjs',
  'apps/desktop/scripts/finalize-macos-release.mjs',
  'apps/desktop/scripts/release-cache.mjs',
  'apps/desktop/scripts/release-cloudflare.mjs',
  'apps/desktop/scripts/release-lib.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
]);

export const SIDELINE_RELEASE_PATH_PREFIXES = [
  'apps/sideline/',
  'packages/contracts/',
  'packages/ui/',
  'patches/',
];

export function sidelineReleaseInputPaths(paths) {
  return paths.filter((path) => SIDELINE_RELEASE_EXACT_PATHS.has(path)
    || SIDELINE_RELEASE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

export function stableVersion(value) {
  const parsed = parseVersion(value);
  if (parsed.prerelease.length > 0) {
    throw new Error(`Sideline releases require a stable semantic version; received ${value}`);
  }
  return value;
}

export function nextPatchVersion(value) {
  const parsed = parseVersion(stableVersion(value));
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function parseSidelineTag(tag) {
  if (!tag?.startsWith('sideline-v')) {
    throw new Error(`Sideline release tag must have the form sideline-v<semver>; received ${tag || '(empty)'}`);
  }
  return stableVersion(tag.slice('sideline-v'.length));
}

export function planSidelineRelease({
  headSha,
  manifestVersion,
  latestTag,
  changedPaths,
  apiDeploymentRef = headSha,
}) {
  stableVersion(manifestVersion);
  const base = { ref: headSha };
  const release = (version, reason, requiresApiDeploy) => ({
    ...base,
    shouldRelease: true,
    version,
    tag: `sideline-v${version}`,
    requiresApiDeploy,
    apiDeploymentRef: requiresApiDeploy ? apiDeploymentRef : '',
    reason,
  });
  const skip = (reason) => ({
    ...base,
    shouldRelease: false,
    version: manifestVersion,
    tag: `sideline-v${manifestVersion}`,
    requiresApiDeploy: false,
    apiDeploymentRef: '',
    reason,
  });

  if (!latestTag) {
    return release(
      manifestVersion,
      `no Sideline release tag exists, so ${manifestVersion} ships the current tree`,
      true,
    );
  }

  const releasedVersion = parseSidelineTag(latestTag);
  const candidate = nextPatchVersion(releasedVersion);
  if (manifestVersion !== releasedVersion && manifestVersion !== candidate) {
    throw new Error(
      `Sideline manifest ${manifestVersion} must match released ${releasedVersion} or resumable ${candidate}`,
    );
  }

  if (changedPaths === null) {
    return release(
      manifestVersion === candidate ? manifestVersion : candidate,
      `the ${latestTag} watermark could not be read, so the planner fails open`,
      true,
    );
  }

  const inputs = sidelineReleaseInputPaths(changedPaths);
  if (inputs.length === 0) {
    return skip(`no Sideline release inputs changed after ${latestTag}`);
  }

  const version = manifestVersion === candidate ? manifestVersion : candidate;
  return release(
    version,
    `${inputs.length} Sideline release input(s) changed: ${inputs.slice(0, 5).join(', ')}`,
    inputs.some((path) => path.startsWith('packages/contracts/')),
  );
}

function gitOutput(args, cwd = repositoryDirectory) {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function latestReachableTag(headSha) {
  const tags = gitOutput([
    'for-each-ref',
    `--merged=${headSha}`,
    '--sort=-version:refname',
    '--format=%(refname:short)',
    'refs/tags/sideline-v*',
  ]).split('\n').filter(Boolean);
  return tags.find((tag) => {
    try {
      parseSidelineTag(tag);
      return true;
    } catch {
      return false;
    }
  });
}

function changedPathsSince(tag, headSha) {
  try {
    const base = gitOutput(['rev-parse', `${tag}^{commit}`]);
    const output = execFileSync(
      '/usr/bin/git',
      ['diff', '--no-renames', '--name-only', '-z', `${base}..${headSha}`],
      { cwd: repositoryDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return output.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

export function latestContractCommit(headSha, cwd = repositoryDirectory) {
  return gitOutput([
    'log', '-1', '--first-parent', '--format=%H', headSha, '--', 'packages/contracts',
  ], cwd);
}

function report(plan) {
  console.log(`Sideline release plan: ${plan.shouldRelease ? 'release' : 'skip'} — ${plan.reason}`);
  const outputs = [
    `should_release=${plan.shouldRelease}`,
    `version=${plan.version}`,
    `tag=${plan.tag}`,
    `ref=${plan.ref}`,
    `requires_api_deploy=${plan.requiresApiDeploy}`,
    `api_deployment_ref=${plan.apiDeploymentRef}`,
  ];
  if (process.env.GITHUB_OUTPUT) {
    return import('node:fs/promises')
      .then(({ appendFile }) => appendFile(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`));
  }
  console.log(outputs.join('\n'));
  return undefined;
}

async function main() {
  const headSha = gitOutput(['rev-parse', 'HEAD']);
  const manifest = JSON.parse(await readFile(resolve(sidelineDirectory, 'package.json'), 'utf8'));
  const latestTag = latestReachableTag(headSha);
  return report(planSidelineRelease({
    headSha,
    manifestVersion: manifest.version,
    latestTag,
    changedPaths: latestTag ? changedPathsSince(latestTag, headSha) : [],
    apiDeploymentRef: latestContractCommit(headSha),
  }));
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Planning the Sideline release failed');
    process.exitCode = 1;
  });
}
