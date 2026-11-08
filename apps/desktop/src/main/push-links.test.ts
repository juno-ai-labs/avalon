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

describe("the web app's Organization URL", () => {
  const canvas = '00000000-0000-7000-8000-000000000002';
  const artifact = '00000000-0000-7000-8000-000000000003';
  const organization = `https://rallywith.ai/app/workspaces/global/${id}`;
  const target = { region: 'global', workspaceId: id };

  it.each([
    ['with no hash', organization, { kind: 'home', target }],
    ['on www, with a trailing slash', `https://www.rallywith.ai/app/workspaces/global/${id}/`, { kind: 'home', target }],
    ['on its landing hash', `${organization}#/`, { kind: 'home', target }],
    ['on a Canvas', `${organization}#/canvases/${canvas}`, { kind: 'canvas', canvasId: canvas, target }],
    ['on a Canvas onto an artifact', `${organization}#/canvases/${canvas}?artifact=${artifact}`, { kind: 'canvas', canvasId: canvas, artifactId: artifact, target }],
    ['on a Sidekick', `${organization}#/sidekicks/${canvas}`, { kind: 'sidekick', sidekickId: canvas, target }],
  ])('opens the app %s', (_name, url, intent) => {
    const deepLink = httpsLinkDeepLink(url);
    expect(deepLink).not.toBeNull();
    expect(parseDesktopDeepLinkIntent(deepLink!)).toEqual(intent);
  });

  it('lands with no hash on the addressed Organization home', () => {
    expect(httpsLinkDeepLink(organization)).toBe('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/home');
  });

  it.each([
    ['another hash route', `${organization}#/settings?section=connections`],
    ['the Canvases list hash', `${organization}#/canvases`],
    ['a Canvas turn', `${organization}#/canvases/${canvas}?turn=${artifact}&sequence=4`],
    ['an artifact beside another query key', `${organization}#/canvases/${canvas}?artifact=${artifact}&turn=1`],
    ['an artifact that is not an id', `${organization}#/canvases/${canvas}?artifact=notes`],
    ['a Sidekick run', `${organization}#/sidekicks/${canvas}?run=${artifact}`],
    ['a path below a Canvas', `${organization}#/canvases/${canvas}/more`],
    ['a Canvas id that is not a UUID', `${organization}#/canvases/1111117Hxt1fAWDjN7TX`],
    ['an outer query', `${organization}?surface=settings#/canvases/${canvas}`],
    ['a Base58 Organization', 'https://rallywith.ai/app/workspaces/global/1111117Hxt1fAWDjN7TW'],
    ['a path below the Organization', `${organization}/sites/abc`],
    ['the web app host, which the Mac app is not associated with', `https://app.rallywith.ai/app/workspaces/global/${id}#/canvases/${canvas}`],
    ['a legacy host', `https://with-avalon.com/app/workspaces/global/${id}`],
  ])('leaves %s in the browser', (_name, url) => {
    expect(httpsLinkDeepLink(url)).toBeNull();
  });
});
