import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  RALLY_UPDATE_URL,
  assertDeveloperIdDetails,
  assertEmbeddedUpdateConfig,
  assertEntitlementPlistMatchesPolicy,
  assertExactNestedEntitlements,
} from './mac-signature-policy.mjs';

test('nested components permit exactly the audited Electron and microphone entitlements', () => {
  assert.doesNotThrow(() => assertExactNestedEntitlements([
    'com.apple.security.network.client',
    'com.apple.security.cs.allow-jit',
    'com.apple.security.device.audio-input',
  ], 'Helper'));
  assert.throws(
    () => assertExactNestedEntitlements([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
      'com.apple.security.network.client',
      'com.apple.developer.aps-environment',
    ], 'Helper'),
    /aps-environment/u,
  );
  assert.throws(
    () => assertExactNestedEntitlements(['com.apple.security.cs.allow-jit'], 'Helper'),
    /must be exactly/u,
  );
});

test('the checked-in inherited entitlement plist matches the signing allowlist', () => {
  const contents = readFileSync(new URL('../resources/entitlements.mac.inherit.plist', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertEntitlementPlistMatchesPolicy(contents, 'Inherited plist'));
});

test('the packaged app explains microphone and native system audio without requesting screen access', () => {
  const contents = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(contents, /^\s+NSMicrophoneUsageDescription:\s+\S.+$/mu);
  assert.match(contents, /^\s+NSAudioCaptureUsageDescription:\s+\S.+$/mu);
  assert.doesNotMatch(contents, /NSScreenCaptureUsageDescription/u);
  assert.match(contents, /from:\s+\.native-build\/system-audio-tap\.node/u);
  assert.match(contents, /from:\s+\.native-build\/unified-log\.node/u);
});

test('nested components require the Rally Developer ID team', () => {
  const details = [
    'Authority=Developer ID Application: Juno AI Labs Inc. (7ZLT6A8W25)',
    'TeamIdentifier=7ZLT6A8W25',
  ].join('\n');
  assert.doesNotThrow(() => assertDeveloperIdDetails(details, '7ZLT6A8W25', 'ShipIt'));
  assert.throws(
    () => assertDeveloperIdDetails(details, 'WRONGTEAM1', 'ShipIt'),
    /expected WRONGTEAM1/u,
  );
  assert.throws(
    () => assertDeveloperIdDetails('TeamIdentifier=7ZLT6A8W25', '7ZLT6A8W25', 'ShipIt'),
    /Developer ID/u,
  );
});

test('embedded updater is pinned to the stable arm64 channel', () => {
  assert.doesNotThrow(() => assertEmbeddedUpdateConfig([
    'provider: generic',
    `url: ${RALLY_UPDATE_URL}`,
    '',
  ].join('\n')));
  assert.throws(
    () => assertEmbeddedUpdateConfig('provider: generic\nurl: https://downloads.rallywith.ai/beta/darwin/arm64\n'),
    /must be exactly/u,
  );
  assert.throws(
    () => assertEmbeddedUpdateConfig(`provider: generic\nprovider: generic\nurl: ${RALLY_UPDATE_URL}\n`),
    /exactly one generic/u,
  );
});


test('profile decoder reads the Developer ID boolean using macOS plutil', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('./verify-macos-app.mjs', import.meta.url), 'utf8');
  const decoder = source.slice(source.indexOf('const profileField ='), source.indexOf('\nfunction verifyNestedComponent'));
  for (const expected of [true, false]) {
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>ProvisionsAllDevices</key><${expected}/>
      <key>TeamIdentifier</key><array><string>7ZLT6A8W25</string></array>
      <key>Entitlements</key><dict/>
      <key>ExpirationDate</key><date>2099-01-01T00:00:00Z</date>
    </dict></plist>`;
    runInNewContext(decoder, {
      spawnSync, profileResult: { stdout: xml }, appPath: '/fixture/Rally.app',
      inspectEntitlements: () => ({}),
      assertPushProvisioning: (profile) => assert.equal(profile.ProvisionsAllDevices, expected),
    });
  }
});

test('push profile must match the app capabilities and remain valid', async () => {
  const { assertPushProvisioning, NESTED_COMPONENT_ENTITLEMENTS } = await import('./mac-signature-policy.mjs');
  const entitlements = {
    ...Object.fromEntries(NESTED_COMPONENT_ENTITLEMENTS.map(key => [key, true])),
    'com.apple.developer.aps-environment': 'production',
    'com.apple.developer.associated-domains': ['applinks:rallywith.ai', 'applinks:www.rallywith.ai'],
  };
  const profile = { ProvisionsAllDevices: true, TeamIdentifier: ['7ZLT6A8W25'], ExpirationDate: '2099-01-01', Entitlements: { ...entitlements, 'com.apple.application-identifier': '7ZLT6A8W25.ai.rallywith.desktop' } };
  assert.doesNotThrow(() => assertPushProvisioning(profile, entitlements));
  assert.throws(() => assertPushProvisioning({ ...profile, ProvisionsAllDevices: false }, entitlements), /Developer ID/);
  assert.throws(() => assertPushProvisioning({ ...profile, ExpirationDate: '2020-01-01' }, entitlements), /expired/);
  assert.throws(() => assertPushProvisioning(profile, { ...entitlements, 'com.apple.developer.aps-environment': 'sandbox' }), /production push/);
});
