import "../../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import { workstreamHttpsDeepLink } from './deep-links';
import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
const id = '00000000-0000-7000-8000-000000000001';
describe('Apple work-stream links', () => {
  it('adapts an addressed private child into the existing scheme parser', () => {
    const link = workstreamHttpsDeepLink(`https://rallywith.ai/app/workspaces/enterprise/${id}/workstreams/${id}/substreams/${id}`);
    expect(link).not.toBeNull();
    expect(parseDesktopDeepLinkIntent(link!)).toMatchObject({ kind: 'workstream' });
    expect(link).toContain('substreams');
  });
  it('leaves legacy hosts and non-work-stream links in the browser', () => {
    expect(workstreamHttpsDeepLink(`https://with-avalon.com/app/workstreams/${id}`)).toBeNull();
    expect(workstreamHttpsDeepLink('https://rallywith.ai/download')).toBeNull();
    expect(workstreamHttpsDeepLink('rallywithai://settings')).toBeNull();
  });
});
