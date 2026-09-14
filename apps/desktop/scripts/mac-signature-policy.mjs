export const NESTED_COMPONENT_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.device.audio-input',
  'com.apple.security.network.client',
]);

export const RALLY_UPDATE_URL = 'https://downloads.rallywith.ai/stable/darwin/arm64';

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
  if (urlLines.length !== 1 || yamlScalar(urlLines[0]) !== RALLY_UPDATE_URL) {
    throw new Error(`Embedded app-update.yml URL must be exactly ${RALLY_UPDATE_URL}`);
  }
}

export function assertPushProvisioning(profile, entitlements, now = Date.now()) {
  if (profile.ProvisionsAllDevices !== true) throw new Error('Push provisioning profile must support Developer ID distribution');
  const domains = ['applinks:rallywith.ai', 'applinks:www.rallywith.ai'];
  if (!profile.TeamIdentifier?.includes('7ZLT6A8W25')
    || profile.Entitlements?.['com.apple.application-identifier'] !== '7ZLT6A8W25.ai.rallywith.desktop'
    || profile.Entitlements?.['com.apple.developer.aps-environment'] !== 'production'
    || !(Date.parse(profile.ExpirationDate) > now)) throw new Error('Push provisioning profile has the wrong app, team, environment, or is expired');
  const allowedDomains = profile.Entitlements['com.apple.developer.associated-domains'];
  if (!Array.isArray(allowedDomains) || (!allowedDomains.includes('*') && domains.some((domain) => !allowedDomains.includes(domain)))) {
    throw new Error('Provisioning profile does not allow Rally associated domains');
  }
  const keys = Object.keys(entitlements).filter((key) => !['com.apple.developer.aps-environment', 'com.apple.developer.associated-domains', 'com.apple.application-identifier', 'com.apple.developer.team-identifier'].includes(key));
  assertExactNestedEntitlements(keys, 'Main app');
  if (entitlements['com.apple.developer.aps-environment'] !== 'production'
    || JSON.stringify([...entitlements['com.apple.developer.associated-domains'] ?? []].sort()) !== JSON.stringify(domains.sort())) {
    throw new Error('Main app must carry production push and exactly the Rally associated domains');
  }
}
