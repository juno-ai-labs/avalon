import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AVALON_UPDATE_URL,
  assertDeveloperIdDetails,
  assertEmbeddedUpdateConfig,
  assertExactNestedEntitlements,
} from './mac-signature-policy.mjs';

test('nested components permit exactly the two audited Electron entitlements', () => {
  assert.doesNotThrow(() => assertExactNestedEntitlements([
    'com.apple.security.network.client',
    'com.apple.security.cs.allow-jit',
  ], 'Helper'));
  assert.throws(
    () => assertExactNestedEntitlements([
      'com.apple.security.cs.allow-jit',
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

test('nested components require the Avalon Developer ID team', () => {
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
    `url: ${AVALON_UPDATE_URL}`,
    '',
  ].join('\n')));
  assert.throws(
    () => assertEmbeddedUpdateConfig('provider: generic\nurl: https://downloads.with-avalon.com/beta/darwin/arm64\n'),
    /must be exactly/u,
  );
  assert.throws(
    () => assertEmbeddedUpdateConfig(`provider: generic\nprovider: generic\nurl: ${AVALON_UPDATE_URL}\n`),
    /exactly one generic/u,
  );
});
