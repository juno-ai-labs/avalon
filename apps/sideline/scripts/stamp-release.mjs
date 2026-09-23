#!/usr/bin/env node
// Plan and stamp against the same main tip. Other release workflows also write
// to main, so a lost push means the release inputs and API gate must be planned
// again before any code is verified or signed.

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from '../../desktop/scripts/entry-point.mjs';
import { applySidelineReleaseVersion } from './apply-release-version.mjs';
import { planFromHead } from './plan-release.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function git(args, cwd) {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function applyVersion(version, cwd) {
  return applySidelineReleaseVersion(version, resolve(cwd, 'apps/sideline/package.json'));
}

function remoteTagExists(tag, cwd) {
  return git(['ls-remote', '--refs', 'origin', `refs/tags/${tag}`], cwd) !== '';
}

function pushStamp(cwd) {
  const result = spawnSync('/usr/bin/git', ['push', 'origin', 'HEAD:main'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

async function writeOutputs(plan, commit, outputPath) {
  const outputs = [
    `should_release=${plan.shouldRelease}`,
    `version=${plan.version}`,
    `tag=${plan.tag}`,
    `ref=${plan.ref}`,
    `requires_api_deploy=${plan.requiresApiDeploy}`,
    `api_deployment_ref=${plan.apiDeploymentRef}`,
    `commit=${commit}`,
  ];
  await writeFile(outputPath, `${outputs.join('\n')}\n`, { flag: 'a' });
}

export async function stampSidelineRelease({
  cwd = repositoryDirectory,
  outputPath = process.env.GITHUB_OUTPUT,
  planRelease = planFromHead,
  applyReleaseVersion = applyVersion,
} = {}) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required to stamp a Sideline release');

  while (true) {
    git(['fetch', '--tags', 'origin', 'main'], cwd);
    git(['reset', '--hard', 'origin/main'], cwd);
    const plannedTip = git(['rev-parse', 'HEAD'], cwd);
    const plan = await planRelease(cwd);
    console.log(`Sideline release plan: ${plan.shouldRelease ? 'release' : 'skip'} — ${plan.reason}`);

    if (!plan.shouldRelease) {
      // A Rally bot stamp can change root package.json, a Sideline release
      // input, without triggering another workflow run.
      git(['fetch', 'origin', 'main'], cwd);
      if (git(['rev-parse', 'origin/main'], cwd) !== plannedTip) {
        console.log('main moved after Sideline planning; replanning');
        continue;
      }
      await writeOutputs(plan, plannedTip, outputPath);
      return plan;
    }

    if (remoteTagExists(plan.tag, cwd)) {
      throw new Error(`${plan.tag} already exists; refusing to rebuild a published version`);
    }

    await applyReleaseVersion(plan.version, cwd);
    const changed = git(['status', '--porcelain', '--', 'apps/sideline/package.json'], cwd) !== '';
    if (changed) {
      git(['add', 'apps/sideline/package.json'], cwd);
      git([
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `Bump Sideline to ${plan.version} for release`,
      ], cwd);
      const pushed = pushStamp(cwd);
      if (pushed.status !== 0) {
        git(['fetch', 'origin', 'main'], cwd);
        if (git(['rev-parse', 'origin/main'], cwd) === plannedTip) {
          throw new Error(`Could not push Sideline release stamp: ${pushed.stderr.trim()}`);
        }
        console.log('main moved while stamping Sideline; replanning');
        continue;
      }
    } else {
      console.log(`main already declares ${plan.version}; resuming its unpublished release`);
    }

    const commit = git(['rev-parse', 'HEAD'], cwd);
    await writeOutputs(plan, commit, outputPath);
    return { ...plan, commit };
  }
}

if (isEntryPoint(import.meta.url)) {
  stampSidelineRelease().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Sideline release stamping failed');
    process.exitCode = 1;
  });
}
