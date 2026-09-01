import { describe, expect, it } from 'vitest';

import { acceptedDeepLink, isConnectorOAuthResult } from './deep-links';

const WORKSPACE_ID = '00000000-0000-7000-8000-000000000019';
const WORKSTREAM_ID = '00000000-0000-7000-8000-000000000021';
const CONNECTION_ID = '00000000-0000-7000-8000-000000000022';

describe('main-process workspace deep-link boundary', () => {
  it('accepts legacy readers and the one workspace-addressed form', () => {
    for (const target of [
      `rallywithai://workstreams/${WORKSTREAM_ID}`,
      `rallywithai://workstreams/${WORKSTREAM_ID}?region=global&workspace=${WORKSPACE_ID}`,
      `rallywithai://settings/digest?region=global&workspace=${WORKSPACE_ID}`,
      `rallywithai://automations/new?region=global&workspace=${WORKSPACE_ID}`,
      `rallywithai://slack/link?token=${'a'.repeat(43)}&region=global&workspace=${WORKSPACE_ID}`,
    ]) {
      expect(acceptedDeepLink(target), target).toBe(target);
    }
  });

  it('rejects partial, duplicate, and augmented workspace targets', () => {
    for (const target of [
      `rallywithai://workstreams/${WORKSTREAM_ID}?region=global`,
      `rallywithai://settings/digest?workspace=${WORKSPACE_ID}`,
      `rallywithai://automations/new?region=global&workspace=${WORKSPACE_ID}&template=other`,
      `rallywithai://slack/link?token=${'a'.repeat(43)}&region=global&workspace=${WORKSPACE_ID}&workspace=${WORKSPACE_ID}`,
    ]) {
      expect(acceptedDeepLink(target), target).toBeNull();
    }
  });

  it('recognizes every shared connector provider, including Granola', () => {
    for (const provider of ['google', 'github', 'granola', 'linear', 'notion', 'slack']) {
      expect(isConnectorOAuthResult(
        `rallywithai://auth/complete?provider=${provider}&region=global&workspace=${WORKSPACE_ID}&connection=${CONNECTION_ID}&status=connected`,
      ), provider).toBe(true);
    }
  });
});
