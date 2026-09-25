import "../../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import { workstreamHttpsDeepLink } from './deep-links';
import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
const id = '00000000-0000-7000-8000-000000000001';
describe('Apple channel links', () => {
  it('adapts Base58 Space, Channel, and Breakout paths with their placement', () => {
    const root = 'https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/';
    expect(parseDesktopDeepLinkIntent(workstreamHttpsDeepLink(root)!)).toMatchObject({ kind: 'space', spaceId: '00000000-0000-7000-8000-000000000002' });
    expect(parseDesktopDeepLinkIntent(workstreamHttpsDeepLink(`${root}c/1111117Hxt1fAWDjN7TY/b/1111117Hxt1fAWDjN7Te`)!))
      .toMatchObject({ kind: 'workstream', spaceId: '00000000-0000-7000-8000-000000000002', substreamId: '00000000-0000-7000-8000-000000000009' });
  });
  it('adapts a Base58 Sidekick path into its addressed screen', () => {
    expect(parseDesktopDeepLinkIntent(workstreamHttpsDeepLink('https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/sidekicks/1111117Hxt1fAWDjN7TX/')!))
      .toMatchObject({ kind: 'sidekick', sidekickId: '00000000-0000-7000-8000-000000000002', target: { region: 'global' } });
  });
  it('adapts an addressed private child into the existing scheme parser', () => {
    const link = workstreamHttpsDeepLink(`https://rallywith.ai/app/workspaces/enterprise/${id}/workstreams/${id}/substreams/${id}`);
    expect(link).not.toBeNull();
    expect(parseDesktopDeepLinkIntent(link!)).toMatchObject({ kind: 'workstream' });
    expect(link).toContain('substreams');
  });
  it('leaves legacy hosts and non-channel links in the browser', () => {
    expect(workstreamHttpsDeepLink(`https://with-avalon.com/app/workstreams/${id}`)).toBeNull();
    expect(workstreamHttpsDeepLink('https://rallywith.ai/download')).toBeNull();
    expect(workstreamHttpsDeepLink('rallywithai://settings')).toBeNull();
  });
});
