import "../../../tests/isolated-region";
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesktopTarget } from '../src/auth-handoff';
import { parseSlackLinkFragment, slackDesktopTarget } from '../src/slack-link';
import { classifyDesktopHandoffTarget } from '../src/desktop-open';
import { isIosDevice, legacyIosWorkstreamHandoff } from '../src/workstream-link';
import { normalizedTelemetryPathname, SITE_ACTION_LINKS, siteActionForLink, sitePageForPath } from '../src/telemetry';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('public Rally site', () => {
  it('keeps Space-only handoffs on the web when iOS has no Space screen', () => {
    expect(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 0)).toBe(false);
  });
  it('hands canonical Channel paths to iPhone builds through their legacy addressed reader', () => {
    expect(legacyIosWorkstreamHandoff({
      region: 'global', workspaceId: '00000000-0000-7000-8000-0000000000a1',
      spaceId: '00000000-0000-7000-8000-0000000000a9',
      workstreamId: '00000000-0000-7000-8000-0000000000b1',
    })).toBe('rallywithai://handoff/workspaces/global/00000000-0000-7000-8000-0000000000a1/workstreams/00000000-0000-7000-8000-0000000000b1');
  });
  it('parses a Slack identity fragment and builds the exact desktop target', () => {
    const token = 'a'.repeat(43);
    expect(parseSlackLinkFragment(`#token=${token}&region=enterprise&workspace=00000000-0000-7000-8000-000000000009`))
      .toEqual({
        token,
        workspaceTarget: { region: 'enterprise', workspaceId: '00000000-0000-7000-8000-000000000009' },
      });
    expect(slackDesktopTarget({
      token,
      workspaceTarget: { region: 'enterprise', workspaceId: '00000000-0000-7000-8000-000000000009' },
    })).toBe(
      `rallywithai://workspace/enterprise/00000000-0000-7000-8000-000000000009/slack/link?token=${token}`,
    );
    expect(parseSlackLinkFragment(`#token=${token}`)).toEqual({ token, workspaceTarget: null });
    expect(parseSlackLinkFragment(`#token=${token}&region=enterprise`)).toBeNull();
  });

  it('removes resource identity from public handoff paths and classifies invalid targets truthfully', () => {
    expect(normalizedTelemetryPathname(
      '/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY/b/1111117Hxt1fAWDjN7Te',
    )).toBe('/app/:region/:organization/s/:space/c/:channel/b/:breakout');
    expect(normalizedTelemetryPathname(
      '/app/workspaces/enterprise/00000000-0000-7000-8000-000000000009/workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30',
    )).toBe('/app/workspaces/:region/:workspace/workstreams/:id');
    expect(normalizedTelemetryPathname('/app/workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30'))
      .toBe('/app/workstreams/:id');
    expect(normalizedTelemetryPathname(
      '/app/workspaces/enterprise/private-workspace/workstreams/private-workstream/extra',
    )).toBe('/app/workspaces/:region/:workspace/workstreams/:id');
    expect(normalizedTelemetryPathname('/app/workspaces/enterprise/private-workspace'))
      .toBe('/app/workspaces/:region/:workspace/workstreams/:id');
    expect(normalizedTelemetryPathname('/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7TX/'))
      .toBe('/app/:region/:organization/sk/:sidekick');
    expect(normalizedTelemetryPathname('/app/global/private-org/s/private-space/c'))
      .toBe('/app/:unrecognized');
    expect(normalizedTelemetryPathname('/trust/privacy/')).toBe('/trust/privacy/');
    expect(sitePageForPath('/trust')).toBe('legal');
    expect(sitePageForPath('/trust/')).toBe('legal');
    expect(sitePageForPath('/trust/privacy/')).toBe('legal');
    expect(sitePageForPath('/support')).toBe('support');
    expect(sitePageForPath('/support/')).toBe('support');
    expect(sitePageForPath('/help')).toBe('support');
    expect(sitePageForPath('/help/')).toBe('support');
    expect(sitePageForPath('/help/sidekicks/triggers-and-schedules/')).toBe('support');
    expect(sitePageForPath('/helpful')).toBe('landing');
    expect(classifyDesktopHandoffTarget('avalon://workstreams/not-a-uuid')).toEqual({
      handoffType: 'workstream', validity: 'invalid',
    });
    expect(classifyDesktopHandoffTarget(null)).toEqual({
      handoffType: 'unknown', validity: 'invalid',
    });

    expect(sitePageForPath('/app/workspaces/:region/:workspace/workstreams/:id'))
      .toBe('workstream_handoff');
  });

  it('validates and launches only exact desktop OAuth handoff targets', () => {
    const ticket = 'single-use-ticket_long-enough-1234567890';
    const attempt = 'a'.repeat(43);
    const successTarget = `avalon://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}`;
    const errorTarget = `avalon://auth/complete?error=google_oauth_denied&region=global&attempt=${attempt}`;
    const sidelineSuccessTarget = `sideline://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}`;
    const sidelineErrorTarget = `sideline://auth/complete?error=google_oauth_denied&region=global&attempt=${attempt}`;
    const connectorSuccessTarget = `avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=enterprise&attempt=${attempt}&provider=linear`;
    const targetedConnectorSuccess = `avalon://workspace/enterprise/00000000-0000-7000-8000-000000000009/auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&attempt=${attempt}&provider=linear`;
    const connectorErrorTarget = `avalon://auth/complete?provider=linear&region=enterprise&attempt=${attempt}&status=denied&error=oauth_denied`;
    const granolaSuccessTarget = `avalon://auth/complete?connection=00000000-0000-7000-8000-000000000005&status=connected&region=global&attempt=${attempt}&provider=granola`;
    const granolaErrorTarget = `avalon://auth/complete?provider=granola&region=global&attempt=${attempt}&status=failed&error=connector_oauth_failed`;
    const asFragment = (target: string): string => `#${new URLSearchParams({ target }).toString()}`;

    expect(parseDesktopTarget(asFragment(successTarget))).toBe(successTarget);
    expect(parseDesktopTarget(asFragment(errorTarget))).toBe(errorTarget);
    expect(parseDesktopTarget(asFragment(sidelineSuccessTarget))).toBe(sidelineSuccessTarget);
    expect(parseDesktopTarget(asFragment(sidelineErrorTarget))).toBe(sidelineErrorTarget);
    expect(parseDesktopTarget(asFragment(connectorSuccessTarget))).toBe(connectorSuccessTarget);
    expect(parseDesktopTarget(asFragment(targetedConnectorSuccess))).toBe(targetedConnectorSuccess);
    expect(parseDesktopTarget(asFragment(connectorErrorTarget))).toBe(connectorErrorTarget);
    expect(parseDesktopTarget(asFragment(granolaSuccessTarget))).toBe(granolaSuccessTarget);
    expect(parseDesktopTarget(asFragment(granolaErrorTarget))).toBe(granolaErrorTarget);
    expect(parseDesktopTarget(asFragment('avalon://auth/complete?error=google_oauth_denied')))
      .toBe('avalon://auth/complete?error=google_oauth_denied');
    expect(parseDesktopTarget(`?target=${encodeURIComponent(successTarget)}`)).toBeNull();
    expect(parseDesktopTarget(`${asFragment(successTarget)}&extra=value`)).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=us&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global&attempt=short`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`sideline://auth/complete?ticket=${ticket}&region=global&attempt=short`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}&extra=value`))).toBeNull();
    expect(parseDesktopTarget(asFragment('avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=enterprise&provider=linear')))
      .toBe('avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=enterprise&provider=linear');
    expect(parseDesktopTarget(asFragment('avalon://auth/complete?connection=00000000-0000-7000-8000-0000000000-4&status=connected&region=enterprise&provider=linear')))
      .toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=enterprise&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?provider=unknown&region=enterprise&attempt=${attempt}&status=denied&error=oauth_denied`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`https://with-avalon.com/?ticket=${ticket}&region=global&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete/?ticket=${ticket}&region=global&attempt=${attempt}`))).toBeNull();
  });
  it('tags every tracked landing link with a known id, one per installer link', () => {
    const page = readProjectFile('index.html');
    const ids = [...page.matchAll(/data-site-action="([^"]+)"/gu)].map(([, id]) => id);
    // A misspelled id is ignored at runtime, which would silently stop counting that link.
    for (const id of ids) expect(siteActionForLink(id), id).not.toBeNull();
    // A tag removed in a redesign is just as silent: every tracked link must still be on the page.
    for (const id of Object.keys(SITE_ACTION_LINKS)) expect(ids, id).toContain(id);
    // Each installer link carries its own id, so the dashboard can tell them apart.
    for (const link of page.match(/<a [^>]*Rally\.dmg[^>]*>/gu) ?? []) {
      expect(link).toMatch(/data-site-action="download-[a-z-]+"/u);
    }
  });
});
