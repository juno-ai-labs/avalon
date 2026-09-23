import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
          should_release: 'true',
          version: '0.1.6',
          tag: 'sideline-v0.1.6',
          ref,
          requires_api_deploy: plans === 1 ? 'false' : 'true',
          api_deployment_ref: plans === 1 ? '' : contractCommit,
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
