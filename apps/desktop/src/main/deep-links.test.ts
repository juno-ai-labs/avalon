import { describe, expect, it } from 'vitest';

import {
  acceptedDeepLink,
  isConnectorOAuthResult,
  shouldDeliverConnectorResultToSettings,
} from './deep-links';

const WORKSPACE_ID = '00000000-0000-7000-8000-000000000019';
const WORKSTREAM_ID = '00000000-0000-7000-8000-000000000021';
const CONNECTION_ID = '00000000-0000-7000-8000-000000000022';

describe('main-process workspace deep-link boundary', () => {
  it('accepts legacy readers and the one workspace-addressed form', () => {
    for (const target of [
      `rallywithai://workstreams/${WORKSTREAM_ID}`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/workstreams/${WORKSTREAM_ID}`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/settings/digest`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/automations/new`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/slack/link?token=${'a'.repeat(43)}`,
    ]) {
      expect(acceptedDeepLink(target), target).toBe(target);
    }
  });

  it('rejects partial, duplicate, and augmented workspace targets', () => {
    for (const target of [
      `rallywithai://workstreams/${WORKSTREAM_ID}?region=global`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/settings/digest?workspace=${WORKSPACE_ID}`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/automations/new?template=other`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/slack/link?token=${'a'.repeat(43)}&workspace=${WORKSPACE_ID}`,
    ]) {
      expect(acceptedDeepLink(target), target).toBeNull();
    }
  });

  it('recognizes every shared connector provider, including Granola', () => {
    for (const provider of ['google', 'github', 'granola', 'linear', 'notion', 'slack']) {
      expect(isConnectorOAuthResult(
        `rallywithai://workspace/global/${WORKSPACE_ID}/auth/complete?provider=${provider}&connection=${CONNECTION_ID}&status=connected`,
      ), provider).toBe(true);
    }
  });

  it('delivers only legacy unaddressed connector results to Settings', () => {
    const result = `connection=${CONNECTION_ID}&status=connected&attempt=${'a'.repeat(43)}&provider=slack`;

    expect(shouldDeliverConnectorResultToSettings(
      `rallywithai://auth/complete?${result}&region=global`,
    )).toBe(true);
    expect(shouldDeliverConnectorResultToSettings(
      `rallywithai://workspace/global/${WORKSPACE_ID}/auth/complete?${result}`,
    )).toBe(false);
    expect(shouldDeliverConnectorResultToSettings(
      `rallywithai://workspace/global/${WORKSPACE_ID}/settings/connections`,
    )).toBe(false);
  });
});
