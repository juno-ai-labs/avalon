import "../../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import { httpsLinkDeepLink } from './deep-links';
import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
const id = '00000000-0000-7000-8000-000000000001';
describe('Apple universal links', () => {
  it('adapts a Base58 Canvas path, with the artifact it opens onto, into its addressed screen', () => {
    expect(httpsLinkDeepLink('https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/'))
      .toBe('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX');
    expect(parseDesktopDeepLinkIntent(httpsLinkDeepLink('https://www.rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/a/1111117Hxt1fAWDjN7TY/')!))
      .toEqual({ kind: 'canvas', canvasId: '00000000-0000-7000-8000-000000000002', artifactId: '00000000-0000-7000-8000-000000000003', target: { region: 'global', workspaceId: id } });
  });
  it('adapts a Base58 Sidekick path into its addressed screen', () => {
    expect(parseDesktopDeepLinkIntent(httpsLinkDeepLink('https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7TX/')!))
      .toMatchObject({ kind: 'sidekick', sidekickId: '00000000-0000-7000-8000-000000000002', target: { region: 'global' } });
  });
  it('leaves retired, legacy-host and other links in the browser', () => {
    expect(httpsLinkDeepLink('https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY')).toBeNull();
    expect(httpsLinkDeepLink(`https://rallywith.ai/app/workspaces/enterprise/${id}/workstreams/${id}`)).toBeNull();
    expect(httpsLinkDeepLink('https://with-avalon.com/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/')).toBeNull();
    expect(httpsLinkDeepLink('https://rallywith.ai/download')).toBeNull();
    expect(httpsLinkDeepLink('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX')).toBeNull();
  });
});
