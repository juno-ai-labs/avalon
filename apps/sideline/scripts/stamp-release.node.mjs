import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planFromHead } from './plan-release.mjs';
import { stampSidelineRelease } from './stamp-release.mjs';

function git(cwd, args) {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('a competing main stamp replans the Sideline commit and API deployment gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sideline-stamp-race-'));
  const remote = join(root, 'origin.git');
  const author = join(root, 'author');
  const runner = join(root, 'runner');
  const rival = join(root, 'rival');
  const output = join(root, 'outputs');
  try {
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['clone', remote, author]);
    git(author, ['config', 'user.name', 'Release Test']);
    git(author, ['config', 'user.email', 'release-test@example.com']);
    await mkdir(join(author, 'apps/sideline'), { recursive: true });
    await mkdir(join(author, 'packages/contracts'), { recursive: true });
    await writeFile(join(author, 'apps/sideline/package.json'), '{"version":"0.1.5"}\n');
    await writeFile(join(author, 'packages/contracts/schema.ts'), 'export const version = 1;\n');
    git(author, ['add', '.']);
    git(author, ['commit', '-m', 'Seed Sideline']);
    git(author, ['push', 'origin', 'HEAD:main']);
    git(author, ['tag', 'sideline-v0.1.5']);
    git(author, ['push', 'origin', 'sideline-v0.1.5']);
    await writeFile(join(author, 'apps/sideline/source.ts'), 'export const changed = true;\n');
    git(author, ['add', '.']);
    git(author, ['commit', '-m', 'Change Sideline']);
    git(author, ['push', 'origin', 'HEAD:main']);
    git(root, ['clone', remote, runner]);
    git(root, ['clone', remote, rival]);
    git(rival, ['config', 'user.name', 'Rival Release']);
    git(rival, ['config', 'user.email', 'rival@example.com']);

    let plans = 0;
    let contractCommit = '';
    await stampSidelineRelease({
      cwd: runner,
      outputPath: output,
      planRelease: async (cwd) => {
        plans += 1;
        const ref = git(cwd, ['rev-parse', 'HEAD']);
        if (plans === 1) {
          await writeFile(join(rival, 'packages/contracts/schema.ts'), 'export const version = 2;\n');
          git(rival, ['add', '.']);
          git(rival, ['commit', '-m', 'Advance contracts while Sideline plans']);
          git(rival, ['push', 'origin', 'HEAD:main']);
          contractCommit = git(rival, ['rev-parse', 'HEAD']);
        }
        return {
          shouldRelease: true,
          version: '0.1.6',
          tag: 'sideline-v0.1.6',
          ref,
          requiresApiDeploy: plans !== 1,
          apiDeploymentRef: plans === 1 ? '' : contractCommit,
          reason: 'a Sideline input changed',
        };
      },
      applyReleaseVersion: async (version, cwd) => {
        await writeFile(join(cwd, 'apps/sideline/package.json'), `{"version":"${version}"}\n`);
      },
    });

    const stamped = git(runner, ['rev-parse', 'HEAD']);
    assert.equal(plans, 2);
    assert.equal(git(runner, ['rev-parse', 'origin/main']), stamped);
    assert.equal(git(runner, ['merge-base', contractCommit, stamped]), contractCommit);
    assert.equal(JSON.parse(await readFile(join(runner, 'apps/sideline/package.json'), 'utf8')).version, '0.1.6');
    const outputs = await readFile(output, 'utf8');
    assert.match(outputs, new RegExp(`^ref=${contractCommit}$`, 'mu'));
    assert.match(outputs, new RegExp(`^api_deployment_ref=${contractCommit}$`, 'mu'));
    assert.match(outputs, /^requires_api_deploy=true$/mu);
    assert.match(outputs, new RegExp(`^commit=${stamped}$`, 'mu'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing remote release tag stops stamping before changing the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sideline-stamp-tag-'));
  const remote = join(root, 'origin.git');
  const runner = join(root, 'runner');
  try {
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['clone', remote, runner]);
    await mkdir(join(runner, 'apps/sideline'), { recursive: true });
    await writeFile(join(runner, 'apps/sideline/package.json'), '{\n  "version": "0.1.5"\n}\n');
    git(runner, ['add', '.']);
    git(runner, ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.com', 'commit', '-m', 'Seed Sideline']);
    git(runner, ['push', 'origin', 'HEAD:main']);
    git(runner, ['tag', 'sideline-v0.1.6']);
    git(runner, ['push', 'origin', 'sideline-v0.1.6']);
    let applied = false;
    await assert.rejects(stampSidelineRelease({
      cwd: runner,
      outputPath: join(root, 'outputs'),
      planRelease: async (cwd) => ({
        shouldRelease: true,
        version: '0.1.6',
        tag: 'sideline-v0.1.6',
        ref: git(cwd, ['rev-parse', 'HEAD']),
        requiresApiDeploy: false,
        apiDeploymentRef: '',
        reason: 'a Sideline input changed',
      }),
      applyReleaseVersion: async () => { applied = true; },
    }), /sideline-v0\.1\.6 already exists/u);
    assert.equal(applied, false);
    assert.equal(JSON.parse(await readFile(join(runner, 'apps/sideline/package.json'), 'utf8')).version, '0.1.5');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bot stamp during a skipped plan is replanned from the new release input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sideline-stamp-skip-'));
  const remote = join(root, 'origin.git');
  const runner = join(root, 'runner');
  const rival = join(root, 'rival');
  const output = join(root, 'outputs');
  try {
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['clone', remote, runner]);
    await mkdir(join(runner, 'apps/sideline'), { recursive: true });
    await writeFile(join(runner, 'apps/sideline/package.json'), '{\n  "version": "0.1.5"\n}\n');
    await writeFile(join(runner, 'package.json'), '{"version":"1.445.0"}\n');
    git(runner, ['add', '.']);
    git(runner, ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.com', 'commit', '-m', 'Seed releases']);
    git(runner, ['push', 'origin', 'HEAD:main']);
    git(runner, ['tag', 'sideline-v0.1.5']);
    git(runner, ['push', 'origin', 'sideline-v0.1.5']);
    git(root, ['clone', remote, rival]);

    let plans = 0;
    await stampSidelineRelease({
      cwd: runner,
      outputPath: output,
      planRelease: async (cwd) => {
        const plan = await planFromHead(cwd);
        plans += 1;
        if (plans === 1) {
          assert.equal(plan.shouldRelease, false);
          await writeFile(join(rival, 'package.json'), '{"version":"1.446.0"}\n');
          git(rival, ['add', '.']);
          git(rival, ['-c', 'user.name=Rally Bot', '-c', 'user.email=rally-bot@example.com', 'commit', '-m', 'Bump Rally']);
          git(rival, ['push', 'origin', 'HEAD:main']);
        }
        return plan;
      },
    });

    assert.equal(plans, 2);
    assert.equal(JSON.parse(await readFile(join(runner, 'apps/sideline/package.json'), 'utf8')).version, '0.1.6');
    const stamped = git(runner, ['rev-parse', 'HEAD']);
    assert.equal(git(runner, ['rev-parse', 'origin/main']), stamped);
    assert.match(await readFile(output, 'utf8'), new RegExp(`^commit=${stamped}$`, 'mu'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unpublished stamped version resumes from that exact commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sideline-stamp-resume-'));
  const remote = join(root, 'origin.git');
  const runner = join(root, 'runner');
  const output = join(root, 'outputs');
  try {
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['clone', remote, runner]);
    await mkdir(join(runner, 'apps/sideline'), { recursive: true });
    await writeFile(join(runner, 'apps/sideline/package.json'), '{\n  "version": "0.1.5"\n}\n');
    git(runner, ['add', '.']);
    git(runner, ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.com', 'commit', '-m', 'Publish 0.1.5']);
    git(runner, ['tag', 'sideline-v0.1.5']);
    await writeFile(join(runner, 'apps/sideline/package.json'), '{\n  "version": "0.1.6"\n}\n');
    git(runner, ['add', '.']);
    git(runner, ['-c', 'user.name=Release Bot', '-c', 'user.email=release-bot@example.com', 'commit', '-m', 'Stamp unpublished 0.1.6']);
    const stamped = git(runner, ['rev-parse', 'HEAD']);
    git(runner, ['push', 'origin', 'HEAD:main']);
    git(runner, ['push', 'origin', 'sideline-v0.1.5']);

    await stampSidelineRelease({ cwd: runner, outputPath: output });
    assert.equal(git(runner, ['rev-parse', 'HEAD']), stamped);
    assert.equal(git(runner, ['rev-parse', 'origin/main']), stamped);
    assert.match(await readFile(output, 'utf8'), new RegExp(`^commit=${stamped}$`, 'mu'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
