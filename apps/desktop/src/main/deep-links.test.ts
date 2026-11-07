import { describe, expect, it } from 'vitest';

import { uuidToBase58 } from '@rally/contracts/uuid-base58';

import {
  acceptedDeepLink,
  isConnectorOAuthResult,
  shouldDeliverConnectorResultToSettings,
  httpsLinkDeepLink,
  isRetiredDeepLink,
} from './deep-links';

const WORKSPACE_ID = '00000000-0000-7000-8000-000000000019';
const WORKSTREAM_ID = '00000000-0000-7000-8000-000000000021';
const CONNECTION_ID = '00000000-0000-7000-8000-000000000022';

describe('main-process organization deep-link boundary', () => {
  it('accepts the organization-addressed forms', () => {
    for (const target of [
      `rallywithai://workspace/global/${WORKSPACE_ID}/canvases/${uuidToBase58(WORKSTREAM_ID)}`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/settings/digest`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/automations/new`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/slack/link?token=${'a'.repeat(43)}`,
    ]) {
      expect(acceptedDeepLink(target), target).toBe(target);
    }
  });

  it('rejects partial, duplicate, and augmented organization targets', () => {
    for (const target of [
      // A Thread's deep link, addressed or not, went with Threads.
      `rallywithai://workstreams/${WORKSTREAM_ID}`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/workstreams/${WORKSTREAM_ID}`,
      `rallywithai://workspace/global/${WORKSPACE_ID}/canvases/${uuidToBase58(WORKSTREAM_ID)}?region=global`,
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

describe('an HTTPS link onto an artifact', () => {
  it('becomes a deep link the main process accepts, naming the artifact under its Canvas', () => {
    const [workspace, canvas, artifact] = [WORKSPACE_ID, WORKSTREAM_ID, '00000000-0000-7000-8000-000000000023'].map(uuidToBase58);
    const deepLink = httpsLinkDeepLink(`https://rallywith.ai/app/global/${workspace}/cv/${canvas}/a/${artifact}/`);
    expect(deepLink).toBe(`rallywithai://workspace/global/${workspace}/canvases/${canvas}/artifacts/${artifact}`);
    expect(acceptedDeepLink(deepLink!)).toBe(deepLink);
  });
});

describe('a link to something retired with Threads', () => {
  it('is recognized by shape, so main can say it no longer exists', () => {
    for (const retired of [
      'rallywithai://workstreams/new',
      'rallywithai://workstreams/00000000-0000-7000-8000-000000000021',
      'rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/workstreams/00000000-0000-7000-8000-000000000021',
      'rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/spaces/1111117Hxt1fAWDjN7TX/channels/1111117Hxt1fAWDjN7TY',
      'avalon://workstreams/00000000-0000-7000-8000-000000000021',
      'https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY',
      'https://www.rallywith.ai/app/workspaces/global/00000000-0000-7000-8000-000000000019/workstreams/00000000-0000-7000-8000-000000000021',
    ]) {
      expect(isRetiredDeepLink(retired), retired).toBe(true);
      expect(acceptedDeepLink(retired), retired).toBeNull();
    }
  });

  it('leaves current, unrelated and malformed links alone', () => {
    for (const other of [
      'rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX',
      'rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/sidekicks/1111117Hxt1fAWDjN7TX',
      'rallywithai://settings/connections',
      'rallywithai://notes/abc',
      'https://rallywith.ai/app/workspaces/global/00000000-0000-7000-8000-000000000019',
      'https://evil.example/app/workstreams/00000000-0000-7000-8000-000000000021',
      'not a url',
    ]) expect(isRetiredDeepLink(other), other).toBe(false);
  });
});
