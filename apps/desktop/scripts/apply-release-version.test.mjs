import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { applyManifestVersion, applyReleaseVersion } from './apply-release-version.mjs';

const manifest = (version) => `{\n  "name": "@rally/desktop",\n  "version": "${version}",\n`
  + `  "private": true,\n  "dependencies": {\n    "electron-updater": "6.8.9"\n  }\n}\n`;

test('only the version line changes', () => {
  const source = manifest('1.33.0');
  const { text, changed, previousVersion } = applyManifestVersion(source, '1.34.0');

  assert.equal(changed, true);
  assert.equal(previousVersion, '1.33.0');
  assert.equal(text, manifest('1.34.0'));
  // Formatting is preserved rather than round-tripped through JSON, so the
  // release bump stays a one-line diff a human can review.
  assert.equal(text.split('\n').length, source.split('\n').length);
});

test('a manifest already at the version is left untouched', () => {
  // The resumable state after a release that failed past the bump.
  const source = manifest('1.34.0');
  const { text, changed } = applyManifestVersion(source, '1.34.0');

  assert.equal(changed, false);
  assert.equal(text, source);
});

test('a nested version field is never mistaken for the manifest version', () => {
  const source = '{\n  "name": "x",\n  "version": "1.33.0",\n  "dependencies": {\n'
    + '    "thinking-orbs": "0.2.0"\n  },\n  "pnpm": {\n    "overrides": {\n'
    + '      "version": "9.9.9"\n    }\n  }\n}\n';
  const { text } = applyManifestVersion(source, '1.34.0');

  assert.equal(JSON.parse(text).version, '1.34.0');
  assert.equal(JSON.parse(text).pnpm.overrides.version, '9.9.9');
});

test('a manifest without a top-level version fails instead of inventing one', () => {
  assert.throws(() => applyManifestVersion('{\n  "name": "x"\n}\n', '1.34.0'), /exactly one top-level version/u);
});

test('both workspace manifests are stamped together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-release-version-'));
  try {
    const root = resolve(directory, 'package.json');
    const desktop = resolve(directory, 'desktop.json');
    await writeFile(root, manifest('1.33.0'));
    await writeFile(desktop, manifest('1.33.0'));

    const outcome = await applyReleaseVersion('1.34.0', [root, desktop]);

    assert.equal(outcome.changed, true);
    // validate-release-tag.mjs rejects the release unless both agree with the
    // tag, so stamping one without the other must not be possible.
    for (const path of [root, desktop]) {
      assert.equal(JSON.parse(await readFile(path, 'utf8')).version, '1.34.0');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the release version policy is enforced before anything is written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-release-version-'));
  try {
    const root = resolve(directory, 'package.json');
    await writeFile(root, manifest('1.33.0'));

    await assert.rejects(() => applyReleaseVersion('1.34.1', [root]), /patch 0/u);
    await assert.rejects(() => applyReleaseVersion('1.34.0-rc.1', [root]), /patch 0/u);
    assert.equal(JSON.parse(await readFile(root, 'utf8')).version, '1.33.0');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
