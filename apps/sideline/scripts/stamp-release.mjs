#!/usr/bin/env node
// Plan and stamp against the same main tip. Other release workflows also write
// to main, so a lost push means the release inputs and API gate must be planned
// again before any code is verified or signed.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from '../../desktop/scripts/entry-point.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function git(args, cwd) {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function run(args, cwd, environment = process.env) {
  execFileSync(process.execPath, args, { cwd, env: environment, stdio: 'inherit' });
}

function parsePlannerOutputs(value) {
  const outputs = Object.fromEntries(value.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Invalid Sideline release plan output: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  for (const key of ['should_release', 'version', 'tag', 'ref', 'requires_api_deploy', 'api_deployment_ref']) {
    if (!(key in outputs)) throw new Error(`Sideline release plan omitted ${key}`);
  }
  return outputs;
}

async function planCurrentTree(cwd) {
  const directory = await mkdtemp(join(tmpdir(), 'sideline-release-plan-'));
  const outputPath = join(directory, 'outputs');
  try {
    run(['apps/sideline/scripts/plan-release.mjs'], cwd, {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
    });
    return parsePlannerOutputs(await readFile(outputPath, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function applyVersion(version, cwd) {
  run(['apps/sideline/scripts/apply-release-version.mjs', version], cwd);
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

export async function stampSidelineRelease({
  cwd = repositoryDirectory,
  outputPath = process.env.GITHUB_OUTPUT,
  planRelease = planCurrentTree,
  applyReleaseVersion = applyVersion,
} = {}) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required to stamp a Sideline release');

  while (true) {
    git(['fetch', '--tags', 'origin', 'main'], cwd);
    git(['reset', '--hard', 'origin/main'], cwd);
    const plannedTip = git(['rev-parse', 'HEAD'], cwd);
    const plan = await planRelease(cwd);
    if (plan.ref !== plannedTip) throw new Error('Sideline planner did not read the checked-out main tip');

    if (plan.should_release === 'false') {
      git(['fetch', 'origin', 'main'], cwd);
      if (git(['rev-parse', 'origin/main'], cwd) !== plannedTip) {
        console.log('main moved after Sideline planning; replanning');
        continue;
      }
      await writeFile(outputPath, `${Object.entries(plan).map(([key, value]) => `${key}=${value}`).join('\n')}\ncommit=${plannedTip}\n`, { flag: 'a' });
      return plan;
    }
    if (plan.should_release !== 'true') throw new Error(`Invalid Sideline release decision: ${plan.should_release}`);

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
      git(['fetch', 'origin', 'main'], cwd);
      if (git(['rev-parse', 'origin/main'], cwd) !== plannedTip) {
        console.log('main moved while resuming Sideline; replanning');
        continue;
      }
      console.log(`main already declares ${plan.version}; resuming its unpublished release`);
    }

    const commit = git(['rev-parse', 'HEAD'], cwd);
    await writeFile(outputPath, `${Object.entries(plan).map(([key, value]) => `${key}=${value}`).join('\n')}\ncommit=${commit}\n`, { flag: 'a' });
    return { ...plan, commit };
  }
}

if (isEntryPoint(import.meta.url)) {
  stampSidelineRelease().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Sideline release stamping failed');
    process.exitCode = 1;
  });
}
