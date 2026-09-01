import { describe, expect, it } from 'vitest';

import { parseDesktopDeepLinkIntent } from './desktop-deep-link-intent';

const WORKSPACE_ID = '00000000-0000-7000-8000-000000000009';
const RESOURCE_ID = '00000000-0000-7000-8000-000000000010';
const ATTEMPT_ID = 'a'.repeat(43);

describe('desktop deep-link intent grammar', () => {
  it.each([
    {
      raw: `rallywithai://workspace/eu/${WORKSPACE_ID}/workstreams/${RESOURCE_ID}`,
      kind: 'workstream',
    },
    {
      raw: `rallywithai://workspace/eu/${WORKSPACE_ID}/settings/connections`,
      kind: 'settings',
    },
    {
      raw: `rallywithai://workspace/eu/${WORKSPACE_ID}/automations/new`,
      kind: 'new-automation',
    },
    {
      raw: `rallywithai://workspace/eu/${WORKSPACE_ID}/slack/link?token=${ATTEMPT_ID}`,
      kind: 'slack-link',
    },
    {
      raw: `rallywithai://workspace/eu/${WORKSPACE_ID}/auth/complete?connection=${RESOURCE_ID}&status=connected&attempt=${ATTEMPT_ID}&provider=github`,
      kind: 'connector-result',
    },
  ])('parses one shared addressed $kind shape', ({ raw, kind }) => {
    expect(parseDesktopDeepLinkIntent(raw)).toMatchObject({
      kind,
      target: { region: 'eu', workspaceId: WORKSPACE_ID },
    });
  });

  it.each([
    `rallywithai://workstreams/${RESOURCE_ID}?region=eu&workspace=${WORKSPACE_ID}`,
    `rallywithai://settings/connections?region=eu&workspace=${WORKSPACE_ID}`,
    `rallywithai://automations/new?region=eu&workspace=${WORKSPACE_ID}`,
    `rallywithai://slack/link?token=${ATTEMPT_ID}&region=eu&workspace=${WORKSPACE_ID}`,
    `rallywithai://auth/complete?connection=${RESOURCE_ID}&status=connected&region=eu&workspace=${WORKSPACE_ID}&provider=github`,
  ])('rejects the pre-release query-addressed shape: %s', (raw) => {
    expect(parseDesktopDeepLinkIntent(raw)).toBeNull();
  });

  it('keeps legacy unaddressed identity and connector callbacks during rollout', () => {
    expect(parseDesktopDeepLinkIntent(
      `avalon://auth/complete?ticket=${ATTEMPT_ID}&region=global&attempt=${ATTEMPT_ID}`,
    )).toMatchObject({ kind: 'identity-result', status: 'ticket' });
    expect(parseDesktopDeepLinkIntent(
      `avalon://auth/complete?provider=linear&region=eu&status=denied&error=oauth_denied`,
    )).toMatchObject({ kind: 'connector-result', status: 'denied', target: null });
  });

  it.each([
    `rallywithai://workspace/eu/${WORKSPACE_ID}/settings/connections?extra=value`,
    `rallywithai://workspace/eu/${WORKSPACE_ID}/auth/complete?connection=${RESOURCE_ID}&status=connected&provider=unknown`,
    `rallywithai://workspace/eu/${WORKSPACE_ID}/auth/complete?connection=${RESOURCE_ID}&connection=${RESOURCE_ID}&status=connected&provider=google`,
    `https://rallywith.ai/workspace/eu/${WORKSPACE_ID}/settings/connections`,
  ])('rejects malformed or non-desktop input: %s', (raw) => {
    expect(parseDesktopDeepLinkIntent(raw)).toBeNull();
  });
});
