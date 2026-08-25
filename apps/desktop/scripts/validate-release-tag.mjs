import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReleaseTag } from './release-lib.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (!tag) throw new Error('Pass the release tag or set RELEASE_TAG');

const [rootPackage, desktopPackage] = await Promise.all([
  readFile(resolve(repositoryDirectory, 'package.json'), 'utf8').then(JSON.parse),
  readFile(resolve(desktopDirectory, 'package.json'), 'utf8').then(JSON.parse),
]);
const version = assertReleaseTag(tag, rootPackage.version, desktopPackage.version);

function git(...args) {
  return execFileSync('/usr/bin/git', args, {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let taggedCommit;
try {
  taggedCommit = git('rev-parse', `refs/tags/${tag}^{commit}`);
} catch (error) {
  throw new Error(`Release tag ${tag} does not exist in this checkout`, { cause: error });
}
const headCommit = git('rev-parse', 'HEAD');
if (taggedCommit !== headCommit) {
  throw new Error(`Release tag ${tag} points to ${taggedCommit}, but HEAD is ${headCommit}`);
}

console.log(`Release guard passed: ${tag} at ${headCommit} packages Rally ${version}`);
