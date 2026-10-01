import "../../../tests/isolated-region";
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesktopTarget } from '../src/auth-handoff';
import { parseSlackLinkFragment, slackDesktopTarget } from '../src/slack-link';
import { classifyDesktopHandoffTarget } from '../src/desktop-open';
import { isIosDevice, legacyIosWorkstreamHandoff } from '../src/workstream-link';
import { parseComparison, renderComparisonPage } from '../src/comparison-pages';
import { comparisons, renderComparisonSitemap, renderLlmsTxt, renderSiteChrome } from '../src/site-chrome';
import { renderComparisonCard } from '../src/social-cards';
import sharp from 'sharp';
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
    const page = renderSiteChrome(readProjectFile('index.html'));
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

  it('lists every comparison and Trust Center page in the footer columns', () => {
    const footer = renderSiteChrome('<!-- rally:site-footer -->');
    const column = (title: string): string[] => {
      const nav = footer.match(new RegExp(`<h2[^>]*>${title}</h2><ul class="footer-links">(.*?)</ul>`, 'u'))?.[1] ?? '';
      return [...nav.matchAll(/href="([^"]+)"/gu)].flatMap(([, href]) => (href ? [href] : []));
    };
    expect(column('Compared to')).toEqual([
      '/compare/claude-tag/', '/compare/grok-bot/', '/compare/viktor/', '/compare/chatgpt/',
      '/compare/claude-cowork/', '/compare/slack/', '/compare/',
    ]);
    expect(column('Trust Center')).toEqual([
      '/trust/', '/trust/security/', '/trust/privacy/', '/trust/terms/', '/trust/dpa/',
      '/trust/subprocessors/', '/trust/cookies/', '/trust/acceptable-use/',
    ]);
  });

  it('renders one comparison table row per rival and refuses an unknown marker', () => {
    const table = renderSiteChrome('<!-- rally:comparison-table -->');
    expect([...table.matchAll(/<th scope="row"><a class="compare-name" href="([^"]+)">([^<]+)</gu)]
      .map(([, href, name]) => `${name} ${href}`)).toEqual(comparisons.map(({ name, slug }) => `${name} /compare/${slug}/`));
    expect(() => renderSiteChrome('<!-- rally:nope -->')).toThrow('Unknown site chrome marker: nope');
  });

  it('renders a comparison page from GitHub-flavored Markdown', () => {
    const source = [
      '---', 'slug: acme', 'name: Acme', 'maker: Acme Inc', 'order: 1', 'title: "Rally vs Acme"',
      'description: "Acme compared."', 'updated: 2026-10-01', 'kind: "A tool."', 'edge: "Rally is better."', '---',
      '**Short answer:** Pick Rally.', '',
      '## Side by side', '', '| | Rally | Acme |', '| --- | --- | --- |', '| Pricing | $100 | Per seat |', '',
      '## Where Acme shines', '', '### Fast', '', 'It is quick.', '',
      '## Where Rally wins', '', '### Together', '', 'Teams share it.', '', '> A pun.', '',
      '## Which one should you pick?', '', '### Pick Acme if', '', '- Solo', '', '### Pick Rally if', '', '- Team', '',
      '## Questions', '', '### Is Rally per seat?', '', 'No. One price per organization.', '',
      '## Sources', '', '- [Acme pricing](https://acme.example/pricing), Acme, checked 2026-10-01', '',
    ].join('\n');
    const page = renderComparisonPage(parseComparison(source, 'acme.md'));
    expect(page).toContain('<p class="compare-answer"><strong>Short answer:</strong> Pick Rally.</p>');
    expect(page).toContain('<tr><th scope="row">Pricing</th><td class="versus-rally" data-label="Rally">$100</td><td data-label="Acme">Per seat</td></tr>');
    expect(page).toContain('<ul class="points"><li><h3>Together</h3><p>Teams share it.</p>\n</li></ul><div class="compare-aside"><p>A pun.</p>\n</div>');
    expect(page).toContain('<div class="verdict verdict-rally"><h3>Pick Rally if</h3><ul>\n<li>Team</li>\n</ul>\n</div>');
    expect(page).toContain('<details><summary>Is Rally per seat?</summary><p>No. One price per organization.</p>\n</details>');
    expect(page).toContain('{"@type":"Question","name":"Is Rally per seat?","acceptedAnswer":{"@type":"Answer","text":"No. One price per organization."}}');
    expect(page).toContain('<time datetime="2026-10-01">October 1, 2026</time>');
    expect(page).toContain('<!-- rally:site-footer -->');
    expect(page).toContain('<meta property="og:image" content="https://rallywith.ai/compare/acme/social.png" />');
    expect(page).toContain('<meta name="twitter:image:alt" content="Rally vs Acme: Rally is better." />');
    expect(() => renderComparisonPage(parseComparison(source.replace('## Sources', '## Odds and ends\n\nExtra.\n\n## Sources'), 'acme.md')))
      .toThrow('Unknown comparison section "Odds and ends"');
    expect(() => parseComparison(source.replace('maker: Acme Inc\n', ''), 'acme.md'))
      .toThrow('acme.md: front matter is missing "maker"');
    const swapped = source.replace('### Pick Acme if\n\n- Solo\n\n### Pick Rally if\n\n- Team', '### Pick Rally if\n\n- Team\n\n### Pick Acme if\n\n- Solo');
    expect(renderComparisonPage(parseComparison(swapped, 'acme.md')))
      .toContain('<div class="verdicts"><div class="verdict verdict-rally"><h3>Pick Rally if</h3>');
    expect(() => renderComparisonPage(parseComparison(source.replace(/## Which one should you pick\?[\s\S]*?(?=## Questions)/u, ''), 'acme.md')))
      .toThrow('acme.md: missing "## Which one should you pick?"');
    expect(() => renderComparisonPage(parseComparison(source.replace('### Pick Rally if', '### Pick us if'), 'acme.md')))
      .toThrow('acme.md: "Which one should you pick?" needs a "### Pick Rally if"');
  });

  it('draws a 1200 by 630 opaque PNG unfurl card for a comparison', async () => {
    const card = await renderComparisonCard({ slug: 'acme', name: 'A very long product name indeed', edge: 'Rally is better. '.repeat(20) });
    const { format, width, height, hasAlpha } = await sharp(card).metadata();
    expect({ format, width, height, hasAlpha }).toEqual({ format: 'png', width: 1200, height: 630, hasAlpha: false });
  });

  it('derives every hub list, count, sitemap and llms.txt entry from the comparison files', () => {
    const hub = renderSiteChrome('<!-- rally:comparison-count -->|<!-- rally:comparison-count-title -->|<!-- rally:comparison-names -->|<!-- rally:comparison-item-list -->');
    const [count, title, names, list] = hub.split('|');
    expect([count, title]).toEqual(['six', 'Six']);
    expect(names).toBe('Claude Tag, Grok Bot, Viktor, ChatGPT, Claude Cowork, and Slack');
    expect((JSON.parse(list ?? '') as { itemListElement: { url: string }[] }).itemListElement.map(({ url }) => url))
      .toEqual(comparisons.map(({ slug }) => `https://rallywith.ai/compare/${slug}/`));
    expect([...renderComparisonSitemap().matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, loc]) => loc))
      .toEqual(['https://rallywith.ai/compare/', ...comparisons.map(({ slug }) => `https://rallywith.ai/compare/${slug}/`)]);
    expect(renderLlmsTxt()).toContain('- [Rally vs Slack](https://rallywith.ai/compare/slack/): Team chat with other humans\n');
  });
});
