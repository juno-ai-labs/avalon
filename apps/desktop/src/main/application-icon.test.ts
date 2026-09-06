import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationIconChoices } from '../common/application-icons';
import {
  applicationIconPath,
  applicationIconPreferenceDirectoryForLaunch,
  clearStoredApplicationIcon,
  parseStoredApplicationIcon,
  readStoredApplicationIcon,
  writeStoredApplicationIcon,
} from './application-icon';

const temporaryDirectories: string[] = [];
const resourceDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../resources/app-icons',
);
const previewDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../renderer/assets/app-icons',
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('application icon persistence', () => {
  it('uses the Dock plugin directory for packaged launches but isolates smoke tests', () => {
    expect(applicationIconPreferenceDirectoryForLaunch(
      '/Users/test/Library/Application Support',
      '/tmp/rally-profile',
      true,
      false,
    )).toBe('/Users/test/Library/Application Support/Rally');
    expect(applicationIconPreferenceDirectoryForLaunch(
      '/Users/test/Library/Application Support',
      '/tmp/rally-profile',
      true,
      true,
    )).toBe('/tmp/rally-profile');
    expect(applicationIconPreferenceDirectoryForLaunch(
      '/Users/test/Library/Application Support',
      '/tmp/rally-development',
      false,
      false,
    )).toBe('/tmp/rally-development');
  });

  it('accepts only the versioned allowlisted preference shape', () => {
    expect(parseStoredApplicationIcon({ version: 1, icon: 'calm' })).toBe('calm');
    expect(parseStoredApplicationIcon({ version: 2, icon: 'calm' })).toBeNull();
    expect(parseStoredApplicationIcon({ version: 1, icon: '../../private' })).toBeNull();
    expect(parseStoredApplicationIcon({ version: 1, icon: 'ludicrous-speed' })).toBeNull();
    expect(parseStoredApplicationIcon(null)).toBeNull();
  });

  it('distinguishes retired preferences from missing or malformed preferences', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'rally-application-icon-'));
    temporaryDirectories.push(directory);
    for (const icon of ['ludicrous-speed', 'grass-court', 'clay-court', 'hard-court', 'ball-felt', 'night-match']) {
      await writeFile(resolve(directory, 'application-icon.json'), JSON.stringify({ version: 1, icon }));
      expect(await readStoredApplicationIcon(directory)).toBe('retired');
    }
    await writeFile(resolve(directory, 'application-icon.json'), JSON.stringify({ version: 2, icon: 'grass-court' }));
    expect(await readStoredApplicationIcon(directory)).toBeNull();
  });

  it('writes, replaces, and clears the device preference atomically', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'rally-application-icon-'));
    temporaryDirectories.push(directory);

    expect(await readStoredApplicationIcon(directory)).toBeNull();
    await writeStoredApplicationIcon(directory, 'ludicrous');
    expect(await readStoredApplicationIcon(directory)).toBe('ludicrous');
    await writeStoredApplicationIcon(directory, 'builder');
    expect(await readStoredApplicationIcon(directory)).toBe('builder');
    expect((await stat(resolve(directory, 'application-icon.json'))).mode & 0o777).toBe(0o600);
    await clearStoredApplicationIcon(directory);
    expect(await readStoredApplicationIcon(directory)).toBeNull();
  });

  it('ships every allowlisted Icon Composer artwork source as a full-size PNG', async () => {
    for (const choice of applicationIconChoices) {
      const encoded = await readFile(resolve(resourceDirectory, choice.artworkFileName));
      expect(encoded.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(encoded.toString('ascii', 12, 16)).toBe('IHDR');
      expect(encoded.readUInt32BE(16)).toBe(1024);
      expect(encoded.readUInt32BE(20)).toBe(1024);
    }
  });

  it('resolves packaged selectable icons to system-compiled ICNS resources', () => {
    expect(applicationIconPath('/Applications/Rally.app/Contents/Resources/app-icons', 'ludicrous'))
      .toBe('/Applications/Rally.app/Contents/Resources/app-icons/ludicrous.icns');
  });

  it('provides compact Retina previews for every selectable icon', async () => {
    for (const choice of applicationIconChoices) {
      const encoded = await readFile(resolve(previewDirectory, choice.artworkFileName));
      expect(encoded.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(encoded.readUInt32BE(16)).toBe(128);
      expect(encoded.readUInt32BE(20)).toBe(128);
    }
  });
});
