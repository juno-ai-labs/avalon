import "../../../tests/isolated-region";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDesktopTarget } from '../src/auth-handoff';
import { parseSlackLinkFragment, slackDesktopTarget } from '../src/slack-link';
import { classifyDesktopHandoffTarget } from '../src/desktop-open';
import { handoffAppLink, handoffDevice, handoffHeading, handoffPlan } from '../src/link-handoff';
import { parseComparison, renderComparisonPage } from '../src/comparison-pages';
import { loadBlogPosts, parseBlogPost, renderBlogIndex, renderBlogPost } from '../src/blog-pages';
import { blogPosts, comparisons, renderBlogSitemap, renderComparisonSitemap, renderLlmsTxt, renderSiteChrome } from '../src/site-chrome';
import { renderComparisonCard } from '../src/social-cards';
import sharp from 'sharp';
import { normalizedTelemetryPathname, SITE_ACTION_LINKS, siteActionForLink, sitePageForPath } from '../src/telemetry';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('public Rally site', () => {
  it('quotes the linked name in the handoff heading and cuts it past 40 characters', () => {
    expect(handoffHeading('Q3 launch plan')).toBe('Opening “Q3 launch plan” in Rally');
    expect(handoffHeading('x'.repeat(40))).toBe(`Opening “${'x'.repeat(40)}” in Rally`);
    expect(handoffHeading(`${'x'.repeat(39)} tail`)).toBe(`Opening “${'x'.repeat(39)}…” in Rally`);
  });
  it('names which device runs the Mac app, an iPad that reports a Mac included', () => {
    expect(handoffDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe('mac');
    expect(handoffDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe('other');
    expect(handoffDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5)).toBe('other');
    expect(handoffDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe('other');
    expect(handoffDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Linux armv8l', 5)).toBe('other');
  });
  it('hands a Canvas or Sidekick link to the Mac app, and to the web app where none runs', () => {
    const canvas = handoffPlan('/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/');
    expect(canvas).toEqual({ kind: 'open', target: {
      kind: 'canvas', region: 'global', workspaceId: '00000000-0000-7000-8000-000000000001', canvasId: '00000000-0000-7000-8000-000000000002',
    } });
    if (canvas.kind !== 'open') throw new Error('expected a Canvas');
    expect(handoffAppLink('mac', canvas.target)).toBe('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX');
    expect(handoffAppLink('other', canvas.target)).toBeNull();
    const artifact = handoffPlan('/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/a/1111117Hxt1fAWDjN7TY/');
    if (artifact.kind !== 'open') throw new Error('expected a Canvas');
    expect(handoffAppLink('mac', artifact.target))
      .toBe('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX/artifacts/1111117Hxt1fAWDjN7TY');
    const sidekick = handoffPlan('/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7TX/');
    if (sidekick.kind !== 'open') throw new Error('expected a Sidekick');
    expect(handoffAppLink('mac', sidekick.target)).toBe('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/sidekicks/1111117Hxt1fAWDjN7TX');
  });
  it('opens a Thread link as the Canvas of the same id', () => {
    for (const thread of [
      '/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY',
      '/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY/',
    ]) {
      const plan = handoffPlan(thread);
      if (plan.kind !== 'open') throw new Error('expected a Canvas');
      expect(handoffAppLink('mac', plan.target)).toBe('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TY');
    }
  });
  it('answers a Space, Breakout or Organization-less Thread link as gone, and anything else as invalid', () => {
    for (const retired of [
      '/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/',
      '/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY/b/1111117Hxt1fAWDjN7Te',
      '/app/workstreams/00000000-0000-7000-8000-00000000000b',
    ]) expect(handoffPlan(retired)).toEqual({ kind: 'gone' });
    expect(handoffPlan('/app/global/1111117Hxt1fAWDjN7TW/cv/not-base58/')).toEqual({ kind: 'invalid' });
    expect(handoffPlan('/app/')).toEqual({ kind: 'invalid' });
    expect(handoffPlan('/app/workspaces/global/00000000-0000-7000-8000-00000000000a')).toEqual({ kind: 'invalid' });
    expect(handoffPlan('/app/workspaces/global/00000000-0000-7000-8000-00000000000a/')).toEqual({ kind: 'invalid' });
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
    expect(normalizedTelemetryPathname('/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/'))
      .toBe('/app/:region/:organization/cv/:canvas');
    expect(normalizedTelemetryPathname('/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/a/1111117Hxt1fAWDjN7TY/'))
      .toBe('/app/:region/:organization/cv/:canvas/a/:artifact');
    expect(normalizedTelemetryPathname('/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7TX/'))
      .toBe('/app/:region/:organization/sk/:sidekick');
    expect(normalizedTelemetryPathname(
      '/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY/b/1111117Hxt1fAWDjN7Te',
    )).toBe('/app/:retired');
    expect(normalizedTelemetryPathname(
      '/app/workspaces/enterprise/00000000-0000-7000-8000-000000000009/workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30',
    )).toBe('/app/workspaces/:region/:organization/workstreams/:thread');
    expect(normalizedTelemetryPathname('/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY'))
      .toBe('/app/:region/:organization/s/:space/c/:thread');
    expect(normalizedTelemetryPathname('/app/workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30')).toBe('/app/:retired');
    expect(normalizedTelemetryPathname('/app/workspaces/global/00000000-0000-7000-8000-000000000009'))
      .toBe('/app/:unrecognized');
    expect(normalizedTelemetryPathname('/app/global/private-org/cv')).toBe('/app/:unrecognized');
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
    expect(classifyDesktopHandoffTarget('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX')).toEqual({
      handoffType: 'canvas', validity: 'valid',
    });
    expect(classifyDesktopHandoffTarget('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/not-base58')).toEqual({
      handoffType: 'canvas', validity: 'invalid',
    });
    expect(classifyDesktopHandoffTarget('avalon://workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30')).toEqual({
      handoffType: 'unknown', validity: 'invalid',
    });
    expect(classifyDesktopHandoffTarget('rallywithai://workspace/enterprise/00000000-0000-7000-8000-000000000009/activity')).toEqual({
      handoffType: 'activity', validity: 'valid',
    });
    expect(classifyDesktopHandoffTarget(null)).toEqual({
      handoffType: 'unknown', validity: 'invalid',
    });

    expect(sitePageForPath('/app/:region/:organization/cv/:canvas'))
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
    // The retired Sideline app's callback scheme is no longer a handoff target.
    expect(parseDesktopTarget(asFragment(sidelineSuccessTarget))).toBeNull();
    expect(parseDesktopTarget(asFragment(sidelineErrorTarget))).toBeNull();
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
    const ids = (page: string) => [...page.matchAll(/data-site-action="([^"]+)"/gu)].map(([, id]) => id);
    const home = renderSiteChrome(readProjectFile('index.html'));
    const variant = renderSiteChrome(readProjectFile('start-fast/index.html'));
    // A misspelled id is ignored at runtime, which would silently stop counting that link.
    for (const id of [...ids(home), ...ids(variant)]) expect(siteActionForLink(id), id).not.toBeNull();
    // A tag removed in a redesign is just as silent: every tracked link must still be on the home page.
    // Checked against the home page alone, so a variant can't hide a tag the home page lost.
    for (const id of Object.keys(SITE_ACTION_LINKS)) expect(ids(home), id).toContain(id);
    // Each installer link carries its own id, so the dashboard can tell them apart.
    for (const link of `${home}${variant}`.match(/<a [^>]*Rally\.dmg[^>]*>/gu) ?? []) {
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
      '/compare/slack/',
    ]);
    expect(column('Trust Center')).toEqual([
      '/trust/', '/trust/security/', '/trust/privacy/', '/trust/terms/', '/trust/dpa/',
      '/trust/subprocessors/', '/trust/cookies/', '/trust/acceptable-use/',
    ]);
    expect(column('Blog')).toEqual(['/blog/', `/blog/${blogPosts[0]?.slug ?? ''}/`]);
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
      '**Short answer:** Pick Rally.', '', '> Import a chat.', '',
      '## Side by side', '', '| | Rally | Acme |', '| --- | --- | --- |', '| Pricing | $100 | Per seat |', '', '> Prices as of today.', '',
      '## Where Rally wins', '', '### Together', '', 'Teams share it.', '', '> A pun.', '',
    ].join('\n');
    const page = renderComparisonPage(parseComparison(source, 'acme.md'));
    expect(page).toContain('<p class="compare-answer"><strong>Short answer:</strong> Pick Rally.</p>');
    expect(page).toContain('<tr><th scope="row">Pricing</th><td class="versus-rally" data-label="Rally">$100</td><td data-label="Acme">Per seat</td></tr>');
    expect(page).toContain('<ul class="points"><li><h3>Together</h3><p>Teams share it.</p>\n</li></ul><div class="compare-aside"><p>A pun.</p>\n</div>');
    expect(page).toContain('<p class="compare-answer"><strong>Short answer:</strong> Pick Rally.</p>\n<blockquote>\n<p>Import a chat.</p>\n</blockquote>');
    expect(page).toContain('</tbody></table></div><blockquote>\n<p>Prices as of today.</p>\n</blockquote>');
    expect(page).not.toContain('See Rally pricing');
    expect(page).not.toContain('Compare Rally with other tools');
    expect(page).toContain('<time datetime="2026-10-01">October 1, 2026</time>');
    expect(page).toContain('<!-- rally:site-footer -->');
    expect(page).toContain('<meta property="og:image" content="https://rallywith.ai/compare/acme/social.png" />');
    expect(page).toContain('<meta name="twitter:image:alt" content="Rally vs Acme: Rally is better." />');
    expect(() => renderComparisonPage(parseComparison(`${source}\n## Odds and ends\n\nExtra.\n`, 'acme.md')))
      .toThrow('Unknown comparison section "Odds and ends"');
    expect(() => parseComparison(source.replace('maker: Acme Inc\n', ''), 'acme.md'))
      .toThrow('acme.md: front matter is missing "maker"');
    expect(() => renderComparisonPage(parseComparison(source.replace(/## Where Rally wins[\s\S]*/u, ''), 'acme.md')))
      .toThrow('acme.md: missing "## Where Rally wins"');
  });

  it('draws a 1200 by 630 opaque PNG unfurl card for a comparison', async () => {
    const card = await renderComparisonCard({ slug: 'acme', name: 'A very long product name indeed', edge: 'Rally is better. '.repeat(20) });
    const { format, width, height, hasAlpha } = await sharp(card).metadata();
    expect({ format, width, height, hasAlpha }).toEqual({ format: 'png', width: 1200, height: 630, hasAlpha: false });
  });

  it('derives every sitemap and llms.txt entry from the comparison files', () => {
    expect([...renderComparisonSitemap().matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, loc]) => loc))
      .toEqual(comparisons.map(({ slug }) => `https://rallywith.ai/compare/${slug}/`));
    expect(renderLlmsTxt()).toContain('- [Rally vs Slack](https://rallywith.ai/compare/slack/): Team chat with other humans\n');
  });

  it('lists the section links and the rolling sign-in button in the shared header, without Blog', () => {
    const nav = renderSiteChrome('<!-- rally:site-nav -->');
    const links = [...nav.matchAll(/<a [^>]*href="([^"]+)"([^>]*)>(.*?)<\/a>/gu)];
    expect(links.map(([, href, attrs, body]) => `${/aria-label="([^"]+)"/u.exec(attrs ?? '')?.[1] ?? body} ${href}`)).toEqual([
      'Features /#features', 'Pricing /#pricing', 'Compare /#compare',
      'Sign in to Rally or sign up for Rally https://app.rallywith.ai',
    ]);
    expect(nav).toContain('<span>Sign in to Rally</span><span>Sign up for Rally</span>');
  });

  it('renders a blog post from a dated Markdown file and refuses a bad name or front matter', () => {
    const source = [
      '---', 'slug: hello', 'title: "Hello"', 'description: "A first post."', 'author: "The Rally team"', '---',
      '', 'First paragraph.', '', 'Second **paragraph**.', '',
    ].join('\n');
    const post = parseBlogPost(source, '2026-10-01-hello-there.md');
    const page = renderBlogPost(post);
    expect(page).toContain('<h1 class="display blog-title">Hello</h1>');
    expect(page).toContain('<p class="blog-meta"><time datetime="2026-10-01">October 1, 2026</time> · The Rally team</p>');
    expect(page).toContain('<div class="blog-body"><p>First paragraph.</p>\n<p>Second <strong>paragraph</strong>.</p>\n</div>');
    expect(page).toContain('<link rel="canonical" href="https://rallywith.ai/blog/hello/" />');
    expect(page).toContain('<meta property="og:image" content="https://rallywith.ai/blog/hello/social.png" />');
    expect(() => parseBlogPost(source, 'hello.md')).toThrow('hello.md: file name must be YYYY-MM-DD-<title>.md');
    expect(() => parseBlogPost(source, '2026-10-01-hello_world.md')).toThrow('2026-10-01-hello_world.md: file name must be YYYY-MM-DD-<title>.md');
    expect(() => parseBlogPost(source.replace('slug: hello', 'slug: hello_world'), '2026-10-01-hello.md'))
      .toThrow('2026-10-01-hello.md: slug "hello_world" must be lowercase letters, digits and hyphens');
    expect(() => parseBlogPost(source.replace('slug: hello\n', ''), '2026-10-01-hello.md')).toThrow('2026-10-01-hello.md: front matter is missing "slug"');
    expect(() => parseBlogPost(source, '2026-02-30-hello.md')).toThrow('2026-02-30-hello.md: date "2026-02-30" is not a real YYYY-MM-DD day');
    expect(() => parseBlogPost(source, '2026-13-01-hello.md')).toThrow('2026-13-01-hello.md: date "2026-13-01" is not a real YYYY-MM-DD day');
    expect(() => parseBlogPost(source.replace('author: "The Rally team"\n', ''), '2026-10-01-hello.md')).toThrow('2026-10-01-hello.md: front matter is missing "author"');
    expect(() => parseBlogPost(source.replace('---\nslug', '---\ndate: 2026-10-02\nslug'), '2026-10-01-hello.md'))
      .toThrow('2026-10-01-hello.md: "date" comes from the file name, not the front matter');
  });

  it('refuses two blog posts that share a slug', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blog-'));
    try {
      const front = ['---', 'slug: same', 'title: "T"', 'description: "D."', 'author: "A"', '---', '', 'Body.', ''].join('\n');
      writeFileSync(join(directory, '2026-10-01-first.md'), front);
      writeFileSync(join(directory, '2026-10-02-second.md'), front);
      expect(() => loadBlogPosts(pathToFileURL(`${directory}/`))).toThrow('2026-10-02-second.md: slug "same" is already used by 2026-10-01-first.md');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders the blog index as a changelog: the newest post in full, older posts as a first paragraph and a link', () => {
    const post = (file: string, title: string, body: string) =>
      parseBlogPost(['---', `slug: ${title.toLowerCase()}`, `title: "${title}"`, 'description: "D."', 'author: "The Rally team"', '---', '', body].join('\n'), file);
    const index = renderBlogIndex([
      post('2026-10-08-newer.md', 'Newer', 'Newer opening.\n\n- [x] Shipped\n\nNewer close.\n'),
      post('2026-10-01-older.md', 'Older', '## A heading\n\nOlder opening with **bold**.\n\nOlder close.\n'),
    ]);
    const entries = index.split('<article class="changelog-entry">').slice(1);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('<time datetime="2026-10-08">October 8, 2026</time>');
    expect(entries[0]).toContain('<h2 class="changelog-title"><a href="/blog/newer/">Newer</a></h2>');
    expect(entries[0]).toContain('<p>Newer close.</p>');
    expect(entries[0]).toContain('<input checked="" disabled="" type="checkbox"> Shipped');
    expect(entries[0]).not.toContain('Read more');
    expect(entries[1]).toContain('<div class="blog-body"><p>Older opening with <strong>bold</strong>.</p>\n</div>');
    expect(entries[1]).not.toContain('Older close.');
    expect(entries[1]).not.toContain('A heading');
    expect(entries[1]).toContain('<a class="changelog-more" href="/blog/older/" aria-label="Read more: Older">Read more');
    const referenced = renderBlogIndex([
      post('2026-10-08-newer.md', 'Newer', 'Newer.\n'),
      post('2026-10-01-older.md', 'Older', 'See [the details][d].\n\nMore.\n\n[d]: https://example.com/d\n'),
    ]);
    expect(referenced).toContain('<p>See <a href="https://example.com/d">the details</a>.</p>');
  });

  it('lists the blog index and every post in the blog sitemap', () => {
    expect([...renderBlogSitemap().matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, loc]) => loc))
      .toEqual(['https://rallywith.ai/blog/', ...blogPosts.map(({ slug }) => `https://rallywith.ai/blog/${slug}/`)]);
    expect(blogPosts.map(({ slug }) => slug)).toContain('blastoff');
  });
});
