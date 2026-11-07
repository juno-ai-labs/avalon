import "../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';

import { parseDesktopDeepLinkIntent } from './desktop-deep-link-intent';

const WORKSPACE_ID = '00000000-0000-7000-8000-000000000009';
const RESOURCE_ID = '00000000-0000-7000-8000-000000000010';
const ATTEMPT_ID = 'a'.repeat(43);

describe('desktop deep-link intent grammar', () => {
  it.each([
    {
      raw: `rallywithai://workspace/enterprise/${WORKSPACE_ID}/canvases/1111117Hxt1fAWDjN7Tm`,
      kind: 'canvas',
    },
    {
      raw: `rallywithai://workspace/enterprise/${WORKSPACE_ID}/settings/connections`,
      kind: 'settings',
    },
    {
      raw: `rallywithai://workspace/enterprise/${WORKSPACE_ID}/automations/new`,
      kind: 'new-automation',
    },
    {
      raw: `rallywithai://workspace/enterprise/${WORKSPACE_ID}/slack/link?token=${ATTEMPT_ID}`,
      kind: 'slack-link',
    },
    {
      raw: `rallywithai://workspace/enterprise/${WORKSPACE_ID}/auth/complete?connection=${RESOURCE_ID}&status=connected&attempt=${ATTEMPT_ID}&provider=github`,
      kind: 'connector-result',
    },
  ])('parses one shared addressed $kind shape', ({ raw, kind }) => {
    expect(parseDesktopDeepLinkIntent(raw)).toMatchObject({
      kind,
      target: { region: 'enterprise', workspaceId: WORKSPACE_ID },
    });
  });

  it.each([
    `rallywithai://workstreams/${RESOURCE_ID}?region=enterprise&workspace=${WORKSPACE_ID}`,
    `rallywithai://settings/connections?region=enterprise&workspace=${WORKSPACE_ID}`,
    `rallywithai://automations/new?region=enterprise&workspace=${WORKSPACE_ID}`,
    `rallywithai://slack/link?token=${ATTEMPT_ID}&region=enterprise&workspace=${WORKSPACE_ID}`,
    `rallywithai://auth/complete?connection=${RESOURCE_ID}&status=connected&region=enterprise&workspace=${WORKSPACE_ID}&provider=github`,
  ])('rejects the pre-release query-addressed shape: %s', (raw) => {
    expect(parseDesktopDeepLinkIntent(raw)).toBeNull();
  });

  it('opens each settings page an email or the app links to, and no other', () => {
    for (const section of ['workspace', 'members', 'connections', 'digest']) {
      expect(parseDesktopDeepLinkIntent(`rallywithai://workspace/enterprise/${WORKSPACE_ID}/settings/${section}`))
        .toMatchObject({ kind: 'settings', section, target: { region: 'enterprise', workspaceId: WORKSPACE_ID } });
    }
    expect(parseDesktopDeepLinkIntent(`rallywithai://workspace/enterprise/${WORKSPACE_ID}/settings/application`)).toBeNull();
  });

  it('opens an access request from the menu bar, and nothing else under that host', () => {
    expect(parseDesktopDeepLinkIntent(`rallywithai://access-requests/${RESOURCE_ID}`))
      .toEqual({ kind: 'access-request', requestId: RESOURCE_ID, target: null });
    expect(parseDesktopDeepLinkIntent(`rallywithai://workspace/enterprise/${WORKSPACE_ID}/access-requests/${RESOURCE_ID}`))
      .toMatchObject({ kind: 'access-request', requestId: RESOURCE_ID, target: { region: 'enterprise', workspaceId: WORKSPACE_ID } });
    expect(parseDesktopDeepLinkIntent('rallywithai://access-requests/not-an-id')).toBeNull();
    expect(parseDesktopDeepLinkIntent(`rallywithai://access-requests/${RESOURCE_ID}/approve`)).toBeNull();
    expect(parseDesktopDeepLinkIntent(`rallywithai://access-requests/${RESOURCE_ID}?decision=approve`)).toBeNull();
  });

  it('opens Activity in an organization, and nothing else under that host', () => {
    expect(parseDesktopDeepLinkIntent(`rallywithai://workspace/enterprise/${WORKSPACE_ID}/activity`))
      .toEqual({ kind: 'activity', target: { region: 'enterprise', workspaceId: WORKSPACE_ID } });
    expect(parseDesktopDeepLinkIntent('rallywithai://activity')).toEqual({ kind: 'activity', target: null });
    expect(parseDesktopDeepLinkIntent(`rallywithai://activity/${RESOURCE_ID}`)).toBeNull();
    expect(parseDesktopDeepLinkIntent('rallywithai://activity?filter=mentions')).toBeNull();
  });

  it('keeps legacy unaddressed identity and connector callbacks during rollout', () => {
    expect(parseDesktopDeepLinkIntent(
      `avalon://auth/complete?ticket=${ATTEMPT_ID}&region=global&attempt=${ATTEMPT_ID}`,
    )).toMatchObject({ kind: 'identity-result', status: 'ticket' });
    expect(parseDesktopDeepLinkIntent(
      `avalon://auth/complete?provider=linear&region=enterprise&status=denied&error=oauth_denied`,
    )).toMatchObject({ kind: 'connector-result', status: 'denied', target: null });
  });

  it.each([
    `rallywithai://workspace/enterprise/${WORKSPACE_ID}/settings/connections?extra=value`,
    `rallywithai://workspace/enterprise/${WORKSPACE_ID}/auth/complete?connection=${RESOURCE_ID}&status=connected&provider=unknown`,
    `rallywithai://workspace/enterprise/${WORKSPACE_ID}/auth/complete?connection=${RESOURCE_ID}&connection=${RESOURCE_ID}&status=connected&provider=google`,
    `https://rallywith.ai/workspace/enterprise/${WORKSPACE_ID}/settings/connections`,
  ])('rejects malformed or non-desktop input: %s', (raw) => {
    expect(parseDesktopDeepLinkIntent(raw)).toBeNull();
  });
});
