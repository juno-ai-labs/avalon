export const NESTED_COMPONENT_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.device.audio-input',
  'com.apple.security.network.client',
]);

export const AVALON_UPDATE_URL = 'https://downloads.rallywith.ai/stable/darwin/arm64';

export function assertExactNestedEntitlements(keys, label) {
  const actual = [...new Set(keys)].sort();
  const expected = [...NESTED_COMPONENT_ENTITLEMENTS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `${label} entitlements must be exactly {${expected.join(', ')}}; found {${actual.join(', ')}}`,
    );
  }
}

export function assertEntitlementPlistMatchesPolicy(contents, label) {
  const keys = [...contents.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/gu)]
    .map((match) => match[1]);
  assertExactNestedEntitlements(keys, label);
}

export function assertDeveloperIdDetails(details, expectedTeam, label) {
  if (details.includes('(adhoc)') || !details.includes('Authority=Developer ID Application:')) {
    throw new Error(`${label} is not signed with a Developer ID Application identity`);
  }
  const team = details.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim();
  if (team !== expectedTeam) {
    throw new Error(`${label} is signed by Apple team ${team ?? '(missing)'}; expected ${expectedTeam}`);
  }
}

function yamlScalar(line) {
  const value = line.replace(/^\s*[^:]+:\s*/u, '').trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function assertEmbeddedUpdateConfig(contents) {
  const providerLines = contents.split('\n').filter((line) => /^\s*-?\s*provider\s*:/u.test(line));
  const urlLines = contents.split('\n').filter((line) => /^\s*url\s*:/u.test(line));
  if (providerLines.length !== 1 || yamlScalar(providerLines[0]) !== 'generic') {
    throw new Error('Embedded app-update.yml must contain exactly one generic update provider');
  }
  if (urlLines.length !== 1 || yamlScalar(urlLines[0]) !== AVALON_UPDATE_URL) {
    throw new Error(`Embedded app-update.yml URL must be exactly ${AVALON_UPDATE_URL}`);
  }
}
